import { isEmailFidelityChecksTableReady, isRawEmailArtifactsTableReady } from "@/database/tables";
import type { EmailRecord } from "@/types";
import { now } from "@/utils/helpers";
import { logError } from "@/utils/logging";
import { normalizeEmailAddress } from "@/utils/platform";

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 90;
const RAW_EMAIL_PARSER_VERSION = "postal-mime:v1";

type ParsedAddress = { address?: string; name?: string };
type ParsedHeader = { key: string; value: string };

export interface ParsedEmailForFidelity {
	from?: ParsedAddress;
	to?: ParsedAddress[];
	cc?: ParsedAddress[];
	bcc?: ParsedAddress[];
	replyTo?: ParsedAddress[];
	subject?: string | null;
	messageId?: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	headers?: ParsedHeader[];
}

export interface RawEmailArtifact {
	id: string;
	email_id: string;
	domain: string;
	mailbox: string;
	object_key: string;
	sha256: string;
	size: number;
	stored_at: number;
	expires_at: number;
	source: string;
	envelope_from: string | null;
	envelope_to: string | null;
	parse_status: string;
	created_at: number;
}

export interface EmailFidelityCheck {
	id: string;
	email_id: string;
	checked_at: number;
	parser_version: string;
	status: "pass" | "warn" | "fail";
	raw_sha256: string | null;
	raw_size: number | null;
	mismatches: FidelityMismatch[];
	raw_headers: HeaderSnapshot;
	stored_headers: StoredHeaderSnapshot;
	envelope: EnvelopeSnapshot;
	created_at: number;
}

export interface FidelityMismatch {
	field: string;
	raw: unknown;
	stored: unknown;
	severity: "warn" | "fail";
}

export interface HeaderSnapshot {
	from_address: string | null;
	from_name: string | null;
	to_addresses: string[];
	cc_addresses: string[];
	bcc_addresses: string[];
	reply_to_addresses: string[];
	subject: string | null;
	message_id: string | null;
	in_reply_to: string | null;
	references_header: string | null;
	list_unsubscribe: string | null;
}

export interface StoredHeaderSnapshot extends HeaderSnapshot {
	to_address: string;
}

export interface EnvelopeSnapshot {
	from: string | null;
	to: string | null;
}

export interface EmailFidelitySummary extends EmailFidelityCheck {
	artifact: RawEmailArtifact | null;
	email: {
		id: string;
		domain: string;
		mailbox: string;
		subject: string | null;
		from_address: string;
		to_address: string;
		received_at: number;
	} | null;
}

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function toStringOrNull(value: unknown): string | null {
	if (value == null) return null;
	const stringValue = String(value);
	return stringValue.length > 0 ? stringValue : null;
}

function toNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

function getHeaderValue(headers: ParsedHeader[] | undefined, key: string): string | null {
	const normalizedKey = key.toLowerCase();
	return (
		headers?.find((header) => header.key.toLowerCase() === normalizedKey)?.value?.trim() ?? null
	);
}

function extractAddresses(values: ParsedAddress[] | undefined): string[] {
	return (values ?? [])
		.map((value) => (value.address ? normalizeEmailAddress(value.address) : null))
		.filter((value): value is string => Boolean(value));
}

function normalizeOptionalAddress(value: string | null | undefined): string | null {
	return value ? normalizeEmailAddress(value) : null;
}

function arraysEqual(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function addScalarMismatch(
	mismatches: FidelityMismatch[],
	field: string,
	raw: unknown,
	stored: unknown,
	severity: "warn" | "fail" = "fail",
) {
	if (raw !== stored) {
		mismatches.push({ field, raw, stored, severity });
	}
}

function addArrayMismatch(
	mismatches: FidelityMismatch[],
	field: string,
	raw: string[],
	stored: string[],
) {
	if (!arraysEqual(raw, stored)) {
		mismatches.push({ field, raw, stored, severity: "fail" });
	}
}

export function getRawEmailRetentionDays(env: CloudflareBindings): number {
	const configured = Number(
		(env as { RAW_EMAIL_RETENTION_DAYS?: string }).RAW_EMAIL_RETENTION_DAYS,
	);
	if (!Number.isFinite(configured) || configured <= 0) {
		return DEFAULT_RETENTION_DAYS;
	}
	return Math.min(Math.floor(configured), MAX_RETENTION_DAYS);
}

export function getRawEmailExpiresAt(env: CloudflareBindings, storedAt: number): number {
	return storedAt + getRawEmailRetentionDays(env) * 24 * 60 * 60 * 1000;
}

export function buildRawEmailObjectKey(emailId: string, receivedAt: number): string {
	const isoDay = new Date(receivedAt).toISOString().slice(0, 10);
	const [year, month, day] = isoDay.split("-");
	return `raw-inbound/${year}/${month}/${day}/${emailId}.eml`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildHeaderSnapshot(parsed: ParsedEmailForFidelity): HeaderSnapshot {
	return {
		from_address: normalizeOptionalAddress(parsed.from?.address),
		from_name: parsed.from?.name?.trim() || null,
		to_addresses: extractAddresses(parsed.to),
		cc_addresses: extractAddresses(parsed.cc),
		bcc_addresses: extractAddresses(parsed.bcc),
		reply_to_addresses: extractAddresses(parsed.replyTo),
		subject: parsed.subject || null,
		message_id: parsed.messageId || null,
		in_reply_to: parsed.inReplyTo || null,
		references_header: parsed.references || null,
		list_unsubscribe: getHeaderValue(parsed.headers, "list-unsubscribe"),
	};
}

export function buildStoredHeaderSnapshot(email: EmailRecord): StoredHeaderSnapshot {
	return {
		from_address: normalizeOptionalAddress(email.from_address),
		from_name: email.from_name?.trim() || null,
		to_address: normalizeEmailAddress(email.to_address),
		to_addresses: email.to_addresses.map(normalizeEmailAddress),
		cc_addresses: email.cc_addresses.map(normalizeEmailAddress),
		bcc_addresses: email.bcc_addresses.map(normalizeEmailAddress),
		reply_to_addresses: email.reply_to_addresses.map(normalizeEmailAddress),
		subject: email.subject,
		message_id: email.message_id,
		in_reply_to: email.in_reply_to,
		references_header: email.references_header,
		list_unsubscribe: email.list_unsubscribe ?? null,
	};
}

export function buildEmailFidelityCheck({
	email,
	parsed,
	envelope,
	rawSha256,
	rawSize,
	checkedAt = now(),
}: {
	email: EmailRecord;
	parsed: ParsedEmailForFidelity;
	envelope: EnvelopeSnapshot;
	rawSha256: string | null;
	rawSize: number | null;
	checkedAt?: number;
}): Omit<EmailFidelityCheck, "id" | "created_at"> {
	const rawHeaders = buildHeaderSnapshot(parsed);
	const storedHeaders = buildStoredHeaderSnapshot(email);
	const normalizedEnvelope = {
		from: normalizeOptionalAddress(envelope.from),
		to: normalizeOptionalAddress(envelope.to),
	};
	const mismatches: FidelityMismatch[] = [];

	addScalarMismatch(
		mismatches,
		"envelope.to_address",
		normalizedEnvelope.to,
		storedHeaders.to_address,
	);
	addScalarMismatch(
		mismatches,
		"from_address",
		rawHeaders.from_address,
		storedHeaders.from_address,
	);
	addScalarMismatch(mismatches, "from_name", rawHeaders.from_name, storedHeaders.from_name, "warn");
	addArrayMismatch(mismatches, "to_addresses", rawHeaders.to_addresses, storedHeaders.to_addresses);
	addArrayMismatch(mismatches, "cc_addresses", rawHeaders.cc_addresses, storedHeaders.cc_addresses);
	addArrayMismatch(
		mismatches,
		"bcc_addresses",
		rawHeaders.bcc_addresses,
		storedHeaders.bcc_addresses,
	);
	addArrayMismatch(
		mismatches,
		"reply_to_addresses",
		rawHeaders.reply_to_addresses,
		storedHeaders.reply_to_addresses,
	);
	addScalarMismatch(mismatches, "subject", rawHeaders.subject, storedHeaders.subject, "warn");
	addScalarMismatch(mismatches, "message_id", rawHeaders.message_id, storedHeaders.message_id);
	addScalarMismatch(mismatches, "in_reply_to", rawHeaders.in_reply_to, storedHeaders.in_reply_to);
	addScalarMismatch(
		mismatches,
		"references_header",
		rawHeaders.references_header,
		storedHeaders.references_header,
	);
	addScalarMismatch(
		mismatches,
		"list_unsubscribe",
		rawHeaders.list_unsubscribe,
		storedHeaders.list_unsubscribe,
		"warn",
	);

	const status = mismatches.some((mismatch) => mismatch.severity === "fail")
		? "fail"
		: mismatches.length > 0
			? "warn"
			: "pass";

	return {
		email_id: email.id,
		checked_at: checkedAt,
		parser_version: RAW_EMAIL_PARSER_VERSION,
		status,
		raw_sha256: rawSha256,
		raw_size: rawSize,
		mismatches,
		raw_headers: rawHeaders,
		stored_headers: storedHeaders,
		envelope: normalizedEnvelope,
	};
}

function mapRawEmailArtifact(row: Row | null | undefined): RawEmailArtifact | null {
	if (!row) return null;
	return {
		id: String(row.id),
		email_id: String(row.email_id),
		domain: String(row.domain),
		mailbox: String(row.mailbox),
		object_key: String(row.object_key),
		sha256: String(row.sha256),
		size: toNumber(row.size),
		stored_at: toNumber(row.stored_at),
		expires_at: toNumber(row.expires_at),
		source: String(row.source),
		envelope_from: toStringOrNull(row.envelope_from),
		envelope_to: toStringOrNull(row.envelope_to),
		parse_status: String(row.parse_status),
		created_at: toNumber(row.created_at),
	};
}

function mapEmailFidelityCheck(row: Row | null | undefined): EmailFidelityCheck | null {
	if (!row) return null;
	return {
		id: String(row.id),
		email_id: String(row.email_id),
		checked_at: toNumber(row.checked_at),
		parser_version: String(row.parser_version),
		status: String(row.status) as EmailFidelityCheck["status"],
		raw_sha256: toStringOrNull(row.raw_sha256),
		raw_size: row.raw_size == null ? null : toNumber(row.raw_size),
		mismatches: parseJson<FidelityMismatch[]>(row.mismatches_json, []),
		raw_headers: parseJson<HeaderSnapshot>(row.raw_headers_json, {
			from_address: null,
			from_name: null,
			to_addresses: [],
			cc_addresses: [],
			bcc_addresses: [],
			reply_to_addresses: [],
			subject: null,
			message_id: null,
			in_reply_to: null,
			references_header: null,
			list_unsubscribe: null,
		}),
		stored_headers: parseJson<StoredHeaderSnapshot>(row.stored_headers_json, {
			from_address: null,
			from_name: null,
			to_address: "",
			to_addresses: [],
			cc_addresses: [],
			bcc_addresses: [],
			reply_to_addresses: [],
			subject: null,
			message_id: null,
			in_reply_to: null,
			references_header: null,
			list_unsubscribe: null,
		}),
		envelope: parseJson<EnvelopeSnapshot>(row.envelope_json, { from: null, to: null }),
		created_at: toNumber(row.created_at),
	};
}

export async function getRawEmailArtifactByEmailId(
	db: D1Database,
	emailId: string,
): Promise<{ artifact: RawEmailArtifact | null; error?: Error }> {
	if (!(await isRawEmailArtifactsTableReady(db))) {
		return { artifact: null };
	}

	try {
		const row = await db
			.prepare("SELECT * FROM raw_email_artifacts WHERE email_id = ? LIMIT 1")
			.bind(emailId)
			.first<Row>();
		return { artifact: mapRawEmailArtifact(row) };
	} catch (err) {
		return { artifact: null, error: err instanceof Error ? err : new Error(String(err)) };
	}
}

export async function getEmailFidelityCheckByEmailId(
	db: D1Database,
	emailId: string,
): Promise<{ check: EmailFidelityCheck | null; error?: Error }> {
	if (!(await isEmailFidelityChecksTableReady(db))) {
		return { check: null };
	}

	try {
		const row = await db
			.prepare("SELECT * FROM email_fidelity_checks WHERE email_id = ? LIMIT 1")
			.bind(emailId)
			.first<Row>();
		return { check: mapEmailFidelityCheck(row) };
	} catch (err) {
		return { check: null, error: err instanceof Error ? err : new Error(String(err)) };
	}
}

function pushDomainScope(
	conditions: string[],
	params: unknown[],
	domainScope: string[],
	tableAlias = "e",
) {
	if (domainScope.length === 0) return;
	conditions.push(`${tableAlias}.domain IN (${domainScope.map(() => "?").join(", ")})`);
	params.push(...domainScope);
}

export async function listEmailFidelityChecks(
	db: D1Database,
	options: {
		domainScope: string[];
		status?: string;
		limit?: number;
	},
): Promise<{ checks: EmailFidelitySummary[]; error?: Error }> {
	if (!(await isEmailFidelityChecksTableReady(db))) {
		return { checks: [] };
	}

	const conditions: string[] = [];
	const params: unknown[] = [];
	pushDomainScope(conditions, params, options.domainScope);

	if (options.status && options.status !== "all") {
		conditions.push("c.status = ?");
		params.push(options.status);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
	params.push(limit);

	try {
		const result = await db
			.prepare(
				`SELECT
					c.*,
					a.id AS artifact_id,
					a.domain AS artifact_domain,
					a.mailbox AS artifact_mailbox,
					a.object_key AS artifact_object_key,
					a.sha256 AS artifact_sha256,
					a.size AS artifact_size,
					a.stored_at AS artifact_stored_at,
					a.expires_at AS artifact_expires_at,
					a.source AS artifact_source,
					a.envelope_from AS artifact_envelope_from,
					a.envelope_to AS artifact_envelope_to,
					a.parse_status AS artifact_parse_status,
					a.created_at AS artifact_created_at,
					e.id AS email_row_id,
					e.domain AS email_domain,
					e.mailbox AS email_mailbox,
					e.subject AS email_subject,
					e.from_address AS email_from_address,
					e.to_address AS email_to_address,
					e.received_at AS email_received_at
				FROM email_fidelity_checks c
				INNER JOIN emails e ON e.id = c.email_id
				LEFT JOIN raw_email_artifacts a ON a.email_id = c.email_id
				${where}
				ORDER BY c.checked_at DESC
				LIMIT ?`,
			)
			.bind(...params)
			.all<Row>();

		const checks = (result.results ?? [])
			.map((row) => {
				const check = mapEmailFidelityCheck(row);
				if (!check) return null;
				const artifact = row.artifact_id
					? mapRawEmailArtifact({
							id: row.artifact_id,
							email_id: row.email_id,
							domain: row.artifact_domain,
							mailbox: row.artifact_mailbox,
							object_key: row.artifact_object_key,
							sha256: row.artifact_sha256,
							size: row.artifact_size,
							stored_at: row.artifact_stored_at,
							expires_at: row.artifact_expires_at,
							source: row.artifact_source,
							envelope_from: row.artifact_envelope_from,
							envelope_to: row.artifact_envelope_to,
							parse_status: row.artifact_parse_status,
							created_at: row.artifact_created_at,
						})
					: null;
				return {
					...check,
					artifact,
					email: row.email_row_id
						? {
								id: String(row.email_row_id),
								domain: String(row.email_domain),
								mailbox: String(row.email_mailbox),
								subject: toStringOrNull(row.email_subject),
								from_address: String(row.email_from_address),
								to_address: String(row.email_to_address),
								received_at: toNumber(row.email_received_at),
							}
						: null,
				};
			})
			.filter((check): check is EmailFidelitySummary => check !== null);

		return { checks };
	} catch (err) {
		return { checks: [], error: err instanceof Error ? err : new Error(String(err)) };
	}
}

export async function purgeExpiredRawEmailArtifacts(
	db: D1Database,
	bucket: R2Bucket | undefined,
	limit = 100,
	options: { dryRun?: boolean } = {},
): Promise<{
	scanned: number;
	deleted: number;
	failed: number;
	errors: Array<{ email_id: string; error: string }>;
	candidates?: Array<{ email_id: string; object_key: string }>;
}> {
	if (!bucket || !(await isRawEmailArtifactsTableReady(db))) {
		return { scanned: 0, deleted: 0, failed: 0, errors: [] };
	}

	const batchSize = Math.max(1, Math.min(limit, 500));
	const cutoff = now();
	const result = await db
		.prepare(
			`SELECT email_id, object_key
			 FROM raw_email_artifacts
			 WHERE expires_at <= ?
			 ORDER BY expires_at ASC
			 LIMIT ?`,
		)
		.bind(cutoff, batchSize)
		.all<{ email_id: string; object_key: string }>();

	const rows = result.results ?? [];
	if (options.dryRun) {
		return {
			scanned: rows.length,
			deleted: 0,
			failed: 0,
			errors: [],
			candidates: rows.slice(0, 20),
		};
	}

	let deleted = 0;
	const errors: Array<{ email_id: string; error: string }> = [];

	for (const row of rows) {
		try {
			await bucket.delete(row.object_key);
			await db
				.prepare("DELETE FROM raw_email_artifacts WHERE email_id = ?")
				.bind(row.email_id)
				.run();
			deleted += 1;
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			errors.push({ email_id: row.email_id, error });
			logError("raw_email_purge_failed", { email_id: row.email_id, error });
		}
	}

	return {
		scanned: rows.length,
		deleted,
		failed: errors.length,
		errors: errors.slice(0, 10),
	};
}
