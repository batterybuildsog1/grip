/**
 * The one path for storing incoming mail: raw RFC 822 bytes + delivery context
 * → raw write-ahead to R2 → PostalMime parse → existing-delivery lookup →
 * repair or one-batch materialization. Email Routing (handlers/email.ts) and
 * POST /api/emails/import-raw (an external IMAP sync) both call
 * `ingestRawEmail`; a later Gmail API sync only has to fetch raw bytes.
 *
 * Invariants (v40 review 2 X3, S2):
 * - Materialization is ONE D1 batch (a transaction): a conditional email insert
 *   (`INSERT … SELECT … WHERE NOT EXISTS same delivery AND NOT EXISTS tombstone`)
 *   followed by attachments, raw artifact and fidelity rows, each guarded by
 *   `WHERE EXISTS (SELECT 1 FROM emails WHERE id = ?)`. Two racing importers
 *   converge on one row; a failing attachment statement leaves no email row.
 * - `ingestRawEmail` never throws. After the raw copy is in R2, a failure is
 *   reported as `{status: "failed", rawStored}` and the caller decides.
 * - A delivery = Message-ID (either `<id>` or `id` form) + domain + mailbox +
 *   direction (per-mailbox dedupe, 8fac813). With no Message-ID, the content
 *   identity from c5a63d8/1478955 applies (from + first recipient + subject +
 *   received_at + mailbox + direction).
 * - A delivery that already exists is repaired in place: missing attachments,
 *   HTML, recipients, Reply-To, Message-ID and the exact Date are filled in;
 *   id, thread, labels, category and read state are never touched.
 */
import { createId } from "@paralleldrive/cuid2";
import { getUserRuleClassification, logUserRuleClassification } from "@/agent/classify";
import { insertClassificationLog } from "@/database/agent";
import { isBlockedSender } from "@/database/blocked-senders";
import { buildEmailInsertRow } from "@/database/d1";
import {
	forgetPurgedDeliveries,
	isAttachmentExtractStatusColumnReady,
	isAttachmentNamesColumnReady,
	isEmailFidelityChecksTableReady,
	isHtmlOffloadColumnsReady,
	isListUnsubscribeColumnReady,
	isListUnsubscribePostColumnReady,
	isPurgedDeliveriesTableReady,
	isRawEmailArtifactsTableReady,
} from "@/database/tables";
import { notifyNewMail } from "@/services/apns";
import { ensureCodeNote } from "@/services/code-note";
import { ensureInvitationNote } from "@/services/invitation-note";
import { type PeopleRuleReason, peopleRuleMatch } from "@/services/people-rule";
import {
	buildEmailFidelityCheck,
	buildRawEmailObjectKey,
	getRawEmailExpiresAt,
	sha256Hex,
} from "@/services/raw-email";
import { isSystemMail } from "@/services/system-mail";
import {
	isThreadMutedSafe,
	refreshThreadSafe,
	resolveThreadIdSafe,
} from "@/services/threads-loader";
import type { EmailAttachment, EmailRecord } from "@/types";
import { resolveAttachmentExtractStatus } from "@/utils/attachments";
import { now } from "@/utils/helpers";
import { putEmailBodyToR2, shouldOffloadHtml } from "@/utils/html-offload";
import { logError, logInfo, logWarn } from "@/utils/logging";
import { processEmailContent } from "@/utils/mail";
import { messageIdForms } from "@/utils/message-id";
import {
	buildAttachmentObjectKey,
	getAttachmentSize,
	getConfiguredDomains,
	normalizeEmailAddress,
} from "@/utils/platform";

/** Above this, fail loudly instead of storing partially. Email Routing stops at 25 MiB, but
 *  imported Gmail raw copies can run larger; 32 MiB keeps Worker memory
 *  headroom for parsing. */
export const MAX_RAW_BYTES = 32 * 1024 * 1024;
const MINUTE_MS = 60_000;
/** D1 resets on CPU exhaustion fail every statement in flight; the conditional insert
 *  makes a retry safe, so transient failures are retried in-process before giving up. */
const STORE_ATTEMPTS = 3;
const RAW_PREFIX = "raw-inbound/";

export type IngestLane = "live" | "history";

export interface DeliveryContext {
	domain: string;
	mailbox: string;
	/** Email Routing knows the direction (always inbound). Otherwise it comes from the folder:
	 *  Sent → outbound; INBOX → inbound unless From is the account address itself. */
	direction?: "inbound" | "outbound";
	folder: "inbox" | "sent";
	seen: boolean;
	/** live = a real arrival (inbox, sorter, thread re-emergence). history = re-walk/backfill:
	 *  inbound mail lands archived, so the sorter (category NULL + inbound + inbox) never claims it. */
	lane: IngestLane;
	/** raw_email_artifacts.source */
	source: string;
	/** emails.source_type (null for Email Routing rows, as before) */
	sourceType: string | null;
	/** SMTP envelope; only Email Routing has one (enables the fidelity check). */
	envelope?: { from: string; to: string } | null;
	/** Arrival time. Email Routing passes now(); otherwise the Date header, then mailboxDate,
	 *  then now(). */
	receivedAt?: number;
	/** The source mailbox's own date for the message (IMAP INTERNALDATE), used only when the
	 *  message has no usable Date header. Gmail Sent holds bare copies (no Date, no Message-ID)
	 *  that were stamped with import time and showed as sent hours ago (2026-10-01). */
	mailboxDate?: number;
	/** Scope for the user sender-rule lookup. */
	domainScope: string[];
	/** Also match legacy text-only rows (no Message-ID, minute-rounded date, coworker mail stored
	 *  as outbound). import-raw only: Email Routing never had a text-only importer. */
	matchLegacy: boolean;
	/** Keep the raw write-ahead when materialization fails: true when it is the only copy. */
	rawIsOnlyCopy: boolean;
	/** Replay of an existing write-ahead object (the sweep): no second copy is written. */
	existingRawKey?: string;
	/** Repair existing rows only; never insert. The re-walk uses it for mail older than the
	 *  30-day trash-purge horizon: such mail may have been purged before tombstones existed
	 *  (v44) or without a Message-ID, and must not come back (v40 review, 2.4). */
	repairOnly?: boolean;
	/** E2E only (fixture mailbox, API token): append a failing statement to the
	 *  materialization batch to prove it is atomic and that the sweep recovers. */
	faultInjection?: "batch";
	dryRun?: boolean;
}

export type IngestMatch = "message_id" | "content" | "legacy" | "misdirected";

export type IngestResult =
	| {
			status: "imported";
			emailId: string;
			threadId: string | null;
			mailboxState: EmailRecord["mailbox_state"];
			direction: EmailRecord["direction"];
			blockedSender: boolean;
			dryRun?: boolean;
	  }
	| { status: "duplicate"; emailId: string; match: IngestMatch; dryRun?: boolean }
	| {
			status: "repaired";
			emailId: string;
			match: IngestMatch;
			repaired: string[];
			dryRun?: boolean;
	  }
	| { status: "purged"; dryRun?: boolean }
	| { status: "skipped"; reason: "repair_only"; dryRun?: boolean }
	| { status: "rejected"; code: "TOO_LARGE"; error: string }
	| {
			status: "failed";
			stage: string;
			error: string;
			rawStored: boolean;
			rawObjectKey: string | null;
	  };

type ParsedEmail = Awaited<ReturnType<typeof import("postal-mime")["default"]["parse"]>>;
type ParsedAddress = { address?: string; name?: string };

function extractAddresses(values: ParsedAddress[] | undefined, fallback: string[] = []): string[] {
	const addresses = (values || [])
		.map((value) => (value.address ? normalizeEmailAddress(value.address) : null))
		.filter((value): value is string => Boolean(value));
	return addresses.length > 0 ? addresses : fallback;
}

export function resolveInboundHeaderAddresses({
	to,
	cc,
	bcc,
	deliveredTo,
}: {
	to?: ParsedAddress[];
	cc?: ParsedAddress[];
	bcc?: ParsedAddress[];
	deliveredTo: string;
}): { toAddresses: string[]; ccAddresses: string[]; bccAddresses: string[] } {
	return {
		toAddresses: extractAddresses(to, [normalizeEmailAddress(deliveredTo)]),
		ccAddresses: extractAddresses(cc),
		bccAddresses: extractAddresses(bcc),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingTombstoneTable(error: unknown): boolean {
	return /no such table:\s*(main\.)?purged_deliveries/i.test(errorMessage(error));
}

/** Everything derived from the raw message before any D1 lookup. */
interface Delivery {
	record: EmailRecord & { attachment_names?: string | null };
	ids: ReturnType<typeof messageIdForms>;
	account: string;
	firstTo: string;
	/** The Date header, else the mailbox's date; null when neither is known. */
	dateMs: number | null;
	/** dateMs came from mailbox_date (no Date header). It is only minute-precise, so a match
	 *  on it also needs the same body, or an empty stored body (review, 2026-10-01). */
	dateFromMailbox: boolean;
	attachments: ParsedEmail["attachments"];
	/** Coworker mail (same domain, not the account) arriving inbound via import-raw: the
	 *  text-only importer stored exactly this mail as outbound/sent. Its stored or
	 *  tombstoned copy may therefore carry direction 'outbound'. */
	misdirectable: boolean;
}

function describe(parsed: ParsedEmail, ctx: DeliveryContext, emailId: string): Delivery {
	const account = `${ctx.mailbox}@${ctx.domain}`.toLowerCase();
	const fromAddress = normalizeEmailAddress(parsed.from?.address || ctx.envelope?.from || "");
	const direction =
		ctx.direction ?? (ctx.folder === "sent" || fromAddress === account ? "outbound" : "inbound");
	const { toAddresses, ccAddresses, bccAddresses } = resolveInboundHeaderAddresses({
		to: parsed.to as ParsedAddress[] | undefined,
		cc: parsed.cc as ParsedAddress[] | undefined,
		bcc: parsed.bcc as ParsedAddress[] | undefined,
		deliveredTo: account,
	});
	const headerTo = extractAddresses(parsed.to as ParsedAddress[] | undefined);
	const parsedDate = parsed.date ? Date.parse(parsed.date) : Number.NaN;
	const dateFromMailbox = !Number.isFinite(parsedDate) && ctx.mailboxDate !== undefined;
	const dateMs = Number.isFinite(parsedDate) ? parsedDate : (ctx.mailboxDate ?? null);
	const receivedAt = ctx.receivedAt ?? dateMs ?? now();
	const { htmlContent, textContent } = processEmailContent(
		parsed.html ?? null,
		parsed.text ?? null,
	);
	const ids = messageIdForms(parsed.messageId);
	const attachments = parsed.attachments ?? [];
	const names = attachments
		.map((attachment) => attachment.filename?.trim() || "")
		.filter(Boolean)
		.join(" ");

	return {
		record: {
			id: emailId,
			from_address: fromAddress,
			from_name: parsed.from?.name?.trim() || null,
			// Inbound: the delivery mailbox (as Email Routing always stored it). Outbound: first To.
			to_address: direction === "inbound" ? account : (headerTo[0] ?? ""),
			to_addresses: direction === "inbound" ? toAddresses : headerTo,
			cc_addresses: ccAddresses,
			bcc_addresses: bccAddresses,
			reply_to_addresses: extractAddresses(parsed.replyTo as ParsedAddress[] | undefined),
			domain: ctx.domain,
			mailbox: ctx.mailbox,
			direction,
			mailbox_state: "inbox", // decided in materialize()
			subject: parsed.subject || null,
			received_at: receivedAt,
			sent_at: direction === "outbound" ? receivedAt : null,
			read_at: ctx.seen ? receivedAt : null,
			html_content: htmlContent,
			text_content: textContent,
			message_id: ids?.canonical ?? null,
			provider_message_id: null,
			source_type: ctx.sourceType,
			source_folder: ctx.sourceType ? ctx.folder : null,
			source_message_id: ctx.sourceType ? (ids?.canonical ?? null) : null,
			in_reply_to: parsed.inReplyTo || null,
			references_header: parsed.references || null,
			has_attachments: attachments.length > 0,
			attachment_count: attachments.length,
			thread_id: null,
			category: null,
			sub_category: null,
			list_unsubscribe:
				parsed.headers?.find((header) => header.key === "list-unsubscribe")?.value ?? null,
			list_unsubscribe_post:
				parsed.headers?.find((header) => header.key === "list-unsubscribe-post")?.value ?? null,
			attachment_names: attachments.length > 0 ? names : null,
		},
		ids,
		account,
		firstTo: headerTo[0] ?? "",
		dateMs,
		dateFromMailbox,
		attachments,
		misdirectable:
			ctx.matchLegacy &&
			direction === "inbound" &&
			fromAddress !== account &&
			fromAddress.endsWith(`@${ctx.domain.toLowerCase()}`),
	};
}

// ---------------------------------------------------------------------------
// Existing-delivery lookup
// ---------------------------------------------------------------------------

interface ExistingRow {
	id: string;
	thread_id: string | null;
	direction: "inbound" | "outbound";
	mailbox_state: string;
	message_id: string | null;
	received_at: number;
	sent_at: number | null;
	from_name: string | null;
	in_reply_to: string | null;
	references_header: string | null;
	list_unsubscribe: string | null;
	list_unsubscribe_post?: string | null;
	to_addresses_json: string | null;
	cc_addresses_json: string | null;
	bcc_addresses_json: string | null;
	reply_to_addresses_json: string | null;
	no_html: number;
	no_text: number;
	/** Selected only for dateFromMailbox deliveries (body corroboration). */
	text_content?: string | null;
	attachment_rows: number;
	raw_rows: number;
}

async function selectExistingColumns(db: D1Database): Promise<string> {
	const html = (await isHtmlOffloadColumnsReady(db))
		? "(html_content IS NULL AND COALESCE(html_in_r2, 0) = 0)"
		: "(html_content IS NULL)";
	const rawRows = (await isRawEmailArtifactsTableReady(db))
		? "(SELECT COUNT(*) FROM raw_email_artifacts r WHERE r.email_id = emails.id)"
		: "1";
	const listUnsubscribe = (await isListUnsubscribeColumnReady(db))
		? "list_unsubscribe"
		: "NULL AS list_unsubscribe";
	const listUnsubscribePost = (await isListUnsubscribePostColumnReady(db))
		? ", list_unsubscribe_post"
		: "";
	return `id, thread_id, direction, mailbox_state, message_id, received_at, sent_at, from_name,
		in_reply_to, references_header, ${listUnsubscribe}${listUnsubscribePost}, to_addresses_json, cc_addresses_json,
		bcc_addresses_json, reply_to_addresses_json, ${html} AS no_html,
		(text_content IS NULL OR text_content = '') AS no_text,
		(SELECT COUNT(*) FROM attachments a WHERE a.email_id = emails.id) AS attachment_rows,
		${rawRows} AS raw_rows`;
}

/**
 * Find the stored copy of this delivery, in priority order:
 * 1. message_id: same Message-ID (either form) in the same domain/mailbox/direction.
 * 2. misdirected (import-raw): the text-only importer stored coworker mail as outbound
 *    (own-domain sender ⇒ outbound). Same Message-ID, stored outbound, same sender.
 * 3. legacy (import-raw): a row with no Message-ID from the same sender to the same first
 *    recipient with the same subject, dated either exactly this Date or this Date floored
 *    to the minute (the text-only importer stored minute-rounded dates). Exact-or-floor,
 *    not a range: two distinct no-Message-ID sends in one minute stay two rows (N1/N4).
 * 4. content (Email Routing has no legacy rows): no Message-ID ⇒ the exact content identity.
 */
async function findExisting(
	db: D1Database,
	d: Delivery,
	ctx: DeliveryContext,
): Promise<{ row: ExistingRow; match: IngestMatch } | null> {
	const cols = `${await selectExistingColumns(db)}${d.dateFromMailbox ? ", text_content" : ""}`;
	const r = d.record;
	const queries: Array<{ match: IngestMatch; stmt: D1PreparedStatement }> = [];

	if (d.ids) {
		queries.push({
			match: "message_id",
			stmt: db
				.prepare(
					`SELECT ${cols} FROM emails
					 WHERE message_id IN (?, ?) AND domain = ? AND mailbox = ? AND direction = ? LIMIT 1`,
				)
				.bind(...d.ids.forms, r.domain, r.mailbox, r.direction),
		});
		if (d.misdirectable) {
			// Only text-only importer rows (source_type NULL): an import-raw Sent copy of a
			// coworker-authored message is a real outbound delivery and stays one.
			queries.push({
				match: "misdirected",
				stmt: db
					.prepare(
						`SELECT ${cols} FROM emails
						 WHERE message_id IN (?, ?) AND domain = ? AND mailbox = ? AND direction = 'outbound'
						   AND from_address = ? AND source_type IS NULL AND mailbox_state <> 'draft' LIMIT 1`,
					)
					.bind(...d.ids.forms, r.domain, r.mailbox, r.from_address),
			});
		}
	}

	if (!d.ids) {
		queries.push({
			match: "content",
			stmt: db
				.prepare(
					`SELECT ${cols} FROM emails
					 WHERE from_address = ? AND received_at = ? AND subject IS ? AND to_address = ?
					   AND domain = ? AND mailbox = ? AND direction = ? LIMIT 1`,
				)
				.bind(
					r.from_address,
					r.received_at,
					r.subject,
					r.to_address,
					r.domain,
					r.mailbox,
					r.direction,
				),
		});
	}

	// Text-only importer rows only (source_type NULL, no Message-ID): a row this path
	// stored itself is never "legacy", so two distinct sends in one minute stay two.
	if (ctx.matchLegacy && d.dateMs !== null) {
		const minute = Math.floor(d.dateMs / MINUTE_MS) * MINUTE_MS;
		const direction = d.misdirectable ? "direction IN (?, 'outbound')" : "direction = ?";
		queries.push({
			match: "legacy",
			stmt: db
				.prepare(
					`SELECT ${cols} FROM emails
					 WHERE from_address = ? AND received_at IN (?, ?)
					   AND message_id IS NULL AND source_type IS NULL AND domain = ? AND mailbox = ?
					   AND ${direction}
					   AND subject IS ? AND to_address IN (?, ?) AND mailbox_state <> 'draft'
					 ORDER BY received_at ASC LIMIT ${d.dateFromMailbox ? 5 : 1}`,
				)
				.bind(
					r.from_address,
					r.received_at,
					minute,
					r.domain,
					r.mailbox,
					r.direction,
					r.subject,
					d.firstTo,
					d.account,
				),
		});
	}

	if (queries.length === 0) return null;
	const results = await db.batch<ExistingRow>(queries.map((query) => query.stmt));
	for (const [index, result] of results.entries()) {
		const match = queries[index].match;
		const corroborate = d.dateFromMailbox && (match === "content" || match === "legacy");
		const row = (result.results ?? []).find((candidate) => !corroborate || sameBody(candidate, r));
		if (row) return { row, match };
	}
	return null;
}

/** A minute-precise mailbox date alone cannot tell two sends apart: the stored copy must be
 *  empty (the text-only importer's body-less twins) or carry the same text. */
function sameBody(row: ExistingRow, r: EmailRecord): boolean {
	const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
	const stored = squash(row.text_content);
	return stored === "" || stored === squash(r.text_content);
}

/** Directions a tombstone for this delivery may carry: a deleted legacy coworker row was
 *  stored (and tombstoned) as outbound, and must still block its corrected inbound replay. */
function tombstoneDirections(d: Delivery): string[] {
	return d.misdirectable ? [d.record.direction, "outbound"] : [d.record.direction];
}

function tombstoneClause(d: Delivery): { sql: string; params: unknown[] } | null {
	if (!d.ids) return null;
	const directions = tombstoneDirections(d);
	return {
		sql: `SELECT 1 FROM purged_deliveries WHERE domain = ? AND mailbox = ?
			AND direction IN (${directions.map(() => "?").join(", ")}) AND message_id IN (?, ?)`,
		params: [d.record.domain, d.record.mailbox, ...directions, ...d.ids.forms],
	};
}

async function isTombstoned(db: D1Database, d: Delivery): Promise<boolean> {
	const clause = tombstoneClause(d);
	if (!clause || !(await isPurgedDeliveriesTableReady(db))) return false;
	try {
		const row = await db
			.prepare(`${clause.sql} LIMIT 1`)
			.bind(...clause.params)
			.first();
		return row !== null;
	} catch (error) {
		if (!isMissingTombstoneTable(error)) throw error;
		forgetPurgedDeliveries();
		return false;
	}
}

// ---------------------------------------------------------------------------
// Attachments to R2 (before the batch; keys are cleaned up if the batch no-ops)
// ---------------------------------------------------------------------------

async function putAttachments(
	bucket: R2Bucket,
	emailId: string,
	attachments: ParsedEmail["attachments"],
	createdAt: number,
	{ freshKeys }: { freshKeys: boolean },
): Promise<EmailAttachment[]> {
	const stored: EmailAttachment[] = [];
	try {
		for (const [index, attachment] of attachments.entries()) {
			const objectKey = buildAttachmentObjectKey(emailId, index, attachment.filename);
			const mimeType = attachment.mimeType || "application/octet-stream";
			await bucket.put(objectKey, attachment.content, { httpMetadata: { contentType: mimeType } });
			stored.push({
				id: createId(),
				email_id: emailId,
				object_key: objectKey,
				filename: attachment.filename,
				mime_type: mimeType,
				size: getAttachmentSize(attachment.content),
				disposition: attachment.disposition,
				content_id: attachment.contentId ?? null,
				created_at: createdAt,
			});
		}
	} catch (error) {
		// Keys under a new id belong to this attempt alone; keys under an existing id
		// (repair) may already back a concurrent repair's committed rows, so keep them.
		if (freshKeys) {
			await deleteObjects(
				bucket,
				stored.map((attachment) => attachment.object_key),
			);
		}
		throw error;
	}
	return stored;
}

async function deleteObjects(bucket: R2Bucket | undefined, keys: Array<string | null>) {
	if (!bucket) return;
	await Promise.allSettled(
		keys.filter((key): key is string => Boolean(key)).map((key) => bucket.delete(key)),
	);
}

async function attachmentInsertStatements(
	db: D1Database,
	attachments: EmailAttachment[],
	emailId: string,
	{ skipExistingKeys }: { skipExistingKeys: boolean },
): Promise<D1PreparedStatement[]> {
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
		...(extractStatusReady ? ["extract_status"] : []),
	];
	const guard = skipExistingKeys
		? " AND NOT EXISTS (SELECT 1 FROM attachments WHERE email_id = ? AND object_key = ?)"
		: "";
	const sql = `INSERT INTO attachments (${columns.join(", ")})
		SELECT ${columns.map(() => "?").join(", ")}
		WHERE EXISTS (SELECT 1 FROM emails WHERE id = ?)${guard}`;
	return attachments.map((attachment) => {
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
		values.push(emailId);
		if (skipExistingKeys) values.push(emailId, attachment.object_key);
		return db.prepare(sql).bind(...values);
	});
}

async function rawArtifactStatement(
	env: CloudflareBindings,
	emailId: string,
	ctx: DeliveryContext,
	raw: { key: string; sha256: string; size: number; storedAt: number },
): Promise<D1PreparedStatement | null> {
	if (!(await isRawEmailArtifactsTableReady(env.D1))) return null;
	return env.D1.prepare(
		`INSERT OR IGNORE INTO raw_email_artifacts (
			id, email_id, domain, mailbox, object_key, sha256, size, stored_at, expires_at, source,
			envelope_from, envelope_to, parse_status, created_at
		) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed', ?
		WHERE EXISTS (SELECT 1 FROM emails WHERE id = ?)`,
	).bind(
		createId(),
		emailId,
		ctx.domain,
		ctx.mailbox,
		raw.key,
		raw.sha256,
		raw.size,
		raw.storedAt,
		getRawEmailExpiresAt(env, raw.storedAt),
		ctx.source,
		ctx.envelope?.from ?? null,
		ctx.envelope?.to ?? `${ctx.mailbox}@${ctx.domain}`,
		raw.storedAt,
		emailId,
	);
}

// ---------------------------------------------------------------------------
// Repair an existing delivery
// ---------------------------------------------------------------------------

function parseList(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/** Which fields the stored row lacks that this raw copy can supply. Pure; drives dry runs too. */
function planRepair(
	row: ExistingRow,
	match: IngestMatch,
	d: Delivery,
	ctx: DeliveryContext,
): string[] {
	const r = d.record;
	const fields: string[] = [];
	if (row.mailbox_state === "draft") return fields;
	if (match === "misdirected" || (match === "legacy" && row.direction !== r.direction)) {
		fields.push("direction");
	}
	if (!row.message_id && r.message_id) fields.push("message_id");
	// The text-only importer stored the Date floored to the minute, with or without a
	// Message-ID. Email Routing rows hold arrival time and are never "corrected".
	if (
		ctx.matchLegacy &&
		d.dateMs !== null &&
		!d.dateFromMailbox &&
		Number(row.raw_rows) === 0 &&
		row.received_at !== r.received_at &&
		row.received_at % MINUTE_MS === 0 &&
		Math.floor(r.received_at / MINUTE_MS) * MINUTE_MS === row.received_at
	) {
		fields.push("received_at");
	}
	if (row.no_html && r.html_content) fields.push("html");
	if (row.no_text && r.text_content) fields.push("text");
	if (parseList(row.to_addresses_json).length < r.to_addresses.length) fields.push("to");
	if (parseList(row.cc_addresses_json).length === 0 && r.cc_addresses.length > 0) fields.push("cc");
	if (parseList(row.bcc_addresses_json).length === 0 && r.bcc_addresses.length > 0) {
		fields.push("bcc");
	}
	if (parseList(row.reply_to_addresses_json).length === 0 && r.reply_to_addresses.length > 0) {
		fields.push("reply_to");
	}
	if (!row.from_name && r.from_name) fields.push("from_name");
	if (!row.in_reply_to && r.in_reply_to) fields.push("in_reply_to");
	if (!row.references_header && r.references_header) fields.push("references");
	if (!row.list_unsubscribe && r.list_unsubscribe) fields.push("list_unsubscribe");
	if (
		row.list_unsubscribe_post !== undefined &&
		!row.list_unsubscribe_post &&
		r.list_unsubscribe_post
	) {
		fields.push("list_unsubscribe_post");
	}
	if (Number(row.attachment_rows) === 0 && d.attachments.length > 0) fields.push("attachments");
	return fields;
}

async function repairExisting(
	env: CloudflareBindings,
	row: ExistingRow,
	fields: string[],
	d: Delivery,
	ctx: DeliveryContext,
	raw: { key: string; sha256: string; size: number; storedAt: number; stored: boolean },
): Promise<{ rawRecorded: boolean }> {
	const db = env.D1;
	const r = d.record;
	const want = new Set(fields);
	const sets: string[] = [];
	const params: unknown[] = [];
	const cas = (column: string, oldValue: unknown, newValue: unknown) => {
		sets.push(`${column} = CASE WHEN ${column} IS ? THEN ? ELSE ${column} END`);
		params.push(oldValue, newValue);
	};
	const fill = (column: string, value: unknown) => {
		sets.push(`${column} = COALESCE(${column}, ?)`);
		params.push(value);
	};

	// Identity changes (direction, Message-ID) apply only if no other row already is this
	// delivery: a concurrent ingest may have stored it since the lookup. The check runs in
	// the UPDATE itself, so it is atomic with the change.
	const noOtherCopy = (direction: string): { sql: string; params: unknown[] } =>
		d.ids
			? {
					sql: `NOT EXISTS (SELECT 1 FROM emails o WHERE o.message_id IN (?, ?) AND o.domain = ?
						AND o.mailbox = ? AND o.direction = ? AND o.id <> ?)`,
					params: [...d.ids.forms, r.domain, r.mailbox, direction, row.id],
				}
			: { sql: "1", params: [] };
	if (want.has("direction")) {
		// Coworker mail the text-only importer stored as outbound/sent. History never
		// lands in the inbox; live mail goes where a fresh delivery would.
		const state = ctx.lane === "history" ? "archived" : "inbox";
		const guard = noOtherCopy("inbound");
		const flip = `(direction = 'outbound' AND ${guard.sql})`;
		sets.push(`direction = CASE WHEN ${flip} THEN 'inbound' ELSE direction END`);
		params.push(...guard.params);
		sets.push(
			`mailbox_state = CASE WHEN ${flip} AND mailbox_state = 'sent' THEN ? ELSE mailbox_state END`,
		);
		params.push(...guard.params, state);
		sets.push(`to_address = CASE WHEN ${flip} THEN ? ELSE to_address END`);
		params.push(...guard.params, d.account);
		sets.push(`sent_at = CASE WHEN ${flip} THEN NULL ELSE sent_at END`);
		params.push(...guard.params);
	} else if (want.has("received_at") && row.sent_at === row.received_at) {
		cas("sent_at", row.sent_at, r.received_at);
	}
	if (want.has("received_at")) cas("received_at", row.received_at, r.received_at);
	if (want.has("message_id")) {
		const guard = noOtherCopy(r.direction);
		sets.push(
			`message_id = CASE WHEN message_id IS NULL AND ${guard.sql} THEN ? ELSE message_id END`,
		);
		params.push(...guard.params, r.message_id);
	}
	if (want.has("html")) {
		const offload =
			env.ATTACHMENTS &&
			(await isHtmlOffloadColumnsReady(db)) &&
			shouldOffloadHtml({ html_content: r.html_content, received_at: row.received_at }).offload;
		if (offload && env.ATTACHMENTS && r.html_content) {
			const key = await putEmailBodyToR2(env.ATTACHMENTS, row.id, r.html_content);
			sets.push(
				"r2_html_key = CASE WHEN html_content IS NULL AND html_in_r2 = 0 THEN ? ELSE r2_html_key END",
				"html_in_r2 = CASE WHEN html_content IS NULL AND html_in_r2 = 0 THEN 1 ELSE html_in_r2 END",
			);
			params.push(key);
		} else {
			const guard = (await isHtmlOffloadColumnsReady(db))
				? "html_content IS NULL AND html_in_r2 = 0"
				: "html_content IS NULL";
			sets.push(`html_content = CASE WHEN ${guard} THEN ? ELSE html_content END`);
			params.push(r.html_content);
		}
	}
	if (want.has("text")) {
		sets.push(
			"text_content = CASE WHEN text_content IS NULL OR text_content = '' THEN ? ELSE text_content END",
		);
		params.push(r.text_content);
	}
	if (want.has("to"))
		cas("to_addresses_json", row.to_addresses_json, JSON.stringify(r.to_addresses));
	if (want.has("cc"))
		cas("cc_addresses_json", row.cc_addresses_json, JSON.stringify(r.cc_addresses));
	if (want.has("bcc")) {
		cas("bcc_addresses_json", row.bcc_addresses_json, JSON.stringify(r.bcc_addresses));
	}
	if (want.has("reply_to")) {
		cas(
			"reply_to_addresses_json",
			row.reply_to_addresses_json,
			JSON.stringify(r.reply_to_addresses),
		);
	}
	if (want.has("from_name")) fill("from_name", r.from_name);
	if (want.has("in_reply_to")) fill("in_reply_to", r.in_reply_to);
	if (want.has("references")) fill("references_header", r.references_header);
	if (want.has("list_unsubscribe")) fill("list_unsubscribe", r.list_unsubscribe);
	if (want.has("list_unsubscribe_post") && (await isListUnsubscribePostColumnReady(db))) {
		fill("list_unsubscribe_post", r.list_unsubscribe_post);
	}

	const statements: D1PreparedStatement[] = [];
	if (sets.length > 0) {
		statements.push(
			db.prepare(`UPDATE emails SET ${sets.join(", ")} WHERE id = ?`).bind(...params, row.id),
		);
	}

	if (want.has("attachments") && env.ATTACHMENTS) {
		const stored = await putAttachments(env.ATTACHMENTS, row.id, d.attachments, row.received_at, {
			freshKeys: false,
		});
		statements.push(
			...(await attachmentInsertStatements(db, stored, row.id, { skipExistingKeys: true })),
		);
		const count = "(SELECT COUNT(*) FROM attachments WHERE attachments.email_id = emails.id)";
		const names = (await isAttachmentNamesColumnReady(db))
			? `, attachment_names = COALESCE((SELECT GROUP_CONCAT(COALESCE(filename, ''), ' ')
					FROM attachments WHERE attachments.email_id = emails.id), '')`
			: "";
		statements.push(
			db
				.prepare(
					`UPDATE emails
					 SET has_attachments = CASE WHEN ${count} > 0 THEN 1 ELSE has_attachments END,
					     attachment_count = CASE WHEN ${count} > 0 THEN ${count} ELSE attachment_count END${names}
					 WHERE id = ?`,
				)
				.bind(row.id),
		);
	}

	let artifactIndex = -1;
	if (raw.stored && Number(row.raw_rows) === 0) {
		const artifact = await rawArtifactStatement(env, row.id, ctx, raw);
		if (artifact) {
			artifactIndex = statements.length;
			statements.push(artifact);
		}
	}

	// On failure the batch rolls back. R2 keys written above live under the existing id
	// and are only ever rewritten with the same bytes, so they are left in place: a
	// concurrent repair may already reference them, and the next attempt overwrites them.
	const results = await db.batch(statements);
	return { rawRecorded: artifactIndex >= 0 && (results[artifactIndex]?.meta?.changes ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// Materialize a new delivery: one batch
// ---------------------------------------------------------------------------

/** The people rule must never fail a delivery: on error the mail goes to the sorter. */
async function peopleRuleMatchSafe(
	env: CloudflareBindings,
	r: EmailRecord,
): Promise<PeopleRuleReason | null> {
	try {
		return await peopleRuleMatch(env, r);
	} catch (error) {
		logWarn("people_rule_failed", { email_id: r.id, error: errorMessage(error) });
		return null;
	}
}

async function materialize(
	env: CloudflareBindings,
	d: Delivery,
	ctx: DeliveryContext,
	raw: { key: string; sha256: string; size: number; storedAt: number; stored: boolean },
	parsed: ParsedEmail,
	freshKeys: Set<string>,
): Promise<{
	inserted: boolean;
	blockedSender: boolean;
	userRule: Awaited<ReturnType<typeof getUserRuleClassification>>;
	peopleRule: PeopleRuleReason | null;
}> {
	const db = env.D1;
	const r = d.record;
	const blockedSender = r.direction === "inbound" && (await isBlockedSender(db, r.from_address));
	const systemMail =
		r.direction === "inbound" && !blockedSender && isSystemMail(env, r, ctx.envelope?.to);
	const userRule =
		r.direction === "inbound" && !blockedSender && !systemMail
			? await getUserRuleClassification(db, r.from_address, env.HOME_ALERTS_JSON)
			: null;
	r.category = systemMail ? "agents" : (userRule?.category ?? null);
	r.sub_category = userRule?.sub_category ?? null;
	r.thread_id = await resolveThreadIdSafe(db, r);
	const peopleRule =
		r.direction === "inbound" && !blockedSender && !userRule && !systemMail
			? await peopleRuleMatchSafe(env, r)
			: null;
	if (peopleRule) {
		r.category = "personal";
		r.sub_category = null;
	}
	r.mailbox_state =
		r.direction === "outbound"
			? "sent"
			: blockedSender
				? "trash"
				: ctx.lane === "history"
					? "archived"
					: "inbox";
	if (r.thread_id && r.mailbox_state === "inbox" && (await isThreadMutedSafe(db, r.thread_id))) {
		r.mailbox_state = "archived";
	}

	if (!env.ATTACHMENTS && d.attachments.length > 0) {
		throw new Error(
			"attachment storage (R2) is not configured; refusing to store without attachments",
		);
	}
	const stored =
		env.ATTACHMENTS && d.attachments.length > 0
			? await putAttachments(env.ATTACHMENTS, r.id, d.attachments, r.received_at, {
					freshKeys: true,
				})
			: [];
	for (const attachment of stored) freshKeys.add(attachment.object_key);

	{
		const row = await buildEmailInsertRow(db, r, { bucket: env.ATTACHMENTS });
		if (row.offloadedHtmlKey) freshKeys.add(row.offloadedHtmlKey);

		const run = async (useTombstones: boolean) => {
			const sameDelivery = d.ids
				? {
						sql: "message_id IN (?, ?) AND domain = ? AND mailbox = ? AND direction = ?",
						params: [...d.ids.forms, r.domain, r.mailbox, r.direction],
					}
				: {
						// A mailbox-dated delivery is the same one only with the same body (sameBody).
						sql: `from_address = ? AND received_at = ? AND subject IS ? AND to_address = ? AND domain = ? AND mailbox = ? AND direction = ?${d.dateFromMailbox ? " AND COALESCE(text_content, '') = ?" : ""}`,
						params: [
							r.from_address,
							r.received_at,
							r.subject,
							r.to_address,
							r.domain,
							r.mailbox,
							r.direction,
							...(d.dateFromMailbox ? [r.text_content ?? ""] : []),
						],
					};
			let where = `NOT EXISTS (SELECT 1 FROM emails WHERE ${sameDelivery.sql})`;
			const whereParams: unknown[] = [...sameDelivery.params];
			const tombstone = useTombstones ? tombstoneClause(d) : null;
			if (tombstone) {
				where += ` AND NOT EXISTS (${tombstone.sql})`;
				whereParams.push(...tombstone.params);
			}
			const statements: D1PreparedStatement[] = [
				db
					.prepare(
						`INSERT INTO emails (${row.columns.join(", ")})
						 SELECT ${row.columns.map(() => "?").join(", ")} WHERE ${where}`,
					)
					.bind(...row.values, ...whereParams),
				...(await attachmentInsertStatements(db, stored, r.id, { skipExistingKeys: false })),
			];
			if (raw.stored) {
				const artifact = await rawArtifactStatement(env, r.id, ctx, raw);
				if (artifact) statements.push(artifact);
			}
			if (ctx.envelope && (await isEmailFidelityChecksTableReady(db))) {
				const check = buildEmailFidelityCheck({
					email: r,
					parsed,
					envelope: { from: ctx.envelope.from, to: ctx.envelope.to },
					rawSha256: raw.sha256,
					rawSize: raw.size,
					checkedAt: raw.storedAt,
				});
				statements.push(
					db
						.prepare(
							`INSERT OR IGNORE INTO email_fidelity_checks (
								id, email_id, checked_at, parser_version, status, raw_sha256, raw_size,
								mismatches_json, raw_headers_json, stored_headers_json, envelope_json, created_at
							) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
							WHERE EXISTS (SELECT 1 FROM emails WHERE id = ?)`,
						)
						.bind(
							createId(),
							check.email_id,
							check.checked_at,
							check.parser_version,
							check.status,
							check.raw_sha256,
							check.raw_size,
							JSON.stringify(check.mismatches),
							JSON.stringify(check.raw_headers),
							JSON.stringify(check.stored_headers),
							JSON.stringify(check.envelope),
							raw.storedAt,
							r.id,
						),
				);
				if (check.status !== "pass") {
					logError("inbound_fidelity_check_mismatch", {
						email_id: r.id,
						status: check.status,
						mismatches: check.mismatches,
					});
				}
			}
			// A live reply brings its archived thread back to the inbox (Email Routing's
			// long-standing behavior, now for every live arrival).
			if (ctx.lane === "live" && r.thread_id && r.mailbox_state === "inbox") {
				statements.push(
					db
						.prepare(
							`UPDATE emails SET mailbox_state = 'inbox'
							 WHERE thread_id = ? AND mailbox_state = 'archived'
							   AND EXISTS (SELECT 1 FROM emails WHERE id = ?)`,
						)
						.bind(r.thread_id, r.id),
				);
			}
			if (ctx.faultInjection === "batch") {
				statements.push(db.prepare("INSERT INTO e2e_fault_injection_missing_table VALUES (1)"));
			}
			return db.batch(statements);
		};

		const useTombstones = await isPurgedDeliveriesTableReady(db);
		let results: D1Result[];
		try {
			results = await run(useTombstones);
		} catch (error) {
			if (!useTombstones || !isMissingTombstoneTable(error)) throw error;
			forgetPurgedDeliveries();
			results = await run(false);
		}
		// A batch that returned is a definite outcome. One that threw may still have
		// committed (lost response), so its objects are kept until ingestRawEmail knows.
		const inserted = (results[0]?.meta?.changes ?? 0) > 0;
		if (!inserted) {
			await deleteObjects(env.ATTACHMENTS, [...freshKeys]);
			freshKeys.clear();
		}
		return { inserted, blockedSender, userRule, peopleRule };
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

type RawInfo = { key: string; sha256: string; size: number; storedAt: number; stored: boolean };

/** Lookup → repair | tombstone skip | materialize, for one parsed delivery. Idempotent, so
 *  the caller may retry it after a D1 failure. */
async function storeDelivery(
	env: CloudflareBindings,
	d: Delivery,
	ctx: DeliveryContext,
	raw: RawInfo,
	parsed: ParsedEmail,
	dropRaw: () => Promise<void>,
	setStage: (stage: string) => void,
	logCtx: Record<string, unknown>,
	freshKeys: Set<string>,
): Promise<IngestResult> {
	setStage("lookup");
	const existing = await findExisting(env.D1, d, ctx);
	// Our own row: an earlier attempt committed but its response was lost.
	const ownCommit = existing?.row.id === d.record.id;
	if (existing && !ownCommit) {
		const fields = planRepair(existing.row, existing.match, d, ctx);
		const base = { emailId: existing.row.id, match: existing.match };
		if (ctx.dryRun) {
			return fields.length > 0
				? { status: "repaired", ...base, repaired: fields, dryRun: true }
				: { status: "duplicate", ...base, dryRun: true };
		}
		if (fields.length === 0) {
			await dropRaw();
			logInfo("ingest_duplicate", {
				...logCtx,
				existing_id: existing.row.id,
				match: existing.match,
			});
			return { status: "duplicate", ...base };
		}
		setStage("repair");
		const { rawRecorded } = await repairExisting(env, existing.row, fields, d, ctx, raw);
		if (!rawRecorded) await dropRaw();
		if (existing.row.thread_id) await refreshThreadSafe(env.D1, existing.row.thread_id);
		logInfo("ingest_repaired", {
			...logCtx,
			existing_id: existing.row.id,
			match: existing.match,
			repaired: fields,
		});
		return { status: "repaired", ...base, repaired: fields };
	}

	// ownCommit: the failed attempt already decided the state (blocked ⇒ trash).
	let blockedSender =
		ownCommit && d.record.direction === "inbound" && d.record.mailbox_state === "trash";
	let userRule: Awaited<ReturnType<typeof getUserRuleClassification>> = null;
	let peopleRule: PeopleRuleReason | null = null;
	if (!ownCommit) {
		if (await isTombstoned(env.D1, d)) {
			await dropRaw();
			logInfo("ingest_purged_skipped", logCtx);
			return { status: "purged", ...(ctx.dryRun ? { dryRun: true } : {}) };
		}
		if (ctx.repairOnly) {
			await dropRaw();
			logInfo("ingest_repair_only_skipped", logCtx);
			return { status: "skipped", reason: "repair_only", ...(ctx.dryRun ? { dryRun: true } : {}) };
		}
		if (ctx.dryRun) {
			return {
				status: "imported",
				emailId: d.record.id,
				threadId: null,
				mailboxState:
					d.record.direction === "outbound"
						? "sent"
						: ctx.lane === "history"
							? "archived"
							: "inbox",
				direction: d.record.direction,
				blockedSender: false,
				dryRun: true,
			};
		}

		setStage("materialize");
		const outcome = await materialize(env, d, ctx, raw, parsed, freshKeys);
		if (!outcome.inserted) {
			// Lost a race to an identical delivery, or it was purged in between.
			await dropRaw();
			const winner = await findExisting(env.D1, d, ctx);
			if (winner) {
				logInfo("ingest_duplicate", {
					...logCtx,
					existing_id: winner.row.id,
					match: winner.match,
					raced: true,
				});
				return { status: "duplicate", emailId: winner.row.id, match: winner.match };
			}
			logInfo("ingest_purged_skipped", { ...logCtx, raced: true });
			return { status: "purged" };
		}
		blockedSender = outcome.blockedSender;
		userRule = outcome.userRule;
		peopleRule = outcome.peopleRule;
	}

	// Post-commit bookkeeping: best-effort. The row and its raw artifact are committed,
	// so nothing here may turn the delivery into a reported failure (or drop the raw).
	const r = d.record;
	try {
		if (r.thread_id) await refreshThreadSafe(env.D1, r.thread_id);
		if (r.category === "notifications") await ensureInvitationNote(env.D1, r.id);
		if (userRule) {
			await logUserRuleClassification(env.D1, r.id, r.from_address, r.subject, userRule);
		}
		if (peopleRule) {
			await insertClassificationLog(env.D1, {
				email_id: r.id,
				from_address: r.from_address,
				subject: r.subject,
				category: "personal",
				previous_category: null,
				method: "people_rule",
				confidence: 1,
				ai_tokens_used: null,
			});
		}
	} catch (error) {
		logWarn("ingest_post_commit_failed", { ...logCtx, error: errorMessage(error) });
	}
	if (
		!ownCommit &&
		ctx.lane === "live" &&
		r.direction === "inbound" &&
		r.mailbox_state === "inbox" &&
		!blockedSender
	) {
		// A code notifies like a Needs-you note, whatever the sorter files it under (build 6).
		await ensureCodeNote(env.D1, r).catch((error) => {
			logWarn("ingest_code_note_failed", { ...logCtx, error: errorMessage(error) });
		});
		await notifyNewMail(env, r.id);
	}
	logInfo("ingest_imported", {
		...logCtx,
		mailbox_state: r.mailbox_state,
		attachment_count: d.attachments.length,
		blocked_sender: blockedSender,
		raw_object_key: raw.stored ? raw.key : null,
	});
	return {
		status: "imported",
		emailId: r.id,
		threadId: r.thread_id ?? null,
		mailboxState: r.mailbox_state,
		direction: r.direction,
		blockedSender,
	};
}

export async function ingestRawEmail(
	env: CloudflareBindings,
	raw: Uint8Array,
	ctx: DeliveryContext,
): Promise<IngestResult> {
	if (raw.byteLength > MAX_RAW_BYTES) {
		logWarn("ingest_raw_too_large", {
			domain: ctx.domain,
			mailbox: ctx.mailbox,
			size: raw.byteLength,
			limit: MAX_RAW_BYTES,
		});
		return {
			status: "rejected",
			code: "TOO_LARGE",
			error: `Message is ${raw.byteLength} bytes; the limit is ${MAX_RAW_BYTES}`,
		};
	}

	const emailId = createId();
	const storedAt = now();
	const rawKey = ctx.existingRawKey ?? buildRawEmailObjectKey(emailId, storedAt);
	let rawStored = Boolean(ctx.existingRawKey);
	let stage = "hash";
	const log = { email_id: emailId, domain: ctx.domain, mailbox: ctx.mailbox, lane: ctx.lane };

	// Never delete a raw object an artifact row references: a lost-response commit, an
	// overlapping replay or the original delivery may have adopted it. If D1 cannot
	// answer, keep it (an orphan costs storage; a dangling artifact loses evidence).
	const dropRaw = async () => {
		if (!rawStored) return;
		try {
			const referenced = await env.D1.prepare(
				"SELECT 1 FROM raw_email_artifacts WHERE object_key = ? LIMIT 1",
			)
				.bind(rawKey)
				.first();
			if (!referenced) await deleteObjects(env.ATTACHMENTS, [rawKey]);
		} catch {}
		rawStored = false;
	};
	const freshKeys = new Set<string>();

	try {
		const rawSha256 = await sha256Hex(raw);

		// Write-ahead: the raw bytes reach R2 before any parsing or D1 work, so a
		// message is never lost to a parser or D1 failure. Its customMetadata is the
		// delivery context, so the object alone is enough to replay it (replayRawBacklog).
		stage = "write_ahead";
		if (env.ATTACHMENTS && !ctx.dryRun && !ctx.existingRawKey) {
			try {
				await env.ATTACHMENTS.put(rawKey, raw, {
					httpMetadata: { contentType: "message/rfc822" },
					customMetadata: {
						domain: ctx.domain,
						mailbox: ctx.mailbox,
						folder: ctx.folder,
						seen: ctx.seen ? "1" : "0",
						lane: ctx.lane,
						source: ctx.source,
						received_at: String(ctx.receivedAt ?? ""),
						mailbox_date: String(ctx.mailboxDate ?? ""),
						repair_only: ctx.repairOnly ? "1" : "0",
						envelope_from: (ctx.envelope?.from ?? "").slice(0, 320),
						envelope_to: (ctx.envelope?.to ?? "").slice(0, 320),
					},
				});
				rawStored = true;
			} catch (error) {
				logError("ingest_raw_write_ahead_failed", { ...log, error: errorMessage(error) });
			}
		}

		stage = "parse";
		const { default: PostalMime } = await import("postal-mime");
		const parsed = await PostalMime.parse(raw);
		const d = describe(parsed, ctx, emailId);
		const logCtx = { ...log, message_id: d.record.message_id, direction: d.record.direction };

		for (let attempt = 1; ; attempt++) {
			try {
				return await storeDelivery(
					env,
					d,
					ctx,
					{ key: rawKey, sha256: rawSha256, size: raw.byteLength, storedAt, stored: rawStored },
					parsed,
					dropRaw,
					(next) => {
						stage = next;
					},
					logCtx,
					freshKeys,
				);
			} catch (error) {
				if (attempt >= STORE_ATTEMPTS) throw error;
				logWarn("ingest_store_retry", { ...logCtx, stage, attempt, error: errorMessage(error) });
				await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
			}
		}
	} catch (error) {
		// The last attempt may have committed before its response was lost.
		let committed: boolean | null = null;
		try {
			committed =
				(await env.D1.prepare("SELECT 1 FROM emails WHERE id = ?").bind(emailId).first()) !== null;
		} catch {}
		if (committed) {
			logWarn("ingest_committed_despite_error", { ...log, stage, error: errorMessage(error) });
			const row = await env.D1.prepare(
				"SELECT thread_id, mailbox_state, direction FROM emails WHERE id = ?",
			)
				.bind(emailId)
				.first<{
					thread_id: string | null;
					mailbox_state: EmailRecord["mailbox_state"];
					direction: EmailRecord["direction"];
				}>()
				.catch(() => null);
			return {
				status: "imported",
				emailId,
				threadId: row?.thread_id ?? null,
				mailboxState: row?.mailbox_state ?? "inbox",
				direction: row?.direction ?? "inbound",
				blockedSender: row?.direction === "inbound" && row?.mailbox_state === "trash",
			};
		}
		if (committed === false) await deleteObjects(env.ATTACHMENTS, [...freshKeys]);
		if (!ctx.rawIsOnlyCopy && committed === false) await dropRaw();
		logError("ingest_failed", {
			...log,
			stage,
			error: errorMessage(error),
			raw_object_key: rawStored ? rawKey : null,
			recovery: rawStored ? "replayed by the raw_replay cron (replayRawBacklog)" : null,
		});
		return {
			status: "failed",
			stage,
			error: errorMessage(error),
			rawStored,
			rawObjectKey: rawStored ? rawKey : null,
		};
	}
}

// ---------------------------------------------------------------------------
// Sweep: replay write-ahead objects that never got an artifact row
// ---------------------------------------------------------------------------

/**
 * Every raw write-ahead object ends with a raw_email_artifacts row (stored or
 * repaired) or is deleted (duplicate, purged, import-raw failure). One that is
 * older than `minAgeMs` and has neither is a delivery whose materialization
 * failed after the write-ahead (v40 review 2 X3/S1): replay it from its
 * own customMetadata, reusing the object. Scans the last three days' prefixes
 * (a two-day D1 outage still recovers); bounded by `limit` replays per run, in
 * random order so a poison object cannot starve healthy ones.
 */
export async function replayRawBacklog(
	env: CloudflareBindings,
	options: { limit?: number; minAgeMs?: number; nowMs?: number } = {},
): Promise<{ scanned: number; replayed: Array<{ key: string; status: string }> }> {
	const bucket = env.ATTACHMENTS;
	if (!bucket || !(await isRawEmailArtifactsTableReady(env.D1)))
		return { scanned: 0, replayed: [] };
	const limit = options.limit ?? 10;
	const nowMs = options.nowMs ?? now();
	const cutoff = nowMs - (options.minAgeMs ?? 15 * MINUTE_MS);
	const days = [0, 1, 2].map((back) =>
		new Date(nowMs - back * 24 * 60 * MINUTE_MS).toISOString().slice(0, 10).replaceAll("-", "/"),
	);

	const candidates: R2Object[] = [];
	let scanned = 0;
	for (const day of days) {
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const listing = await bucket.list({
				prefix: `${RAW_PREFIX}${day}/`,
				cursor,
				limit: 1000,
				include: ["customMetadata"],
			});
			const objects = listing.objects.filter((object) => object.uploaded.getTime() < cutoff);
			scanned += listing.objects.length;
			for (let i = 0; i < objects.length; i += 90) {
				const chunk = objects.slice(i, i + 90);
				const known = await env.D1.prepare(
					`SELECT object_key FROM raw_email_artifacts WHERE object_key IN (${chunk.map(() => "?").join(", ")})`,
				)
					.bind(...chunk.map((object) => object.key))
					.all<{ object_key: string }>();
				const recorded = new Set((known.results ?? []).map((row) => row.object_key));
				candidates.push(...chunk.filter((object) => !recorded.has(object.key)));
			}
			if (!listing.truncated) break;
			cursor = listing.cursor;
		}
	}

	for (let i = candidates.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[candidates[i], candidates[j]] = [candidates[j], candidates[i]];
	}
	const replayed: Array<{ key: string; status: string }> = [];
	for (const object of candidates.slice(0, limit)) {
		const meta = object.customMetadata ?? {};
		const body = await bucket.get(object.key);
		if (!body || !meta.domain || !meta.mailbox) {
			logError("raw_replay_unreadable", { key: object.key, has_metadata: Boolean(meta.domain) });
			replayed.push({ key: object.key, status: "unreadable" });
			continue;
		}
		const routed = meta.source === "cloudflare-email-routing";
		const receivedAt = Number(meta.received_at);
		const mailboxDate = Number(meta.mailbox_date);
		const result = await ingestRawEmail(env, new Uint8Array(await body.arrayBuffer()), {
			domain: meta.domain,
			mailbox: meta.mailbox,
			direction: routed ? "inbound" : undefined,
			folder: meta.folder === "sent" ? "sent" : "inbox",
			seen: meta.seen === "1",
			lane: meta.lane === "live" ? "live" : "history",
			source: meta.source || "replay",
			sourceType: routed ? null : "import-raw",
			envelope: routed ? { from: meta.envelope_from ?? "", to: meta.envelope_to ?? "" } : null,
			receivedAt: Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : undefined,
			mailboxDate: Number.isFinite(mailboxDate) && mailboxDate > 0 ? mailboxDate : undefined,
			domainScope: getConfiguredDomains(env),
			matchLegacy: !routed,
			rawIsOnlyCopy: true,
			existingRawKey: object.key,
			repairOnly: meta.repair_only === "1",
		});
		replayed.push({ key: object.key, status: result.status });
		logInfo("raw_replay", { key: object.key, status: result.status });
	}
	return { scanned, replayed };
}
