import { buildMatchSnippetSourceSubquery, buildMatchSnippetSubquery } from "@/database/fts-snippet";
import { compileSearch, type FtsMatchQueries, QueryInputError } from "@/database/search-query";
import {
	areComposeDraftColumnsReady,
	isAttachmentExtractStatusColumnReady,
	isAttachmentNamesColumnReady,
	isAttachmentSearchTextColumnReady,
	isHtmlOffloadColumnsReady,
	isListUnsubscribeColumnReady,
	isListUnsubscribePostColumnReady,
	isSubCategoryColumnReady,
	isThreadsTableReady,
	isTrashedAtColumnReady,
} from "@/database/tables";
import { cleanSnippet } from "@/services/snippet";
import {
	applyThreadBatchActionSafe,
	refreshThreadBatchSafe,
	refreshThreadSafe,
} from "@/services/threads-loader";
import type {
	ContactSuggestion,
	DomainMailboxSummary,
	DomainSummary,
	Email,
	EmailAttachment,
	EmailBatchActionRequest,
	EmailCategory,
	EmailExport,
	EmailFilters,
	EmailRecord,
	EmailSummary,
	InterestLevel,
	UpdateDraftRequest,
	UpdateEmailRequest,
} from "@/types";
import { resolveAttachmentExtractStatus } from "@/utils/attachments";
import { buildContactSuggestions } from "@/utils/contacts";
import { now } from "@/utils/helpers";
import {
	getEmailBodyFromR2,
	putEmailBodyToR2,
	putPreparedEmailBody,
	shouldOffloadHtml,
} from "@/utils/html-offload";
import { logError } from "@/utils/logging";
import { messageIdForms } from "@/utils/message-id";

type Row = Record<string, unknown>;

function pushDomainScope(conditions: string[], params: unknown[], domainScope: string[]) {
	if (domainScope.length === 0) {
		return;
	}

	conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
	params.push(...domainScope);
}

function nullableString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

function numberOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	return Number(value);
}

function parseStringArray(value: unknown): string[] {
	if (value === null || value === undefined) {
		return [];
	}

	if (Array.isArray(value)) {
		return value.map(String);
	}

	if (typeof value !== "string" || value.trim() === "") {
		return [];
	}

	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function serializeStringArray(values: string[]): string {
	return JSON.stringify(values);
}

function extractMessageIdentifiers(
	email: Pick<EmailRecord, "message_id" | "in_reply_to" | "references_header">,
): string[] {
	const identifiers = new Set<string>();

	if (email.message_id) identifiers.add(email.message_id.trim());
	if (email.in_reply_to) identifiers.add(email.in_reply_to.trim());
	if (email.references_header) {
		for (const value of email.references_header.split(/\s+/)) {
			const normalized = value.trim();
			if (normalized) identifiers.add(normalized);
		}
	}

	return [...identifiers];
}

function mapEmailRecord(row: Row): EmailRecord {
	return {
		id: String(row.id),
		from_address: String(row.from_address),
		from_name: nullableString(row.from_name),
		to_address: String(row.to_address),
		to_addresses: parseStringArray(row.to_addresses_json),
		cc_addresses: parseStringArray(row.cc_addresses_json),
		bcc_addresses: parseStringArray(row.bcc_addresses_json),
		reply_to_addresses: parseStringArray(row.reply_to_addresses_json),
		domain: String(row.domain),
		mailbox: String(row.mailbox),
		direction: String(row.direction) as EmailRecord["direction"],
		mailbox_state: String(row.mailbox_state) as EmailRecord["mailbox_state"],
		subject: nullableString(row.subject),
		received_at: Number(row.received_at),
		sent_at: numberOrNull(row.sent_at),
		read_at: numberOrNull(row.read_at),
		html_content: nullableString(row.html_content),
		text_content: nullableString(row.text_content),
		message_id: nullableString(row.message_id),
		provider_message_id: nullableString(row.provider_message_id),
		source_type: nullableString(row.source_type),
		source_path: nullableString(row.source_path),
		source_folder: nullableString(row.source_folder),
		source_message_id: nullableString(row.source_message_id),
		in_reply_to: nullableString(row.in_reply_to),
		references_header: nullableString(row.references_header),
		has_attachments: Boolean(row.has_attachments),
		attachment_count: Number(row.attachment_count ?? 0),
		draft_revision: Number(row.draft_revision ?? 0),
		editor_state_json: nullableString(row.editor_state_json),
		thread_id: nullableString(row.thread_id),
		category: (row.category as EmailCategory | null) ?? null,
		sub_category: nullableString(row.sub_category),
		auto_read_at: numberOrNull(row.auto_read_at),
		interest_level: (row.interest_level as InterestLevel | null) ?? null,
		interest_comment: nullableString(row.interest_comment),
		list_unsubscribe: nullableString(row.list_unsubscribe),
		list_unsubscribe_post: nullableString(row.list_unsubscribe_post),
		html_in_r2: Boolean(row.html_in_r2),
		r2_html_key: nullableString(row.r2_html_key),
	};
}

function parseThreadParticipants(
	namesJson: unknown,
	addressesJson: unknown,
): Array<{ name: string | null; address: string }> {
	const names = parseStringArray(namesJson);
	const addresses = parseStringArray(addressesJson);
	const result: Array<{ name: string | null; address: string }> = [];
	for (let i = 0; i < addresses.length; i++) {
		result.push({ name: names[i] || null, address: addresses[i] });
	}
	return result;
}

function mapEmailSummary(row: Row): EmailSummary {
	const record = mapEmailRecord(row);

	return {
		id: record.id,
		from_address: record.from_address,
		from_name: record.from_name,
		to_address: record.to_address,
		to_addresses: record.to_addresses,
		cc_addresses: record.cc_addresses,
		bcc_addresses: record.bcc_addresses,
		reply_to_addresses: record.reply_to_addresses,
		domain: record.domain,
		mailbox: record.mailbox,
		direction: record.direction,
		mailbox_state: record.mailbox_state,
		subject: record.subject,
		received_at: record.received_at,
		sent_at: record.sent_at,
		read_at: record.read_at,
		provider_message_id: record.provider_message_id,
		source_type: record.source_type,
		source_path: record.source_path,
		source_folder: record.source_folder,
		source_message_id: record.source_message_id,
		has_attachments: record.has_attachments,
		attachment_count: record.attachment_count,
		thread_id: record.thread_id ?? null,
		category: record.category,
		sub_category: record.sub_category,
		interest_level: record.interest_level,
		interest_comment: record.interest_comment,
		snippet: cleanSnippet(nullableString(row.snippet ?? row.thread_snippet), record.subject),
		thread_count: Number(row.thread_count ?? 1),
		thread_unread_count: Number(row.thread_unread_count ?? 0),
		thread_participants: parseThreadParticipants(
			row.thread_participant_names ?? row.participant_names,
			row.thread_participant_addresses ?? row.participant_addresses,
		),
		thread_has_attachments: Boolean(row.thread_has_attachments ?? record.has_attachments),
		thread_is_muted: Boolean(row.thread_is_muted ?? false),
		thread_is_starred: Boolean(row.thread_is_starred ?? false),
	};
}

function mapSearchEmailSummary(row: Row): EmailSummary {
	return {
		id: String(row.id),
		from_address: String(row.from_address),
		from_name: nullableString(row.from_name),
		to_address: String(row.to_address),
		to_addresses: parseStringArray(row.to_addresses_json),
		cc_addresses: parseStringArray(row.cc_addresses_json),
		bcc_addresses: parseStringArray(row.bcc_addresses_json),
		reply_to_addresses: parseStringArray(row.reply_to_addresses_json),
		domain: String(row.domain),
		mailbox: String(row.mailbox),
		direction: String(row.direction) as EmailSummary["direction"],
		mailbox_state: String(row.mailbox_state) as EmailSummary["mailbox_state"],
		subject: nullableString(row.subject),
		received_at: Number(row.received_at),
		sent_at: numberOrNull(row.sent_at),
		read_at: numberOrNull(row.read_at),
		provider_message_id: nullableString(row.provider_message_id),
		source_type: nullableString(row.source_type),
		source_path: nullableString(row.source_path),
		source_folder: nullableString(row.source_folder),
		source_message_id: nullableString(row.source_message_id),
		has_attachments: Boolean(row.has_attachments),
		attachment_count: Number(row.attachment_count ?? 0),
		thread_id: nullableString(row.thread_id),
		category: (row.category as EmailCategory | null) ?? null,
		sub_category: nullableString(row.sub_category),
		interest_level: null,
		interest_comment: null,
		snippet: cleanSnippet(nullableString(row.snippet), nullableString(row.subject)),
		snippet_source: row.snippet_source === "attachment" ? "attachment" : null,
		thread_count: 1,
		thread_unread_count: 0,
		thread_participants: [],
		thread_has_attachments: Boolean(row.has_attachments),
		thread_is_muted: false,
		thread_is_starred: false,
	};
}

interface SearchCursor {
	sort_at: number;
	id: string;
}

function encodeSearchCursor(cursor: SearchCursor): string {
	return encodeURIComponent(JSON.stringify(cursor));
}

function decodeSearchCursor(cursor: string | undefined): SearchCursor | null {
	if (!cursor) return null;

	try {
		const parsed = JSON.parse(decodeURIComponent(cursor)) as SearchCursor;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof parsed.sort_at === "number" &&
			Number.isFinite(parsed.sort_at) &&
			typeof parsed.id === "string" &&
			parsed.id.trim() !== ""
		) {
			return { sort_at: parsed.sort_at, id: parsed.id };
		}
		return null;
	} catch {
		return null;
	}
}

function mapAttachment(row: Row): EmailAttachment {
	return {
		id: String(row.id),
		email_id: String(row.email_id),
		object_key: String(row.object_key),
		filename: nullableString(row.filename),
		mime_type: String(row.mime_type),
		size: Number(row.size ?? 0),
		disposition: nullableString(row.disposition),
		content_id: nullableString(row.content_id),
		created_at: Number(row.created_at),
	};
}

async function getContactSuggestionsFromEmails(
	db: D1Database,
	query: string,
	domainScope: string[],
	limit: number,
) {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return { contacts: [] as ContactSuggestion[], error: undefined };
	}

	// Contact columns already have an FTS index (v31). Prefix MATCH avoids the
	// old seven-column LIKE scan and whole-mailbox date sort on every keystroke.
	// Separate sent/inbound lanes prevent marketing volume from burying recipients.
	if (!/[\p{L}\p{N}]/u.test(normalizedQuery)) {
		return { contacts: [] as ContactSuggestion[], error: undefined };
	}
	const match = `{from_address from_name to_address to_addresses_json cc_addresses_json bcc_addresses_json reply_to_addresses_json}: "${normalizedQuery.replace(/"/g, '""')}"*`;
	const scope = domainScope.length
		? ` AND e.domain IN (${domainScope.map(() => "?").join(",")})`
		: "";
	const lane = (direction: string) => `SELECT e.from_address, e.from_name, e.to_address,
		e.to_addresses_json, e.cc_addresses_json, e.bcc_addresses_json, e.reply_to_addresses_json,
		e.direction, e.domain, e.mailbox, COALESCE(e.sent_at, e.received_at) AS last_seen_at
		FROM emails_fts CROSS JOIN emails e ON e.rowid = emails_fts.rowid
		WHERE emails_fts MATCH ? AND e.direction = '${direction}'
		AND e.mailbox_state NOT IN ('draft', 'trash') AND COALESCE(e.category, '') != 'spam'${scope}
		ORDER BY emails_fts.rowid DESC LIMIT 250`;
	const { results } = await db
		.prepare(
			`WITH sent AS (${lane("outbound")}), received AS (${lane("inbound")})
		 SELECT * FROM sent UNION ALL SELECT * FROM received LIMIT 500`,
		)
		.bind(match, ...domainScope, match, ...domainScope)
		.all<Row>();
	const contacts = buildContactSuggestions(
		results.map((row) => ({
			from_address: nullableString(row.from_address),
			from_name: nullableString(row.from_name),
			to_address: nullableString(row.to_address),
			to_addresses: parseStringArray(row.to_addresses_json),
			cc_addresses: parseStringArray(row.cc_addresses_json),
			bcc_addresses: parseStringArray(row.bcc_addresses_json),
			reply_to_addresses: parseStringArray(row.reply_to_addresses_json),
			last_seen_at: numberOrNull(row.last_seen_at),
			direction: String(row.direction),
			account: `${row.mailbox}@${row.domain}`,
		})),
		normalizedQuery,
		limit,
	);
	return { contacts, error: undefined };
}

/**
 * The `emails` column list and values for one row, gated on which migrations
 * are applied. Offloads large/old HTML to R2 first (the returned
 * `offloadedHtmlKey` is the R2 object to delete if the row is never written).
 * Shared by `insertEmail` and the raw-ingest batch (src/services/ingest.ts) so
 * the column set lives in one place.
 */
export async function buildEmailInsertRow(
	db: D1Database,
	email: EmailRecord & { attachment_names?: string | null },
	options: { bucket?: R2Bucket; preparedBody?: boolean } = {},
): Promise<{ columns: string[]; values: unknown[]; offloadedHtmlKey: string | null }> {
	// HTML offload: if enabled and the email qualifies, write the HTML to
	// R2 first and store NULL in D1. The `emails.html_in_r2` flag tells
	// read paths to hydrate from R2. See src/utils/html-offload.ts.
	let htmlContent: string | null = email.html_content;
	let htmlInR2 = 0;
	let r2HtmlKey: string | null = null;
	const offloadColumnsReady = await isHtmlOffloadColumnsReady(db);
	if (options.bucket && offloadColumnsReady) {
		const decision = shouldOffloadHtml({
			html_content: email.html_content,
			received_at: email.received_at,
		});
		if (decision.offload && email.html_content) {
			try {
				// A keyed send's prepared body is create-only under its own key: the
				// sent copy (finalizeDraftSend) never overwrites it.
				r2HtmlKey = options.preparedBody
					? await putPreparedEmailBody(options.bucket, email.id, email.html_content)
					: await putEmailBodyToR2(options.bucket, email.id, email.html_content);
				htmlContent = null;
				htmlInR2 = 1;
			} catch (err) {
				// R2 write failed — fall back to inline D1 storage. If the row is
				// too big it will surface the real error at insert time.
				logError("html_offload_r2_put_failed", {
					email_id: email.id,
					size: email.html_content.length,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	const columns = [
		"id",
		"from_address",
		"from_name",
		"to_address",
		"to_addresses_json",
		"cc_addresses_json",
		"bcc_addresses_json",
		"reply_to_addresses_json",
		"domain",
		"mailbox",
		"direction",
		"mailbox_state",
		"subject",
		"received_at",
		"sent_at",
		"read_at",
		"html_content",
		"text_content",
		"message_id",
		"provider_message_id",
		"source_type",
		"source_path",
		"source_folder",
		"source_message_id",
		"in_reply_to",
		"references_header",
		"has_attachments",
		"attachment_count",
		"thread_id",
		"category",
	];
	const values: unknown[] = [
		email.id,
		email.from_address,
		email.from_name ?? null,
		email.to_address,
		serializeStringArray(email.to_addresses),
		serializeStringArray(email.cc_addresses),
		serializeStringArray(email.bcc_addresses),
		serializeStringArray(email.reply_to_addresses),
		email.domain,
		email.mailbox,
		email.direction,
		email.mailbox_state,
		email.subject,
		email.received_at,
		email.sent_at,
		email.read_at,
		htmlContent,
		email.text_content,
		email.message_id,
		email.provider_message_id,
		email.source_type ?? null,
		email.source_path ?? null,
		email.source_folder ?? null,
		email.source_message_id ?? null,
		email.in_reply_to,
		email.references_header,
		email.has_attachments,
		email.attachment_count,
		email.thread_id ?? null,
		email.category ?? null,
	];

	if (offloadColumnsReady) {
		columns.push("html_in_r2", "r2_html_key");
		values.push(htmlInR2, r2HtmlKey);
	}

	if (await areComposeDraftColumnsReady(db)) {
		columns.push("draft_revision", "editor_state_json");
		values.push(email.draft_revision ?? 0, email.editor_state_json ?? null);
	}

	if (await isListUnsubscribeColumnReady(db)) {
		columns.push("list_unsubscribe");
		values.push(email.list_unsubscribe ?? null);
	}
	if (await isListUnsubscribePostColumnReady(db)) {
		columns.push("list_unsubscribe_post");
		values.push(email.list_unsubscribe_post ?? null);
	}

	// Phase 4: sub_category column, added in v27. Check cheaply before
	// writing so environments still on an older schema don't blow up.
	if (await isSubCategoryColumnReady(db)) {
		columns.push("sub_category");
		values.push(email.sub_category ?? null);
	}

	if (email.attachment_names != null && (await isAttachmentNamesColumnReady(db))) {
		columns.push("attachment_names");
		values.push(email.attachment_names);
	}

	// Stored straight into Trash (a blocked sender's mail): the 30-day purge selects on trashed_at.
	if (email.mailbox_state === "trash" && (await isTrashedAtColumnReady(db))) {
		columns.push("trashed_at");
		values.push(now());
	}

	return { columns, values, offloadedHtmlKey: r2HtmlKey };
}

/**
 * `ifMissing`: insert unless a row with this id exists (a keyed send's draft, written by
 * every attempt with its key; the first row wins). `preparedBody`: see buildEmailInsertRow.
 */
export async function insertEmail(
	db: D1Database,
	email: EmailRecord,
	options: { bucket?: R2Bucket; preparedBody?: boolean; ifMissing?: boolean } = {},
) {
	try {
		const { columns, values } = await buildEmailInsertRow(db, email, options);
		const { success, error } = await db
			.prepare(
				`INSERT INTO emails (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})${
					options.ifMissing ? " ON CONFLICT(id) DO NOTHING" : ""
				}`,
			)
			.bind(...values)
			.run();

		return { success, error };
	} catch (e: unknown) {
		return { success: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * True when this exact delivery is already stored: same Message-ID in the same
 * mailbox and direction. A message we sent from one of our domains to another,
 * or one addressed to two of our mailboxes, is several deliveries and each
 * copy is kept (per-mailbox delivery dedupe, 2026-09-11).
 */
export async function emailExistsByMessageId(
	db: D1Database,
	messageId: string,
	delivery: { domain: string; mailbox: string; direction: "inbound" | "outbound" },
): Promise<boolean> {
	const ids = messageIdForms(messageId);
	if (!ids) return false;
	try {
		const result = await db
			.prepare(
				"SELECT 1 FROM emails WHERE message_id IN (?, ?) AND domain = ? AND mailbox = ? AND direction = ? LIMIT 1",
			)
			.bind(...ids.forms, delivery.domain, delivery.mailbox, delivery.direction)
			.first();

		return result !== null;
	} catch {
		return false;
	}
}

/**
 * Dedupe for a delivery with no Message-ID (some mail clients send none, and
 * a polling IMAP sync sees each such message again every cycle). Same sender, subject and
 * first recipient and timestamp in the same mailbox and direction is the same
 * message.
 */
export async function emailExistsByContent(
	db: D1Database,
	delivery: {
		domain: string;
		mailbox: string;
		direction: "inbound" | "outbound";
		fromAddress: string;
		toAddress: string;
		subject: string | null;
		receivedAt: number;
	},
): Promise<boolean> {
	try {
		const result = await db
			.prepare(
				`SELECT 1 FROM emails
				 WHERE from_address = ? AND received_at = ? AND subject IS ? AND to_address = ?
				   AND domain = ? AND mailbox = ? AND direction = ?
				 LIMIT 1`,
			)
			.bind(
				delivery.fromAddress,
				delivery.receivedAt,
				delivery.subject,
				delivery.toAddress,
				delivery.domain,
				delivery.mailbox,
				delivery.direction,
			)
			.first();
		return result !== null;
	} catch {
		return false;
	}
}

/** Text matches above this many messages are refused (see selectMessages). */
const BROAD_QUERY_LIMIT = 20_000;

export { buildFtsMatchQueries, QueryInputError } from "@/database/search-query";

/**
 * Structured filters plus the FTS inputs for a message query, with the query's
 * operators (has: is: in: category: after: before:) merged in. Explicit
 * filters win over operators. Throws QueryInputError for anything that can't
 * be applied, so a bad query can never widen into an unfiltered result.
 */
function resolveMessageQuery(filters: EmailFilters): {
	filters: EmailFilters;
	fts: FtsMatchQueries | null;
	interpreted?: string;
} {
	const q = filters.q?.trim();
	if (!q) return { filters: { ...filters, q: undefined }, fts: null };

	const parsed = compileSearch(q);
	const ops = parsed.filters;
	const merged: EmailFilters = { ...filters, q };
	if (ops.has_attachment !== undefined && merged.has_attachments === undefined)
		merged.has_attachments = ops.has_attachment;
	if (ops.is_read !== undefined && merged.is_read === undefined) merged.is_read = ops.is_read;
	if (ops.category && merged.category === undefined)
		merged.category = ops.category as EmailFilters["category"];
	if (ops.after) merged.after = Math.max(merged.after ?? ops.after, ops.after);
	if (ops.before) merged.before = Math.min(merged.before ?? ops.before, ops.before);
	if (ops.mailbox_state && !merged.mailbox_state)
		merged.mailbox_state = ops.mailbox_state as EmailFilters["mailbox_state"];

	const fts = parsed.fts;
	return {
		filters: merged,
		fts: fts.match || fts.exclude ? fts : null,
		interpreted: parsed.interpreted,
	};
}

/** WHERE conditions over a single `emails e` row (no text matching). */
function buildMessageConditions(
	filters: EmailFilters,
	domainScope: string[],
): { conditions: string[]; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	const equal = (column: string, value: unknown) => {
		conditions.push(`e.${column} = ?`);
		params.push(value);
	};

	if (domainScope.length > 0) {
		conditions.push(`e.domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}
	if (filters.from) equal("from_address", filters.from);
	if (filters.to) equal("to_address", filters.to);
	if (filters.domain) equal("domain", filters.domain);
	if (filters.mailbox) equal("mailbox", filters.mailbox);
	if (filters.direction) equal("direction", filters.direction);
	if (filters.mailbox_state) equal("mailbox_state", filters.mailbox_state);
	if (filters.after) {
		conditions.push("e.received_at >= ?");
		params.push(filters.after);
	}
	if (filters.before) {
		conditions.push("e.received_at <= ?");
		params.push(filters.before);
	}
	if (typeof filters.has_attachments === "boolean") {
		equal("has_attachments", filters.has_attachments ? 1 : 0);
	}
	if (typeof filters.is_read === "boolean") {
		conditions.push(filters.is_read ? "e.read_at IS NOT NULL" : "e.read_at IS NULL");
	}
	if (filters.category === null) {
		conditions.push("e.category IS NULL");
	} else if (filters.category !== undefined) {
		equal("category", filters.category);
	}
	if (filters.sub_category) {
		// A comma list ORs, as on /api/conversations: "invoice_conversations,failed_payments".
		const subs = filters.sub_category
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (subs.length > 0) {
			conditions.push(`e.sub_category IN (${subs.map(() => "?").join(", ")})`);
			params.push(...subs);
		}
	}

	return { conditions, params };
}

function whereSql(conditions: string[]): string {
	return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

/** Keyset condition for `ORDER BY COALESCE(sent_at, received_at) DESC, id DESC`. */
function buildMessageCursorCondition(cursor: string | undefined): {
	condition: string | null;
	params: unknown[];
} {
	if (!cursor) return { condition: null, params: [] };
	const parsed = decodeSearchCursor(cursor);
	if (!parsed) {
		throw new QueryInputError(
			"INVALID_CURSOR",
			"Invalid cursor. Pass back next_cursor exactly as returned, with the same filters.",
		);
	}
	return {
		condition:
			"(COALESCE(e.sent_at, e.received_at) < ? OR (COALESCE(e.sent_at, e.received_at) = ? AND e.id < ?))",
		params: [parsed.sort_at, parsed.sort_at, parsed.id],
	};
}

/**
 * Per-message filters, as a predicate over a single `emails` row.
 *
 * The threads table carries no from/to/direction/mailbox columns, so these
 * only exist on member emails. They are combined into ONE predicate so the
 * conjunction stays per-message: `direction=outbound&from=x` means "x sent a
 * message in this thread", not "the thread has some outbound message and,
 * separately, some message from x".
 */
export function buildThreadMemberPredicate(
	filters: EmailFilters,
	alias = "member",
): { conditions: string[]; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (filters.mailbox_state) {
		conditions.push(`${alias}.mailbox_state = ?`);
		params.push(filters.mailbox_state);
	}
	if (filters.from) {
		conditions.push(`${alias}.from_address = ?`);
		params.push(filters.from);
	}
	if (filters.to) {
		conditions.push(`${alias}.to_address = ?`);
		params.push(filters.to);
	}
	if (filters.direction) {
		conditions.push(`${alias}.direction = ?`);
		params.push(filters.direction);
	}
	if (filters.mailbox) {
		conditions.push(`${alias}.mailbox = ?`);
		params.push(filters.mailbox);
	}

	return { conditions, params };
}

export function buildThreadCollapsedWhereClause(
	filters: EmailFilters,
	domainScope: string[] = [],
): { where: string; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (domainScope.length > 0) {
		conditions.push(`t.domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	const member = buildThreadMemberPredicate(filters);
	if (member.conditions.length > 0) {
		conditions.push(
			`EXISTS (SELECT 1 FROM emails member WHERE member.thread_id = t.id AND ${member.conditions.join(" AND ")})`,
		);
		params.push(...member.params);
	}
	if (filters.domain) {
		conditions.push("t.domain = ?");
		params.push(filters.domain);
	}
	if (filters.category !== undefined) {
		// Phase 1.2: thread categorization is priority-pinned — manual user override
		// wins, otherwise the max-priority category any member email has ever had.
		// Filtering by t.category (the legacy "latest message category") caused
		// cross-category threads to hide and flicker between folders.
		if (filters.category === null) {
			conditions.push("COALESCE(t.user_pinned_category, t.priority_category, t.category) IS NULL");
		} else {
			conditions.push("COALESCE(t.user_pinned_category, t.priority_category, t.category) = ?");
			params.push(filters.category);
		}
	}
	if (filters.sub_category) {
		// Same key as /api/conversations: the thread mirrors its latest email's sub_category.
		const subs = filters.sub_category
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (subs.length > 0) {
			conditions.push(`t.priority_sub_category IN (${subs.map(() => "?").join(", ")})`);
			params.push(...subs);
		}
	}
	if (typeof filters.has_attachments === "boolean") {
		conditions.push("t.has_attachments = ?");
		params.push(filters.has_attachments ? 1 : 0);
	}
	if (typeof filters.is_read === "boolean") {
		conditions.push(filters.is_read ? "t.unread_count = 0" : "t.unread_count > 0");
	}
	if (filters.after) {
		conditions.push("t.latest_message_at >= ?");
		params.push(filters.after);
	}
	if (filters.before) {
		conditions.push("t.latest_message_at <= ?");
		params.push(filters.before);
	}

	return {
		where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
		params,
	};
}

const THREAD_CONVERSATION_SELECT_COLUMNS = `
	 e.id,
	 e.from_address,
	 e.from_name,
	 e.to_address,
	 e.to_addresses_json,
	 e.cc_addresses_json,
	 e.bcc_addresses_json,
	 e.reply_to_addresses_json,
	 e.domain,
	 e.mailbox,
	 e.direction,
	 e.mailbox_state,
	 e.subject,
	 e.received_at,
	 e.sent_at,
	 e.read_at,
	 e.provider_message_id,
	 e.source_type,
	 e.source_path,
	 e.source_folder,
	 e.source_message_id,
	 e.has_attachments,
	 e.attachment_count,
	 e.thread_id,
	 COALESCE(t.user_pinned_category, t.priority_category, t.category, e.category) AS category,
	 COALESCE(t.priority_sub_category, e.sub_category) AS sub_category,
	 e.interest_level,
	 e.interest_comment,
	 t.snippet AS thread_snippet,
	 t.message_count AS thread_count,
	 t.unread_count AS thread_unread_count,
	 t.participant_names AS thread_participant_names,
	 t.participant_addresses AS thread_participant_addresses,
	 t.has_attachments AS thread_has_attachments,
	 t.is_muted AS thread_is_muted,
	 t.is_starred AS thread_is_starred`;

function buildThreadConversationSelectSql(joinClause: string, where: string, suffix = ""): string {
	return `SELECT${THREAD_CONVERSATION_SELECT_COLUMNS}
	 FROM threads t
	 ${joinClause}
	 ${where}
	 ${suffix}`;
}

export function buildThreadConversationJoinClause(filters: EmailFilters): {
	joinClause: string;
	params: unknown[];
} {
	const { conditions, params } = buildThreadMemberPredicate(filters);

	if (conditions.length === 0) {
		return {
			joinClause: "INNER JOIN emails e ON e.id = t.latest_email_id",
			params: [],
		};
	}

	// Represent the thread with its newest *matching* message rather than
	// t.latest_email_id — otherwise a from/direction-filtered list renders the
	// thread's latest inbound reply, which reads as the filter being ignored.
	return {
		joinClause: `INNER JOIN emails e ON e.id = (
			SELECT member.id
			FROM emails member
			WHERE member.thread_id = t.id AND ${conditions.join(" AND ")}
			ORDER BY COALESCE(member.sent_at, member.received_at) DESC LIMIT 1
		)`,
		params,
	};
}

async function getThreadCollapsedEmails(
	db: D1Database,
	filters: EmailFilters,
	domainScope: string[] = [],
) {
	try {
		const { where, params } = buildThreadCollapsedWhereClause(filters, domainScope);
		const { joinClause, params: joinParams } = buildThreadConversationJoinClause(filters);

		const countResult = await db
			.prepare(
				`SELECT COUNT(*) as total
				 FROM threads t
				 ${where}`,
			)
			.bind(...params)
			.first<{ total: number }>();

		const { results } = await db
			.prepare(
				buildThreadConversationSelectSql(
					joinClause,
					where,
					"ORDER BY t.latest_message_at DESC LIMIT ? OFFSET ?",
				),
			)
			.bind(...joinParams, ...params, filters.limit, filters.offset)
			.all();

		const emails = (results as Row[]).map((row) => mapEmailSummary(row));

		return { emails, total: countResult?.total ?? 0, next_cursor: undefined, error: undefined };
	} catch (e: unknown) {
		return {
			emails: [],
			total: 0,
			next_cursor: undefined,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

const MESSAGE_SUMMARY_COLUMNS = `
		 e.id,
		 e.from_address,
		 e.from_name,
		 e.to_address,
		 e.to_addresses_json,
		 e.cc_addresses_json,
		 e.bcc_addresses_json,
		 e.reply_to_addresses_json,
		 e.domain,
		 e.mailbox,
		 e.direction,
		 e.mailbox_state,
		 e.subject,
		 e.received_at,
		 e.sent_at,
		 e.read_at,
		 e.provider_message_id,
		 e.source_type,
		 e.source_path,
		 e.source_folder,
		 e.source_message_id,
		 e.has_attachments,
		 e.attachment_count,
		 e.thread_id,
		 e.category,
		 e.sub_category,
		 COALESCE(e.sent_at, e.received_at) AS sort_at`;

/** Body-prefix snippet for rows that have no matched term to highlight. */
const PREFIX_SNIPPET_SQL = `CASE
		 WHEN e.text_content IS NOT NULL AND TRIM(e.text_content) != '' THEN SUBSTR(TRIM(REPLACE(REPLACE(e.text_content, CHAR(10), ' '), CHAR(13), ' ')), 1, 2000)
		 ELSE NULL
	 END`;

type MessageRowsResult<T> = {
	/** What the query searched (search-query.ts `interpreted`), when there was one. */
	interpreted?: string;
	emails: T[];
	/** Null on cursor pages; the first page carries the count. */
	total: number | null;
	next_cursor: string | undefined;
	error: Error | undefined;
};

/**
 * The one "messages matching X" query: list-with-query, `rows=messages`, and
 * export all run through here, so they can never disagree on membership.
 * Order is newest first by COALESCE(sent_at, received_at), then id; paging is
 * by the returned cursor (export may still page by offset for old callers).
 * Content only changes the columns returned, never which messages match.
 */
async function selectMessages<T>(
	db: D1Database,
	rawFilters: EmailFilters,
	domainScope: string[],
	content: "summary" | "full",
	options: { allowOffset?: boolean } = {},
): Promise<MessageRowsResult<T>> {
	try {
		const { filters, fts, interpreted } = resolveMessageQuery(rawFilters);
		const base = buildMessageConditions(filters, domainScope);
		const cursor = buildMessageCursorCondition(filters.cursor);
		if (!options.allowOffset && filters.offset > 0) {
			throw new QueryInputError(
				"INVALID_CURSOR",
				"Message results page by cursor, not offset. Pass back next_cursor as cursor.",
			);
		}
		const offset = options.allowOffset && !filters.cursor ? filters.offset : 0;

		// Positive text terms join the FTS table (and highlight); a negation-only
		// query excludes matching rows over a plain scan because FTS5 has no
		// bare NOT; no text at all is a plain scan.
		// A very common word matches most of the mailbox; sorting that burns
		// D1's CPU budget for ~30s and resets the database for every caller.
		// Probe the match size with a bounded read and refuse fast instead.
		if (fts?.match && !filters.from && !filters.to) {
			const probe = await db
				.prepare(
					`SELECT COUNT(*) AS n FROM (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ? LIMIT ${BROAD_QUERY_LIMIT + 1})`,
				)
				.bind(fts.match)
				.first<{ n: number }>();
			if ((probe?.n ?? 0) > BROAD_QUERY_LIMIT) {
				throw new QueryInputError(
					"QUERY_TOO_BROAD",
					`This search matches more than ${BROAD_QUERY_LIMIT.toLocaleString("en-US")} messages. Use a rarer term or a from:/subject: operator.`,
				);
			}
		}
		const ftsJoin = Boolean(fts?.match);
		const conditions = [...base.conditions];
		const params = [...base.params];
		if (fts?.match) {
			conditions.push("emails_fts MATCH ?");
			params.push(fts.match);
		} else if (fts?.exclude) {
			conditions.push("e.rowid NOT IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)");
			params.push(fts.exclude);
		}
		const from = ftsJoin
			? "FROM emails_fts INNER JOIN emails e ON e.rowid = emails_fts.rowid"
			: "FROM emails e";
		const pageConditions = cursor.condition ? [...conditions, cursor.condition] : conditions;

		let columns: string;
		const columnParams: unknown[] = [];
		if (content === "full") {
			// Order and page on narrow rows first; the full rows (bodies can be
			// hundreds of KB) are loaded by id afterwards. Sorting e.* made D1
			// run out of CPU on large windows.
			columns = "e.id, COALESCE(e.sent_at, e.received_at) AS sort_at";
		} else if (fts?.match) {
			// The two correlated snippet subqueries each bind the match query,
			// textually before the WHERE params.
			columns = `${MESSAGE_SUMMARY_COLUMNS},
		 ${buildMatchSnippetSubquery("e.rowid")} AS snippet,
		 ${buildMatchSnippetSourceSubquery("e.rowid")} AS snippet_source`;
			columnParams.push(fts.match, fts.match);
		} else {
			columns = `${MESSAGE_SUMMARY_COLUMNS},
		 ${PREFIX_SNIPPET_SQL} AS snippet,
		 NULL AS snippet_source`;
		}

		const select = db
			.prepare(
				`SELECT ${columns} ${from} ${whereSql(pageConditions)}
				 ORDER BY COALESCE(e.sent_at, e.received_at) DESC, e.id DESC
				 LIMIT ? OFFSET ?`,
			)
			.bind(...columnParams, ...params, ...cursor.params, filters.limit + 1, offset);
		// Count once, on the first page: re-counting the whole match set on
		// every cursor page makes a full walk quadratic. Later pages return null.
		let total: number | null = null;
		let rows: Row[];
		if (cursor.condition) {
			rows = (await select.all()).results as Row[];
		} else {
			const [countResult, selectResult] = await db.batch([
				db.prepare(`SELECT COUNT(*) as total ${from} ${whereSql(conditions)}`).bind(...params),
				select,
			]);
			total = Number(((countResult.results as Row[])[0]?.total ?? 0) || 0);
			rows = selectResult.results as Row[];
		}
		const hasMore = rows.length > filters.limit;
		const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
		const lastRow = pageRows[pageRows.length - 1];
		const next_cursor =
			hasMore && lastRow
				? encodeSearchCursor({
						sort_at: Number(lastRow.sort_at ?? lastRow.received_at ?? 0),
						id: String(lastRow.id),
					})
				: undefined;
		let emails: T[];
		if (content === "full") {
			const ids = pageRows.map((row) => String(row.id));
			const full =
				ids.length === 0
					? []
					: ((
							await db
								.prepare(`SELECT * FROM emails WHERE id IN (${ids.map(() => "?").join(", ")})`)
								.bind(...ids)
								.all()
						).results as Row[]);
			const byId = new Map(full.map((row) => [String(row.id), row]));
			emails = ids
				.map((id) => byId.get(id))
				.filter((row): row is Row => Boolean(row))
				.map((row) => mapEmailRecord(row)) as T[];
		} else {
			emails = pageRows.map((row) => mapSearchEmailSummary(row)) as T[];
		}
		return { emails, total, next_cursor, error: undefined, interpreted };
	} catch (e: unknown) {
		return {
			emails: [],
			total: 0,
			next_cursor: undefined,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

/**
 * List. Without a query (and without `rows: "messages"`) this is the
 * conversation list: one row per thread, filtered on thread aggregates and
 * ordered by thread activity. With a query, or `rows: "messages"`, it is
 * message rows from selectMessages.
 */
export async function getEmails(
	db: D1Database,
	filters: EmailFilters,
	domainScope: string[] = [],
	rows: "messages" | "conversations" | undefined = undefined,
) {
	if (rows === "conversations" && filters.q) {
		return {
			emails: [],
			total: 0,
			next_cursor: undefined,
			error: new QueryInputError(
				"UNSUPPORTED",
				"rows=conversations with a search query is not supported; use rows=messages.",
			),
		};
	}
	if (filters.q || rows === "messages") {
		return selectMessages<EmailSummary>(db, filters, domainScope, "summary");
	}
	return getThreadCollapsedEmails(db, filters, domainScope);
}

async function getConversationSummaryByThreadId(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
) {
	const conditions = ["t.id = ?"];
	const params: unknown[] = [threadId];
	if (domainScope.length > 0) {
		conditions.push(`t.domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}
	const where = `WHERE ${conditions.join(" AND ")}`;

	const primaryResult = await db
		.prepare(
			buildThreadConversationSelectSql(
				"INNER JOIN emails e ON e.id = t.latest_email_id",
				where,
				"LIMIT 1",
			),
		)
		.bind(...params)
		.first<Row>();

	if (primaryResult) {
		return mapEmailSummary(primaryResult);
	}

	const fallbackResult = await db
		.prepare(
			buildThreadConversationSelectSql(
				"INNER JOIN emails e ON e.thread_id = t.id",
				where,
				"ORDER BY COALESCE(e.sent_at, e.received_at) DESC LIMIT 1",
			),
		)
		.bind(...params)
		.first<Row>();

	return fallbackResult ? mapEmailSummary(fallbackResult) : null;
}

async function getConversationEmailsByThreadId(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
) {
	const emailConditions = ["thread_id = ?"];
	const emailParams: unknown[] = [threadId];
	if (domainScope.length > 0) {
		emailConditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		emailParams.push(...domainScope);
	}

	const { results } = await db
		.prepare(`SELECT id FROM emails WHERE ${emailConditions.join(" AND ")}`)
		.bind(...emailParams)
		.all<Row>();

	const emailIds = (results ?? [])
		.map((row) => nullableString(row.id)?.trim() ?? "")
		.filter((id): id is string => id !== "");

	if (emailIds.length === 0) {
		return { emails: [] as Email[], error: undefined };
	}

	return getEmailsByIds(db, emailIds, domainScope);
}

/**
 * Conversation-first detail helper keyed by thread id.
 */
export async function getConversationByThreadId(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
) {
	try {
		const [conversation, thread] = await Promise.all([
			getConversationSummaryByThreadId(db, threadId, domainScope),
			getConversationEmailsByThreadId(db, threadId, domainScope),
		]);

		if (thread.error) {
			return { conversation: null, emails: [] as Email[], error: thread.error };
		}

		return {
			conversation,
			emails: thread.emails.sort(
				(a, b) => (a.sent_at ?? a.received_at) - (b.sent_at ?? b.received_at),
			),
			error: undefined,
		};
	} catch (e: unknown) {
		return {
			conversation: null,
			emails: [] as Email[],
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

export async function getConversationDetailByThreadId(
	db: D1Database,
	threadId: string,
	domainScope: string[] = [],
) {
	return getConversationByThreadId(db, threadId, domainScope);
}

export async function getContactSuggestions(
	db: D1Database,
	query: string,
	domainScope: string[] = [],
	limit = 8,
) {
	try {
		return await getContactSuggestionsFromEmails(db, query, domainScope, limit);
	} catch (error: unknown) {
		return {
			contacts: [] as ContactSuggestion[],
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

export async function getEmailsWithContent(
	db: D1Database,
	filters: EmailFilters,
	domainScope: string[] = [],
) {
	// Offset paging stays for the classifier daemon; everyone else uses the cursor.
	return selectMessages<EmailExport>(db, filters, domainScope, "full", { allowOffset: true });
}

export async function getEmailById(
	db: D1Database,
	id: string,
	domainScope: string[] = [],
	options: { bucket?: R2Bucket } = {},
) {
	try {
		const emailConditions = ["id = ?"];
		const emailParams: unknown[] = [id];
		pushDomainScope(emailConditions, emailParams, domainScope);

		const attachmentConditions = ["attachments.email_id = ?"];
		const attachmentParams: unknown[] = [id];
		pushDomainScope(attachmentConditions, attachmentParams, domainScope);

		const [emailResult, attachmentResult] = await db.batch([
			db
				.prepare(`SELECT * FROM emails WHERE ${emailConditions.join(" AND ")}`)
				.bind(...emailParams),
			db
				.prepare(
					`SELECT
						attachments.id as id,
						attachments.email_id as email_id,
						attachments.object_key as object_key,
						attachments.filename as filename,
						attachments.mime_type as mime_type,
						attachments.size as size,
						attachments.disposition as disposition,
						attachments.content_id as content_id,
						attachments.created_at as created_at
					FROM attachments
					INNER JOIN emails ON emails.id = attachments.email_id
					WHERE ${attachmentConditions.join(" AND ")}
					ORDER BY attachments.created_at ASC, attachments.id ASC`,
				)
				.bind(...attachmentParams),
		]);

		const row = emailResult.results?.[0] as Row | undefined;
		if (!row) {
			return { email: null, error: undefined };
		}

		const email: Email = {
			...mapEmailRecord(row),
			attachments: ((attachmentResult.results ?? []) as Row[]).map(mapAttachment),
		} as Email;

		// R2 hydration: if html_content was offloaded, pull it back for the caller.
		if (email.html_in_r2 && email.r2_html_key && options.bucket) {
			try {
				email.html_content = await getEmailBodyFromR2(options.bucket, email.r2_html_key);
			} catch (err) {
				logError("html_hydrate_r2_get_failed", {
					email_id: id,
					key: email.r2_html_key,
					error: err instanceof Error ? err.message : String(err),
				});
				// Leave html_content null — UI handles gracefully.
			}
		}

		return { email, error: undefined };
	} catch (e: unknown) {
		return { email: null, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * Partial content update used by the local backfill/extractor pipeline.
 * STRICTLY ADDITIVE: only the fields present (!== undefined) in `content` are
 * written — sending only attachment fields must never touch text_content or
 * html_content (user policy: never delete/null email content).
 */
export async function hydrateEmailContent(
	db: D1Database,
	id: string,
	content: {
		html_content?: string | null;
		text_content?: string | null;
		attachment_names?: string | null;
		attachment_search_text?: string | null;
	},
	domainScope: string[] = [],
	options: { bucket?: R2Bucket; received_at?: number } = {},
) {
	try {
		const sets: string[] = [];
		const params: unknown[] = [];
		const offloadColumnsReady =
			content.html_content !== undefined ? await isHtmlOffloadColumnsReady(db) : false;

		if (content.html_content !== undefined) {
			let htmlValue: string | null = content.html_content ?? null;
			if (options.bucket && offloadColumnsReady) {
				const decision = shouldOffloadHtml({
					html_content: content.html_content,
					received_at: options.received_at,
				});
				if (decision.offload && content.html_content) {
					try {
						const key = await putEmailBodyToR2(options.bucket, id, content.html_content);
						htmlValue = null;
						sets.push("html_in_r2 = ?");
						params.push(1);
						sets.push("r2_html_key = ?");
						params.push(key);
					} catch (err) {
						logError("html_offload_r2_put_failed", {
							email_id: id,
							context: "hydrateEmailContent",
							size: content.html_content.length,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				} else if (offloadColumnsReady) {
					sets.push("html_in_r2 = ?");
					params.push(0);
					sets.push("r2_html_key = ?");
					params.push(null);
				}
			}
			sets.push("html_content = ?");
			params.push(htmlValue);
		}
		if (content.text_content !== undefined) {
			sets.push("text_content = ?");
			params.push(content.text_content);
		}
		if (content.attachment_names !== undefined && (await isAttachmentNamesColumnReady(db))) {
			sets.push("attachment_names = ?");
			params.push(content.attachment_names);
		}
		if (
			content.attachment_search_text !== undefined &&
			(await isAttachmentSearchTextColumnReady(db))
		) {
			sets.push("attachment_search_text = ?");
			params.push(content.attachment_search_text);
		}
		if (sets.length === 0) {
			return { updated: false, error: undefined };
		}

		const conditions = ["id = ?"];
		params.push(id);
		pushDomainScope(conditions, params, domainScope);

		const { meta } = await db
			.prepare(`UPDATE emails SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`)
			.bind(...params)
			.run();

		return { updated: (meta?.changes ?? 0) > 0, error: undefined };
	} catch (e: unknown) {
		return { updated: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function insertAttachments(db: D1Database, attachments: EmailAttachment[]) {
	try {
		if (attachments.length === 0) {
			return { success: true, error: undefined };
		}

		// v34: tag every newly ingested attachment row for the local text
		// extractor — 'pending' for extractable document types, 'skipped:type'
		// otherwise. Gated so pre-migration environments keep working.
		const extractStatusReady = await isAttachmentExtractStatusColumnReady(db);
		const columns = [
			"id",
			"email_id",
			"object_key",
			"filename",
			"mime_type",
			"size",
			"disposition",
			"content_id",
			"created_at",
		];
		if (extractStatusReady) {
			columns.push("extract_status");
		}
		const insertSql = `INSERT INTO attachments (${columns.join(", ")}) VALUES (${columns
			.map(() => "?")
			.join(", ")})`;

		await db.batch(
			attachments.map((attachment) => {
				const values: unknown[] = [
					attachment.id,
					attachment.email_id,
					attachment.object_key,
					attachment.filename,
					attachment.mime_type,
					attachment.size,
					attachment.disposition,
					attachment.content_id,
					attachment.created_at,
				];
				if (extractStatusReady) {
					values.push(resolveAttachmentExtractStatus(attachment.mime_type, attachment.filename));
				}
				return db.prepare(insertSql).bind(...values);
			}),
		);

		await refreshAttachmentNames(db, [
			...new Set(attachments.map((attachment) => attachment.email_id)),
		]);

		return { success: true, error: undefined };
	} catch (e: unknown) {
		return { success: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * Set emails.attachment_names to an explicit value. Used by the import path
 * for metadata-only attachments (filename known, no stored payload): those
 * never get attachments rows, so refreshAttachmentNames — which recomputes
 * from the attachments table — would drop their filenames. The v34 UPDATE OF
 * trigger syncs emails_fts.
 */
export async function setEmailAttachmentNames(
	db: D1Database,
	emailId: string,
	attachmentNames: string,
	domainScope: string[] = [],
): Promise<{ updated: boolean; error?: Error }> {
	try {
		if (!(await isAttachmentNamesColumnReady(db))) {
			return { updated: false };
		}
		const conditions = ["id = ?"];
		const params: unknown[] = [attachmentNames, emailId];
		pushDomainScope(conditions, params, domainScope);
		const { meta } = await db
			.prepare(`UPDATE emails SET attachment_names = ? WHERE ${conditions.join(" AND ")}`)
			.bind(...params)
			.run();
		return { updated: (meta?.changes ?? 0) > 0 };
	} catch (e: unknown) {
		return { updated: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * Reconcile an email's `has_attachments` / `attachment_count` columns with the
 * attachment rows that actually exist, and return its thread_id so the caller
 * can refresh the thread aggregate. Derives both flags from `COUNT(*)` of
 * attachment rows — but ONLY when rows exist, so the metadata-only import flow
 * (intentional has_attachments=1 with zero rows + attachment_names) is left
 * untouched. This closes the gap where a repair (or a partial ingest failure)
 * left the email row disagreeing with stored attachments (dropped PDFs at ingest,
 * attachments lost by an import).
 */
export async function reconcileEmailAttachmentFlags(
	db: D1Database,
	emailId: string,
	domainScope: string[] = [],
): Promise<{ updated: boolean; threadId: string | null; error?: Error }> {
	try {
		const conditions = ["id = ?"];
		const params: unknown[] = [emailId];
		pushDomainScope(conditions, params, domainScope);
		const rowCount = "(SELECT COUNT(*) FROM attachments WHERE attachments.email_id = emails.id)";
		await db
			.prepare(
				`UPDATE emails
				 SET has_attachments = CASE WHEN ${rowCount} > 0 THEN 1 ELSE has_attachments END,
				     attachment_count = CASE WHEN ${rowCount} > 0 THEN ${rowCount} ELSE attachment_count END
				 WHERE ${conditions.join(" AND ")}`,
			)
			.bind(...params)
			.run();
		const row = await db
			.prepare("SELECT thread_id FROM emails WHERE id = ?")
			.bind(emailId)
			.first<{ thread_id: string | null }>();
		return { updated: true, threadId: row?.thread_id ?? null };
	} catch (e: unknown) {
		return { updated: false, threadId: null, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

async function refreshAttachmentNames(
	db: D1Database,
	emailIds: string[],
	domainScope: string[] = [],
): Promise<void> {
	if (emailIds.length === 0 || !(await isAttachmentNamesColumnReady(db))) return;

	await db.batch(
		emailIds.map((emailId) => {
			const conditions = ["id = ?"];
			const whereParams: unknown[] = [emailId];
			pushDomainScope(conditions, whereParams, domainScope);
			return db
				.prepare(
					`UPDATE emails
					 SET attachment_names = COALESCE((
						 SELECT GROUP_CONCAT(COALESCE(filename, ''), ' ')
						 FROM attachments
						 WHERE email_id = ?
					 ), '')
					 WHERE ${conditions.join(" AND ")}`,
				)
				.bind(emailId, ...whereParams);
		}),
	);
}

export async function replaceDraftAttachmentsAtomic(
	db: D1Database,
	draftId: string,
	attachments: EmailAttachment[],
	domainScope: string[] = [],
) {
	try {
		const hasAttachments = attachments.length > 0;
		const updateConditions = ["id = ?", "mailbox_state = 'draft'"];
		const updateParams: unknown[] = [hasAttachments, attachments.length, draftId];
		pushDomainScope(updateConditions, updateParams, domainScope);

		const statements: D1PreparedStatement[] = [
			db.prepare("DELETE FROM attachments WHERE email_id = ?").bind(draftId),
			...attachments.map((attachment) =>
				db
					.prepare(
						`INSERT INTO attachments (
							id,
							email_id,
							object_key,
							filename,
							mime_type,
							size,
							disposition,
							content_id,
							created_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						attachment.id,
						attachment.email_id,
						attachment.object_key,
						attachment.filename,
						attachment.mime_type,
						attachment.size,
						attachment.disposition,
						attachment.content_id,
						attachment.created_at,
					),
			),
			db
				.prepare(
					`UPDATE emails
					 SET has_attachments = ?, attachment_count = ?
					 WHERE ${updateConditions.join(" AND ")}`,
				)
				.bind(...updateParams),
		];

		await db.batch(statements);
		await refreshAttachmentNames(db, [draftId], domainScope);
		return { success: true, error: undefined };
	} catch (e: unknown) {
		return { success: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * A keyed send's attachment rows (ticket 08): make the draft's rows exactly `rows`,
 * insert-if-missing, so every attempt with the key can run this and none can undo another.
 * Row ids encode the position, so rows sharing created_at still read back in order. Rows of
 * another layout (an old Worker's preparation) are dropped; their R2 objects are left
 * alone. Nothing happens once the email is no longer a draft: a sent copy's rows are fixed.
 */
export async function ensureSendAttachments(
	db: D1Database,
	emailId: string,
	rows: EmailAttachment[],
): Promise<{ error?: Error }> {
	try {
		const isDraft = "EXISTS (SELECT 1 FROM emails WHERE id = ? AND mailbox_state = 'draft')";
		const ids = rows.map((row) => row.id);
		const keep = ids.length > 0 ? `AND id NOT IN (${ids.map(() => "?").join(", ")})` : "";
		await db.batch([
			db
				.prepare(`DELETE FROM attachments WHERE email_id = ? ${keep} AND ${isDraft}`)
				.bind(emailId, ...ids, emailId),
			...rows.map((row) =>
				db
					.prepare(
						`INSERT INTO attachments
						 (id, email_id, object_key, filename, mime_type, size, disposition, content_id, created_at)
						 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${isDraft}
						 ON CONFLICT(id) DO NOTHING`,
					)
					.bind(
						row.id,
						emailId,
						row.object_key,
						row.filename,
						row.mime_type,
						row.size,
						row.disposition,
						row.content_id,
						row.created_at,
						emailId,
					),
			),
			db
				.prepare(
					`UPDATE emails SET has_attachments = ?, attachment_count = ?
					 WHERE id = ? AND mailbox_state = 'draft'`,
				)
				.bind(rows.length > 0, rows.length, emailId),
		]);
		await refreshAttachmentNames(db, [emailId]);
		return {};
	} catch (e: unknown) {
		return { error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function getAttachmentsByEmailId(
	db: D1Database,
	emailId: string,
	domainScope: string[] = [],
) {
	try {
		const conditions = ["attachments.email_id = ?"];
		const params: unknown[] = [emailId];
		pushDomainScope(conditions, params, domainScope);

		const { results } = await db
			.prepare(
				`SELECT
					attachments.id as id,
					attachments.email_id as email_id,
					attachments.object_key as object_key,
					attachments.filename as filename,
					attachments.mime_type as mime_type,
					attachments.size as size,
					attachments.disposition as disposition,
					attachments.content_id as content_id,
					attachments.created_at as created_at
				FROM attachments
				INNER JOIN emails ON emails.id = attachments.email_id
				WHERE ${conditions.join(" AND ")}
				ORDER BY attachments.created_at ASC, attachments.id ASC`,
			)
			.bind(...params)
			.all();

		return {
			attachments: (results as Row[]).map((row) => mapAttachment(row)),
			error: undefined,
		};
	} catch (e: unknown) {
		return { attachments: [], error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function getAttachmentById(
	db: D1Database,
	emailId: string,
	attachmentId: string,
	domainScope: string[] = [],
) {
	try {
		const conditions = ["attachments.email_id = ?", "attachments.id = ?"];
		const params: unknown[] = [emailId, attachmentId];
		pushDomainScope(conditions, params, domainScope);

		const result = await db
			.prepare(
				`SELECT
					attachments.id as id,
					attachments.email_id as email_id,
					attachments.object_key as object_key,
					attachments.filename as filename,
					attachments.mime_type as mime_type,
					attachments.size as size,
					attachments.disposition as disposition,
					attachments.content_id as content_id,
					attachments.created_at as created_at
				FROM attachments
				INNER JOIN emails ON emails.id = attachments.email_id
				WHERE ${conditions.join(" AND ")}`,
			)
			.bind(...params)
			.first<Row>();

		if (!result) {
			return { attachment: null, error: undefined };
		}

		return { attachment: mapAttachment(result), error: undefined };
	} catch (e: unknown) {
		return { attachment: null, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export interface AttachmentExtractQueueRow {
	id: string;
	email_id: string;
	filename: string | null;
	mime_type: string;
	size: number;
	extract_status: string | null;
	text_extracted_at: number | null;
	created_at: number;
}

/**
 * List attachment rows by extraction status for the local text-extraction
 * sidecar (v34 attachment search). `extractStatus === null` selects rows that
 * were never stamped (pre-v34 ingests) so backfills can triage them.
 */
export async function listAttachmentsByExtractStatus(
	db: D1Database,
	extractStatus: string | null,
	limit: number,
	domainScope: string[] = [],
) {
	try {
		const conditions = [
			extractStatus === null
				? "attachments.extract_status IS NULL"
				: "attachments.extract_status = ?",
		];
		const params: unknown[] = extractStatus === null ? [] : [extractStatus];
		pushDomainScope(conditions, params, domainScope);
		params.push(limit);

		const { results } = await db
			.prepare(
				`SELECT
					attachments.id as id,
					attachments.email_id as email_id,
					attachments.filename as filename,
					attachments.mime_type as mime_type,
					attachments.size as size,
					attachments.extract_status as extract_status,
					attachments.text_extracted_at as text_extracted_at,
					attachments.created_at as created_at
				FROM attachments
				INNER JOIN emails ON emails.id = attachments.email_id
				WHERE ${conditions.join(" AND ")}
				ORDER BY attachments.created_at ASC
				LIMIT ?`,
			)
			.bind(...params)
			.all();

		const attachments: AttachmentExtractQueueRow[] = (results as Row[]).map((row) => ({
			id: String(row.id),
			email_id: String(row.email_id),
			filename: nullableString(row.filename),
			mime_type: String(row.mime_type),
			size: Number(row.size ?? 0),
			extract_status: nullableString(row.extract_status),
			text_extracted_at: numberOrNull(row.text_extracted_at),
			created_at: Number(row.created_at),
		}));

		return { attachments, error: undefined };
	} catch (e: unknown) {
		return {
			attachments: [] as AttachmentExtractQueueRow[],
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

/**
 * Flip one attachment row's extract_status (sidecar bookkeeping). Stamps
 * text_extracted_at only when the row reaches 'done'; emails table content is
 * never touched here — extracted text flows through hydrateEmailContent.
 */
export async function updateAttachmentExtractStatus(
	db: D1Database,
	attachmentId: string,
	extractStatus: string,
	domainScope: string[] = [],
) {
	try {
		const sets = ["extract_status = ?"];
		const params: unknown[] = [extractStatus];
		if (extractStatus === "done") {
			sets.push("text_extracted_at = ?");
			params.push(now());
		}

		const conditions = ["id = ?"];
		params.push(attachmentId);
		if (domainScope.length > 0) {
			conditions.push(
				`email_id IN (SELECT id FROM emails WHERE domain IN (${domainScope
					.map(() => "?")
					.join(", ")}))`,
			);
			params.push(...domainScope);
		}

		const { meta } = await db
			.prepare(`UPDATE attachments SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`)
			.bind(...params)
			.run();

		return { updated: (meta?.changes ?? 0) > 0, error: undefined };
	} catch (e: unknown) {
		return { updated: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function deleteEmailById(db: D1Database, id: string, domainScope: string[] = []) {
	try {
		const conditions = ["id = ?"];
		const params: unknown[] = [id];
		pushDomainScope(conditions, params, domainScope);
		// Get thread_id before deletion
		let threadId: string | null = null;
		try {
			const row = await db
				.prepare(`SELECT thread_id FROM emails WHERE ${conditions.join(" AND ")}`)
				.bind(...params)
				.first<Row>();
			threadId = row?.thread_id ? String(row.thread_id) : null;
		} catch {
			// thread_id column may not exist yet
		}

		const deletion = db
			.prepare(`DELETE FROM emails WHERE ${conditions.join(" AND ")}`)
			.bind(...params);
		// Removing the last member and its projection is one transaction. A
		// failed/cancelled refresh after DELETE must not leave a dead draft row.
		const { meta } =
			threadId && (await isThreadsTableReady(db))
				? (
						await db.batch([
							deletion,
							db
								.prepare(
									"DELETE FROM threads WHERE id = ? AND NOT EXISTS (SELECT 1 FROM emails WHERE thread_id = ?)",
								)
								.bind(threadId, threadId),
						])
					)[0]
				: await deletion.run();
		const deleted = (meta?.changes ?? 0) > 0;

		if (deleted) {
			await db.prepare("DELETE FROM attachments WHERE email_id = ?").bind(id).run();

			// Refresh thread (will delete thread row if no emails remain)
			if (threadId) {
				await refreshThreadSafe(db, threadId);
			}
		}

		return { deleted, error: undefined };
	} catch (e: unknown) {
		return { deleted: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/** Find emails in trash older than a threshold for auto-purge. */
export async function getTrashedEmailsForPurge(
	db: D1Database,
	olderThanMs: number,
	limit = 100,
): Promise<{ emails: Array<{ id: string; attachmentKeys: string[] }>; error?: Error }> {
	try {
		if (!(await isTrashedAtColumnReady(db))) {
			return { emails: [] };
		}

		const cutoff = now() - olderThanMs;
		const { results } = await db
			.prepare(
				`SELECT e.id, GROUP_CONCAT(a.object_key) as attachment_keys
				 FROM emails e
				 LEFT JOIN attachments a ON a.email_id = e.id
				 WHERE e.mailbox_state = 'trash' AND e.trashed_at IS NOT NULL AND e.trashed_at < ?
				 GROUP BY e.id
				 LIMIT ?`,
			)
			.bind(cutoff, limit)
			.all();

		return {
			emails: (results as Row[]).map((row) => ({
				id: String(row.id),
				attachmentKeys: row.attachment_keys ? String(row.attachment_keys).split(",") : [],
			})),
		};
	} catch (e: unknown) {
		return { emails: [], error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function updateEmailById(
	db: D1Database,
	id: string,
	updates: UpdateEmailRequest,
	domainScope: string[] = [],
) {
	try {
		const sets: string[] = [];
		const params: unknown[] = [];
		const trashedAtColumnReady = updates.mailbox_state ? await isTrashedAtColumnReady(db) : false;

		if (updates.mailbox_state) {
			sets.push("mailbox_state = ?");
			params.push(updates.mailbox_state);
			if (trashedAtColumnReady && updates.mailbox_state === "trash") {
				sets.push("trashed_at = ?");
				params.push(now());
			} else if (trashedAtColumnReady) {
				sets.push("trashed_at = NULL");
			}
		}

		if (typeof updates.is_read === "boolean") {
			sets.push("read_at = ?");
			params.push(updates.is_read ? now() : null);
		}

		if (updates.category !== undefined) {
			sets.push("category = ?");
			params.push(updates.category);
		}

		if (updates.interest_level !== undefined) {
			sets.push("interest_level = ?");
			params.push(updates.interest_level);
		}

		if (updates.interest_comment !== undefined) {
			sets.push("interest_comment = ?");
			params.push(updates.interest_comment);
		}

		if (updates.user_kept_unread !== undefined) {
			// Phase 1.4: setting user_kept_unread = true also marks the email unread
			// so the row immediately shows in the unread view; setting it false
			// doesn't touch read_at (the user can mark-read separately).
			sets.push("user_kept_unread = ?");
			params.push(updates.user_kept_unread ? 1 : 0);
			if (updates.user_kept_unread === true && updates.is_read === undefined) {
				sets.push("read_at = ?");
				params.push(null);
			}
		}

		if (updates.classification_uncertain !== undefined) {
			sets.push("classification_uncertain = ?");
			params.push(updates.classification_uncertain ? 1 : 0);
		}

		if (updates.sub_category !== undefined) {
			sets.push("sub_category = ?");
			params.push(updates.sub_category);
		}

		if (sets.length === 0) {
			return { updated: false, error: undefined };
		}

		const conditions = ["id = ?"];
		params.push(id);
		pushDomainScope(conditions, params, domainScope);

		const { meta } = await db
			.prepare(`UPDATE emails SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`)
			.bind(...params)
			.run();

		// Refresh thread if state changed
		if ((meta?.changes ?? 0) > 0) {
			const row = await db
				.prepare("SELECT thread_id FROM emails WHERE id = ?")
				.bind(id)
				.first<Row>();
			if (row?.thread_id) {
				await refreshThreadSafe(db, String(row.thread_id));
			}
		}

		return { updated: (meta?.changes ?? 0) > 0, error: undefined };
	} catch (e: unknown) {
		return { updated: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

async function getBatchActionUpdate(
	db: D1Database,
	action: EmailBatchActionRequest["action"],
): Promise<{
	setClause: string;
	params: unknown[];
}> {
	const trashedAtColumnReady =
		action === "trash" || action === "restore" ? await isTrashedAtColumnReady(db) : false;

	switch (action) {
		case "archive":
			return { setClause: "mailbox_state = ?", params: ["archived"] };
		case "trash":
			return trashedAtColumnReady
				? { setClause: "mailbox_state = ?, trashed_at = ?", params: ["trash", now()] }
				: { setClause: "mailbox_state = ?", params: ["trash"] };
		case "restore":
			return trashedAtColumnReady
				? {
						setClause:
							"mailbox_state = CASE WHEN direction = 'outbound' AND sent_at IS NULL AND provider_message_id IS NULL THEN 'draft' WHEN direction = 'outbound' THEN 'sent' ELSE 'inbox' END, trashed_at = NULL",
						params: [],
					}
				: {
						setClause:
							"mailbox_state = CASE WHEN direction = 'outbound' AND sent_at IS NULL AND provider_message_id IS NULL THEN 'draft' WHEN direction = 'outbound' THEN 'sent' ELSE 'inbox' END",
						params: [],
					};
		case "mark_read":
			return { setClause: "read_at = ?", params: [now()] };
		case "mark_unread":
			return { setClause: "read_at = ?", params: [null] };
		case "set_personal":
			return {
				setClause: "category = 'personal', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_billing":
			return {
				setClause: "category = 'billing', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_agents":
			return {
				setClause: "category = 'agents', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_notifications":
			return {
				setClause: "category = 'notifications', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_newsletters":
			return {
				setClause: "category = 'newsletters', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_marketing":
			return {
				setClause: "category = 'marketing', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_spam":
			return {
				setClause: "category = 'spam', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_home_alerts":
			return {
				setClause: "category = 'home_alerts', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "set_tax_documents":
			return {
				setClause: "category = 'tax_documents', sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		case "clear_category":
			return {
				setClause: "category = NULL, sub_category = NULL, classification_uncertain = 0",
				params: [],
			};
		default:
			throw new Error(`Unsupported batch action: ${action}`);
	}
}

function parseDraftAddressList(value?: string | string[]): string[] {
	if (!value) {
		return [];
	}

	return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
}

export async function createDraft(
	db: D1Database,
	email: EmailRecord,
	options: { bucket?: R2Bucket } = {},
) {
	return insertEmail(db, email, options);
}

export async function updateDraftById(
	db: D1Database,
	id: string,
	updates: UpdateDraftRequest,
	domainScope: string[] = [],
	options: { bucket?: R2Bucket; expectedDraftRevision?: number } = {},
) {
	try {
		const sets: string[] = [];
		const params: unknown[] = [];
		const composeDraftColumnsReady =
			updates.draft_revision !== undefined ||
			updates.editor_state_json !== undefined ||
			options.expectedDraftRevision !== undefined
				? await areComposeDraftColumnsReady(db)
				: false;
		const offloadColumnsReady =
			updates.html !== undefined ? await isHtmlOffloadColumnsReady(db) : false;
		if (options.expectedDraftRevision !== undefined && !composeDraftColumnsReady) {
			return {
				updated: false,
				error: new Error("Draft revision columns are not available"),
			};
		}

		if (updates.from !== undefined) {
			sets.push("from_address = ?");
			params.push(updates.from);
		}
		if (updates.domain !== undefined) {
			sets.push("domain = ?");
			params.push(updates.domain);
		}
		if (updates.mailbox !== undefined) {
			sets.push("mailbox = ?");
			params.push(updates.mailbox);
		}
		if (updates.to !== undefined) {
			const values = parseDraftAddressList(updates.to);
			sets.push("to_address = ?");
			params.push(values[0] || "");
			sets.push("to_addresses_json = ?");
			params.push(serializeStringArray(values));
		}
		if (updates.cc !== undefined) {
			sets.push("cc_addresses_json = ?");
			params.push(serializeStringArray(parseDraftAddressList(updates.cc)));
		}
		if (updates.bcc !== undefined) {
			sets.push("bcc_addresses_json = ?");
			params.push(serializeStringArray(parseDraftAddressList(updates.bcc)));
		}
		if (updates.reply_to !== undefined) {
			sets.push("reply_to_addresses_json = ?");
			params.push(serializeStringArray(parseDraftAddressList(updates.reply_to)));
		}
		if (updates.subject !== undefined) {
			sets.push("subject = ?");
			params.push(updates.subject || null);
		}
		if (updates.html !== undefined) {
			// Re-evaluate offload on every draft update. Small drafts stay
			// inline; when a user pastes a huge body the row heads to R2 and
			// any previous R2 object for the same id is overwritten.
			let htmlValue: string | null = updates.html ?? null;
			if (options.bucket && offloadColumnsReady) {
				const decision = shouldOffloadHtml({
					html_content: updates.html,
					// Drafts are always "now" — only the size threshold matters here.
					received_at: Date.now(),
				});
				if (decision.offload && updates.html) {
					try {
						const key = await putEmailBodyToR2(options.bucket, id, updates.html);
						htmlValue = null;
						sets.push("html_in_r2 = ?");
						params.push(1);
						sets.push("r2_html_key = ?");
						params.push(key);
					} catch (err) {
						logError("html_offload_r2_put_failed", {
							email_id: id,
							context: "updateDraftById",
							size: updates.html?.length ?? 0,
							error: err instanceof Error ? err.message : String(err),
						});
						// Fall through: store inline, clear offload flags if the previous
						// draft revision had a tiny body that no longer needs R2.
						if (offloadColumnsReady) {
							sets.push("html_in_r2 = ?");
							params.push(0);
							sets.push("r2_html_key = ?");
							params.push(null);
						}
					}
				} else if (offloadColumnsReady) {
					// Body shrunk back under the threshold — clear any prior R2 flag.
					sets.push("html_in_r2 = ?");
					params.push(0);
					sets.push("r2_html_key = ?");
					params.push(null);
				}
			}
			sets.push("html_content = ?");
			params.push(htmlValue);
		}
		if (updates.text !== undefined) {
			sets.push("text_content = ?");
			params.push(updates.text);
		}
		if (updates.has_attachments !== undefined) {
			sets.push("has_attachments = ?");
			params.push(updates.has_attachments);
		}
		if (updates.attachment_count !== undefined) {
			sets.push("attachment_count = ?");
			params.push(updates.attachment_count);
		}
		if (composeDraftColumnsReady && updates.draft_revision !== undefined) {
			sets.push("draft_revision = ?");
			params.push(updates.draft_revision);
		}
		if (composeDraftColumnsReady && updates.editor_state_json !== undefined) {
			sets.push("editor_state_json = ?");
			params.push(updates.editor_state_json);
		}
		if (updates.in_reply_to !== undefined) {
			sets.push("in_reply_to = ?");
			params.push(updates.in_reply_to);
		}
		if (updates.references !== undefined) {
			sets.push("references_header = ?");
			params.push(updates.references);
		}

		if (sets.length === 0) {
			return { updated: false, error: undefined };
		}

		const conditions = ["id = ?", "mailbox_state = 'draft'"];
		params.push(id);
		pushDomainScope(conditions, params, domainScope);
		if (composeDraftColumnsReady && options.expectedDraftRevision !== undefined) {
			conditions.push("draft_revision = ?");
			params.push(options.expectedDraftRevision);
		}

		const { meta } = await db
			.prepare(`UPDATE emails SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`)
			.bind(...params)
			.run();

		return { updated: (meta?.changes ?? 0) > 0, error: undefined };
	} catch (e: unknown) {
		return { updated: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function markDraftSendAcceptedFallback(
	db: D1Database,
	id: string,
	payload: {
		provider_message_id: string;
		message_id: string | null;
		sent_at: number;
	},
	domainScope: string[] = [],
): Promise<{ updated: boolean; error?: Error }> {
	try {
		const conditions = ["id = ?", "mailbox_state = 'draft'"];
		const params: unknown[] = [
			payload.sent_at,
			payload.sent_at,
			payload.provider_message_id,
			payload.message_id,
			id,
		];
		pushDomainScope(conditions, params, domainScope);
		const { meta } = await db
			.prepare(
				`UPDATE emails
				 SET sent_at = ?,
				     read_at = ?,
				     provider_message_id = ?,
				     message_id = COALESCE(?, message_id),
				     mailbox_state = 'sent'
				 WHERE ${conditions.join(" AND ")}`,
			)
			.bind(...params)
			.run();
		return { updated: (meta?.changes ?? 0) > 0 };
	} catch (e: unknown) {
		return { updated: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function finalizeDraftSend(
	db: D1Database,
	id: string,
	payload: {
		from_address: string;
		to_addresses: string[];
		cc_addresses: string[];
		bcc_addresses: string[];
		reply_to_addresses: string[];
		subject: string;
		html_content: string | null;
		text_content: string | null;
		provider_message_id: string;
		message_id: string | null;
		thread_id: string | null;
		in_reply_to: string | null;
		references_header: string | null;
		has_attachments: boolean;
		attachment_count: number;
		sent_at: number;
	},
	domainScope: string[] = [],
	options: { bucket?: R2Bucket } = {},
) {
	try {
		// HTML offload decision. Sent emails use payload.sent_at as the
		// timestamp for the age check (they're always "fresh" so only the
		// size threshold practically applies to outbound).
		let htmlContent: string | null = payload.html_content;
		let htmlInR2 = 0;
		let r2HtmlKey: string | null = null;
		const offloadColumnsReady = await isHtmlOffloadColumnsReady(db);
		if (options.bucket && offloadColumnsReady) {
			const decision = shouldOffloadHtml({
				html_content: payload.html_content,
				received_at: payload.sent_at,
			});
			if (decision.offload && payload.html_content) {
				try {
					r2HtmlKey = await putEmailBodyToR2(options.bucket, id, payload.html_content);
					htmlContent = null;
					htmlInR2 = 1;
				} catch (err) {
					logError("html_offload_r2_put_failed", {
						email_id: id,
						context: "finalizeDraftSend",
						size: payload.html_content.length,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		const conditions = ["id = ?", "mailbox_state = 'draft'"];
		const params: unknown[] = [
			payload.from_address,
			payload.to_addresses[0] || "",
			serializeStringArray(payload.to_addresses),
			serializeStringArray(payload.cc_addresses),
			serializeStringArray(payload.bcc_addresses),
			serializeStringArray(payload.reply_to_addresses),
			payload.subject,
			payload.sent_at,
			payload.sent_at,
			htmlContent,
			payload.text_content,
			payload.provider_message_id,
			payload.message_id,
			payload.thread_id,
			payload.in_reply_to,
			payload.references_header,
			payload.has_attachments,
			payload.attachment_count,
		];
		if (offloadColumnsReady) {
			params.push(htmlInR2, r2HtmlKey);
		}
		params.push(id);
		pushDomainScope(conditions, params, domainScope);

		const setOffload = offloadColumnsReady
			? ",\n\t\t\t\t     html_in_r2 = ?,\n\t\t\t\t     r2_html_key = ?"
			: "";
		const { meta } = await db
			.prepare(
				`UPDATE emails
				 SET from_address = ?,
				     to_address = ?,
				     to_addresses_json = ?,
				     cc_addresses_json = ?,
				     bcc_addresses_json = ?,
				     reply_to_addresses_json = ?,
				     subject = ?,
				     sent_at = ?,
				     read_at = ?,
				     html_content = ?,
				     text_content = ?,
				     provider_message_id = ?,
				     message_id = ?,
				     thread_id = ?,
				     in_reply_to = ?,
				     references_header = ?,
				     mailbox_state = 'sent',
				     has_attachments = ?,
				     attachment_count = ?${setOffload}
				 WHERE ${conditions.join(" AND ")}`,
			)
			.bind(...params)
			.run();

		return { updated: (meta?.changes ?? 0) > 0, error: undefined };
	} catch (e: unknown) {
		return { updated: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * D1 caps prepared-statement bind parameters at ~100 per query. A thread
 * of 100+ messages blew through that limit (one
 * placeholder per id plus domain-scope params), triggering
 * "too many SQL variables" 500s. Chunk the id list into sub-batches
 * that stay safely under the cap.
 */
const MAX_IDS_PER_QUERY = 80;

async function getEmailsByIds(db: D1Database, ids: string[], domainScope: string[] = []) {
	if (ids.length === 0) {
		return { emails: [] as Email[], error: undefined };
	}

	try {
		const chunks: string[][] = [];
		for (let i = 0; i < ids.length; i += MAX_IDS_PER_QUERY) {
			chunks.push(ids.slice(i, i + MAX_IDS_PER_QUERY));
		}

		// Build one emails-select + one attachments-select per chunk, then
		// batch everything into a single D1 round-trip. Two statements per
		// chunk so the batch stays tiny compared to the serial alternative.
		const statements = chunks.flatMap((chunk) => {
			const emailConditions = [`id IN (${chunk.map(() => "?").join(", ")})`];
			const emailParams: unknown[] = [...chunk];
			pushDomainScope(emailConditions, emailParams, domainScope);

			const attachmentConditions = [`attachments.email_id IN (${chunk.map(() => "?").join(", ")})`];
			const attachmentParams: unknown[] = [...chunk];
			pushDomainScope(attachmentConditions, attachmentParams, domainScope);

			return [
				db
					.prepare(`SELECT * FROM emails WHERE ${emailConditions.join(" AND ")}`)
					.bind(...emailParams),
				db
					.prepare(
						`SELECT
							attachments.id as id,
							attachments.email_id as email_id,
							attachments.object_key as object_key,
							attachments.filename as filename,
							attachments.mime_type as mime_type,
							attachments.size as size,
							attachments.disposition as disposition,
							attachments.content_id as content_id,
							attachments.created_at as created_at
						FROM attachments
						INNER JOIN emails ON emails.id = attachments.email_id
						WHERE ${attachmentConditions.join(" AND ")}
						ORDER BY attachments.email_id, attachments.created_at ASC`,
					)
					.bind(...attachmentParams),
			];
		});

		const batchResults = await db.batch(statements);

		// Statements come back in pairs: [emailResult, attachmentResult, ...].
		const attachmentsByEmailId = new Map<string, EmailAttachment[]>();
		const emails: Email[] = [];
		for (let i = 0; i < batchResults.length; i += 2) {
			const emailResult = batchResults[i];
			const attachmentResult = batchResults[i + 1];

			for (const row of (attachmentResult.results ?? []) as Row[]) {
				const emailId = String(row.email_id);
				const list = attachmentsByEmailId.get(emailId) ?? [];
				list.push(mapAttachment(row));
				attachmentsByEmailId.set(emailId, list);
			}

			for (const row of (emailResult.results ?? []) as Row[]) {
				const record = mapEmailRecord(row);
				emails.push({
					...record,
					attachments: attachmentsByEmailId.get(record.id) ?? [],
				});
			}
		}

		return { emails, error: undefined };
	} catch (e: unknown) {
		return { emails: [] as Email[], error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function getThreadByEmailId(db: D1Database, id: string, domainScope: string[] = []) {
	try {
		const { email, error } = await getEmailById(db, id, domainScope);
		if (error) return { emails: [] as Email[], error };
		if (!email) return { emails: [] as Email[], error: undefined };

		// Prefer the assigned conversation membership when we have it.
		if (email.thread_id) {
			const conversation = await getConversationByThreadId(db, email.thread_id, domainScope);
			if (conversation.error) {
				return { emails: [] as Email[], error: conversation.error };
			}
			if (conversation.emails.length > 0) {
				return { emails: conversation.emails, error: undefined };
			}
		}

		const knownEmailIds = new Set<string>([email.id]);
		const knownIdentifiers = new Set<string>(extractMessageIdentifiers(email));
		const queue = [...knownIdentifiers];

		for (let iteration = 0; iteration < 5 && queue.length > 0; iteration += 1) {
			const identifiers = [...new Set(queue.splice(0, queue.length))];
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (identifiers.length > 0) {
				conditions.push(`message_id IN (${identifiers.map(() => "?").join(", ")})`);
				params.push(...identifiers);
				conditions.push(`in_reply_to IN (${identifiers.map(() => "?").join(", ")})`);
				params.push(...identifiers);
				for (const identifier of identifiers) {
					conditions.push("INSTR(references_header, ?) > 0");
					params.push(identifier);
				}
			}

			if (conditions.length === 0) {
				break;
			}

			const scopedConditions = [`(${conditions.join(" OR ")})`];
			pushDomainScope(scopedConditions, params, domainScope);

			const { results } = await db
				.prepare(
					`SELECT id, message_id, in_reply_to, references_header FROM emails WHERE ${scopedConditions.join(" AND ")}`,
				)
				.bind(...params)
				.all<Row>();

			for (const row of results as Row[]) {
				const emailId = String(row.id);
				if (!knownEmailIds.has(emailId)) {
					knownEmailIds.add(emailId);
				}

				for (const identifier of extractMessageIdentifiers({
					message_id: nullableString(row.message_id),
					in_reply_to: nullableString(row.in_reply_to),
					references_header: nullableString(row.references_header),
				})) {
					if (!knownIdentifiers.has(identifier)) {
						knownIdentifiers.add(identifier);
						queue.push(identifier);
					}
				}
			}
		}

		const thread = await getEmailsByIds(db, [...knownEmailIds], domainScope);
		if (thread.error) return thread;

		return {
			emails: thread.emails.sort(
				(a, b) => (a.sent_at ?? a.received_at) - (b.sent_at ?? b.received_at),
			),
			error: undefined,
		};
	} catch (e: unknown) {
		return { emails: [] as Email[], error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function applyEmailBatchAction(
	db: D1Database,
	payload: EmailBatchActionRequest,
	domainScope: string[] = [],
) {
	try {
		// Handle thread-level actions
		if (payload.thread_ids && payload.thread_ids.length > 0) {
			const result = await applyThreadBatchActionSafe(
				db,
				payload.thread_ids,
				payload.action,
				domainScope,
			);
			return { updated: result.updated, error: undefined };
		}

		if (payload.ids.length === 0) {
			return { updated: 0, error: undefined };
		}

		const { setClause, params } = await getBatchActionUpdate(db, payload.action);
		const conditions = [`id IN (${payload.ids.map(() => "?").join(", ")})`];
		const queryParams: unknown[] = [...params, ...payload.ids];
		pushDomainScope(conditions, queryParams, domainScope);

		const { meta } = await db
			.prepare(`UPDATE emails SET ${setClause} WHERE ${conditions.join(" AND ")}`)
			.bind(...queryParams)
			.run();

		// Refresh affected threads
		if ((meta?.changes ?? 0) > 0) {
			const threadRows = await db
				.prepare(
					`SELECT DISTINCT thread_id FROM emails WHERE id IN (${payload.ids.map(() => "?").join(", ")}) AND thread_id IS NOT NULL`,
				)
				.bind(...payload.ids)
				.all<Row>();
			const threadIds = (threadRows.results ?? [])
				.map((row) => row.thread_id)
				.filter((tid): tid is string => typeof tid === "string");
			await refreshThreadBatchSafe(db, threadIds);
		}

		return { updated: meta?.changes ?? 0, error: undefined };
	} catch (e: unknown) {
		return { updated: 0, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * One unread conversation, as the lists count it: a thread with an unread message that isn't in
 * Trash (a thread's state is 'trash' only when no message is anywhere else, src/services/threads.ts,
 * which is when browse drops it). The category, sub-category and person-lane queries all use it,
 * so withoutPersonLane subtracts like from like.
 */
const UNREAD_CONVERSATIONS =
	"SUM(CASE WHEN unread_count > 0 AND mailbox_state <> 'trash' THEN 1 ELSE 0 END)";

/**
 * Grouped thread counts minus the person lane's rows for the same key: {key, count, unread}
 * rows, dropping groups with no threads left (as a `for_person IS NULL` GROUP BY would).
 */
function withoutPersonLane(all: Row[], lane: Row[], key: string): Row[] {
	const laneByKey = new Map<unknown, { count: number; unread: number }>();
	for (const row of lane) {
		const sum = laneByKey.get(row[key]) ?? { count: 0, unread: 0 };
		sum.count += Number(row.count ?? 0);
		sum.unread += Number(row.unread ?? 0);
		laneByKey.set(row[key], sum);
	}
	return all.flatMap((row) => {
		const sub = laneByKey.get(row[key]);
		const count = Number(row.count ?? 0) - (sub?.count ?? 0);
		return count > 0
			? [{ ...row, count, unread: Number(row.unread ?? 0) - (sub?.unread ?? 0) }]
			: [];
	});
}

export async function getCombinedMetaStats(
	db: D1Database,
	configuredDomains: string[] = [],
	domainScope: string[] = [],
) {
	try {
		const scopeConditions: string[] = [];
		const scopeParams: unknown[] = [];
		pushDomainScope(scopeConditions, scopeParams, domainScope);
		const where = scopeConditions.length > 0 ? `WHERE ${scopeConditions.join(" AND ")}` : "";
		const unreadWhere = where ? `${where} AND unread_count > 0` : "WHERE unread_count > 0";
		// Category counts skip a forwarded-in person's threads (v54 person lane,
		// 2026-10-14), matching the category lists; they are counted per person instead.
		// They are computed as all threads minus the person lane: the all-threads GROUP BYs
		// stream the v36 covering indexes, while `for_person IS NULL` would read every thread
		// row (hundreds of ms on a large mailbox) and a new index for it re-plans the category
		// lists.
		const subCategoryWhere = where
			? `${where} AND priority_sub_category IS NOT NULL`
			: "WHERE priority_sub_category IS NOT NULL";
		const forPersonWhere = where
			? `${where} AND for_person IS NOT NULL`
			: "WHERE for_person IS NOT NULL";
		const memberStateConditions = [
			"e.mailbox_state IN ('sent', 'draft')",
			"e.thread_id IS NOT NULL",
		];
		if (domainScope.length > 0) {
			memberStateConditions.push(`e.domain IN (${domainScope.map(() => "?").join(", ")})`);
		}
		const memberStateWhere = `WHERE ${memberStateConditions.join(" AND ")}`;

		const [
			domainResult,
			mailboxResult,
			stateCountsResult,
			sentDraftCountsResult,
			unreadResult,
			conversationTotalResult,
			categoryUnreadResult,
			subCategoryUnreadResult,
			personLaneResult,
		] = await db.batch([
			db
				.prepare(
					`SELECT domain, COUNT(*) as email_count, MAX(latest_message_at) as latest_received_at
					 FROM threads ${where} GROUP BY domain ORDER BY latest_received_at DESC`,
				)
				.bind(...scopeParams),
			db
				.prepare(
					`SELECT domain, mailbox, COUNT(*) as email_count, MAX(COALESCE(sent_at, received_at)) as latest_received_at
					 FROM emails ${where} GROUP BY domain, mailbox ORDER BY domain ASC, latest_received_at DESC`,
				)
				.bind(...scopeParams),
			db
				.prepare(
					`SELECT mailbox_state, COUNT(*) as email_count
					 FROM threads ${where} GROUP BY mailbox_state`,
				)
				.bind(...scopeParams),
			db
				.prepare(
					`SELECT e.mailbox_state AS mailbox_state, COUNT(DISTINCT e.thread_id) as email_count
					 FROM emails e INNER JOIN threads t ON t.id = e.thread_id
					 ${memberStateWhere} GROUP BY e.mailbox_state`,
				)
				.bind(...scopeParams),
			db.prepare(`SELECT COUNT(*) as total FROM threads ${unreadWhere}`).bind(...scopeParams),
			db.prepare(`SELECT COUNT(*) as total FROM threads ${where}`).bind(...scopeParams),
			// Per-category unread CONVERSATIONS outside Trash, what the category's list shows
			// and the apps count (release-verify D1: the web said 61 where the apps said 37).
			// Sidebar badges and the tab title read this.
			db
				.prepare(
					`SELECT COALESCE(user_pinned_category, priority_category, category) AS category,
						COUNT(*) as count, ${UNREAD_CONVERSATIONS} as unread
					 FROM threads ${where}
					 GROUP BY COALESCE(user_pinned_category, priority_category, category)`,
				)
				.bind(...scopeParams),
			// Per-sub-category unread conversations (same expression).
			db
				.prepare(
					`SELECT priority_sub_category, COUNT(*) as count, ${UNREAD_CONVERSATIONS} as unread
					 FROM threads ${subCategoryWhere}
					 GROUP BY priority_sub_category`,
				)
				.bind(...scopeParams),
			// The person lane per person, category and sub-category: its per-person counts, and the
			// part subtracted from the totals above. for_person leads the GROUP BY so the planner
			// walks idx_threads_for_person (a small set) instead of every thread.
			db
				.prepare(
					`SELECT for_person,
						COALESCE(user_pinned_category, priority_category, category) AS category,
						priority_sub_category, COUNT(*) as count, ${UNREAD_CONVERSATIONS} as unread
					 FROM threads ${forPersonWhere}
					 GROUP BY for_person, 2, 3`,
				)
				.bind(...scopeParams),
		]);
		const personLaneRows = (personLaneResult.results ?? []) as Row[];
		const categoryRows = withoutPersonLane(
			(categoryUnreadResult.results ?? []) as Row[],
			personLaneRows,
			"category",
		);
		const subCategoryRows = withoutPersonLane(
			(subCategoryUnreadResult.results ?? []) as Row[],
			personLaneRows.filter((row) => row.priority_sub_category != null),
			"priority_sub_category",
		);

		const domains = new Map<string, DomainSummary>();
		for (const row of (domainResult.results ?? []) as Row[]) {
			domains.set(String(row.domain), {
				domain: String(row.domain),
				email_count: Number(row.email_count ?? 0),
				latest_received_at: numberOrNull(row.latest_received_at),
				mailboxes: [],
			});
		}
		for (const domain of configuredDomains) {
			if (!domains.has(domain)) {
				domains.set(domain, {
					domain,
					email_count: 0,
					latest_received_at: null,
					mailboxes: [],
				});
			}
		}
		for (const row of (mailboxResult.results ?? []) as Row[]) {
			const domain = domains.get(String(row.domain));
			if (domain) {
				domain.mailboxes.push({
					mailbox: String(row.mailbox),
					address: `${row.mailbox}@${row.domain}`,
					email_count: Number(row.email_count ?? 0),
					latest_received_at: numberOrNull(row.latest_received_at),
				} satisfies DomainMailboxSummary);
			}
		}

		const mailboxStateCounts = { inbox: 0, sent: 0, archived: 0, trash: 0, draft: 0 };
		for (const row of (stateCountsResult.results ?? []) as Row[]) {
			const state = String(row.mailbox_state);
			if (state in mailboxStateCounts) {
				mailboxStateCounts[state as keyof typeof mailboxStateCounts] = Number(row.email_count ?? 0);
			}
		}

		const categoryCounts: Record<string, number> = {};
		for (const row of categoryRows) {
			const key = row.category != null ? String(row.category) : "uncategorized";
			categoryCounts[key] = Number(row.count ?? 0);
		}

		const conversationMailboxStateCounts = {
			inbox: 0,
			sent: 0,
			archived: 0,
			trash: 0,
			draft: 0,
		};
		for (const row of (stateCountsResult.results ?? []) as Row[]) {
			const state = String(row.mailbox_state);
			if (state in conversationMailboxStateCounts) {
				conversationMailboxStateCounts[state as keyof typeof conversationMailboxStateCounts] =
					Number(row.email_count ?? 0);
			}
		}
		for (const row of (sentDraftCountsResult.results ?? []) as Row[]) {
			const state = String(row.mailbox_state);
			if (state === "sent" || state === "draft") {
				mailboxStateCounts[state] = Number(row.email_count ?? 0);
				conversationMailboxStateCounts[state] = Number(row.email_count ?? 0);
			}
		}

		const conversationCategoryCounts: Record<string, number> = {};
		for (const row of categoryRows) {
			const key = row.category == null ? "uncategorized" : String(row.category);
			conversationCategoryCounts[key] = Number(row.count ?? 0);
		}

		const conversationCategoryUnreadCounts: Record<string, number> = {};
		for (const row of categoryRows) {
			const key = row.category == null ? "uncategorized" : String(row.category);
			conversationCategoryUnreadCounts[key] = Number(row.unread ?? 0);
		}

		const conversationForPersonCounts: Record<string, number> = {};
		const conversationForPersonUnreadCounts: Record<string, number> = {};
		// Own-property reads: a person named e.g. "constructor" must not pick up Object.prototype.
		const own = (counts: Record<string, number>, key: string) =>
			Object.hasOwn(counts, key) ? counts[key] : 0;
		for (const row of personLaneRows) {
			const person = String(row.for_person);
			conversationForPersonCounts[person] =
				own(conversationForPersonCounts, person) + Number(row.count ?? 0);
			conversationForPersonUnreadCounts[person] =
				own(conversationForPersonUnreadCounts, person) + Number(row.unread ?? 0);
		}

		const conversationSubCategoryUnreadCounts: Record<string, number> = {};
		for (const row of subCategoryRows) {
			if (row.priority_sub_category == null) continue;
			conversationSubCategoryUnreadCounts[String(row.priority_sub_category)] = Number(
				row.unread ?? 0,
			);
		}

		return {
			stats: {
				domains: [...domains.values()].sort(
					(left, right) => (right.latest_received_at ?? 0) - (left.latest_received_at ?? 0),
				),
				mailbox_state_counts: mailboxStateCounts,
				unread_count: Number(((unreadResult.results ?? [])[0] as Row | undefined)?.total ?? 0),
				category_counts: categoryCounts,
				error: undefined,
			},
			conversationStats: {
				conversation_count: Number(
					((conversationTotalResult.results ?? [])[0] as Row | undefined)?.total ?? 0,
				),
				conversation_mailbox_state_counts: conversationMailboxStateCounts,
				conversation_unread_count: Number(
					((unreadResult.results ?? [])[0] as Row | undefined)?.total ?? 0,
				),
				conversation_category_counts: conversationCategoryCounts,
				conversation_category_unread_counts: conversationCategoryUnreadCounts,
				conversation_sub_category_unread_counts: conversationSubCategoryUnreadCounts,
				conversation_for_person_counts: conversationForPersonCounts,
				conversation_for_person_unread_counts: conversationForPersonUnreadCounts,
			},
		};
	} catch (e: unknown) {
		return {
			stats: {
				domains: [] as DomainSummary[],
				mailbox_state_counts: { inbox: 0, sent: 0, archived: 0, trash: 0, draft: 0 },
				unread_count: 0,
				category_counts: {} as Record<string, number>,
				error: e instanceof Error ? e : new Error(String(e)),
			},
			conversationStats: {
				conversation_count: 0,
				conversation_mailbox_state_counts: {
					inbox: 0,
					sent: 0,
					archived: 0,
					trash: 0,
					draft: 0,
				},
				conversation_unread_count: 0,
				conversation_category_counts: {} as Record<string, number>,
				conversation_category_unread_counts: {} as Record<string, number>,
				conversation_sub_category_unread_counts: {} as Record<string, number>,
				conversation_for_person_counts: {} as Record<string, number>,
				conversation_for_person_unread_counts: {} as Record<string, number>,
			},
		};
	}
}

/**
 * Phase 1.4 + follow-up: per-category auto-read thresholds.
 *
 * Days to wait before auto-marking unread mail read, per top-level category.
 * Null means "never auto-read" — set for Tax Documents, which are annual
 * and must be acted on. Unknown/uncategorized mail uses the fallback at
 * the end.
 *
 * Rationale: different categories have different attention half-lives.
 * Marketing/Newsletters > 3 days old will never be opened; Personal
 * deserves 21 days in case the reader is away.
 */
export const AUTO_READ_THRESHOLDS_DAYS: Record<string, number | null> = {
	personal: 21,
	home_alerts: 21,
	billing: 21,
	tax_documents: null, // never auto-read
	notifications: 7,
	agents: 7,
	marketing: 0, // read on the first tick after the sorter files it (since 2026-10-22)
	newsletters: 3,
	spam: 1,
};
const AUTO_READ_FALLBACK_DAYS = 21;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mail with its own auto-read wait, whatever its category's (e.g. one forwarded-in person's
 * mail after a few days). `from`: mail from that address. `forPerson`: mail forwarded in for
 * that person (their own view; threads.for_person). From AUTO_READ_SENDERS_JSON on the deployed Worker.
 */
export interface AutoReadSender {
	from?: string;
	forPerson?: string;
	days: number;
}

/**
 * Parse AUTO_READ_SENDERS_JSON, e.g. [{"from":"a@b.c","days":3},{"for":"a@b.c","days":3}]. `for`
 * names a forwarded-in address (FORWARDED_FOR_JSON) and matches its person's mail. Unset = none;
 * anything invalid throws (the cron logs it and keeps the category waits).
 */
export function parseAutoReadSenders(
	raw: string | undefined,
	forwardedFor: Record<string, string> = {},
): AutoReadSender[] {
	if (!raw?.trim()) return [];
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value)) throw new Error("AUTO_READ_SENDERS_JSON must be an array");
	return value.map((entry) => {
		const address = (key: string) =>
			typeof entry?.[key] === "string" ? entry[key].trim().toLowerCase() : "";
		const [from, forAddress] = [address("from"), address("for")];
		const days = entry?.days;
		if (!from === !forAddress) throw new Error("each entry needs from or for (one of them)");
		if (!/^[^@\s]+@[^@\s]+$/.test(from || forAddress))
			throw new Error("each entry's from or for must be an address");
		if (!Number.isInteger(days) || days < 0 || days > 365)
			throw new Error("each entry needs days: a whole number from 0 to 365");
		if (from) return { from, days };
		const person = Object.entries(forwardedFor).find(([a]) => a.toLowerCase() === forAddress)?.[1];
		if (!person) throw new Error(`for: ${forAddress} is not a forwarded-in address`);
		return { forPerson: person, days };
	});
}

/**
 * Build the SQL CASE expression used by autoMarkReadAged to compute the
 * cutoff: a listed sender's (or forwarded-in person's) own wait first, then the
 * per-category one. Returns the fragment plus its params in order (each rule's
 * address or person and cutoff,
 * then `nowMs` repeated once per non-null category branch plus once for the
 * fallback).
 */
function buildCategoryCutoffCase(
	nowMs: number,
	senders: AutoReadSender[] = [],
): { sql: string; params: (number | string)[] } {
	const senderBranches = senders
		.map((sender) =>
			sender.from
				? "WHEN lower(from_address) = ? THEN ?"
				: "WHEN thread_id IN (SELECT id FROM threads WHERE for_person = ?) THEN ?",
		)
		.join(" ");
	const senderParams = senders.flatMap((sender) => [
		sender.from ?? sender.forPerson ?? "",
		nowMs - sender.days * ONE_DAY_MS,
	]);
	const params: number[] = [];
	const branches: string[] = [];
	for (const [category, days] of Object.entries(AUTO_READ_THRESHOLDS_DAYS)) {
		if (days === null) {
			// Tax Documents: thresh = 0 so received_at < 0 never matches.
			branches.push(`WHEN '${category}' THEN 0`);
			continue;
		}
		branches.push(`WHEN '${category}' THEN ?`);
		params.push(nowMs - days * ONE_DAY_MS);
	}
	// Null category / unknown values fall back to the conservative default.
	branches.push(`ELSE ?`);
	params.push(nowMs - AUTO_READ_FALLBACK_DAYS * ONE_DAY_MS);
	const byCategory = `CASE category ${branches.join(" ")} END`;
	if (senders.length === 0) return { sql: byCategory, params };
	return {
		sql: `CASE ${senderBranches} ELSE ${byCategory} END`,
		params: [...senderParams, ...params],
	};
}

/**
 * Phase 1.4 + follow-up: auto-mark-read inbound mail past its sender's or its
 * category's threshold that the user has NOT pinned as kept-unread. Runs from
 * the hourly cron.
 */
export async function autoMarkReadAged(
	db: D1Database,
	_olderThanMs: number,
	batchSize = 500,
	senders: AutoReadSender[] = [],
): Promise<{ marked: number; threads_refreshed: number; error?: Error }> {
	try {
		// Cap the batch to MAX_IDS_PER_QUERY so the subsequent UPDATE's IN (?..)
		// clause stays inside D1's bind-param limit. Cron runs again on the
		// next tick if there's still more to process.
		const effectiveBatch = Math.min(batchSize, MAX_IDS_PER_QUERY);
		const nowMs = now();
		const { sql: cutoffCase, params: cutoffParams } = buildCategoryCutoffCase(nowMs, senders);
		// Newest first: marketing (threshold 0) must go read on the next tick even when an older
		// backlog exceeds one batch; the backlog drains behind it.
		const { results: targetRows } = await db
			.prepare(
				`SELECT id, thread_id FROM emails
				 WHERE read_at IS NULL
					 AND user_kept_unread = 0
					 AND direction = 'inbound'
					 AND received_at < ${cutoffCase}
				 ORDER BY received_at DESC
				 LIMIT ?`,
			)
			.bind(...cutoffParams, effectiveBatch)
			.all<Row>();

		const targets = targetRows ?? [];
		if (targets.length === 0) {
			return { marked: 0, threads_refreshed: 0 };
		}

		const ids = targets.map((row) => String(row.id));
		const placeholders = ids.map(() => "?").join(", ");
		const { meta } = await db
			.prepare(
				`UPDATE emails
				 SET read_at = ?, auto_read_at = ?
				 WHERE id IN (${placeholders})
					 AND read_at IS NULL
					 AND user_kept_unread = 0`,
			)
			.bind(nowMs, nowMs, ...ids)
			.run();

		const threadIds = [
			...new Set(
				targets
					.map((row) => (row.thread_id ? String(row.thread_id) : null))
					.filter((id): id is string => !!id),
			),
		];
		if (threadIds.length > 0) {
			await refreshThreadBatchSafe(db, threadIds);
		}

		return { marked: meta?.changes ?? 0, threads_refreshed: threadIds.length };
	} catch (e: unknown) {
		return {
			marked: 0,
			threads_refreshed: 0,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

/**
 * Phase 1.5: archive any email flagged classification_uncertain whose
 * received_at is older than `olderThanMs`. Content is retained (mailbox_state
 * moves to 'archived'). Drops stale uncertain predictions out of Personal so
 * they don't clutter the inbox indefinitely.
 */
export async function archiveUncertainAged(
	db: D1Database,
	olderThanMs: number,
	batchSize = 500,
): Promise<{ archived: number; threads_refreshed: number; error?: Error }> {
	try {
		// Cap batch to stay under D1's bind-param limit for the subsequent
		// UPDATE ... IN (?..).
		const effectiveBatch = Math.min(batchSize, MAX_IDS_PER_QUERY);
		const cutoff = now() - olderThanMs;
		const { results: targetRows } = await db
			.prepare(
				`SELECT id, thread_id FROM emails
				 WHERE classification_uncertain = 1
					 AND mailbox_state = 'inbox'
					 AND received_at < ?
				 LIMIT ?`,
			)
			.bind(cutoff, effectiveBatch)
			.all<Row>();

		const targets = targetRows ?? [];
		if (targets.length === 0) {
			return { archived: 0, threads_refreshed: 0 };
		}

		const ids = targets.map((row) => String(row.id));
		const placeholders = ids.map(() => "?").join(", ");
		const { meta } = await db
			.prepare(
				`UPDATE emails
				 SET mailbox_state = 'archived'
				 WHERE id IN (${placeholders})
					 AND mailbox_state = 'inbox'`,
			)
			.bind(...ids)
			.run();

		const threadIds = [
			...new Set(
				targets
					.map((row) => (row.thread_id ? String(row.thread_id) : null))
					.filter((id): id is string => !!id),
			),
		];
		if (threadIds.length > 0) {
			await refreshThreadBatchSafe(db, threadIds);
		}

		return { archived: meta?.changes ?? 0, threads_refreshed: threadIds.length };
	} catch (e: unknown) {
		return {
			archived: 0,
			threads_refreshed: 0,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}
