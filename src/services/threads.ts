import { env } from "cloudflare:workers";
import { forwardedFor, threadForPerson } from "@/services/people-rule";
import type { EmailCategory, EmailRecord } from "@/types";
import { now } from "@/utils/helpers";
import { messageIdForms } from "@/utils/message-id";

type Row = Record<string, unknown>;

export type DraftThreadRepairReason =
	| "missing_thread_id"
	| "missing_thread_row"
	| "stale_thread_id"
	| "stale_thread_projection";

export type DraftThreadRepairAction = "none" | "refresh_thread" | "update_thread_id";

export interface DraftThreadRepairSample {
	id: string;
	thread_id: string | null;
	resolved_thread_id: string | null;
	subject: string | null;
	domain: string;
	received_at: number;
	reason: DraftThreadRepairReason;
	action: DraftThreadRepairAction;
}

export interface DraftThreadRepairPageResult {
	dry_run: boolean;
	checked: number;
	selected: number;
	repaired: number;
	updated_thread_ids: number;
	refreshed_threads: number;
	reasons: Partial<Record<DraftThreadRepairReason, number>>;
	next_cursor: string | null;
	remaining_estimate: number;
	sample: DraftThreadRepairSample[];
}

function nullableString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

const SUBJECT_PREFIX_RE = /^(?:re|fw|fwd|aw|wg|sv|vs)\s*[:：]\s*/i;

/**
 * Normalize subject by stripping RE:/FW:/FWD: prefixes and trimming.
 * Handles chained prefixes like "RE: RE: FW: Subject".
 */
export function normalizeSubject(subject: string | null): string {
	if (!subject) return "";
	let normalized = subject.trim();
	let prev: string;
	do {
		prev = normalized;
		normalized = normalized.replace(SUBJECT_PREFIX_RE, "").trim();
	} while (normalized !== prev);
	return normalized;
}

/**
 * Check if a reply's subject has diverged enough from the thread root
 * to warrant splitting into a new thread.
 */
export function shouldSplitThread(
	rootSubject: string | null,
	replySubject: string | null,
): boolean {
	const root = normalizeSubject(rootSubject).toLowerCase();
	const reply = normalizeSubject(replySubject).toLowerCase();

	if (!root || !reply) return false;
	if (root === reply) return false;

	// If the reply contains the root subject, it's still the same conversation
	if (reply.includes(root) || root.includes(reply)) return false;

	// Levenshtein-based divergence: if edit distance > 60% of root length, split
	const maxLen = Math.max(root.length, reply.length);
	const distance = levenshtein(root, reply);
	return distance > maxLen * 0.6;
}

function levenshtein(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const matrix: number[][] = [];
	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			const cost = a[j - 1] === b[i - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,
				matrix[i][j - 1] + 1,
				matrix[i - 1][j - 1] + cost,
			);
		}
	}

	return matrix[b.length][a.length];
}

export type ThreadEmail = Pick<
	EmailRecord,
	"id" | "message_id" | "in_reply_to" | "references_header" | "subject"
>;

/** RFC ids may be folded, adjacent, or stored in the historical bare form. */
function referenceIds(value: string | null): string[] {
	return (value?.match(/<[^<>\s]+>|[^\s<>]+/g) ?? [])
		.map((id) => messageIdForms(id)?.canonical ?? "")
		.filter(Boolean);
}

/**
 * Follow References to a stored MEMBER's thread, not to a hypothetical thread whose
 * id equals that reference (WD-04). Subject alone is never evidence of a reply.
 * Keep the root and the most recent ancestors when a very long chain is truncated.
 */
export async function resolveThreadId(db: D1Database, email: ThreadEmail): Promise<string> {
	const refs = referenceIds(email.references_header);
	const parent = referenceIds(email.in_reply_to);
	const ids = [...new Set([...refs.slice(0, 1), ...refs.slice(-15), ...parent])];
	let diverged = false;
	// One indexed probe across every delivery account, ordered in References order.
	// Resolve a stored member before considering the absent root's Message-ID.
	const forms = ids.flatMap((id) => messageIdForms(id)?.forms ?? []);
	if (forms.length > 0) {
		const { results } = await db
			.prepare(
				`SELECT e.thread_id, e.message_id, t.root_subject FROM emails e
			 LEFT JOIN threads t ON t.id = e.thread_id
			 WHERE e.message_id IN (${forms.map(() => "?").join(",")})
			 AND e.thread_id IS NOT NULL LIMIT 64`,
			)
			.bind(...forms)
			.all<Row>();
		for (const id of ids) {
			for (const row of results) {
				if (messageIdForms(nullableString(row.message_id))?.canonical !== id) continue;
				if (!shouldSplitThread(nullableString(row.root_subject), email.subject))
					return String(row.thread_id);
				diverged = true;
			}
		}
		if (!diverged) {
			// Out-of-order history and legacy threads may have no stored root message.
			// Keep the plain reference root, subject to the existing divergence guard.
			const root = await db
				.prepare("SELECT root_subject FROM threads WHERE id = ? LIMIT 1")
				.bind(ids[0])
				.first<Row>();
			if (!shouldSplitThread(nullableString(root?.root_subject), email.subject)) return ids[0];
		}
	}
	return messageIdForms(email.message_id)?.canonical ?? email.id;
}

/**
 * A thread's priority_category is the highest-ranked category among its member emails
 * (home_alerts above personal: a physical alarm must not be buried by a reply). It follows
 * the members both ways (2026-10-14): refiling a thread's only personal message as
 * notifications takes the thread out of Personal. It used to only go up (Phase 1.2), which
 * kept machine threads in Personal for good. user_pinned_category still wins in every view.
 */
const MEMBER_MAX_PRIORITY_SQL = (threadIdExpr: string) => `
		SELECT category FROM emails
		WHERE thread_id = ${threadIdExpr} AND category IS NOT NULL
		ORDER BY CASE category
			WHEN 'home_alerts' THEN 9
			WHEN 'personal' THEN 7
			WHEN 'tax_documents' THEN 6.5
			WHEN 'billing' THEN 6
			WHEN 'notifications' THEN 5
			WHEN 'agents' THEN 4
			WHEN 'newsletters' THEN 3
			WHEN 'marketing' THEN 2
			WHEN 'spam' THEN 1
			ELSE 0
		END DESC
		LIMIT 1`;

/** SQL CTE query that consolidates aggregate, latest, earliest, participants, and flags. */
const THREAD_CTE_SQL = `
WITH thread_data AS (
	SELECT
		COUNT(*) AS message_count,
		SUM(CASE WHEN read_at IS NULL AND direction = 'inbound' THEN 1 ELSE 0 END)
			AS unread_count,
		MAX(COALESCE(sent_at, received_at)) AS latest_message_at,
		MIN(COALESCE(sent_at, received_at)) AS started_at,
		MAX(has_attachments) AS has_attachments,
		SUM(attachment_count) AS total_attachment_count,
		MIN(domain) AS domain,
		CASE
			WHEN SUM(CASE WHEN mailbox_state = 'inbox' THEN 1 ELSE 0 END) > 0 THEN 'inbox'
			WHEN SUM(CASE WHEN mailbox_state = 'sent' THEN 1 ELSE 0 END) > 0 THEN 'sent'
			WHEN SUM(CASE WHEN mailbox_state = 'draft' THEN 1 ELSE 0 END) > 0 THEN 'draft'
			WHEN SUM(CASE WHEN mailbox_state = 'archived' THEN 1 ELSE 0 END) > 0 THEN 'archived'
			ELSE 'trash'
		END AS computed_mailbox_state
	FROM emails WHERE thread_id = ?1
),
latest_email_cte AS (
	SELECT id, subject, from_name, from_address, category, sub_category,
		CASE
			WHEN text_content IS NOT NULL AND TRIM(text_content) != ''
			THEN SUBSTR(
				TRIM(REPLACE(REPLACE(text_content, CHAR(10), ' '), CHAR(13), ' ')), 1, 180)
			WHEN html_content IS NOT NULL AND TRIM(html_content) != ''
			THEN SUBSTR(
				TRIM(REPLACE(REPLACE(html_content, CHAR(10), ' '), CHAR(13), ' ')), 1, 180)
			ELSE NULL
		END AS snippet
	FROM emails WHERE thread_id = ?1
	ORDER BY COALESCE(sent_at, received_at) DESC LIMIT 1
),
earliest_email_cte AS (
	SELECT subject
	FROM emails WHERE thread_id = ?1
	ORDER BY COALESCE(sent_at, received_at) ASC LIMIT 1
),
participants_cte AS (
	SELECT json_group_array(
		json_object('addr', from_address, 'name', COALESCE(from_name, ''))
	) AS participants_json
	FROM (
		SELECT DISTINCT from_address, from_name
		FROM emails WHERE thread_id = ?1
		ORDER BY COALESCE(sent_at, received_at) ASC
	)
),
member_priority_cte AS (
	SELECT (${MEMBER_MAX_PRIORITY_SQL("?1")}) AS member_max_priority
),
existing_thread_cte AS (
	SELECT (SELECT user_pinned_category FROM threads WHERE id = ?1) AS existing_user_pinned
),
inbound_cte AS (
	-- Each inbound member's [to, cc] JSON text, for threadForPerson (people-rule.ts).
	SELECT json_group_array(json_array(to_addresses_json, cc_addresses_json)) AS inbound_recipients
	FROM emails WHERE thread_id = ?1 AND direction = 'inbound'
)
SELECT
	td.*,
	le.id AS latest_id,
	le.snippet,
	le.category,
	le.sub_category AS latest_sub_category,
	ee.subject AS root_subject,
	pc.participants_json,
	mp.member_max_priority,
	et.existing_user_pinned,
	ic.inbound_recipients,
	COALESCE((SELECT is_muted FROM threads WHERE id = ?1), 0) AS is_muted,
	COALESCE((SELECT is_starred FROM threads WHERE id = ?1), 0) AS is_starred
FROM thread_data td, latest_email_cte le, earliest_email_cte ee, participants_cte pc,
	member_priority_cte mp, existing_thread_cte et, inbound_cte ic
`;

/** SQL upsert for the threads table.
 *
 * priority_category is the member max (MEMBER_MAX_PRIORITY_SQL). user_pinned_category is
 * carried forward unchanged (the caller passes the existing value).
 *
 * The legacy `category` column is still written (with the latest email's
 * category) for one release so anything reading it doesn't break; the inbox
 * list filter now uses COALESCE(user_pinned_category, priority_category).
 */
const THREAD_UPSERT_SQL = `INSERT INTO threads (
	id, domain, root_subject, latest_message_at, started_at,
	message_count, unread_count, mailbox_state,
	has_attachments, attachment_count, snippet,
	participant_names, participant_addresses,
	is_muted, is_starred, category, priority_category, user_pinned_category,
	priority_sub_category, latest_email_id, for_person, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	domain = excluded.domain,
	root_subject = COALESCE(threads.root_subject, excluded.root_subject),
	latest_message_at = excluded.latest_message_at,
	started_at = excluded.started_at,
	message_count = excluded.message_count,
	unread_count = excluded.unread_count,
	mailbox_state = excluded.mailbox_state,
	has_attachments = excluded.has_attachments,
	attachment_count = excluded.attachment_count,
	snippet = excluded.snippet,
	participant_names = excluded.participant_names,
	participant_addresses = excluded.participant_addresses,
	category = excluded.category,
	priority_category = excluded.priority_category,
	user_pinned_category = excluded.user_pinned_category,
	priority_sub_category = excluded.priority_sub_category,
	latest_email_id = excluded.latest_email_id,
	for_person = excluded.for_person,
	updated_at = excluded.updated_at`;

/**
 * Parse the participants JSON from the CTE into parallel name/address arrays.
 */
function parseParticipantsJson(json: string | null | undefined): {
	names: string[];
	addresses: string[];
} {
	const names: string[] = [];
	const addresses: string[] = [];
	if (!json) return { names, addresses };
	try {
		const arr = JSON.parse(json) as { addr: string; name: string }[];
		for (const p of arr) {
			if (!addresses.includes(p.addr)) {
				addresses.push(p.addr);
				names.push(p.name ?? "");
			}
		}
	} catch {
		// Malformed JSON — return empty
	}
	return { names, addresses };
}

/**
 * threads.for_person from the CTE's inbound recipients. FORWARDED_FOR_JSON comes from the
 * Worker env module because the ~30 refresh callers only hold a D1 handle.
 */
function forPersonOf(row: Row): string | null {
	let inbound: [string | null, string | null][] = [];
	try {
		inbound = JSON.parse(String(row.inbound_recipients ?? "[]"));
	} catch {
		return null;
	}
	return threadForPerson(env as CloudflareBindings, inbound);
}

/**
 * Build upsert bind params from a CTE result row.
 * Returns null if the thread has no emails (caller should delete the thread row).
 * user_pinned_category is carried forward unchanged from the existing row.
 */
function buildUpsertParams(threadId: string, row: Row, timestamp: number): unknown[] | null {
	if (Number(row.message_count) === 0) return null;

	const rootSubject = row.root_subject ? normalizeSubject(String(row.root_subject)) : null;
	const { names, addresses } = parseParticipantsJson(
		row.participants_json != null ? String(row.participants_json) : null,
	);

	const priorityCategory = row.member_max_priority ? String(row.member_max_priority) : null;
	const userPinnedCategory = row.existing_user_pinned ? String(row.existing_user_pinned) : null;

	// Phase 4: priority_sub_category mirrors the latest email's sub_category.
	// Simple rule is fine for sub-categories — they rarely collide across
	// thread members the way top-level categories can.
	const prioritySubCategory = row.latest_sub_category ? String(row.latest_sub_category) : null;

	return [
		threadId,
		String(row.domain),
		rootSubject,
		Number(row.latest_message_at),
		Number(row.started_at),
		Number(row.message_count),
		Number(row.unread_count),
		String(row.computed_mailbox_state),
		Boolean(row.has_attachments),
		Number(row.total_attachment_count),
		row.snippet ? String(row.snippet) : null,
		JSON.stringify(names),
		JSON.stringify(addresses),
		Number(row.is_muted),
		Number(row.is_starred),
		row.category ? String(row.category) : null,
		priorityCategory,
		userPinnedCategory,
		prioritySubCategory,
		row.latest_id ? String(row.latest_id) : null,
		forPersonOf(row),
		Number(row.started_at),
		timestamp,
	];
}

/**
 * Recompute all denormalized fields on the threads table for a given thread_id.
 * Uses a single CTE query + 1 upsert (2 queries total, down from 6).
 * Called after any email insert, update, or delete that affects the thread.
 */
export async function refreshThread(db: D1Database, threadId: string): Promise<void> {
	// Cheap probe first — if zero emails match this thread, unconditionally
	// DELETE the threads row and skip the CTE entirely. Avoids any edge
	// case in the cross-join (latest_email_cte / earliest_email_cte return
	// 0 rows → whole CTE returns 0 rows → we'd rely on fallthrough).
	const count = await db
		.prepare("SELECT COUNT(*) AS n FROM emails WHERE thread_id = ?")
		.bind(threadId)
		.first<{ n: number }>();
	if (!count || Number(count.n) === 0) {
		await db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run();
		return;
	}

	const row = await db.prepare(THREAD_CTE_SQL).bind(threadId).first<Row>();

	if (!row || Number(row.message_count) === 0) {
		await db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run();
		return;
	}

	const timestamp = now();
	const params = buildUpsertParams(threadId, row, timestamp);
	if (!params) {
		await db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run();
		return;
	}

	await db
		.prepare(THREAD_UPSERT_SQL)
		.bind(...params)
		.run();
}

/**
 * Batch-refresh multiple threads in a single D1 round-trip.
 * Executes all CTE queries via db.batch(), then batch-upserts results.
 */
export async function refreshThreadBatch(db: D1Database, threadIds: string[]): Promise<void> {
	if (threadIds.length === 0) return;

	// Deduplicate
	const unique = [...new Set(threadIds)];

	// Phase 1: batch all CTE selects
	const cteStatements = unique.map((id) => db.prepare(THREAD_CTE_SQL).bind(id));
	const cteResults = await db.batch<Row>(cteStatements);

	// Phase 2: build upserts (or deletes for empty threads)
	const timestamp = now();
	const phase2Statements: D1PreparedStatement[] = [];
	for (let i = 0; i < unique.length; i++) {
		const threadId = unique[i];
		const rows = cteResults[i]?.results;
		const row = rows?.[0];

		if (!row || Number(row.message_count) === 0) {
			phase2Statements.push(db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId));
			continue;
		}

		const params = buildUpsertParams(threadId, row, timestamp);
		if (!params) {
			phase2Statements.push(db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId));
			continue;
		}

		phase2Statements.push(db.prepare(THREAD_UPSERT_SQL).bind(...params));
	}

	// Run phase-2 statements sequentially rather than via db.batch(). D1's
	// batch() is all-or-nothing: a single failing UPSERT would roll back
	// every DELETE in the batch too, leaving orphan/stale threads behind.
	// This was the root cause of v15-seeded threads with stale unread_count
	// that survived every subsequent refresh attempt. Sequential execution
	// with per-statement error capture isolates failures to their own row.
	for (const stmt of phase2Statements) {
		try {
			await stmt.run();
		} catch (err) {
			console.error("[refreshThreadBatch] per-thread statement failed", err);
		}
	}
}

/**
 * Archive all emails in a thread (Gmail-style: removes from inbox).
 */
export async function archiveThread(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	const conditions = ["thread_id = ?", "mailbox_state NOT IN ('trash', 'draft')"];
	const params: unknown[] = [threadId];
	if (domainScope.length > 0) {
		conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	const { meta } = await db
		.prepare(`UPDATE emails SET mailbox_state = 'archived' WHERE ${conditions.join(" AND ")}`)
		.bind(...params)
		.run();

	return { updated: meta?.changes ?? 0 };
}

/**
 * Trash all emails in a thread.
 */
export async function trashThread(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	const conditions = ["thread_id = ?", "mailbox_state != 'draft'"];
	const params: unknown[] = [threadId];
	if (domainScope.length > 0) {
		conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	// Stamp trashed_at like the per-email trash does (purge needs it); a message that
	// was already in Trash keeps its original timestamp.
	const trashedAt = now();
	const { meta } = await db
		.prepare(
			`UPDATE emails SET trashed_at = CASE WHEN mailbox_state = 'trash' THEN COALESCE(trashed_at, ?) ELSE ? END,
			 mailbox_state = 'trash' WHERE ${conditions.join(" AND ")}`,
		)
		.bind(trashedAt, trashedAt, ...params)
		.run();

	return { updated: meta?.changes ?? 0 };
}

/**
 * Restore all emails in a thread to their natural state. Clears trashed_at like
 * the per-email restore does, so a stale timestamp can't get a re-trashed
 * message purged early.
 */
export async function restoreThread(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	const conditions = ["thread_id = ?"];
	const params: unknown[] = [threadId];
	if (domainScope.length > 0) {
		conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	const { meta } = await db
		.prepare(
			`UPDATE emails SET mailbox_state = CASE
				WHEN direction = 'outbound' AND sent_at IS NULL AND provider_message_id IS NULL THEN 'draft'
				WHEN direction = 'outbound' THEN 'sent'
				ELSE 'inbox'
			 END, trashed_at = NULL WHERE ${conditions.join(" AND ")}`,
		)
		.bind(...params)
		.run();

	return { updated: meta?.changes ?? 0 };
}

/**
 * Mute a thread — new replies auto-archive.
 */
export async function muteThread(db: D1Database, threadId: string): Promise<void> {
	await db
		.prepare("UPDATE threads SET is_muted = 1, updated_at = ? WHERE id = ?")
		.bind(now(), threadId)
		.run();
}

/**
 * Unmute a thread.
 */
export async function unmuteThread(db: D1Database, threadId: string): Promise<void> {
	await db
		.prepare("UPDATE threads SET is_muted = 0, updated_at = ? WHERE id = ?")
		.bind(now(), threadId)
		.run();
}

/**
 * Star a thread.
 */
export async function starThread(db: D1Database, threadId: string): Promise<void> {
	await db
		.prepare("UPDATE threads SET is_starred = 1, updated_at = ? WHERE id = ?")
		.bind(now(), threadId)
		.run();
}

/**
 * Unstar a thread.
 */
export async function unstarThread(db: D1Database, threadId: string): Promise<void> {
	await db
		.prepare("UPDATE threads SET is_starred = 0, updated_at = ? WHERE id = ?")
		.bind(now(), threadId)
		.run();
}

export async function setThreadCategory(
	db: D1Database,
	threadId: string,
	category: EmailCategory | null,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	const conditions = ["thread_id = ?"];
	const params: unknown[] = [threadId];
	if (domainScope.length > 0) {
		conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	const { meta } = await db
		.prepare(
			`UPDATE emails
			 SET category = ?,
			     sub_category = NULL,
			     classification_uncertain = 0
			 WHERE ${conditions.join(" AND ")}`,
		)
		.bind(category, ...params)
		.run();

	await db
		.prepare(
			`UPDATE threads
			 SET user_pinned_category = ?,
			     priority_category = ?,
			     priority_sub_category = NULL,
			     updated_at = ?
			 WHERE id = ?`,
		)
		.bind(category, category, now(), threadId)
		.run();

	return { updated: meta?.changes ?? 0 };
}

/**
 * Mark all emails in a thread as read.
 */
export async function markThreadRead(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	const conditions = ["thread_id = ?", "read_at IS NULL"];
	const params: unknown[] = [now(), threadId];
	if (domainScope.length > 0) {
		conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	const { meta } = await db
		.prepare(`UPDATE emails SET read_at = ? WHERE ${conditions.join(" AND ")}`)
		.bind(...params)
		.run();

	const updated = meta?.changes ?? 0;
	// Belt-and-braces: if zero emails were flipped, the thread may already
	// be read AND the threads.unread_count aggregate may be stale (historical
	// drift from v15 seed / failed refresh). Force the threads row to zero
	// immediately so the user-visible "mark as read" click actually has a
	// visible effect without waiting for refreshThread to catch up.
	if (updated === 0) {
		await db
			.prepare("UPDATE threads SET unread_count = 0, updated_at = ? WHERE id = ?")
			.bind(now(), threadId)
			.run();
	}
	return { updated };
}

/**
 * Mark all emails in a thread as unread.
 */
export async function markThreadUnread(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	const conditions = ["thread_id = ?", "read_at IS NOT NULL", "direction = 'inbound'"];
	const params: unknown[] = [threadId];
	if (domainScope.length > 0) {
		conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	const { meta } = await db
		.prepare(`UPDATE emails SET read_at = NULL WHERE ${conditions.join(" AND ")}`)
		.bind(...params)
		.run();

	return { updated: meta?.changes ?? 0 };
}

/**
 * Apply a batch action to multiple threads at once.
 * Action UPDATEs run sequentially, then all thread refreshes are batched.
 */
export async function applyThreadBatchAction(
	db: D1Database,
	threadIds: string[],
	action: string,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	if (threadIds.length === 0) return { updated: 0 };

	let total = 0;
	const refreshIds: string[] = [];

	for (const threadId of threadIds) {
		let result: { updated: number };
		switch (action) {
			case "archive":
				result = await archiveThread(db, threadId, domainScope);
				refreshIds.push(threadId);
				break;
			case "trash":
				result = await trashThread(db, threadId, domainScope);
				refreshIds.push(threadId);
				break;
			case "restore":
				result = await restoreThread(db, threadId, domainScope);
				refreshIds.push(threadId);
				break;
			case "mark_read":
				result = await markThreadRead(db, threadId, domainScope);
				refreshIds.push(threadId);
				break;
			case "mark_unread":
				result = await markThreadUnread(db, threadId, domainScope);
				refreshIds.push(threadId);
				break;
			case "mute":
				await muteThread(db, threadId);
				result = { updated: 1 };
				break;
			case "unmute":
				await unmuteThread(db, threadId);
				result = { updated: 1 };
				break;
			case "star":
				await starThread(db, threadId);
				result = { updated: 1 };
				break;
			case "unstar":
				await unstarThread(db, threadId);
				result = { updated: 1 };
				break;
			case "set_personal":
				result = await setThreadCategory(db, threadId, "personal", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_billing":
				result = await setThreadCategory(db, threadId, "billing", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_agents":
				result = await setThreadCategory(db, threadId, "agents", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_notifications":
				result = await setThreadCategory(db, threadId, "notifications", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_newsletters":
				result = await setThreadCategory(db, threadId, "newsletters", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_marketing":
				result = await setThreadCategory(db, threadId, "marketing", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_spam":
				result = await setThreadCategory(db, threadId, "spam", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_home_alerts":
				result = await setThreadCategory(db, threadId, "home_alerts", domainScope);
				refreshIds.push(threadId);
				break;
			case "set_tax_documents":
				result = await setThreadCategory(db, threadId, "tax_documents", domainScope);
				refreshIds.push(threadId);
				break;
			case "clear_category":
				result = await setThreadCategory(db, threadId, null, domainScope);
				refreshIds.push(threadId);
				break;
			default:
				result = { updated: 0 };
		}
		total += result.updated;
	}

	// Batch-refresh all affected threads in one D1 round-trip
	if (refreshIds.length > 0) {
		await refreshThreadBatch(db, refreshIds);
	}

	return { updated: total };
}

/**
 * Check if a thread is muted. Used during email ingestion to auto-archive replies.
 */
export async function isThreadMuted(db: D1Database, threadId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT is_muted FROM threads WHERE id = ?")
		.bind(threadId)
		.first<Row>();
	return row ? Boolean(row.is_muted) : false;
}

const THREAD_REBUILD_IDS_SQL = `
SELECT thread_id
FROM (
	SELECT id AS thread_id FROM threads
	UNION
	SELECT DISTINCT thread_id AS thread_id FROM emails WHERE thread_id IS NOT NULL
)
WHERE thread_id IS NOT NULL
	AND (?1 IS NULL OR thread_id > ?1)
ORDER BY thread_id ASC
LIMIT ?2`;

const MISSING_THREAD_EMAILS_SQL = `
SELECT id, message_id, in_reply_to, references_header, subject, domain, mailbox
FROM emails
WHERE thread_id IS NULL
ORDER BY COALESCE(sent_at, received_at) ASC, id ASC
LIMIT ?`;

function buildDomainScopeClause(alias: string, domainScope: string[], params: unknown[]) {
	if (domainScope.length === 0) return "";
	params.push(...domainScope);
	return ` AND ${alias}.domain IN (${domainScope.map(() => "?").join(", ")})`;
}

function incrementReason(
	reasons: Partial<Record<DraftThreadRepairReason, number>>,
	reason: DraftThreadRepairReason,
) {
	reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function isStaleThreadProjection(row: Row): boolean {
	const threadExists = Number(row.thread_exists ?? 0) > 0;
	if (!threadExists) return false;
	if (row.thread_latest_email_id == null) return true;
	const threadMessageCount = Number(row.thread_message_count ?? 0);
	const actualMessageCount = Number(row.actual_thread_message_count ?? 0);
	if (actualMessageCount > 0 && threadMessageCount !== actualMessageCount) return true;
	const threadDraftMembers = Number(row.thread_draft_members ?? 0);
	return threadDraftMembers <= 0;
}

async function getDraftThreadRepairRows(
	db: D1Database,
	options: { domainScope?: string[]; limit?: number; cursor?: string | null } = {},
): Promise<{ rows: Row[]; hasMore: boolean; nextCursor: string | null }> {
	const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500));
	const domainScope = options.domainScope ?? [];
	const cursor = options.cursor?.trim() || null;
	const params: unknown[] = [];
	const conditions = ["e.mailbox_state = 'draft'"];

	const domainClause = buildDomainScopeClause("e", domainScope, params);
	if (domainClause) {
		conditions.push(domainClause.replace(/^ AND /, ""));
	}
	if (cursor) {
		conditions.push("e.id > ?");
		params.push(cursor);
	}

	const { results } = await db
		.prepare(
			`SELECT
				e.id,
				e.thread_id,
				e.message_id,
				e.in_reply_to,
				e.references_header,
				e.subject,
				e.domain,
				e.mailbox,
				e.received_at,
				CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS thread_exists,
				t.latest_email_id AS thread_latest_email_id,
				t.message_count AS thread_message_count,
				(SELECT COUNT(*) FROM emails e_count WHERE e_count.thread_id = e.thread_id)
					AS actual_thread_message_count,
				(SELECT COUNT(*) FROM emails e_draft
				 WHERE e_draft.thread_id = e.thread_id AND e_draft.mailbox_state = 'draft')
					AS thread_draft_members
			 FROM emails e
			 LEFT JOIN threads t ON t.id = e.thread_id
			 WHERE ${conditions.join(" AND ")}
			 ORDER BY e.id ASC
			 LIMIT ?`,
		)
		.bind(...params, limit + 1)
		.all<Row>();

	const rows = (results ?? []) as Row[];
	const pageRows = rows.slice(0, limit);
	return {
		rows: pageRows,
		hasMore: rows.length > limit,
		nextCursor: rows.length > limit ? String(pageRows[pageRows.length - 1]?.id ?? "") : null,
	};
}

async function countLikelyDraftThreadRepairCandidates(
	db: D1Database,
	domainScope: string[] = [],
): Promise<number> {
	const params: unknown[] = [];
	const conditions = ["e.mailbox_state = 'draft'"];
	const domainClause = buildDomainScopeClause("e", domainScope, params);
	if (domainClause) {
		conditions.push(domainClause.replace(/^ AND /, ""));
	}
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total
			 FROM emails e
			 LEFT JOIN threads t ON t.id = e.thread_id
			 WHERE ${conditions.join(" AND ")}
			   AND (
			     e.thread_id IS NULL
			     OR t.id IS NULL
			     OR t.latest_email_id IS NULL
			     OR t.message_count != (
			       SELECT COUNT(*) FROM emails e_count WHERE e_count.thread_id = e.thread_id
			     )
			     OR (
			       SELECT COUNT(*) FROM emails e_draft
			       WHERE e_draft.thread_id = e.thread_id AND e_draft.mailbox_state = 'draft'
			     ) <= 0
			   )`,
		)
		.bind(...params)
		.first<Row>();

	return Number(row?.total ?? 0);
}

/**
 * Rebuild every known thread row from the emails table in batches.
 *
 * This is idempotent: running it repeatedly yields the same thread projection
 * as long as the underlying emails are unchanged.
 */
export async function rebuildThreadsFromEmails(
	db: D1Database,
	batchSize = 250,
): Promise<{ processed: number; batches: number }> {
	const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
	let processed = 0;
	let batches = 0;
	let cursor: string | null = null;

	for (;;) {
		const batch = await rebuildThreadBatchPage(db, {
			batchSize: normalizedBatchSize,
			cursor,
		});
		if (batch.thread_ids.length === 0) {
			break;
		}

		processed += batch.processed;
		batches += batch.batches;
		cursor = batch.next_cursor;

		if (!cursor) {
			break;
		}
	}

	return { processed, batches };
}

export async function rebuildThreadBatchPage(
	db: D1Database,
	options: { batchSize?: number; cursor?: string | null } = {},
): Promise<{
	processed: number;
	batches: number;
	next_cursor: string | null;
	thread_ids: string[];
}> {
	const normalizedBatchSize = Math.max(1, Math.floor(options.batchSize ?? 250));
	const cursor = options.cursor?.trim() || null;
	const { results } = await db
		.prepare(THREAD_REBUILD_IDS_SQL)
		.bind(cursor, normalizedBatchSize)
		.all<Row>();

	const threadIds = (results ?? [])
		.map((row) => nullableString(row.thread_id)?.trim() ?? "")
		.filter((threadId): threadId is string => threadId !== "");

	if (threadIds.length === 0) {
		return { processed: 0, batches: 0, next_cursor: null, thread_ids: [] };
	}

	await refreshThreadBatch(db, threadIds);
	return {
		processed: threadIds.length,
		batches: 1,
		next_cursor: threadIds[threadIds.length - 1] ?? null,
		thread_ids: threadIds,
	};
}

export async function repairMissingThreadIds(
	db: D1Database,
	limit = 250,
): Promise<{ repaired: number; refreshed_threads: number }> {
	const normalizedLimit = Math.max(1, Math.floor(limit));
	const { results } = await db.prepare(MISSING_THREAD_EMAILS_SQL).bind(normalizedLimit).all<Row>();

	const emails = (results ?? []) as Row[];
	if (emails.length === 0) {
		return { repaired: 0, refreshed_threads: 0 };
	}

	const threadIds = new Set<string>();

	for (const row of emails) {
		const threadId = await resolveThreadId(db, {
			id: String(row.id),
			message_id: nullableString(row.message_id),
			in_reply_to: nullableString(row.in_reply_to),
			references_header: nullableString(row.references_header),
			subject: nullableString(row.subject),
		});

		await db
			.prepare("UPDATE emails SET thread_id = ? WHERE id = ? AND thread_id IS NULL")
			.bind(threadId, String(row.id))
			.run();
		threadIds.add(threadId);
	}

	await refreshThreadBatch(db, [...threadIds]);
	return { repaired: emails.length, refreshed_threads: threadIds.size };
}

export async function repairDraftThreadsPage(
	db: D1Database,
	options: {
		domainScope?: string[];
		limit?: number;
		cursor?: string | null;
		dryRun?: boolean;
	} = {},
): Promise<DraftThreadRepairPageResult> {
	const domainScope = options.domainScope ?? [];
	const dryRun = options.dryRun !== false;
	const { rows, hasMore, nextCursor } = await getDraftThreadRepairRows(db, options);
	const reasons: Partial<Record<DraftThreadRepairReason, number>> = {};
	const sample: DraftThreadRepairSample[] = [];
	const updateRows: Array<{
		id: string;
		currentThreadId: string | null;
		resolvedThreadId: string;
	}> = [];
	const refreshIds = new Set<string>();
	let selected = 0;

	for (const row of rows) {
		const id = String(row.id);
		const currentThreadId = nullableString(row.thread_id);
		const resolvedThreadId = await resolveThreadId(db, {
			id,
			message_id: nullableString(row.message_id),
			in_reply_to: nullableString(row.in_reply_to),
			references_header: nullableString(row.references_header),
			subject: nullableString(row.subject),
		});

		let reason: DraftThreadRepairReason | null = null;
		let action: DraftThreadRepairAction = "none";

		if (!currentThreadId) {
			reason = "missing_thread_id";
			action = "update_thread_id";
		} else if (resolvedThreadId !== currentThreadId) {
			reason = "stale_thread_id";
			action = "update_thread_id";
		} else if (Number(row.thread_exists ?? 0) <= 0) {
			reason = "missing_thread_row";
			action = "refresh_thread";
		} else if (isStaleThreadProjection(row)) {
			reason = "stale_thread_projection";
			action = "refresh_thread";
		}

		if (!reason) continue;

		selected += 1;
		incrementReason(reasons, reason);
		if (sample.length < 25) {
			sample.push({
				id,
				thread_id: currentThreadId,
				resolved_thread_id: resolvedThreadId,
				subject: nullableString(row.subject),
				domain: String(row.domain),
				received_at: Number(row.received_at ?? 0),
				reason,
				action,
			});
		}

		if (action === "update_thread_id") {
			updateRows.push({ id, currentThreadId, resolvedThreadId });
			if (currentThreadId) refreshIds.add(currentThreadId);
			refreshIds.add(resolvedThreadId);
		} else if (action === "refresh_thread") {
			refreshIds.add(resolvedThreadId || currentThreadId || id);
		}
	}

	let updatedThreadIds = 0;
	if (!dryRun) {
		for (const row of updateRows) {
			const updateConditions = ["id = ?", "mailbox_state = 'draft'"];
			const updateParams: unknown[] = [row.resolvedThreadId, row.id];
			if (domainScope.length > 0) {
				updateConditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
				updateParams.push(...domainScope);
			}
			updateConditions.push("(thread_id IS NULL OR thread_id != ?)");
			updateParams.push(row.resolvedThreadId);
			const { meta } = await db
				.prepare(`UPDATE emails SET thread_id = ? WHERE ${updateConditions.join(" AND ")}`)
				.bind(...updateParams)
				.run();
			updatedThreadIds += meta?.changes ?? 0;
		}

		if (refreshIds.size > 0) {
			await refreshThreadBatch(db, [...refreshIds]);
		}
	}

	const remainingEstimate = await countLikelyDraftThreadRepairCandidates(db, domainScope);

	return {
		dry_run: dryRun,
		checked: rows.length,
		selected,
		repaired: dryRun ? 0 : updatedThreadIds + refreshIds.size,
		updated_thread_ids: dryRun ? 0 : updatedThreadIds,
		refreshed_threads: dryRun ? 0 : refreshIds.size,
		reasons,
		next_cursor: hasMore ? nextCursor : null,
		remaining_estimate: remainingEstimate,
		sample,
	};
}

/** Bounded re-joining of legacy fragments, separate from projection-only refresh. */
export async function repairSplitThreadsPage(
	db: D1Database,
	opts: { after: string | null; threadId: string | null; limit: number; dryRun: boolean },
) {
	const limit = Math.max(1, Math.min(opts.limit, 20));
	const page = opts.threadId
		? [{ id: opts.threadId }]
		: (
				await db
					.prepare("SELECT id FROM threads WHERE id > ? ORDER BY id LIMIT ?")
					.bind(opts.after ?? "", limit)
					.all<{ id: string }>()
			).results;
	const result = {
		dry_run: opts.dryRun,
		scanned: 0,
		changed: 0,
		applied: 0,
		emails: 0,
		next_after: !opts.threadId && page.length === limit ? page[page.length - 1].id : null,
		skipped: [] as { id: string; reason: string }[],
		sample: [] as { from: string; to: string; emails: number; email_ids: string[] }[],
	};
	let inspected = 0;
	let previous = opts.after;
	for (const { id: source } of page) {
		result.scanned++;
		const { results: members } = await db
			.prepare(
				`SELECT id, message_id, in_reply_to, references_header, subject, domain, mailbox,
			 COALESCE(sent_at, received_at) AS date FROM emails WHERE thread_id = ?
			 ORDER BY COALESCE(sent_at, received_at), id LIMIT 201`,
			)
			.bind(source)
			.all<ThreadEmail & { date: number }>();
		if (!members.length) continue;
		if (members.length > 200) {
			result.skipped.push({ id: source, reason: "more_than_200_members" });
			continue;
		}
		if (inspected + members.length > 200) {
			result.next_after = previous;
			result.scanned--;
			break;
		}
		inspected += members.length;
		previous = source;
		const earliest = members[0];
		const targets = new Set<string>();
		for (const member of members) {
			if (!member.references_header && !member.in_reply_to) continue;
			const target = await resolveThreadId(db, member);
			if (target !== source) targets.add(target);
		}
		const eligible: string[] = [];
		for (const target of targets) {
			// Never turn an unresolved header into a phantom merge. Move only toward an
			// older stored conversation, so repeated pages cannot oscillate or cycle.
			const { results: targetMembers } = await db
				.prepare(
					`SELECT domain, mailbox, subject, COALESCE(sent_at, received_at) AS date
				 FROM emails WHERE thread_id = ? ORDER BY COALESCE(sent_at, received_at), id LIMIT 201`,
				)
				.bind(target)
				.all<Row>();
			const root = targetMembers[0];
			if (!root || targetMembers.length > 200) continue;
			if (
				Number(root.date) > earliest.date ||
				(Number(root.date) === earliest.date && target > source)
			)
				continue;
			if (members.some((m) => shouldSplitThread(nullableString(root.subject), m.subject))) continue;
			eligible.push(target);
		}
		if (eligible.length !== 1) {
			if (eligible.length > 1) result.skipped.push({ id: source, reason: "ambiguous_targets" });
			continue;
		}
		const target = eligible[0];
		// A merge must preserve explicit user choices. Conflicting category pins need
		// an operator's decision; stars and mutes combine with OR.
		const { results: flags } = await db
			.prepare(
				"SELECT id, user_pinned_category, is_muted, is_starred FROM threads WHERE id IN (?, ?) LIMIT 2",
			)
			.bind(source, target)
			.all<Row>();
		const pins = [
			...new Set(flags.map((f) => nullableString(f.user_pinned_category)).filter(Boolean)),
		];
		if (pins.length > 1) {
			result.skipped.push({ id: source, reason: "conflicting_category_pins" });
			continue;
		}
		result.changed++;
		result.emails += members.length;
		result.sample.push({
			from: source,
			to: target,
			emails: members.length,
			email_ids: members.slice(0, 5).map((m) => m.id),
		});
		if (opts.dryRun) continue;
		// Membership and preferences move together. Source projections are retained
		// until the refresh succeeds, making a retry safe after an interrupted refresh.
		if (!flags.some((f) => f.id === target)) await refreshThread(db, target);
		const updates = await db.batch([
			db.prepare("UPDATE emails SET thread_id = ? WHERE thread_id = ?").bind(target, source),
			db
				.prepare(`UPDATE threads SET user_pinned_category = COALESCE(user_pinned_category, ?),
				is_muted = MAX(is_muted, ?), is_starred = MAX(is_starred, ?) WHERE id = ?`)
				.bind(
					pins[0] ?? null,
					flags.some((f) => Boolean(f.is_muted)) ? 1 : 0,
					flags.some((f) => Boolean(f.is_starred)) ? 1 : 0,
					target,
				),
		]);
		await refreshThreadBatch(db, [target, source]);
		if (Number(updates[0].meta.changes) > 0) result.applied++;
	}
	return result;
}

export interface ThreadRecomputePageResult {
	dry_run: boolean;
	scanned: number;
	changed: number;
	applied: number;
	/** "old->new" priority_category counts; "null" stands for no category. */
	priority_changes: Record<string, number>;
	/** Of those, pinned threads (their views don't move: the pin wins). */
	pinned: number;
	/** "old->new" for_person counts. */
	for_person_changes: Record<string, number>;
	next_after: string | null;
	sample: {
		id: string;
		priority: [string | null, string | null];
		for_person: [string | null, string | null];
	}[];
}

function tally(counts: Record<string, number>, from: unknown, to: unknown) {
	const key = `${from ?? "null"}->${to ?? "null"}`;
	counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Re-runs the thread refresh where the stored priority_category or for_person disagrees
 * with what the refresh computes now (2026-10-14: priority used to only go up, and
 * v54 added for_person). One page of threads by id; pass next_after back as `after` until
 * it is null. `since` (epoch ms) skips threads whose latest message is older. Threads only:
 * no email's category is touched.
 */
export async function recomputeThreadsPage(
	db: D1Database,
	opts: { after: string | null; since: number; limit: number; dryRun: boolean },
): Promise<ThreadRecomputePageResult> {
	// Cheap candidate filter: priority differs from the member max, or a member names a
	// forwarded-in address, or for_person is already set.
	const forwarded = Object.keys(forwardedFor(env as CloudflareBindings));
	const mentions = forwarded.length
		? forwarded
				.map(
					() =>
						"instr(lower(m.to_addresses_json), ?) > 0 OR instr(lower(m.cc_addresses_json), ?) > 0",
				)
				.join(" OR ")
		: "0";
	const { results: page } = await db
		.prepare(
			`SELECT t.id, t.priority_category, t.user_pinned_category, t.for_person,
				(${MEMBER_MAX_PRIORITY_SQL("t.id")}) AS member_max,
				EXISTS (SELECT 1 FROM emails m WHERE m.thread_id = t.id AND m.direction = 'inbound'
					AND (${mentions})) AS forwarded_member
			 FROM threads t
			 WHERE t.id > ? AND t.latest_message_at >= ?
			 ORDER BY t.id
			 LIMIT ?`,
		)
		.bind(...forwarded.flatMap((a) => [a, a]), opts.after ?? "", opts.since, opts.limit)
		.all<Row>();

	const candidates = page.filter(
		(t) =>
			(t.member_max ?? null) !== (t.priority_category ?? null) ||
			Number(t.forwarded_member) === 1 ||
			t.for_person != null,
	);
	const result: ThreadRecomputePageResult = {
		dry_run: opts.dryRun,
		scanned: page.length,
		changed: 0,
		applied: 0,
		priority_changes: {},
		pinned: 0,
		for_person_changes: {},
		next_after: page.length === opts.limit ? String(page[page.length - 1].id) : null,
		sample: [],
	};

	const timestamp = now();
	for (let i = 0; i < candidates.length; i += 50) {
		const chunk = candidates.slice(i, i + 50);
		const rows = await db.batch<Row>(
			chunk.map((t) => db.prepare(THREAD_CTE_SQL).bind(String(t.id))),
		);
		for (let j = 0; j < chunk.length; j++) {
			const stored = chunk[j];
			const row = rows[j]?.results?.[0];
			const id = String(stored.id);
			const params = row ? buildUpsertParams(id, row, timestamp) : null;
			if (!row || !params) continue; // empty thread: the next member change deletes it
			const priority = row.member_max_priority ? String(row.member_max_priority) : null;
			const forPerson = forPersonOf(row);
			const oldPriority = (stored.priority_category as string | null) ?? null;
			const oldForPerson = (stored.for_person as string | null) ?? null;
			if (priority === oldPriority && forPerson === oldForPerson) continue;
			result.changed++;
			if (priority !== oldPriority) {
				tally(result.priority_changes, oldPriority, priority);
				if (stored.user_pinned_category != null) result.pinned++;
			}
			if (forPerson !== oldForPerson) tally(result.for_person_changes, oldForPerson, forPerson);
			if (result.sample.length < 25) {
				result.sample.push({
					id,
					priority: [oldPriority, priority],
					for_person: [oldForPerson, forPerson],
				});
			}
			if (opts.dryRun) continue;
			await db
				.prepare(THREAD_UPSERT_SQL)
				.bind(...params)
				.run();
			result.applied++;
		}
	}
	return result;
}
