/**
 * Codex classify-queue queries (Phase 1).
 *
 * The Codex CLI sidecar polls POST /api/agent/classify-queue/claim, runs the
 * classifier prompts locally, and posts results back. These helpers own the
 * lease lifecycle (claim → apply/clear) plus the queue stats used by both the
 * stats endpoint and the admin health 'classifier' check.
 *
 * Leases are two-statement: an UPDATE stamps classify_lease_until and a
 * crypto-random classify_leased_by token onto the claimable rows, then a
 * SELECT reads the claimed rows back by token. The token guards every later
 * write so an expired lease re-claimed by another worker can't be clobbered.
 */

import { buildThreadConsistencyLine } from "@/agent/prompts/classify_v2";
import { CONSENT_CURRENT_SQL, consentCurrentParams } from "@/services/ai-consent";
import { refreshThreadSafe } from "@/services/threads-loader";
import type { EmailCategory, InterestLevel } from "@/types";

/** Re-attempt cooldown after a classification attempt (6 hours). */
export const CLASSIFY_QUEUE_RETRY_COOLDOWN_MS = 21_600_000;
/** classify_after fallback when agent_memory has no 'classify_after' key. */
export const CLASSIFY_AFTER_FALLBACK_MS = 1_774_567_864_000;
/** Sidecar state (classify_after, codex_sidecar_last_seen) lives under 'all'. */
export const SIDECAR_WORKSPACE_ID = "all";

const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pending backlog shared by claim, queue stats and the morning report. A lease/cooldown
 * delays a claim but does not remove mail from the backlog waiting to be classified. */
export const CLASSIFY_PENDING_SQL = `e.category IS NULL
           AND e.direction = 'inbound'
           AND e.mailbox_state = 'inbox'
           AND e.received_at > ?`;

/** Upper bound is for cutoff-based report replay; live queue stats remain unbounded. */
export async function countClassifyPending(
	db: D1Database,
	classifyAfter: number,
	until: number,
): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS count FROM emails e
  WHERE ${CLASSIFY_PENDING_SQL} AND e.received_at<=?`)
		.bind(classifyAfter, until)
		.first<{ count: number }>();
	return Number(row?.count || 0);
}

export interface ClaimQueueOptions {
	nowMs: number;
	leaseMs: number;
	classifyAfter: number;
	limit: number;
	leaseToken: string;
}

/**
 * Pure SQL builder for the claim UPDATE — exported so tests can assert the
 * queue conditions without a D1 instance.
 */
export function buildClaimQueueUpdate(opts: ClaimQueueOptions): {
	sql: string;
	params: unknown[];
} {
	const sql = `UPDATE emails
	 SET classify_lease_until = ?, classify_leased_by = ?
	 WHERE id IN (
		SELECT e.id
		 FROM emails e
		 WHERE ${CLASSIFY_PENDING_SQL}
		   AND (e.classify_lease_until IS NULL OR e.classify_lease_until < ?)
		   AND NOT EXISTS (
			SELECT 1 FROM classification_log cl
			 WHERE cl.email_id = e.id
			   AND cl.method IN ('ai', 'codex')
			   AND cl.created_at > ?
		   )
		 ORDER BY e.received_at DESC
		 LIMIT ?
	 )`;
	return {
		sql,
		params: [
			opts.nowMs + opts.leaseMs,
			opts.leaseToken,
			opts.classifyAfter,
			opts.nowMs,
			opts.nowMs - CLASSIFY_QUEUE_RETRY_COOLDOWN_MS,
			opts.limit,
		],
	};
}

export interface ClaimedQueueEmail {
	id: string;
	from_address: string;
	from_name: string | null;
	subject: string | null;
	body_excerpt: string | null;
	/** Lets the sorter turn "within 60 days" into an action_due (v55). */
	received_at: number;
	attachments: { filename: string | null; mime_type: string; size: number }[];
	thread_hint: string | null;
	/** Header addresses for the memory map's address matches; the route strips this field. */
	address_fields: {
		to_address: string | null;
		to_addresses_json: string | null;
		cc_addresses_json: string | null;
		reply_to_addresses_json: string | null;
	};
}

/**
 * Lease up to `limit` claimable emails and return their classification
 * payloads (body excerpt server-truncated to 2000 chars, attachment
 * metadata, thread consistency hint).
 *
 * AI consent (v64) is checked inside the lease UPDATE: it leases nothing unless decision
 * `consentEpoch` is still the newest allowed decision (or epoch 0 with no row). A withdrawal
 * that commits first leaves every row unleased.
 */
export async function claimClassifyQueueEmails(
	db: D1Database,
	opts: ClaimQueueOptions & { consentEpoch: number },
): Promise<ClaimedQueueEmail[]> {
	const { sql, params } = buildClaimQueueUpdate(opts);
	await db
		.prepare(`${sql} AND ${CONSENT_CURRENT_SQL}`)
		.bind(...params, ...consentCurrentParams(opts.consentEpoch))
		.run();

	const { results } = await db
		.prepare(
			`SELECT e.id,
			        e.from_address,
			        e.from_name,
			        e.subject,
			        SUBSTR(e.text_content, 1, 2000) AS body_excerpt,
			        e.received_at,
			        e.to_address,
			        e.to_addresses_json,
			        e.cc_addresses_json,
			        e.reply_to_addresses_json,
			        t.priority_category AS thread_priority_category,
			        t.message_count AS thread_message_count
			 FROM emails e
			 LEFT JOIN threads t ON t.id = e.thread_id
			 WHERE e.classify_leased_by = ?
			 ORDER BY e.received_at DESC`,
		)
		.bind(opts.leaseToken)
		.all();

	const rows = (results ?? []) as {
		id: string;
		from_address: string;
		from_name: string | null;
		subject: string | null;
		body_excerpt: string | null;
		received_at: number;
		to_address: string | null;
		to_addresses_json: string | null;
		cc_addresses_json: string | null;
		reply_to_addresses_json: string | null;
		thread_priority_category: string | null;
		thread_message_count: number | null;
	}[];
	if (rows.length === 0) return [];

	const emailIds = rows.map((row) => row.id);
	const { results: attachmentRows } = await db
		.prepare(
			`SELECT email_id, filename, mime_type, size
			 FROM attachments
			 WHERE email_id IN (${emailIds.map(() => "?").join(", ")})`,
		)
		.bind(...emailIds)
		.all();

	const attachmentMap = new Map<
		string,
		{ filename: string | null; mime_type: string; size: number }[]
	>();
	for (const row of (attachmentRows ?? []) as {
		email_id: string;
		filename: string | null;
		mime_type: string;
		size: number;
	}[]) {
		const list = attachmentMap.get(row.email_id) || [];
		list.push({ filename: row.filename, mime_type: row.mime_type, size: row.size });
		attachmentMap.set(row.email_id, list);
	}

	return rows.map((row) => {
		// Only hint when the thread has a priority and prior content (>1 message).
		const messageCount = Number(row.thread_message_count ?? 0);
		const threadHint =
			row.thread_priority_category && messageCount >= 2
				? buildThreadConsistencyLine({
						priorityCategory: row.thread_priority_category as EmailCategory,
						memberMessageCount: messageCount,
					})
				: null;
		return {
			id: row.id,
			from_address: row.from_address,
			from_name: row.from_name,
			subject: row.subject,
			body_excerpt: row.body_excerpt,
			received_at: Number(row.received_at),
			attachments: attachmentMap.get(row.id) || [],
			thread_hint: threadHint,
			address_fields: {
				to_address: row.to_address,
				to_addresses_json: row.to_addresses_json,
				cc_addresses_json: row.cc_addresses_json,
				reply_to_addresses_json: row.reply_to_addresses_json,
			},
		};
	});
}

export interface LeasedEmailRow {
	id: string;
	from_address: string;
	subject: string | null;
	category: EmailCategory | null;
	list_unsubscribe: string | null;
	/** The body's first 4,000 characters: a code sent in the body is still a code (code-note.ts). */
	text_head: string | null;
}

/** Rows currently leased under this token (fresh category read — user may
 * have categorized an email while the sidecar was working). */
export async function getLeasedEmailsByToken(
	db: D1Database,
	leaseToken: string,
): Promise<Map<string, LeasedEmailRow>> {
	const { results } = await db
		.prepare(
			`SELECT id, from_address, subject, category, list_unsubscribe, substr(text_content, 1, 4000) AS text_head
			 FROM emails WHERE classify_leased_by = ?`,
		)
		.bind(leaseToken)
		.all();

	const map = new Map<string, LeasedEmailRow>();
	for (const row of (results ?? []) as Record<string, unknown>[]) {
		map.set(String(row.id), {
			id: String(row.id),
			from_address: String(row.from_address),
			subject: row.subject == null ? null : String(row.subject),
			category: (row.category as EmailCategory | null) ?? null,
			list_unsubscribe: row.list_unsubscribe == null ? null : String(row.list_unsubscribe),
			text_head: row.text_head == null ? null : String(row.text_head),
		});
	}
	return map;
}

/**
 * Apply a codex classification, guarded by `category IS NULL` — if the user
 * categorized the email while it was leased, the user wins and nothing is
 * written. Clears the lease columns in the same statement. Refreshes the
 * thread aggregate on success (same behavior as updateEmailById).
 * The action note (v55) rides the same guard and never replaces a note an
 * agent or the owner already wrote (SET reads the row's old values).
 *
 * Fenced (v64): the row must still hold this lease and the lease's consent decision must still
 * be the newest allowed decision (or epoch 0 with no row). A withdrawal releases every lease,
 * so a late result writes nothing.
 * `updated: false` with `userWon: false` means the lease or the consent was lost.
 */
export async function applyCodexClassification(
	db: D1Database,
	opts: {
		emailId: string;
		leaseToken: string;
		consentEpoch: number;
		category: EmailCategory;
		subCategory: string | null;
		uncertain: boolean;
		interestLevel: InterestLevel | null;
		actionNote: string | null;
		actionDue: number | null;
	},
): Promise<{ updated: boolean; userWon: boolean }> {
	const { meta } = await db
		.prepare(
			`UPDATE emails
			 SET category = ?,
			     sub_category = ?,
			     classification_uncertain = ?,
			     interest_level = COALESCE(?, interest_level),
			     action_note = COALESCE(action_note, ?),
			     action_due = CASE WHEN action_note IS NULL AND ? IS NOT NULL THEN ? ELSE action_due END,
			     classify_lease_until = NULL,
			     classify_leased_by = NULL
			 WHERE id = ? AND category IS NULL AND classify_leased_by = ? AND ${CONSENT_CURRENT_SQL}`,
		)
		.bind(
			opts.category,
			opts.subCategory,
			opts.uncertain ? 1 : 0,
			opts.interestLevel,
			opts.actionNote,
			opts.actionNote,
			opts.actionNote ? opts.actionDue : null,
			opts.emailId,
			opts.leaseToken,
			...consentCurrentParams(opts.consentEpoch),
		)
		.run();

	const updated = (meta?.changes ?? 0) > 0;
	if (!updated) {
		const row = await db
			.prepare("SELECT category FROM emails WHERE id = ?")
			.bind(opts.emailId)
			.first<{ category: string | null }>();
		return { updated, userWon: row?.category != null };
	}
	const row = await db
		.prepare("SELECT thread_id FROM emails WHERE id = ?")
		.bind(opts.emailId)
		.first<{ thread_id: string | null }>();
	if (row?.thread_id) {
		await refreshThreadSafe(db, String(row.thread_id));
	}
	return { updated, userWon: false };
}

/** Clear the lease without writing a category (error results, user-won rows,
 * model abstentions). Token-guarded so a re-claimed lease isn't released. */
export async function clearClassifyLease(
	db: D1Database,
	emailId: string,
	leaseToken: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE emails
			 SET classify_lease_until = NULL, classify_leased_by = NULL
			 WHERE id = ? AND classify_leased_by = ?`,
		)
		.bind(emailId, leaseToken)
		.run();
}

/** Release every row of one lease (a claim whose consent changed before it answered). */
export async function releaseClassifyLeaseToken(db: D1Database, leaseToken: string): Promise<void> {
	await db
		.prepare(
			"UPDATE emails SET classify_lease_until = NULL, classify_leased_by = NULL WHERE classify_leased_by = ?",
		)
		.bind(leaseToken)
		.run();
}

/** Read the 'classify_after' watermark (workspace 'all'), with fallback. */
export async function getClassifyAfterMs(db: D1Database): Promise<number> {
	const row = await db
		.prepare("SELECT value FROM agent_memory WHERE key = 'classify_after' AND workspace_id = ?")
		.bind(SIDECAR_WORKSPACE_ID)
		.first<{ value: string }>();
	const parsed = row ? Number(row.value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : CLASSIFY_AFTER_FALLBACK_MS;
}

/** Read the codex_sidecar_last_seen heartbeat (workspace 'all'), or null. */
export async function getCodexSidecarLastSeen(db: D1Database): Promise<number | null> {
	const row = await db
		.prepare(
			"SELECT value FROM agent_memory WHERE key = 'codex_sidecar_last_seen' AND workspace_id = ?",
		)
		.bind(SIDECAR_WORKSPACE_ID)
		.first<{ value: string }>();
	const parsed = row ? Number(row.value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

export interface ClassifyQueueStats {
	pending_total: number;
	pending_fresh_48h: number;
	leased: number;
	oldest_fresh_pending_at: number | null;
	last_codex_result_at: number | null;
	codex_results_24h: number;
	codex_tokens_24h: number;
}

export async function getClassifyQueueStats(
	db: D1Database,
	classifyAfter: number,
	nowMs: number,
): Promise<ClassifyQueueStats> {
	const freshCutoff = nowMs - FRESH_WINDOW_MS;
	const dayCutoff = nowMs - DAY_MS;

	const [queueResult, codexResult] = await db.batch([
		db
			.prepare(
				`SELECT COUNT(*) AS pending_total,
				        SUM(CASE WHEN received_at > ? THEN 1 ELSE 0 END) AS pending_fresh_48h,
				        SUM(CASE WHEN classify_lease_until IS NOT NULL AND classify_lease_until > ? THEN 1 ELSE 0 END) AS leased,
				        MIN(CASE WHEN received_at > ? THEN received_at END) AS oldest_fresh_pending_at
				 FROM emails e
				 WHERE ${CLASSIFY_PENDING_SQL}`,
			)
			.bind(freshCutoff, nowMs, freshCutoff, classifyAfter),
		db
			.prepare(
				`SELECT MAX(created_at) AS last_codex_result_at,
				        SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS codex_results_24h,
				        SUM(CASE WHEN created_at > ? THEN COALESCE(haiku_tokens_used, 0) ELSE 0 END) AS codex_tokens_24h
				 FROM classification_log
				 WHERE method = 'codex'`,
			)
			.bind(dayCutoff, dayCutoff),
	]);

	const queue = ((queueResult.results ?? []) as Record<string, unknown>[])[0] ?? {};
	const codex = ((codexResult.results ?? []) as Record<string, unknown>[])[0] ?? {};

	return {
		pending_total: Number(queue.pending_total ?? 0),
		pending_fresh_48h: Number(queue.pending_fresh_48h ?? 0),
		leased: Number(queue.leased ?? 0),
		oldest_fresh_pending_at:
			queue.oldest_fresh_pending_at == null ? null : Number(queue.oldest_fresh_pending_at),
		last_codex_result_at:
			codex.last_codex_result_at == null ? null : Number(codex.last_codex_result_at),
		codex_results_24h: Number(codex.codex_results_24h ?? 0),
		codex_tokens_24h: Number(codex.codex_tokens_24h ?? 0),
	};
}
