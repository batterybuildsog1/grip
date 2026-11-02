import { Hono } from "hono";
import { restrictedPersons } from "@/auth/principal";
import { getConversationDetailByThreadId, getEmailById, getThreadByEmailId } from "@/database/d1";
import { buildMatchSnippetAndSourceExpr, splitSnippetAndSource } from "@/database/fts-snippet";
import {
	applySpelling,
	compileSearch,
	type ParsedSearch,
	QueryInputError,
	type SpellingCorpus,
	stemPrefix,
	suggestSpelling,
} from "@/database/search-query";
import { isThreadsTableReady } from "@/database/tables";
import { restrictedThreadCondition } from "@/middleware/access";
import { applyQuoteSplits } from "@/services/quoted";
import { cleanSnippet } from "@/services/snippet";
import type {
	AppVariables,
	ConversationDetailResponse,
	ConversationFilters,
	ConversationListResponse,
	ConversationParticipant,
	ConversationSearchInfo,
	ConversationSummary,
	Email,
	EmailCategory,
	EmailDirection,
	MailboxState,
} from "@/types";
import { parseTimestamp } from "@/utils/helpers";
import { hydrateHtmlFromR2 } from "@/utils/html-offload";
import { ERR, OK } from "@/utils/http";
import { getConfiguredDomains } from "@/utils/platform";

type Row = Record<string, unknown>;
type SqlConditions = { conditions: string[]; params: unknown[] };

interface ConversationCursor {
	latest_message_at: number;
	id: string;
}

const conversations = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();

function nullableString(value: unknown): string | null {
	if (value == null) return null;
	const stringValue = String(value);
	return stringValue.length > 0 ? stringValue : null;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value == null) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item)).filter((item) => item.length > 0);
	}
	if (typeof value !== "string" || value.trim() === "") return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.map((item) => String(item)).filter((item) => item.length > 0);
		}
	} catch {
		// Fall through to empty result.
	}
	return [];
}

function parseParticipants(namesJson: unknown, addressesJson: unknown): ConversationParticipant[] {
	const names = parseStringArray(namesJson);
	const addresses = parseStringArray(addressesJson);
	const participants: ConversationParticipant[] = [];

	for (let index = 0; index < addresses.length; index += 1) {
		participants.push({
			name: names[index] || null,
			address: addresses[index],
		});
	}

	return participants;
}

function extractSnippetFromEmail(email: Email): string | null {
	const hasText = Boolean(email.text_content?.trim());
	const source = hasText ? email.text_content : email.html_content;
	if (!source) return null;
	return cleanSnippet(source, email.subject, !hasText && Boolean(email.html_content));
}

function mapConversationSummary(row: Row): ConversationSummary {
	const displayToAddresses = parseStringArray(row.display_to_addresses_json);
	const displayCcAddresses = parseStringArray(row.display_cc_addresses_json);
	const displayBccAddresses = parseStringArray(row.display_bcc_addresses_json);
	const displaySnippetIsHtml =
		row.display_snippet_is_html === true ||
		row.display_snippet_is_html === 1 ||
		row.display_snippet_is_html === "1";
	const displaySnippet = cleanSnippet(
		nullableString(row.display_snippet),
		nullableString(row.display_subject ?? row.root_subject),
		displaySnippetIsHtml,
	);
	return {
		id: String(row.id),
		domain: String(row.domain ?? ""),
		subject: nullableString(row.root_subject),
		latest_message_at: Number(row.latest_message_at ?? 0),
		started_at: Number(row.started_at ?? row.latest_message_at ?? 0),
		message_count: Number(row.message_count ?? 0),
		unread_count: Number(row.unread_count ?? 0),
		mailbox_state: String(row.mailbox_state) as MailboxState,
		has_attachments: Boolean(row.has_attachments),
		attachment_count: Number(row.attachment_count ?? 0),
		// Clients fall back here when display_snippet is empty; never resurrect the subject echo.
		snippet:
			row.display_snippet != null
				? displaySnippet
				: cleanSnippet(nullableString(row.snippet), nullableString(row.root_subject)),
		participants: parseParticipants(row.participant_names, row.participant_addresses),
		is_muted: Boolean(row.is_muted),
		is_starred: Boolean(row.is_starred),
		category: row.category == null ? null : (String(row.category) as EmailCategory),
		latest_email_id: row.latest_email_id == null ? null : String(row.latest_email_id),
		display_attachment_names: [],
		display_email_id: row.display_email_id == null ? null : String(row.display_email_id),
		display_mailbox_state:
			row.display_mailbox_state == null
				? null
				: (String(row.display_mailbox_state) as MailboxState),
		display_direction:
			row.display_direction == null ? null : (String(row.display_direction) as EmailDirection),
		display_from_address: nullableString(row.display_from_address),
		display_from_name: nullableString(row.display_from_name),
		display_to_address: nullableString(row.display_to_address),
		display_to_name: null,
		display_to_addresses: displayToAddresses,
		display_cc_addresses: displayCcAddresses,
		display_bcc_addresses: displayBccAddresses,
		display_received_at: row.display_received_at == null ? null : Number(row.display_received_at),
		display_sent_at: row.display_sent_at == null ? null : Number(row.display_sent_at),
		display_snippet: displaySnippet,
		display_snippet_source: row.display_snippet_source === "attachment" ? "attachment" : null,
		display_subject: nullableString(row.display_subject),
	};
}

/** Enrich only authorized, returned anchors; one statement, at most three rows per id. */
async function attachDisplayAttachmentNames(db: D1Database, summaries: ConversationSummary[]) {
	const ids = [
		...new Set(summaries.flatMap((row) => (row.display_email_id ? [row.display_email_id] : []))),
	];
	if (ids.length === 0) return;
	// Scope before ranking with the existing email_id index. A window avoids D1's
	// compound-SELECT limit while returning at most three rows per display message.
	const { results } = await db
		.prepare(
			`SELECT email_id, filename FROM (
				SELECT email_id, filename,
					ROW_NUMBER() OVER (PARTITION BY email_id ORDER BY created_at, id) AS attachment_rank
				FROM attachments
				WHERE email_id IN (${ids.map(() => "?").join(", ")})
					AND filename IS NOT NULL AND filename != ''
					AND NOT (lower(mime_type) LIKE 'image/%' AND
						(lower(trim(COALESCE(disposition, ''))) = 'inline' OR
						 length(trim(COALESCE(content_id, ''))) > 0))
			) WHERE attachment_rank <= 3 ORDER BY email_id, attachment_rank`,
		)
		.bind(...ids)
		.all<{ email_id: string; filename: string }>();
	const names = new Map<string, string[]>();
	for (const row of results ?? []) {
		const list = names.get(row.email_id) ?? [];
		list.push(row.filename);
		names.set(row.email_id, list);
	}
	for (const summary of summaries) {
		summary.display_attachment_names = names.get(summary.display_email_id ?? "") ?? [];
	}
}

/**
 * `display_to_name` for sent and draft rows ("To Ines Carvalho"). Stored recipients are bare
 * addresses (ingest keeps the address; drafts and Send take bare ones), so the name is found here,
 * once for every client: the conversation's participant with that address, else, for a reader of
 * the whole mailbox, the newest From name that address used in the served domains (one statement
 * per page, an index seek per address; a restricted reader gets participants only). Null = none.
 */
async function nameDisplayRecipients(
	db: D1Database,
	summaries: ConversationSummary[],
	domainScope: string[],
	wholeMailbox: boolean,
) {
	const unresolved = new Map<string, ConversationSummary[]>();
	for (const summary of summaries) {
		summary.display_to_name = null;
		const address = summary.display_to_address?.trim().toLowerCase();
		if (summary.display_direction !== "outbound" || !address) continue;
		const known = summary.participants
			.find((p) => p.address.trim().toLowerCase() === address)
			?.name?.trim();
		if (known) summary.display_to_name = known;
		else unresolved.set(address, [...(unresolved.get(address) ?? []), summary]);
	}
	if (!wholeMailbox || unresolved.size === 0) return;
	const domains = domainScope.map((_, index) => `?${index + 2}`).join(", ");
	const { results } = await db
		.prepare(
			`SELECT a.value AS address, (
				SELECT e.from_name FROM emails e
				WHERE e.from_address = a.value AND TRIM(COALESCE(e.from_name, '')) != ''
					${domains ? `AND e.domain IN (${domains})` : ""}
				ORDER BY e.received_at DESC LIMIT 1
			) AS name FROM json_each(?1) a`,
		)
		.bind(JSON.stringify([...unresolved.keys()]), ...domainScope)
		.all<{ address: string; name: string | null }>();
	for (const row of results ?? []) {
		const name = row.name?.trim();
		if (!name) continue;
		for (const summary of unresolved.get(row.address) ?? []) summary.display_to_name = name;
	}
}

function applyDisplayEmailToSummary(
	summary: ConversationSummary,
	email: Email,
): ConversationSummary {
	const snippet = extractSnippetFromEmail(email);
	return {
		...summary,
		snippet,
		display_email_id: email.id,
		display_mailbox_state: email.mailbox_state,
		display_direction: email.direction,
		display_from_address: email.from_address,
		display_from_name: email.from_name ?? null,
		display_to_address: email.to_address || null,
		display_to_name: null,
		display_to_addresses: email.to_addresses ?? [],
		display_cc_addresses: email.cc_addresses ?? [],
		display_bcc_addresses: email.bcc_addresses ?? [],
		display_received_at: email.received_at,
		display_sent_at: email.sent_at ?? null,
		display_snippet: snippet,
		// Body-derived snippet replaces whatever the FTS search produced, so any
		// stale 'attachment' discriminator must be cleared with it.
		display_snippet_source: null,
	};
}

function buildConversationSummaryFromEmails(
	threadId: string,
	emails: Email[],
): ConversationSummary | null {
	if (emails.length === 0) return null;

	const sorted = [...emails].sort((left, right) => {
		const leftAt = left.sent_at ?? left.received_at;
		const rightAt = right.sent_at ?? right.received_at;
		return leftAt - rightAt;
	});

	const latest = sorted[sorted.length - 1];
	const earliest = sorted[0];
	const participantMap = new Map<string, ConversationParticipant>();
	let unreadCount = 0;
	let hasAttachments = false;
	let attachmentCount = 0;
	let mailboxState: MailboxState = "trash";

	for (const email of sorted) {
		if (!participantMap.has(email.from_address)) {
			participantMap.set(email.from_address, {
				name: email.from_name ?? null,
				address: email.from_address,
			});
		}

		// Collect recipients
		for (const toAddr of email.to_addresses ?? []) {
			const normalized = toAddr.toLowerCase().trim();
			if (normalized && !participantMap.has(normalized)) {
				participantMap.set(normalized, {
					name: null,
					address: toAddr,
				});
			}
		}
		for (const ccAddr of email.cc_addresses ?? []) {
			const normalized = ccAddr.toLowerCase().trim();
			if (normalized && !participantMap.has(normalized)) {
				participantMap.set(normalized, {
					name: null,
					address: ccAddr,
				});
			}
		}

		if (email.direction === "inbound" && email.read_at == null) {
			unreadCount += 1;
		}

		hasAttachments ||= email.has_attachments;
		attachmentCount += email.attachment_count ?? 0;

		if (email.mailbox_state === "inbox") {
			mailboxState = "inbox";
		} else if (mailboxState !== "inbox" && email.mailbox_state === "sent") {
			mailboxState = "sent";
		} else if (
			mailboxState !== "inbox" &&
			mailboxState !== "sent" &&
			email.mailbox_state === "draft"
		) {
			mailboxState = "draft";
		} else if (
			mailboxState !== "inbox" &&
			mailboxState !== "sent" &&
			mailboxState !== "draft" &&
			email.mailbox_state === "archived"
		) {
			mailboxState = "archived";
		}
	}

	const latestAt = latest.sent_at ?? latest.received_at;
	const startedAt = earliest.sent_at ?? earliest.received_at;

	return {
		id: threadId,
		domain: latest.domain,
		subject: earliest.subject ?? latest.subject ?? null,
		latest_message_at: latestAt,
		started_at: startedAt,
		message_count: sorted.length,
		unread_count: unreadCount,
		mailbox_state: mailboxState,
		has_attachments: hasAttachments,
		attachment_count: attachmentCount,
		snippet: extractSnippetFromEmail(latest),
		participants: [...participantMap.values()],
		is_muted: false,
		is_starred: false,
		category: latest.category ?? null,
		latest_email_id: latest.id,
		display_attachment_names: [],
		display_email_id: latest.id,
		display_mailbox_state: latest.mailbox_state,
		display_direction: latest.direction,
		display_from_address: latest.from_address,
		display_from_name: latest.from_name ?? null,
		display_to_address: latest.to_address || null,
		display_to_name: null,
		display_to_addresses: latest.to_addresses ?? [],
		display_cc_addresses: latest.cc_addresses ?? [],
		display_bcc_addresses: latest.bcc_addresses ?? [],
		display_received_at: latest.received_at,
		display_sent_at: latest.sent_at ?? null,
		display_snippet: extractSnippetFromEmail(latest),
	};
}

const VALID_SORTS: ReadonlySet<string> = new Set([
	"latest_desc",
	"latest_asc",
	"sender",
	"subject",
	"unread_first",
]);

function parseConversationFilters(query: Record<string, string | undefined>): ConversationFilters {
	const limitRaw = Number(query.limit ?? 50);
	const offsetRaw = Number(query.offset ?? 0);
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 50;
	const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

	let category: EmailCategory | null | undefined;
	if (query.category === undefined) {
		category = undefined;
	} else if (query.category === "" || query.category === "null") {
		category = null;
	} else {
		category = query.category as EmailCategory;
	}

	const sortRaw = query.sort?.trim();
	const sort =
		sortRaw && VALID_SORTS.has(sortRaw) ? (sortRaw as ConversationFilters["sort"]) : undefined;

	const interestRaw = query.interest_level?.trim();
	const interest_level = isValidInterestLevelQuery(interestRaw)
		? (interestRaw as ConversationFilters["interest_level"])
		: undefined;

	const lower = (value: string | undefined) => value?.trim().toLowerCase() || undefined;
	const direction = query.direction?.trim();
	return {
		domain: lower(query.domain),
		account: lower(query.account),
		from: lower(query.from),
		to: lower(query.to),
		direction: direction === "inbound" || direction === "outbound" ? direction : undefined,
		scope:
			query.scope?.trim() === "view" ? "view" : query.scope?.trim() === "all" ? "all" : undefined,
		mailbox_state: (query.mailbox_state?.trim() || undefined) as MailboxState | undefined,
		category,
		q: query.q?.trim() || undefined,
		after: query.after ? (parseTimestamp(query.after) ?? undefined) : undefined,
		before: query.before ? (parseTimestamp(query.before) ?? undefined) : undefined,
		has_attachments: parseBoolean(query.has_attachments),
		is_read: parseBoolean(query.is_read),
		self: parseBoolean(query.self),
		interest_level,
		sub_category: query.sub_category?.trim() || undefined,
		for_person: query.for_person?.trim() || undefined,
		limit,
		offset,
		cursor: query.cursor?.trim() || undefined,
		sort,
	};
}

function isValidInterestLevelQuery(value: string | undefined): boolean {
	return (
		value === "very_interested" ||
		value === "interested" ||
		value === "somewhat_interested" ||
		value === "not_interested"
	);
}

/** Returns the ORDER BY fragment for a given sort mode (thread list). */
function buildConversationSortOrder(sort: ConversationFilters["sort"] | undefined): string {
	switch (sort) {
		case "latest_asc":
			return "ORDER BY t.latest_message_at ASC, t.id ASC";
		case "sender": {
			// Sort by the sender SHOWN in the row: for outbound (Sent) rows that's
			// the recipient; otherwise the from-name, falling back to from-address.
			// Reads display_email (the thread's anchor email, joined via
			// buildDisplayAnchorJoin). Blank/NULL keys sort last; ties break by recency.
			const key =
				"LOWER(CASE WHEN display_email.direction = 'outbound' " +
				"THEN COALESCE(NULLIF(display_email.to_address, ''), '') " +
				"ELSE COALESCE(NULLIF(display_email.from_name, ''), NULLIF(display_email.from_address, ''), '') END)";
			return `ORDER BY CASE WHEN ${key} = '' THEN 1 ELSE 0 END ASC, ${key} ASC, t.latest_message_at DESC, t.id DESC`;
		}
		case "subject":
			// Blank/NULL subjects sort last; ties break by recency.
			return "ORDER BY CASE WHEN t.root_subject IS NULL OR TRIM(t.root_subject) = '' THEN 1 ELSE 0 END ASC, LOWER(t.root_subject) ASC, t.latest_message_at DESC, t.id DESC";
		case "unread_first":
			// Unread threads first (most-unread first), then newest.
			return "ORDER BY (t.unread_count > 0) DESC, t.unread_count DESC, t.latest_message_at DESC, t.id DESC";
		default:
			return "ORDER BY t.latest_message_at DESC, t.id DESC";
	}
}

function encodeConversationCursor(cursor: ConversationCursor): string {
	return encodeURIComponent(JSON.stringify(cursor));
}

function decodeConversationCursor(cursor: string | undefined): ConversationCursor | null {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(decodeURIComponent(cursor)) as ConversationCursor;
		if (
			typeof parsed.latest_message_at !== "number" ||
			!Number.isFinite(parsed.latest_message_at) ||
			typeof parsed.id !== "string" ||
			parsed.id.length === 0
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function buildConversationCursorClause(cursor?: string): { condition: string; params: unknown[] } {
	const parsed = decodeConversationCursor(cursor);
	if (!parsed) {
		return { condition: "", params: [] };
	}

	return {
		condition: "(t.latest_message_at < ? OR (t.latest_message_at = ? AND t.id < ?))",
		params: [parsed.latest_message_at, parsed.latest_message_at, parsed.id],
	};
}

function combineConversationWhere(where: string, cursorCondition: string): string {
	if (!cursorCondition) return where;
	if (!where) return `WHERE ${cursorCondition}`;
	return `${where} AND ${cursorCondition}`;
}

function buildConversationWhere(
	filters: ConversationFilters,
	domainScope: string[],
	options: {
		/** Conversations with at least one message meeting all these conditions (alias `member`). */
		member?: SqlConditions;
		excludeFtsQuery?: string | null;
		excludeSpam?: boolean;
	} = {},
) {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (domainScope.length > 0) {
		// Several allowed domains cover most mail: the unary + keeps the
		// planner off the domain index, which made it sort every thread instead of
		// walking newest-first (1 s for "-newsletter").
		const column = domainScope.length > 1 ? "+t.domain" : "t.domain";
		conditions.push(`${column} IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	if (filters.mailbox_state) {
		conditions.push(
			"EXISTS (SELECT 1 FROM emails member WHERE member.thread_id = t.id AND member.mailbox_state = ?)",
		);
		params.push(filters.mailbox_state);
	}
	if (filters.domain) {
		conditions.push("t.domain = ?");
		params.push(filters.domain);
	}
	if (filters.category !== undefined) {
		// Phase 1.2: priority-pinned category with manual-override precedence.
		if (filters.category === null) {
			conditions.push("COALESCE(t.user_pinned_category, t.priority_category, t.category) IS NULL");
		} else {
			conditions.push("COALESCE(t.user_pinned_category, t.priority_category, t.category) = ?");
			params.push(filters.category);
		}
	}
	// A restricted user (ticket 09) sees only their persons' threads holding no draft.
	if (filters.for_persons) {
		const restricted = restrictedThreadCondition(filters.for_persons);
		conditions.push(`(${restricted.sql})`);
		params.push(...restricted.params);
	}
	// Person lane (v54, 2026-10-14): a forwarded-in person's threads leave every
	// category view, Personal included, and are listed only by for_person. All and the
	// sidebar search (which drops the category) still show them.
	if (filters.for_person) {
		conditions.push("t.for_person = ?");
		params.push(filters.for_person);
	} else if (typeof filters.category === "string" && !filters.for_persons) {
		conditions.push("t.for_person IS NULL");
	}
	if (options.member) {
		const memberWhere = options.member.conditions.length
			? ` AND ${options.member.conditions.join(" AND ")}`
			: "";
		conditions.push(
			`EXISTS (SELECT 1 FROM emails member WHERE member.thread_id = t.id${memberWhere})`,
		);
		params.push(...options.member.params);
	}
	// Free text (filters.q) is searchConversations' job; negation-only queries arrive here.
	if (options.excludeFtsQuery) {
		// Negation-only search: leave out conversations with any message matching
		// the negated terms. The matching rowids are one set; each listed
		// conversation's members are checked against it (reading thread_id for
		// every match took 1.6 s for -newsletter, review F9).
		conditions.push(
			`NOT EXISTS (
				SELECT 1 FROM emails x
				WHERE x.thread_id = t.id
					AND x.rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)
			)`,
		);
		params.push(options.excludeFtsQuery);
	}
	if (options.excludeSpam) {
		// Search leaves Spam out unless asked (NULL category is kept: IS NOT).
		conditions.push(
			"COALESCE(t.user_pinned_category, t.priority_category, t.category) IS NOT 'spam'",
		);
	}
	if (typeof filters.has_attachments === "boolean") {
		conditions.push("t.has_attachments = ?");
		params.push(filters.has_attachments ? 1 : 0);
	}
	if (typeof filters.is_read === "boolean") {
		conditions.push(filters.is_read ? "t.unread_count = 0" : "t.unread_count > 0");
	}
	if (filters.self === true) {
		// Phase 1.3: Emails-to-self sub-folder. A thread qualifies when it has
		// at least one message where the user wrote to themselves (from equals
		// to). The domainScope filter above already restricts this to the
		// user's configured mailboxes, so we don't need an additional ownership
		// check here.
		conditions.push(
			`EXISTS (
				SELECT 1 FROM emails e_self
				WHERE e_self.thread_id = t.id
					AND e_self.from_address IS NOT NULL
					AND e_self.from_address = e_self.to_address
			)`,
		);
	}
	if (filters.interest_level) {
		// Phase 3.2: Interest sub-filter under Marketing / Newsletters. A
		// thread qualifies when its latest email has the matching
		// interest_level. Keyed off the latest-email row so sub-folders
		// reflect the most recent signal.
		conditions.push(
			`EXISTS (
				SELECT 1 FROM emails e_int
				WHERE e_int.id = t.latest_email_id
					AND e_int.interest_level = ?
			)`,
		);
		params.push(filters.interest_level);
	}
	if (filters.sub_category) {
		// Phase 4: sub-category sub-filter for Billing / Notifications /
		// Agents / Home Alerts. Keyed off priority_sub_category on the
		// thread, which mirrors the latest email's sub_category. A comma list
		// matches any of them (the Money view: failed_payments,invoice_conversations).
		const subs = filters.sub_category
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
		if (subs.length > 0) {
			conditions.push(`t.priority_sub_category IN (${subs.map(() => "?").join(", ")})`);
			params.push(...subs);
		}
	}
	if (filters.after != null && Number.isFinite(filters.after)) {
		conditions.push("t.latest_message_at >= ?");
		params.push(filters.after);
	}
	if (filters.before != null && Number.isFinite(filters.before)) {
		conditions.push("t.latest_message_at <= ?");
		params.push(filters.before);
	}

	return {
		where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
		params,
	};
}

/**
 * The message a list row is shown through: the newest member meeting `anchor`
 * (a mailbox state, or the member conditions that qualified the conversation,
 * review F2), else the conversation's latest message.
 */
function buildDisplayAnchorJoin(anchor?: MailboxState | SqlConditions | null): {
	sql: string;
	params: unknown[];
} {
	const member =
		typeof anchor === "string"
			? { conditions: ["member.mailbox_state = ?"], params: [anchor] }
			: anchor && anchor.conditions.length > 0
				? anchor
				: null;
	if (member) {
		return {
			sql: `LEFT JOIN emails display_email ON display_email.id = (
				SELECT member.id
				FROM emails member
				WHERE member.thread_id = t.id
					AND ${member.conditions.join(" AND ")}
				ORDER BY COALESCE(member.sent_at, member.received_at) DESC, member.id DESC
				LIMIT 1
			)`,
			params: member.params,
		};
	}

	return {
		sql: "LEFT JOIN emails display_email ON display_email.id = t.latest_email_id",
		params: [],
	};
}

function buildConversationListSelect(
	where: string,
	suffix: string,
	anchorOn?: MailboxState | SqlConditions | null,
	source = "threads",
) {
	const anchor = buildDisplayAnchorJoin(anchorOn);
	return `SELECT
			t.id,
			t.domain,
			t.root_subject,
			t.latest_message_at,
			t.started_at,
			t.message_count,
			t.unread_count,
			t.mailbox_state,
			t.has_attachments,
			t.attachment_count,
			t.snippet,
			t.participant_names,
			t.participant_addresses,
			t.is_muted,
			t.is_starred,
			COALESCE(t.user_pinned_category, t.priority_category, t.category) AS category,
			t.latest_email_id,
			display_email.id AS display_email_id,
			display_email.subject AS display_subject,
			display_email.mailbox_state AS display_mailbox_state,
			display_email.direction AS display_direction,
			display_email.from_address AS display_from_address,
			display_email.from_name AS display_from_name,
			display_email.to_address AS display_to_address,
			display_email.to_addresses_json AS display_to_addresses_json,
			display_email.cc_addresses_json AS display_cc_addresses_json,
			display_email.bcc_addresses_json AS display_bcc_addresses_json,
			display_email.received_at AS display_received_at,
			display_email.sent_at AS display_sent_at,
			CASE
				WHEN display_email.text_content IS NOT NULL AND TRIM(display_email.text_content) != ''
				THEN SUBSTR(
					TRIM(REPLACE(REPLACE(display_email.text_content, CHAR(10), ' '), CHAR(13), ' ')),
					1,
					2000
				)
				WHEN display_email.html_content IS NOT NULL AND TRIM(display_email.html_content) != ''
				THEN SUBSTR(
					TRIM(REPLACE(REPLACE(display_email.html_content, CHAR(10), ' '), CHAR(13), ' ')),
					1,
					2000
				)
				ELSE NULL
			END AS display_snippet,
			CASE
				WHEN display_email.text_content IS NOT NULL AND TRIM(display_email.text_content) != ''
				THEN 0
				WHEN display_email.html_content IS NOT NULL AND TRIM(display_email.html_content) != ''
				THEN 1
				ELSE 0
			END AS display_snippet_is_html
		FROM ${source} t
		${anchor.sql}
		${where}
		${suffix}`;
}

/** View filters: what the sidebar selection adds. Search ignores them unless scope=view. */
const VIEW_FILTER_KEYS = [
	"category",
	"sub_category",
	"interest_level",
	"self",
	"for_person",
	"mailbox_state",
	"is_read",
] as const;

interface MessageScope {
	account?: string;
	domain?: string;
	from?: string;
	to?: string;
	direction?: EmailDirection;
	mailbox_state?: MailboxState;
	exclude_trash?: boolean;
	is_read?: boolean;
	has_attachments?: boolean;
	after?: number;
	before?: number;
}

/**
 * Per-message conditions over `emails <alias>`: our account or domain, exact
 * sender/recipient, direction, state, read state, attachments, dates. A
 * conversation is a search hit when one of its messages satisfies all of them
 * (Gmail's account semantics: an example.org message in a conversation that
 * started on example.com is found under example.org).
 */
function buildMessageScope(alias: string, scope: MessageScope): SqlConditions {
	const conditions: string[] = [];
	const params: unknown[] = [];
	const add = (sql: string, ...values: unknown[]) => {
		conditions.push(sql);
		params.push(...values);
	};
	if (scope.account) {
		const at = scope.account.lastIndexOf("@");
		add(
			`${alias}.domain = ? AND ${alias}.mailbox = ?`,
			scope.account.slice(at + 1),
			scope.account.slice(0, at),
		);
	} else if (scope.domain) add(`${alias}.domain = ?`, scope.domain);
	if (scope.from) add(`${alias}.from_address = ?`, scope.from);
	if (scope.to) add(`${alias}.to_address = ?`, scope.to);
	if (scope.direction) add(`${alias}.direction = ?`, scope.direction);
	if (scope.mailbox_state) add(`${alias}.mailbox_state = ?`, scope.mailbox_state);
	else if (scope.exclude_trash) conditions.push(`${alias}.mailbox_state != 'trash'`);
	if (typeof scope.is_read === "boolean")
		conditions.push(scope.is_read ? `${alias}.read_at IS NOT NULL` : `${alias}.read_at IS NULL`);
	if (typeof scope.has_attachments === "boolean")
		add(`${alias}.has_attachments = ?`, scope.has_attachments ? 1 : 0);
	if (scope.after != null) add(`${alias}.received_at >= ?`, scope.after);
	if (scope.before != null) add(`${alias}.received_at <= ?`, scope.before);
	return { conditions, params };
}

async function getConversationList(
	db: D1Database,
	filters: ConversationFilters,
	domainScope: string[] = [],
): Promise<ConversationListResponse> {
	const limit = Math.max(filters.limit, 1);
	const offset = Math.max(filters.offset, 0);
	if (!(await isThreadsTableReady(db))) return pageResponse([], limit, offset, 0);
	if (filters.q) return searchConversations(db, filters, domainScope);
	// Browse: the view's filters, newest first.
	const member = buildMessageScope("member", {
		account: filters.account,
		from: filters.from,
		to: filters.to,
		direction: filters.direction,
		// Browse and its display anchor use the same live member, never a stale
		// projection state or a trashed latest message of an otherwise live thread.
		exclude_trash: !filters.mailbox_state,
	});
	const rows = await listConversationRows(db, filters, domainScope, {
		member,
		excludeSpam: filters.category !== "spam" && filters.mailbox_state !== "trash",
	});
	return pageResponse(rows, limit, offset, -1, isCursorSort(filters.sort));
}

/** The cursor encodes (latest_message_at, id): it pages only the default newest-first order. */
function isCursorSort(sort: ConversationFilters["sort"]): boolean {
	return sort === undefined || sort === "latest_desc";
}

/** Conversation rows for a list (no ranking): LIMIT+1 rows so has_more is known. */
async function listConversationRows(
	db: D1Database,
	listFilters: ConversationFilters,
	domainScope: string[],
	options: { member?: SqlConditions; excludeFtsQuery?: string | null; excludeSpam?: boolean },
): Promise<Row[]> {
	const limit = Math.max(listFilters.limit, 1);
	const offset = Math.max(listFilters.offset, 0);
	// ONE member predicate (account/sender/state/...) both qualifies a conversation
	// and picks the message it is shown through, so a conversation can't qualify on
	// one message's state and another message's account and then show nothing
	// (re-review R2).
	const anchor: SqlConditions = {
		conditions: [...(options.member?.conditions ?? [])],
		params: [...(options.member?.params ?? [])],
	};
	if (listFilters.mailbox_state) {
		anchor.conditions.push("member.mailbox_state = ?");
		anchor.params.push(listFilters.mailbox_state);
	}
	const { where, params } = buildConversationWhere(
		{ ...listFilters, mailbox_state: undefined },
		domainScope,
		{ ...options, member: anchor },
	);
	const sortOrder = buildConversationSortOrder(listFilters.sort);
	// Other sorts page by offset (pageResponse returns no cursor for them).
	const cursor = buildConversationCursorClause(listFilters.cursor);
	const useCursor = Boolean(listFilters.cursor) && isCursorSort(listFilters.sort);
	const pageWhere = useCursor ? combineConversationWhere(where, cursor.condition) : where;
	const pageLimit = useCursor ? "LIMIT ?" : "LIMIT ? OFFSET ?";
	const pageParams = useCursor
		? [...params, ...cursor.params, limit + 1]
		: [...params, limit + 1, offset];
	// Pick the page of conversations first, then find each one's display message:
	// the correlated anchor otherwise runs for every conversation scanned, not
	// just the 51 kept (700 ms for has:attachment). The sender sort orders by the
	// display message, so it keeps the one-step form.
	const statement =
		listFilters.sort === "sender"
			? db
					.prepare(buildConversationListSelect(pageWhere, `${sortOrder} ${pageLimit}`, anchor))
					.bind(...anchor.params, ...pageParams)
			: db
					.prepare(
						buildConversationListSelect(
							"",
							sortOrder,
							anchor,
							`(SELECT * FROM threads t ${pageWhere} ${sortOrder} ${pageLimit})`,
						),
					)
					.bind(...pageParams, ...anchor.params);
	// No COUNT(*): callers report total -1 ("50+") and derive has_more from LIMIT+1.
	return ((await statement.all()).results ?? []) as Row[];
}

function pageResponse(
	rows: Row[],
	limit: number,
	offset: number,
	total: number,
	cursorPaging = true,
): ConversationListResponse {
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = pageRows[pageRows.length - 1];
	return {
		conversations: pageRows.map(mapConversationSummary),
		total,
		limit,
		offset,
		// Without a cursor, has_more tells the client to page by offset.
		next_cursor:
			hasMore && lastRow && cursorPaging
				? encodeConversationCursor({
						latest_message_at: Number(lastRow.latest_message_at ?? 0),
						id: String(lastRow.id),
					})
				: null,
		has_more: hasMore,
	};
}

/** Ranked search returns at most this many conversations (offset + limit). */
const SEARCH_RESULT_CAP = 50;
/**
 * Ranking reads at most the newest RANK_WINDOW authorized matches by message date
 * (bm25 over every match of a very common word like "the" takes seconds of D1 time). A
 * global count gate was removed: it rejected narrow searches and told a
 * restricted user how much mail they can't see matched (re-review R1).
 * Results depend only on in-scope mail; past the window, older matches of a
 * very common word are not ranked. Work still grows with the matches the FTS
 * index walks, so the time is not scope-independent.
 */
const RANK_WINDOW = 20_000;
/** FTS candidates ranked before grouping into conversations (D1 CPU budget). */
const SEARCH_CANDIDATES = 2000;
/**
 * A match whose subject holds every query word ranks as if twice as relevant:
 * the title says what a conversation is about; a body mention is often
 * incidental. No recency term: dividing bm25 by age buried older exact matches
 * (a relevance benchmark scored clearly better without it).
 */
const SUBJECT_MATCH_BONUS = 2;
/**
 * Person-name boost: a one-word query like "nadia" otherwise ranks mail ABOUT
 * the person (subject weight 6) above mail FROM/TO them (address weight 2).
 * Matches from/to that name get a bonus far above the bm25 range (~1-20).
 */
const PARTICIPANT_BOOST = 1000;
const NAME_BOOST_SKIP = new Set(
	"gmail outlook yahoo icloud com io ai net org info support billing invoice receipt noreply donotreply notification notifications admin sales team hello contact mail email".split(
		" ",
	),
);

/**
 * Search: All Mail by default (2026-10-22: Gmail's behaviour; a chip
 * narrows to the view with scope=view). Text is ranked by column-weighted BM25
 * per matching message; each conversation is represented by its best match.
 * A first page with fewer than 3 results gets a spelling check; with none, the
 * corrected query runs once and the response says so (search.corrected_from).
 */
async function searchConversations(
	db: D1Database,
	filters: ConversationFilters,
	domainScope: string[],
): Promise<ConversationListResponse> {
	const query = filters.q ?? "";
	const scope = filters.scope ?? "all";
	const viewFilters: Record<string, string | boolean> = {};
	if (scope === "all") {
		for (const key of VIEW_FILTER_KEYS) {
			const value = filters[key];
			if (value !== undefined && value !== null) viewFilters[key] = value as string | boolean;
		}
	}
	const parsed = compileSearch(query);
	const search: ConversationSearchInfo = {
		query,
		interpreted: parsed.interpreted,
		scope,
		...(Object.keys(viewFilters).length > 0 ? { view_filters: viewFilters } : {}),
	};
	const plan = planSearch(filters, domainScope, parsed);

	if (!parsed.fts.match) {
		// Operator-only ('in:sent') or negation-only ('-newsletter'): nothing to rank
		// by, so list the matching conversations newest first, cursor-paged.
		const rows = await listConversationRows(
			db,
			{
				...plan.threadFilters,
				limit: filters.limit,
				offset: filters.offset,
				cursor: filters.cursor,
			},
			domainScope,
			{ member: plan.member, excludeFtsQuery: parsed.fts.exclude, excludeSpam: plan.excludeSpam },
		);
		return { ...pageResponse(rows, Math.max(filters.limit, 1), filters.offset, -1), search };
	}

	if (filters.cursor) {
		throw new QueryInputError("INVALID_CURSOR", "Ranked search pages by offset, not cursor.");
	}
	const offset = Math.max(filters.offset, 0);
	if (offset >= SEARCH_RESULT_CAP) return { ...pageResponse([], 1, offset, -1), search };
	const limit = Math.max(Math.min(filters.limit, SEARCH_RESULT_CAP - offset), 1);
	let rows = await runRankedSearch(db, parsed, plan, limit, offset);
	if (offset === 0 && rows.length < 3 && parsed.words.length > 0) {
		const fixes = await suggestSpelling(db, parsed.words, spellingCorpus(plan));
		if (fixes.size > 0) {
			const corrected = applySpelling(query, fixes);
			// The retry runs its OWN plan: a fix can create a date phrase ("from septembr").
			let retry: ParsedSearch | null = null;
			if (rows.length === 0) {
				try {
					retry = compileSearch(corrected);
				} catch {
					retry = null;
				}
			}
			const retryRows = retry?.fts.match
				? await runRankedSearch(db, retry, planSearch(filters, domainScope, retry), limit, offset)
				: [];
			if (retry && retryRows.length > 0) {
				rows = retryRows;
				search.corrected_from = query;
				search.query = corrected;
				search.interpreted = retry.interpreted;
			} else search.suggestion = corrected;
		}
	}
	// Ranked pages are offset pages: no cursor past the cap.
	const page = pageResponse(rows, limit, offset, -1);
	const more = page.has_more === true && offset + limit < SEARCH_RESULT_CAP;
	return { ...page, has_more: more, next_cursor: null, search };
}

/**
 * The corpus this search may draw words from: every message and conversation
 * condition of the plan (account, domain, state, dates, attachments, category,
 * the allowed domains and a restricted user's persons), so a spelling
 * suggestion never comes from mail the caller can't search (review F1).
 */
function spellingCorpus(plan: SearchPlan): SpellingCorpus {
	const message = buildMessageScope("cand", plan.messageScope);
	const thread = buildConversationWhere(plan.threadFilters, plan.domainScope, {
		excludeSpam: plan.excludeSpam,
	});
	const threadSql = thread.where.replace(/^WHERE /, "");
	return {
		joins: `CROSS JOIN emails cand ON cand.rowid = emails_fts.rowid${threadSql ? " CROSS JOIN threads t ON t.id = cand.thread_id" : ""}`,
		conditions: [...message.conditions, ...(threadSql ? [threadSql] : [])],
		params: [...message.params, ...thread.params],
	};
}

interface SearchPlan {
	/** The caller's allowed domains (route-set): authorization before the cuts. */
	workspaceDomains?: string[];
	/** Per-message conditions applied to every candidate message. */
	messageScope: MessageScope;
	member: SqlConditions;
	/** Conversation-level filters (category; the rest of the view when scope=view). */
	threadFilters: ConversationFilters;
	excludeSpam: boolean;
	domainScope: string[];
}

function planSearch(
	filters: ConversationFilters,
	domainScope: string[],
	parsed: ParsedSearch,
): SearchPlan {
	const ops = parsed.filters;
	const view = filters.scope === "view";
	const category = ops.category ?? (view ? filters.category : undefined);
	const later = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.max(a, b));
	const earlier = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.min(a, b));
	const messageScope: MessageScope = {
		account: filters.account,
		domain: filters.domain,
		from: filters.from,
		to: filters.to,
		direction: filters.direction,
		mailbox_state: ops.mailbox_state ?? (view ? filters.mailbox_state : undefined),
		// Trash and Spam are left out unless asked for (in:trash, in:anywhere, category:spam).
		exclude_trash: !ops.anywhere,
		is_read: ops.is_read,
		has_attachments: ops.has_attachment ?? filters.has_attachments,
		after: later(filters.after, ops.after),
		before: earlier(filters.before, ops.before),
	};
	return {
		messageScope,
		member: buildMessageScope("member", messageScope),
		threadFilters: {
			category: category as ConversationFilters["category"],
			for_persons: filters.for_persons,
			// Cheap index-side prefilter: a member with attachments implies the thread has them.
			...(messageScope.has_attachments === true ? { has_attachments: true } : {}),
			limit: filters.limit,
			offset: 0,
			...(view
				? {
						sub_category: filters.sub_category,
						interest_level: filters.interest_level,
						self: filters.self,
						for_person: filters.for_person,
						is_read: filters.is_read,
					}
				: {}),
		},
		excludeSpam: !ops.anywhere && category !== "spam",
		domainScope,
		workspaceDomains: filters.for_domains,
	};
}

async function runRankedSearch(
	db: D1Database,
	parsed: ParsedSearch,
	plan: SearchPlan,
	limit: number,
	offset: number,
): Promise<Row[]> {
	// Every parameter is numbered (?N) so values used twice bind once.
	const values: unknown[] = [];
	const bind = (value: unknown) => {
		values.push(value);
		return `?${values.length}`;
	};
	const numbered = (sql: string, params: unknown[]) => {
		let i = 0;
		const out = sql.replace(/\?(?!\d)/g, () => bind(params[i++]));
		if (i !== params.length) throw new Error("search: parameter count mismatch");
		return out;
	};
	const and = (clause: SqlConditions) =>
		clause.conditions.length > 0
			? ` AND ${numbered(clause.conditions.join(" AND "), clause.params)}`
			: "";

	const match = bind(parsed.fts.match);
	// Every message condition, and a restricted user's persons, apply BEFORE the
	// candidate cap, so 2,000 stronger matches they can't see (or without
	// attachments, for has:attachment) can't starve their results (review F10).
	// Columns stored after the bodies (has_attachments, thread_id) cost an
	// overflow read per match; RANK_WINDOW bounds how many are kept.
	const early = and(buildMessageScope("cand", plan.messageScope));
	// Authorization (a restricted user's persons; the caller's allowed domains)
	// applies before BOTH cuts, so mail outside it can't push authorized matches
	// out of the window or the candidate list (re-reviews R1, P1, pass 4).
	const persons = plan.threadFilters.for_persons;
	const restricted = persons ? restrictedThreadCondition(persons) : null;
	const authConditions: string[] = [];
	if (restricted) authConditions.push(numbered(restricted.sql, restricted.params));
	const workspace = plan.workspaceDomains ?? [];
	if (workspace.length > 0) {
		authConditions.push(
			numbered(`t.domain IN (${workspace.map(() => "?").join(", ")})`, workspace),
		);
	}
	const authJoin =
		authConditions.length > 0
			? ` CROSS JOIN threads t ON t.id = cand.thread_id AND ${authConditions.join(" AND ")}`
			: "";
	const thread = buildConversationWhere(plan.threadFilters, plan.domainScope, {
		excludeSpam: plan.excludeSpam,
	});
	const threadWhere = thread.where
		? ` AND ${numbered(thread.where.replace(/^WHERE /, ""), thread.params)}`
		: "";

	// One plain word ("nadia"): boost conversations with that person.
	const fts = parsed.fts.match as string;
	const single =
		parsed.words.length === 1 && !fts.includes(" AND ") && !fts.includes(" NOT ")
			? parsed.words[0]
			: null;
	const boostWord =
		single &&
		single.length >= 3 &&
		!NAME_BOOST_SKIP.has(single) &&
		!(plan.workspaceDomains ?? plan.domainScope).some((d) => d.split(".").includes(single))
			? single
			: null;
	const lit = (w: string) => w.replace(/[\\%_]/g, "\\$&"); // LIKE ... ESCAPE '\'
	const like = (column: string, pattern: string) => `${column} LIKE ${bind(pattern)} ESCAPE '\\'`;
	const boostCase = boostWord
		? `CASE WHEN (
			${like("LOWER(se.from_address)", `${lit(boostWord)}%@%`)}
			OR ${like("LOWER(se.to_address)", `${lit(boostWord)}%@%`)}
			OR ${like("LOWER(COALESCE(se.to_addresses_json, ''))", `%"${lit(boostWord)}%@%`)}
			OR ${like("LOWER(COALESCE(se.from_name, ''))", `${lit(boostWord)}%`)}
		) THEN ${PARTICIPANT_BOOST} ELSE 0 END`
		: "0";
	const subjectFactor =
		parsed.words.length > 0
			? `(CASE WHEN ${parsed.words
					.map((w) => like("LOWER(COALESCE(se.subject, ''))", `%${lit(stemPrefix(w))}%`))
					.join(" AND ")} THEN ${SUBJECT_MATCH_BONUS} ELSE 1.0 END)`
			: "1.0";

	// FTS5 aux functions (bm25, snippet) must run where the FTS index drives the
	// query: bm25 in the candidate scan, snippets as correlated rowid subqueries
	// over the <= 51 survivors (D1 rejects them inside flattened CTEs).
	// CROSS JOIN fixes the join order: candidates drive, threads are looked up.
	// match_window: the newest RANK_WINDOW authorized matches by message date (not
	// rowid, which is import order). scoped_matches: bm25 for those only (the
	// unary + keeps FTS from re-running MATCH per rowid). fts_candidates: the
	// conversation filters (category, Spam, the view) before the 2,000 cut, so
	// excluded conversations can't starve it.
	const sql = `WITH match_window AS (
			SELECT cand.rowid AS rowid
			FROM emails_fts
			CROSS JOIN emails cand ON cand.rowid = emails_fts.rowid${authJoin}
			WHERE emails_fts MATCH ${match}${early}
			ORDER BY cand.received_at DESC, cand.rowid DESC
			LIMIT ${RANK_WINDOW}
		),
		scoped_matches AS (
			SELECT
				emails_fts.rowid AS rowid,
				bm25(emails_fts, 6.0, 1.0, 2.0, 2.0, 1.3, 0.8, 0.5, 0.3, 0.8, 8.0, 3.0) AS fts_rank
			FROM emails_fts
			WHERE emails_fts MATCH ${match} AND +emails_fts.rowid IN (SELECT rowid FROM match_window)
		),
		fts_candidates AS (
			SELECT sm.rowid AS rowid, sm.fts_rank AS fts_rank
			FROM scoped_matches sm
			CROSS JOIN emails ce ON ce.rowid = sm.rowid
			CROSS JOIN threads t ON t.id = ce.thread_id
			WHERE ce.thread_id IS NOT NULL${threadWhere}
			ORDER BY sm.fts_rank ASC
			LIMIT ${SEARCH_CANDIDATES}
		),
		ranked_matches AS (
			SELECT
				se.thread_id,
				se.id,
				se.rowid AS match_rowid,
				fc.fts_rank * ${subjectFactor} - (${boostCase}) AS score,
				ROW_NUMBER() OVER (
					PARTITION BY se.thread_id
					ORDER BY fc.fts_rank * ${subjectFactor} - (${boostCase}) ASC, COALESCE(se.sent_at, se.received_at) DESC, se.id DESC
				) AS rn
			FROM fts_candidates fc
			CROSS JOIN emails se ON se.rowid = fc.rowid
			WHERE se.thread_id IS NOT NULL
		),
		top_threads AS (
			SELECT m.thread_id, m.id, m.match_rowid, m.score AS rank_key
			FROM ranked_matches m
			CROSS JOIN threads t ON t.id = m.thread_id
			WHERE m.rn = 1${threadWhere}
			ORDER BY rank_key ASC, t.latest_message_at DESC, t.id DESC
			LIMIT ${limit + 1} OFFSET ${offset}
		)
		SELECT
			t.id, t.domain, t.root_subject, t.latest_message_at, t.started_at,
			t.message_count, t.unread_count, t.mailbox_state, t.has_attachments,
			t.attachment_count, t.snippet, t.participant_names, t.participant_addresses,
			t.is_muted, t.is_starred,
			COALESCE(t.user_pinned_category, t.priority_category, t.category) AS category,
			t.latest_email_id,
			display_email.id AS display_email_id,
			display_email.subject AS display_subject,
			display_email.mailbox_state AS display_mailbox_state,
			display_email.direction AS display_direction,
			display_email.from_address AS display_from_address,
			display_email.from_name AS display_from_name,
			display_email.to_address AS display_to_address,
			display_email.to_addresses_json AS display_to_addresses_json,
			display_email.cc_addresses_json AS display_cc_addresses_json,
			display_email.bcc_addresses_json AS display_bcc_addresses_json,
			display_email.received_at AS display_received_at,
			display_email.sent_at AS display_sent_at,
			tt.match_rowid AS match_rowid,
			SUBSTR(TRIM(REPLACE(REPLACE(display_email.text_content, CHAR(10), ' '), CHAR(13), ' ')), 1, 2000) AS body_prefix
		FROM top_threads tt
		CROSS JOIN threads t ON t.id = tt.thread_id
		LEFT JOIN emails display_email ON display_email.id = tt.id
		ORDER BY tt.rank_key ASC, t.latest_message_at DESC, t.id DESC`;

	const rows = ((
		await db
			.prepare(sql)
			.bind(...values)
			.all()
	).results ?? []) as Row[];
	// Snippets for the page in ONE MATCH evaluation (a correlated subquery per row
	// re-expanded prefix terms 51 times: 3.6 s for "the"). Row ids are integers.
	const rowids = rows.map((r) => Number(r.match_rowid)).filter(Number.isInteger);
	const snippets = new Map<number, unknown>();
	if (rowids.length > 0) {
		const found = await db
			.prepare(
				`SELECT emails_fts.rowid AS r, ${buildMatchSnippetAndSourceExpr()} AS s
				 FROM emails_fts
				 WHERE emails_fts MATCH ? AND emails_fts.rowid BETWEEN ? AND ?
					AND +emails_fts.rowid IN (${rowids.join(", ")})`,
			)
			.bind(parsed.fts.match, Math.min(...rowids), Math.max(...rowids))
			.all<{ r: number; s: string }>();
		for (const f of found.results ?? []) snippets.set(Number(f.r), f.s);
	}
	return rows.map(({ match_rowid, body_prefix, ...row }) => {
		const { snippet: matched, source } = splitSnippetAndSource(snippets.get(Number(match_rowid)));
		return {
			...row,
			display_snippet: matched ?? body_prefix,
			display_snippet_is_html: 0,
			display_snippet_source: matched ? source : null,
		};
	});
}

/** A printable LIKE pattern that matches no real address or name. */
const _NEVER_MATCH = "~~no~match~~";

async function getConversationDetail(
	db: D1Database,
	id: string,
	options: {
		emailId?: string | null;
		load?: "anchor" | "full";
		bucket?: R2Bucket;
	} = {},
	domainScope: string[] = [],
): Promise<ConversationDetailResponse | null> {
	if (!(await isThreadsTableReady(db))) return null;

	const requestedEmailId = options.emailId?.trim() || null;
	const loadMode = options.load === "full" ? "full" : "anchor";

	const threadRow = await db
		.prepare(
			buildConversationListSelect(
				`WHERE t.id = ?${domainScope.length > 0 ? ` AND t.domain IN (${domainScope.map(() => "?").join(", ")})` : ""}`,
				"",
			),
		)
		.bind(id, ...domainScope)
		.first<Row>();

	let emailsResult = { emails: [] as Email[], error: undefined as Error | undefined };
	let summary: ConversationSummary | null = null;
	let anchorEmailId: string | null = null;

	if (threadRow) {
		const summaryFromRow = mapConversationSummary(threadRow);
		let latestEmailId = summaryFromRow.latest_email_id;
		if (!latestEmailId) {
			const latestEmailRow = await db
				.prepare(
					`SELECT id FROM emails WHERE thread_id = ?${domainScope.length > 0 ? ` AND domain IN (${domainScope.map(() => "?").join(", ")})` : ""} ORDER BY COALESCE(sent_at, received_at) DESC LIMIT 1`,
				)
				.bind(id, ...domainScope)
				.first<Row>();
			latestEmailId = latestEmailRow?.id == null ? null : String(latestEmailRow.id);
		}

		let resolvedEmailId = latestEmailId;
		if (requestedEmailId) {
			const { email: requestedEmail, error } = await getEmailById(
				db,
				requestedEmailId,
				domainScope,
			);
			if (error) throw error;
			if (requestedEmail && requestedEmail.thread_id === id) {
				emailsResult = { emails: [requestedEmail], error: undefined };
				resolvedEmailId = requestedEmail.id;
				anchorEmailId = requestedEmail.id;
			} else {
				return null;
			}
		}
		anchorEmailId = anchorEmailId ?? resolvedEmailId;

		if (resolvedEmailId && emailsResult.emails.length === 0) {
			if (loadMode === "full") {
				const detail = await getConversationDetailByThreadId(db, id, domainScope);
				emailsResult = {
					emails: detail.emails,
					error: detail.error ?? undefined,
				};
			} else {
				const { email: anchorEmail, error } = await getEmailById(db, resolvedEmailId, domainScope);
				emailsResult = {
					emails: anchorEmail ? [anchorEmail] : [],
					error: error ?? undefined,
				};
			}
		} else if (resolvedEmailId && loadMode === "full" && emailsResult.emails.length === 1) {
			const detail = await getConversationDetailByThreadId(db, id, domainScope);
			emailsResult = {
				emails: detail.emails,
				error: detail.error ?? undefined,
			};
		}
		summary = {
			...summaryFromRow,
			latest_email_id: latestEmailId,
			snippet:
				summaryFromRow.snippet ??
				(emailsResult.emails.length > 0
					? extractSnippetFromEmail(emailsResult.emails[emailsResult.emails.length - 1])
					: null),
		};
	}

	if (!summary) {
		const { email } = await getEmailById(db, id, domainScope);
		if (!email) return null;
		anchorEmailId = email.id;

		const threadId = email.thread_id ?? email.id;
		if (loadMode === "full") {
			if (email.thread_id) {
				const detail = await getConversationDetailByThreadId(db, threadId, domainScope);
				emailsResult = {
					emails: detail.emails,
					error: detail.error ?? undefined,
				};
			} else {
				emailsResult = await getThreadByEmailId(db, email.id, domainScope);
			}
		} else {
			emailsResult = { emails: [email], error: undefined };
		}
		summary = buildConversationSummaryFromEmails(threadId, emailsResult.emails) ?? {
			id: threadId,
			domain: email.domain,
			subject: email.subject,
			latest_message_at: email.sent_at ?? email.received_at,
			started_at: email.sent_at ?? email.received_at,
			message_count: 1,
			unread_count: email.direction === "inbound" && email.read_at == null ? 1 : 0,
			mailbox_state: email.mailbox_state,
			has_attachments: email.has_attachments,
			attachment_count: email.attachment_count,
			snippet: extractSnippetFromEmail(email),
			participants: [
				{
					name: email.from_name ?? null,
					address: email.from_address,
				},
			],
			is_muted: false,
			is_starred: false,
			category: email.category ?? null,
			latest_email_id: email.id,
			display_attachment_names: [],
			display_email_id: email.id,
			display_mailbox_state: email.mailbox_state,
			display_direction: email.direction,
			display_from_address: email.from_address,
			display_from_name: email.from_name ?? null,
			display_to_address: email.to_address || null,
			display_to_name: null,
			display_to_addresses: email.to_addresses ?? [],
			display_cc_addresses: email.cc_addresses ?? [],
			display_bcc_addresses: email.bcc_addresses ?? [],
			display_received_at: email.received_at,
			display_sent_at: email.sent_at ?? null,
			display_snippet: extractSnippetFromEmail(email),
		};
	}

	if (emailsResult.error) {
		throw emailsResult.error;
	}
	if (emailsResult.emails.length === 0) return null;

	// Batch-hydrate any offloaded HTML bodies in parallel.
	if (options.bucket && emailsResult.emails.length > 0) {
		await hydrateHtmlFromR2(options.bucket, emailsResult.emails);
	}
	// Quoted-text split for the UI; an anchor-only load has no earlier messages to compare.
	if (emailsResult.emails.length > 1) {
		applyQuoteSplits(emailsResult.emails, { annotateHtml: true });
	}

	if (anchorEmailId) {
		const anchorEmail = emailsResult.emails.find((entry) => entry.id === anchorEmailId);
		if (anchorEmail) {
			summary = applyDisplayEmailToSummary(summary, anchorEmail);
		}
	}

	await attachDisplayAttachmentNames(db, [summary]);
	return {
		conversation: summary,
		emails: emailsResult.emails,
		anchor_email_id: anchorEmailId,
		remaining_email_count: Math.max(summary.message_count - emailsResult.emails.length, 0),
	};
}

conversations.get("/api/conversations", async (c) => {
	const domainScope = getConfiguredDomains(c.env);
	const filters = parseConversationFilters(c.req.query());
	const persons = restrictedPersons(c);
	if (persons) filters.for_persons = persons;
	// Every caller's allowed domains apply before search's candidate cuts: stored
	// mail can carry domains no longer configured (review pass 4), so "all configured
	// domains" is not "all mail".
	if (domainScope.length > 0) filters.for_domains = domainScope;

	const accountDomain = filters.account?.split("@")[1];
	if (filters.account && !/^[^@\s]+@[^@\s]+$/.test(filters.account)) {
		return c.json(ERR("INVALID_QUERY", "account must be a full address like you@example.org"), 400);
	}
	if (accountDomain && filters.domain && accountDomain !== filters.domain) {
		return c.json(ERR("INVALID_QUERY", "account and domain disagree"), 400);
	}
	const requestedDomain = accountDomain ?? filters.domain;
	if (requestedDomain && domainScope.length > 0 && !domainScope.includes(requestedDomain)) {
		return c.json(ERR("FORBIDDEN_DOMAIN", "Requested domain is not one MailClaw serves"), 403);
	}
	const scopeParam = c.req.query("scope");
	if (scopeParam !== undefined && scopeParam !== "all" && scopeParam !== "view") {
		return c.json(ERR("INVALID_QUERY", "scope must be all or view"), 400);
	}
	// A cursor that doesn't decode, or one sent with a browse sort it can't page,
	// would silently restart at page 1.
	if (
		filters.cursor &&
		(!decodeConversationCursor(filters.cursor) || (!filters.q && !isCursorSort(filters.sort)))
	) {
		return c.json(
			ERR("INVALID_CURSOR", "Invalid cursor. Pass back next_cursor exactly as returned."),
			400,
		);
	}

	try {
		const response = await getConversationList(c.env.D1, filters, domainScope);
		await attachDisplayAttachmentNames(c.env.D1, response.conversations);
		await nameDisplayRecipients(c.env.D1, response.conversations, domainScope, !persons);
		return c.json(OK(response));
	} catch (error) {
		if (error instanceof QueryInputError) return c.json(ERR(error.code, error.message), 400);
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("fts5: syntax error")) {
			return c.json(ERR("INVALID_QUERY", `The search could not be parsed: ${message}`), 400);
		}
		if (message.includes("exceeded its CPU time limit")) {
			return c.json(
				ERR(
					"QUERY_TOO_BROAD",
					"The search ran out of database time. Retry once, then add a rarer word or a filter.",
				),
				503,
			);
		}
		return c.json(ERR("D1_ERROR", message), 500);
	}
});

conversations.get("/api/conversations/:id", async (c) => {
	const domainScope = getConfiguredDomains(c.env);
	const id = c.req.param("id");
	const loadParam = c.req.query("load");
	const emailId = c.req.query("email_id");
	const load = loadParam === "full" ? "full" : "anchor";

	try {
		const response = await getConversationDetail(
			c.env.D1,
			id,
			{ emailId, load, bucket: c.env.ATTACHMENTS },
			domainScope,
		);
		if (!response) return c.json(ERR("NOT_FOUND", "Conversation not found"), 404);
		await nameDisplayRecipients(
			c.env.D1,
			[response.conversation],
			domainScope,
			!restrictedPersons(c),
		);
		return c.json(OK(response));
	} catch (error) {
		return c.json(ERR("D1_ERROR", error instanceof Error ? error.message : String(error)), 500);
	}
});

export default conversations;
