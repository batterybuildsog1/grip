/**
 * Send keys (v50 + v48 tracking). See sql/migrate-v50-send-idempotency-keys.sql and
 * sql/migrate-v48-send-tracking.sql.
 *
 * Every send dispatches through one row here; it is the only send guard.
 * - Caller-keyed sends (API/CLI `idempotency_key`): preparing → ready → dispatching →
 *   sent | failed | unknown. The key row is the commitment to one message (`fingerprint`);
 *   it is never deleted. While `preparing`, any request with the same key and fingerprint
 *   writes the message's immutable pieces (insert-if-missing, see prepareKeyedMessage in
 *   routes/emails.ts) and publishes `ready` once all of them are verified, so a dead or
 *   overlapping attempt never strands or damages the key (ticket 08). Keyed drafts are
 *   immutable (see keyedDraftLock).
 * - Keyless sends (UI drafts, API sends without a key): key_id = draft id,
 *   fingerprint = DRAFT_GUARD, created straight into `dispatching`. The draft stays
 *   editable.
 *
 * `owner` is the fence of the request that holds a dispatch (each dispatch takes a fresh
 * token). Only the holder may mark the submission, record the outcome or hand the row back.
 *
 * `submitted_at` is set just before the provider call. Once set, the row can never
 * go back to `ready` or be deleted: a dispatch with the marker and no outcome is
 * `unknown` and is never retried. A stalled dispatch without it never reached the
 * provider and may be taken over.
 */
import { sha256Hex as sha256Bytes } from "@/services/raw-email";

export type SendKeyStatus = "preparing" | "ready" | "dispatching" | "sent" | "failed" | "unknown";

/** fingerprint (and initial owner) of a keyless send's guard row: no content commitment. */
export const DRAFT_GUARD = "draft";

/** A dispatch that has not settled after this long counts as stalled. */
export const SEND_STALL_MS = 120_000;

/** One entry of evidence_json. Append-only, written with the state change it explains. */
export interface SendEvidence {
	at: number;
	event: "submitted" | "accepted" | "rejected" | "error";
	provider: string;
	provider_message_id?: string;
	/** HTTP-style status the provider error mapped to (4xx = definite rejection). */
	status?: number;
	code?: string;
	error?: string;
	/** The provider's own words: SMTP reply line, API code/message. */
	response?: string;
}

export interface SendKey {
	key_id: string;
	fingerprint: string;
	owner: string;
	status: SendKeyStatus;
	provider_message_id: string | null;
	created_at: number;
	updated_at: number;
	submitted_at: number | null;
	evidence: SendEvidence[];
}

type Row = Record<string, unknown>;

function parseEvidence(value: unknown): SendEvidence[] {
	if (typeof value !== "string" || value === "") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as SendEvidence[]) : [];
	} catch {
		return [];
	}
}

function mapSendKey(row: Row | null): SendKey | null {
	if (!row) return null;
	return {
		key_id: String(row.key_id),
		fingerprint: String(row.fingerprint),
		owner: String(row.owner),
		status: String(row.status) as SendKeyStatus,
		provider_message_id: row.provider_message_id == null ? null : String(row.provider_message_id),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
		submitted_at: row.submitted_at == null ? null : Number(row.submitted_at),
		evidence: parseEvidence(row.evidence_json),
	};
}

function asError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

async function changes(
	statement: D1PreparedStatement,
): Promise<{ updated: boolean; error?: Error }> {
	try {
		const result = await statement.run();
		return { updated: (result.meta?.changes ?? 0) > 0 };
	} catch (e: unknown) {
		return { updated: false, error: asError(e) };
	}
}

const MAX_EVIDENCE_TEXT = 500;

/** Bounded, JSON-ready evidence entry (provider messages can be long). */
function evidenceJson(entry: SendEvidence): string {
	const clip = (value: string | undefined) =>
		value === undefined ? undefined : value.slice(0, MAX_EVIDENCE_TEXT);
	return JSON.stringify({
		...entry,
		error: clip(entry.error),
		response: clip(entry.response),
	});
}

const APPEND_EVIDENCE = "json_insert(COALESCE(evidence_json, '[]'), '$[#]', json(?))";

export async function getSendKey(
	db: D1Database,
	keyId: string,
): Promise<{ key: SendKey | null; error?: Error }> {
	try {
		const row = await db
			.prepare("SELECT * FROM send_idempotency_keys WHERE key_id = ?")
			.bind(keyId)
			.first<Row>();
		return { key: mapSendKey(row) };
	} catch (e: unknown) {
		return { key: null, error: asError(e) };
	}
}

/** Atomically claim a caller key for `owner`. `existing` is set when it was taken. */
export async function reserveSendKey(
	db: D1Database,
	keyId: string,
	fingerprint: string,
	owner: string,
	at: number,
): Promise<{ reserved: boolean; existing: SendKey | null; error?: Error }> {
	const insert = await changes(
		db
			.prepare(
				`INSERT OR IGNORE INTO send_idempotency_keys
				 (key_id, fingerprint, owner, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'preparing', ?, ?)`,
			)
			.bind(keyId, fingerprint, owner, at, at),
	);
	if (insert.error) return { reserved: false, existing: null, error: insert.error };
	if (insert.updated) return { reserved: true, existing: null };
	const { key, error } = await getSendKey(db, keyId);
	return { reserved: false, existing: key, error };
}

/**
 * Publish a keyed message as complete. No owner check: whichever matching attempt verified
 * every piece first publishes it, and a later one finds it already `ready` (or further).
 */
export function publishSendKeyReady(db: D1Database, keyId: string, at: number) {
	return changes(
		db
			.prepare(
				`UPDATE send_idempotency_keys SET status = 'ready', updated_at = ?
				 WHERE key_id = ? AND status = 'preparing'`,
			)
			.bind(at, keyId),
	);
}

/**
 * Keyless send: create the draft's guard row already `dispatching`, held by
 * `token`. False when a row exists (another send of this draft, or an earlier one).
 */
export function claimDraftSendKey(db: D1Database, draftId: string, token: string, at: number) {
	return changes(
		db
			.prepare(
				`INSERT OR IGNORE INTO send_idempotency_keys
				 (key_id, fingerprint, owner, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'dispatching', ?, ?)`,
			)
			.bind(draftId, DRAFT_GUARD, token, at, at),
	);
}

/**
 * Start a new dispatch held by `token`, compare-and-set on the row as seen:
 * ready | failed, or a stalled `dispatching` that never set its submission marker.
 * Clears the marker; earlier attempts stay in evidence_json.
 */
export function beginSendKeyDispatch(db: D1Database, seen: SendKey, token: string, at: number) {
	return changes(
		db
			.prepare(
				`UPDATE send_idempotency_keys
				 SET status = 'dispatching', owner = ?, submitted_at = NULL, updated_at = ?
				 WHERE key_id = ? AND status = ? AND owner = ?
				   AND status IN ('ready', 'failed', 'dispatching')
				   AND (status <> 'dispatching' OR submitted_at IS NULL)`,
			)
			.bind(token, at, seen.key_id, seen.status, seen.owner),
	);
}

/**
 * The submission marker, written just before the provider call. The caller must
 * not call the provider unless this returns updated: true.
 */
export function markSendKeySubmitted(
	db: D1Database,
	keyId: string,
	token: string,
	provider: string,
	at: number,
) {
	return changes(
		db
			.prepare(
				`UPDATE send_idempotency_keys
				 SET submitted_at = ?, updated_at = ?, evidence_json = ${APPEND_EVIDENCE}
				 WHERE key_id = ? AND owner = ? AND status = 'dispatching' AND submitted_at IS NULL`,
			)
			.bind(at, at, evidenceJson({ at, event: "submitted", provider }), keyId, token),
	);
}

/**
 * The provider's answer to a submitted dispatch. `unknown` → `sent` is allowed: a
 * late acceptance settles a dispatch the gate had already called unknown.
 */
export function recordSendOutcome(
	db: D1Database,
	keyId: string,
	token: string,
	outcome: "sent" | "failed" | "unknown",
	evidence: SendEvidence,
) {
	return changes(
		db
			.prepare(
				`UPDATE send_idempotency_keys
				 SET status = ?, provider_message_id = COALESCE(?, provider_message_id),
				     updated_at = ?, evidence_json = ${APPEND_EVIDENCE}
				 WHERE key_id = ? AND owner = ? AND submitted_at IS NOT NULL
				   AND status IN ('dispatching', 'unknown')`,
			)
			.bind(
				outcome,
				evidence.provider_message_id ?? null,
				evidence.at,
				evidenceJson(evidence),
				keyId,
				token,
			),
	);
}

/** A stalled dispatch that set its marker: the outcome is unknown, never retry. */
export function markSendKeyUnknown(db: D1Database, seen: SendKey, at: number) {
	return changes(
		db
			.prepare(
				`UPDATE send_idempotency_keys SET status = 'unknown', updated_at = ?
				 WHERE key_id = ? AND owner = ? AND status = 'dispatching' AND submitted_at IS NOT NULL`,
			)
			.bind(at, seen.key_id, seen.owner),
	);
}

/**
 * Hand back a dispatch that stopped before the provider call (validation, missing
 * attachment, rate limit, lost marker write). A keyless row with no history is
 * deleted, leaving the draft untracked as before; any other row returns to `ready`.
 * Never touches a row whose marker is set.
 */
export async function releaseSendKeyDispatch(
	db: D1Database,
	keyId: string,
	token: string,
	at: number,
): Promise<{ updated: boolean; error?: Error }> {
	try {
		const [deleted, readied] = await db.batch([
			db
				.prepare(
					`DELETE FROM send_idempotency_keys
					 WHERE key_id = ? AND owner = ? AND fingerprint = ? AND status = 'dispatching'
					   AND submitted_at IS NULL AND evidence_json IS NULL`,
				)
				.bind(keyId, token, DRAFT_GUARD),
			db
				.prepare(
					`UPDATE send_idempotency_keys SET status = 'ready', updated_at = ?
					 WHERE key_id = ? AND owner = ? AND status = 'dispatching' AND submitted_at IS NULL`,
				)
				.bind(at, keyId, token),
		]);
		return {
			updated: (deleted.meta?.changes ?? 0) + (readied.meta?.changes ?? 0) > 0,
		};
	} catch (e: unknown) {
		return { updated: false, error: asError(e) };
	}
}

/** What `GET /api/emails/:id` and `mailclaw read` show about a message's sending. */
export interface SendSummary {
	state: "sending" | "sent" | "failed" | "unconfirmed";
	attempts: number;
	submitted_at: number | null;
	accepted_at: number | null;
	provider: string | null;
	/** The most recent rejection or error, kept after a later attempt succeeds. */
	last_error: string | null;
}

export function summarizeSendKey(key: SendKey, at: number): SendSummary {
	const submitted = key.evidence.filter((entry) => entry.event === "submitted");
	const accepted = key.evidence.filter((entry) => entry.event === "accepted").at(-1);
	const failure = key.evidence
		.filter((entry) => entry.event === "rejected" || entry.event === "error")
		.at(-1);
	let state: SendSummary["state"];
	switch (key.status) {
		case "sent":
			state = "sent";
			break;
		case "unknown":
			state = "unconfirmed";
			break;
		case "dispatching":
			state =
				key.submitted_at != null && at - key.updated_at > SEND_STALL_MS ? "unconfirmed" : "sending";
			break;
		case "preparing":
			// Nothing can go out before `ready`. A preparation nobody is finishing is
			// resumed by rerunning the same key, like `failed`.
			state = at - key.updated_at > SEND_STALL_MS ? "failed" : "sending";
			break;
		default: // failed, or ready: nothing went out and the same key resumes
			state = "failed";
	}
	return {
		state,
		attempts: submitted.length,
		submitted_at: key.submitted_at ?? submitted.at(-1)?.at ?? null,
		accepted_at: accepted?.at ?? null,
		provider: submitted.at(-1)?.provider ?? null,
		last_error: failure
			? [failure.code, failure.error].filter(Boolean).join(": ") || failure.event
			: null,
	};
}

const encoder = new TextEncoder();

function sha256Hex(value: string): Promise<string> {
	return sha256Bytes(encoder.encode(value));
}

/**
 * Deterministic draft id for (scope, key). Structured, namespaced input so a
 * workspace literally named "api" or containing a delimiter cannot collide
 * with another namespace. Lowercase `k` + 23 hex chars keeps the id inside the
 * [a-z0-9]{24} shape other code expects of cuid2 ids.
 */
export async function sendKeyId(
	scope: { kind: "workspace" | "api" | "user"; id: string },
	key: string,
): Promise<string> {
	const digest = await sha256Hex(
		JSON.stringify(["mailclaw-send-key-v1", scope.kind, scope.id, key]),
	);
	return `k${digest.slice(0, 23)}`;
}

export interface FingerprintInput {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	reply_to: string[];
	subject: string;
	text: string | null;
	html: string | null;
	in_reply_to: string | null;
	references: string | null;
	attachments: Array<{
		filename: string;
		content_type: string;
		content_id?: string;
		disposition?: string;
		content_base64: string;
	}>;
}

/** Hash of every field that changes what the recipient gets. */
export async function sendFingerprint(input: FingerprintInput): Promise<string> {
	const addresses = (values: string[]) => values.map((value) => value.trim().toLowerCase()).sort();
	const attachments = await Promise.all(
		input.attachments.map(async (attachment) => ({
			filename: attachment.filename,
			content_type: attachment.content_type,
			content_id: attachment.content_id ?? null,
			disposition: attachment.disposition ?? "attachment",
			sha256: await sha256Hex(attachment.content_base64.replace(/\s+/g, "")),
		})),
	);
	return sha256Hex(
		JSON.stringify({
			v: 1,
			from: input.from.trim().toLowerCase(),
			to: addresses(input.to),
			cc: addresses(input.cc),
			bcc: addresses(input.bcc),
			reply_to: addresses(input.reply_to),
			subject: input.subject.trim(),
			text: input.text ?? null,
			html: input.html ?? null,
			in_reply_to: input.in_reply_to ?? null,
			references: input.references ?? null,
			attachments,
		}),
	);
}

/**
 * What a reply key commits to: the request, not the composed message (ticket 08,
 * review 2). The first attempt's composition is frozen in the draft row; a later replay
 * must not conflict because the original or the composition rules changed since.
 */
export async function replyRequestFingerprint(
	originalId: string,
	request: {
		text?: string;
		html?: string;
		all?: boolean;
		from?: string;
		cc?: string[];
		bcc?: string[];
		quote?: boolean;
		attachments?: FingerprintInput["attachments"];
	},
): Promise<string> {
	const addresses = (values: string[] = []) =>
		values.map((value) => value.trim().toLowerCase()).sort();
	const attachments = await Promise.all(
		(request.attachments ?? []).map(async (attachment) => ({
			filename: attachment.filename,
			content_type: attachment.content_type,
			content_id: attachment.content_id ?? null,
			disposition: attachment.disposition ?? "attachment",
			sha256: await sha256Hex(attachment.content_base64.replace(/\s+/g, "")),
		})),
	);
	return sha256Hex(
		JSON.stringify({
			v: "reply-request-1",
			original_id: originalId,
			text: request.text ?? null,
			html: request.html ?? null,
			all: request.all === true,
			from: request.from?.trim().toLowerCase() || null,
			cc: addresses(request.cc),
			bcc: addresses(request.bcc),
			quote: request.quote !== false,
			attachments,
		}),
	);
}
