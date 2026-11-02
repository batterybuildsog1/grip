/** Bounded, read-only D1 source discovery. No body/HTML/header JSON is loaded implicitly. */
import type { AttentionEmail, PresentedIssue } from "@/services/morning-report";

const DAY = 86400000;
export const MORNING_SOURCE_LIMITS = {
	candidates: 3000,
	candidateBytes: 12 * 1024 * 1024,
	page: 100,
	bodyBytes: 8192,
	sentRows: 4000,
	sentBytes: 4 * 1024 * 1024,
	relationshipEvents: 12000,
	historyBytes: 512 * 1024,
	historyRows: 1000,
} as const;

// Byte limits also bound malicious/imported metadata. A clipped metadata field makes the
// result incomplete; a body prefix is the explicit rule input, shared by SQL and JS.
const fields: Record<string, number> = {
	id: 256,
	thread_id: 256,
	message_id: 512,
	provider_message_id: 512,
	from_address: 320,
	from_name: 128,
	to_address: 320,
	to_addresses_json: 1024,
	cc_addresses_json: 1024,
	reply_to_addresses_json: 1024,
	subject: 1024,
	domain: 256,
	category: 64,
	sub_category: 64,
	mailbox_state: 32,
	direction: 16,
	action_note: 560,
};
const clip = (column: string, bytes: number) =>
	`CAST(substr(CAST(${column} AS BLOB),1,${bytes}) AS TEXT)`;
const projection = Object.entries(fields)
	.map(([column, bytes]) => `${clip(`e.${column}`, bytes)} AS ${column}`)
	.join(",");
const clippedFields = (columns: string[]) =>
	columns.map((column) => `length(CAST(e.${column} AS BLOB))>${fields[column]}`).join(" OR ");
const clipped = clippedFields(Object.keys(fields));
const sentFields = ["id", "thread_id", "to_address", "to_addresses_json", "cc_addresses_json"];
// Superset of every non-person content gate AND financial-resolution phrase in the selector.
// SQLite scans the prefix in D1, returning only metadata for possible sources/evidence.
const needles = [
	"final-recipient",
	"delivery",
	"undeliver",
	"mailer-daemon",
	"coverage",
	"policy",
	"compromis",
	"certificate",
	"cloudflared",
	"thermostat",
	"hvac",
	"payment",
	"settlement",
	"past",
	"due",
	"suspend",
	"disconnect",
	"shut",
	"publish",
	"grants",
	"reconnect",
	"bank",
	"paid in full",
	"fully repaid",
	"no further action",
	"resolved",
];
const content = `lower(COALESCE(e.subject,'')||char(10)||COALESCE(${clip("e.text_content", MORNING_SOURCE_LIMITS.bodyBytes)},''))`;
const contentGate = needles.map((word) => `instr(${content},'${word}')>0`).join(" OR ");
const effectiveFrom = `lower(CASE WHEN json_valid(e.reply_to_addresses_json) THEN
 CASE WHEN json_array_length(e.reply_to_addresses_json)=1 THEN json_extract(e.reply_to_addresses_json,'$[0]') ELSE e.from_address END ELSE e.from_address END)`;

export interface MorningCollectionMetrics {
	queries: number;
	rows: number;
	/** UTF-8 JSON bytes across D1 responses, not process RSS or a heap estimate. */
	materialized_bytes: number;
	max_result_bytes: number;
	body_rows: number;
}

type Source = AttentionEmail & { metadata_clipped?: number };
function addresses(value?: string | null): string[] {
	try {
		const parsed: unknown = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

export async function loadMorningReportSources(
	db: D1Database,
	options: { until: number; domains: string[]; historyKey: string; supportAddresses?: string[] },
): Promise<{
	emails: AttentionEmail[];
	history: PresentedIssue[];
	errors: string[];
	metrics: MorningCollectionMetrics;
}> {
	const emails: AttentionEmail[] = [];
	const errors: string[] = [];
	let history: PresentedIssue[] = [];
	const metrics: MorningCollectionMetrics = {
		queries: 0,
		rows: 0,
		materialized_bytes: 0,
		max_result_bytes: 0,
		body_rows: 0,
	};
	const account = (value: unknown, rows: number) => {
		const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
		metrics.queries++;
		metrics.rows += rows;
		metrics.materialized_bytes += bytes;
		metrics.max_result_bytes = Math.max(metrics.max_result_bytes, bytes);
	};
	async function all<T>(sql: string, ...params: (string | number)[]): Promise<T[]> {
		const result = await db
			.prepare(sql)
			.bind(...params)
			.all<T>();
		account(result, result.results?.length || 0);
		if (!result.success) throw new Error("source query failed");
		return result.results || [];
	}
	try {
		const state = await all<{ value: string; bytes: number }>(
			`SELECT ${clip("value", MORNING_SOURCE_LIMITS.historyBytes)} AS value,
			 length(CAST(value AS BLOB)) AS bytes FROM agent_memory
			 WHERE key=? AND workspace_id='system' LIMIT 1`,
			options.historyKey,
		);
		if (state[0]) {
			if (state[0].bytes > MORNING_SOURCE_LIMITS.historyBytes) {
				errors.push("Presentation history byte budget reached; collection incomplete");
			} else {
				const parsed: unknown = JSON.parse(state[0].value);
				if (!Array.isArray(parsed)) throw new Error("invalid history");
				if (parsed.length > MORNING_SOURCE_LIMITS.historyRows)
					errors.push("Presentation history row budget reached; collection incomplete");
				const bounded = parsed.slice(0, MORNING_SOURCE_LIMITS.historyRows);
				if (
					!bounded.every((value) => {
						if (!value || typeof value !== "object") return false;
						const h = value as PresentedIssue;
						return (
							typeof h.issue_id === "string" &&
							typeof h.email_id === "string" &&
							typeof h.state === "string" &&
							typeof h.reminded === "boolean" &&
							Number.isFinite(h.presented_at) &&
							Number.isFinite(h.received_at) &&
							Array.isArray(h.duplicate_ids) &&
							h.duplicate_ids.every((id) => typeof id === "string")
						);
					})
				)
					throw new Error("invalid history entries");
				history = bounded;
			}
		}
		// Load only sent relationship metadata once, globally as in v2. Older sent bodies are
		// irrelevant: prior evidence is metadata; responsive replies need only the 45d window.
		const byAddress = new Map<string, number[]>();
		const byThread = new Map<string, number[]>();
		let events = 0;
		const add = (map: Map<string, number[]>, key: string, at: number) => {
			if (!key) return;
			if (++events > MORNING_SOURCE_LIMITS.relationshipEvents)
				throw new Error("relationship event budget");
			const times = map.get(key) || [];
			times.push(at);
			map.set(key, times);
		};
		let sentAt = options.until + 1,
			sentId = "",
			sentRows = 0,
			sentBytes = 0;
		for (;;) {
			const before = metrics.materialized_bytes;
			const page = await all<Source>(
				`SELECT ${sentFields.map((c) => `${clip(`e.${c}`, fields[c])} AS ${c}`).join(",")},e.received_at,
			 (${clippedFields(sentFields)}) AS metadata_clipped FROM emails e
			 WHERE e.direction='outbound' AND e.mailbox_state!='draft' AND e.received_at<=?
			 AND e.received_at>? AND (e.received_at<? OR (e.received_at=? AND e.id>?))
			 ORDER BY e.received_at DESC,e.id ASC LIMIT 250`,
				options.until,
				options.until - 410 * DAY,
				sentAt,
				sentAt,
				sentId,
			);
			sentBytes += metrics.materialized_bytes - before;
			sentRows += page.length;
			if (sentRows > MORNING_SOURCE_LIMITS.sentRows || sentBytes > MORNING_SOURCE_LIMITS.sentBytes)
				throw new Error("sent metadata budget");
			for (const row of page) {
				if (row.metadata_clipped) throw new Error("sent metadata clipped");
				if (row.thread_id) add(byThread, row.thread_id, row.received_at);
				for (const address of new Set([
					row.to_address || "",
					...addresses(row.to_addresses_json),
					...addresses(row.cc_addresses_json),
				]))
					add(byAddress, address.toLowerCase(), row.received_at);
			}
			if (page.length < 250) break;
			sentAt = page[page.length - 1].received_at;
			sentId = page[page.length - 1].id;
		}
		const hasPrior = (times: number[] | undefined, at: number) =>
			times?.some((time) => time <= at && time > at - 365 * DAY);
		const sentAddresses = JSON.stringify([...byAddress.keys()]);
		const sentThreads = JSON.stringify([...byThread.keys()]);
		const domainsJson = JSON.stringify(options.domains);
		// One SQL discovery scan returns at most 3001 tiny identifiers. Re-running the
		// content predicates on every cursor page can rescan/sort the mailbox N times.
		const ids = await all<{ id: string; received_at: number; metadata_clipped: number }>(
			`SELECT ${clip("e.id", fields.id)} AS id,e.received_at,
			 length(CAST(e.id AS BLOB))>${fields.id} AS metadata_clipped FROM emails e
			 WHERE e.domain IN (SELECT value FROM json_each(?)) AND e.received_at<=? AND e.received_at>?
			 AND (e.received_at>? OR e.direction='outbound' OR COALESCE(e.category,'')!='personal')
			 AND (e.direction='outbound' OR e.category='personal'
			 OR ${effectiveFrom} IN (SELECT value FROM json_each(?))
			 OR lower(e.from_address) IN (SELECT value FROM json_each(?))
			 OR e.thread_id IN (SELECT value FROM json_each(?))
			 OR substr(${effectiveFrom},instr(${effectiveFrom},'@')+1) IN (SELECT value FROM json_each(?))
			 OR lower(e.to_address) IN (SELECT value FROM json_each(?))
			 OR EXISTS (SELECT 1 FROM json_each(?) s WHERE instr(lower(COALESCE(e.to_addresses_json,'')), s.value)>0)
			 OR ${contentGate})
			 ORDER BY e.received_at DESC,e.id ASC LIMIT ${MORNING_SOURCE_LIMITS.candidates + 1}`,
			domainsJson,
			options.until,
			options.until - 45 * DAY,
			options.until - 7 * DAY,
			sentAddresses,
			sentAddresses,
			sentThreads,
			domainsJson,
			JSON.stringify(options.supportAddresses ?? []),
			JSON.stringify(options.supportAddresses ?? []),
		);
		if (ids.some((r) => r.metadata_clipped)) throw new Error("candidate id clipped");
		if (ids.length > MORNING_SOURCE_LIMITS.candidates)
			errors.push("Candidate row budget reached; collection incomplete");
		let retainedBytes = 0;
		for (
			let offset = 0;
			offset < Math.min(ids.length, MORNING_SOURCE_LIMITS.candidates);
			offset += MORNING_SOURCE_LIMITS.page
		) {
			const selected = ids.slice(
				offset,
				Math.min(offset + MORNING_SOURCE_LIMITS.page, MORNING_SOURCE_LIMITS.candidates),
			);
			const page = await all<Source>(
				`SELECT ${projection},e.received_at,e.sent_at,e.read_at,e.auto_read_at,
			 e.action_due,e.action_done_at,CASE WHEN e.list_unsubscribe IS NOT NULL AND e.list_unsubscribe!='' THEN 'present' ELSE NULL END AS list_unsubscribe,
			 t.is_muted,${clip("t.user_pinned_category", 64)} AS user_pinned_category,
			 (SELECT ${clip("sr.category", 64)} FROM sender_rules sr WHERE sr.from_pattern=lower(e.from_address) OR sr.from_pattern='*@'||substr(lower(e.from_address),instr(e.from_address,'@')+1) ORDER BY length(sr.from_pattern) DESC LIMIT 1) AS sender_category,
			 (${clipped} OR length(CAST(t.user_pinned_category AS BLOB))>64) AS metadata_clipped,
			 ${clip("e.text_content", MORNING_SOURCE_LIMITS.bodyBytes)} AS text_content
			 FROM emails e LEFT JOIN threads t ON t.id=e.thread_id
			 WHERE e.id IN (${selected.map(() => "?").join(",")})`,
				...selected.map((r) => r.id),
			);
			metrics.body_rows += page.length;
			if (page.length !== selected.length) throw new Error("source changed during collection");
			if (page.some((r) => r.metadata_clipped)) throw new Error("candidate metadata clipped");
			for (const row of page) {
				const replyTo = addresses(row.reply_to_addresses_json);
				const effective = (replyTo.length === 1 ? replyTo[0] : row.from_address).toLowerCase();
				row.people_signal =
					hasPrior(byThread.get(row.thread_id || ""), row.received_at) ||
					hasPrior(byAddress.get(effective), row.received_at) ||
					hasPrior(byAddress.get(row.from_address.toLowerCase()), row.received_at)
						? "correspondent"
						: null;
				delete row.metadata_clipped;
				const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
				if (retainedBytes + bytes > MORNING_SOURCE_LIMITS.candidateBytes)
					throw new Error("candidate byte budget");
				retainedBytes += bytes;
				emails.push(row);
			}
		}
	} catch {
		// Do not expose exception details: D1 errors can include SQL parameters/source text.
		errors.push(
			"Source collection failed or reached a safety budget; check Personal for mail awaiting attention",
		);
	}
	return { emails, history, errors, metrics };
}
