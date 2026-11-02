/**
 * Morning report (2026-10-22): one email a day with a ranked, deduplicated list of source emails
 * that need attention. v2 (2026-10-27) replaces category inventories with people and evidenced
 * consequences.
 * Deterministic selection and factual rendering, no daily prose-generation model.
 *
 * Config is a Worker var, kept off the tree like the other deployment settings; unset = off:
 *   MORNING_REPORT_JSON={"from":"reports@example.com","to":"you@example.com",
 *                        "time_zone":"America/New_York","hour":6}
 *
 * Schedule: the hourly cron sends on the first tick where local time (Intl, so DST is handled) is
 * at or past `hour` and today's report has not gone out. The window is "since the last report",
 * so a missed day is folded into the next one, never lost.
 *
 * Exactly once: the rendered message is frozen in agent_memory before the first attempt and sent
 * through the Worker's own POST /api/emails/send with idempotency_key `<ns>-<local date>`. A
 * retry on a later tick resends the identical message under the same key, so a provider failure
 * or a crash between send and bookkeeping can never produce a second copy.
 *
 * Mail content is untrusted: every subject, name, address and note is HTML-escaped.
 */
import { addressParser, decodeWords } from "postal-mime";
import { findSenderRule, upsertSenderRule } from "@/database/agent";
import { countClassifyPending, getClassifyAfterMs } from "@/database/classifier";
import { CONSENT_VERSION } from "@/services/ai-consent";
import { isDeliveryNotice, loadMorningDeliveryEvidence } from "@/services/morning-report-delivery";
import {
	loadMorningReportSources,
	type MorningCollectionMetrics,
} from "@/services/morning-report-sources";
import { forwardedFor, looksLikePerson } from "@/services/people-rule";
import { applyQuoteSplits, type QuoteSplit } from "@/services/quoted";
import type { Email } from "@/types";
import { logError, logInfo } from "@/utils/logging";
import { isOwnerAddress, ownerAddresses } from "@/utils/owner";
import { getConfiguredDomains } from "@/utils/platform";

const DAY_MS = 24 * 60 * 60 * 1000;
/** First report, or a report after a long gap, looks back at most this far. */
const MAX_WINDOW_MS = 7 * DAY_MS;
export interface MorningReportConfig {
	from: string;
	to: string;
	time_zone: string;
	hour: number;
}

function regexEscape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function reportIdentity(env: CloudflareBindings) {
	try {
		const v = JSON.parse(env.MORNING_REPORT_IDENTITY_JSON || "{}");
		const list = (k: string): string[] =>
			Array.isArray(v?.[k])
				? v[k]
						.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
						.map((s: string) => s.trim())
				: [];
		return {
			names: list("names"),
			attentionNames: list("attention_names"),
			excludedLocalParts: list("excluded_local_parts").map((s) => s.toLowerCase()),
			supportAddresses: list("support_addresses").map((s) => s.toLowerCase()),
		};
	} catch {
		return { names: [], attentionNames: [], excludedLocalParts: [], supportAddresses: [] };
	}
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parse MORNING_REPORT_JSON; null (report off) when unset or malformed. */
export function getMorningReportConfig(env: CloudflareBindings): MorningReportConfig | null {
	const raw = env.MORNING_REPORT_JSON;
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<MorningReportConfig>;
		const from = String(value.from ?? "")
			.trim()
			.toLowerCase();
		const to = String(value.to ?? "")
			.trim()
			.toLowerCase();
		const timeZone = String(value.time_zone ?? env.INSTANCE_TIME_ZONE ?? "UTC");
		const hour = Number(value.hour ?? 6);
		if (!ADDRESS.test(from) || !ADDRESS.test(to)) return null;
		if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
		localClock(Date.now(), timeZone); // throws RangeError for an unknown zone
		return { from, to, time_zone: timeZone, hour };
	} catch (err) {
		logError("morning_report_config_invalid", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** Local calendar date (YYYY-MM-DD) and hour (0-23) at `nowMs` in `timeZone`. */
export function localClock(nowMs: number, timeZone: string): { date: string; hour: number } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(nowMs));
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return {
		date: `${part("year")}-${part("month")}-${part("day")}`,
		hour: Number(part("hour")) % 24,
	};
}

// --- State (agent_memory, workspace 'system') ---------------------------------------------------

interface FrozenReport {
	date: string;
	since: number;
	until: number;
	subject: string;
	html: string;
	text: string;
	data?: MorningReportData;
}

async function getState(db: D1Database, key: string): Promise<string | null> {
	const row = await db
		.prepare("SELECT value FROM agent_memory WHERE key = ? AND workspace_id = 'system'")
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			"INSERT OR REPLACE INTO agent_memory (key, workspace_id, value, updated_at) VALUES (?, 'system', ?, ?)",
		)
		.bind(key, value, Date.now())
		.run();
}

// --- Read-only attention selection ---------------------------------------------------------------

export interface AttentionEmail {
	id: string;
	from_address: string;
	from_name?: string | null;
	subject?: string | null;
	received_at: number;
	thread_id?: string | null;
	message_id?: string | null;
	provider_message_id?: string | null;
	sent_at?: number | null;
	text_content?: string | null;
	domain?: string;
	mailbox?: string;
	to_address?: string;
	to_addresses_json?: string | null;
	cc_addresses_json?: string | null;
	reply_to_addresses_json?: string | null;
	direction?: string;
	mailbox_state?: string;
	category?: string | null;
	sub_category?: string | null;
	list_unsubscribe?: string | null;
	read_at?: number | null;
	auto_read_at?: number | null;
	action_note?: string | null;
	action_due?: number | null;
	action_done_at?: number | null;
	is_muted?: number;
	people_signal?: string | null;
	quote?: QuoteSplit;
	/** Ephemeral MIME delivery-status and original headers; never frozen in the report. */
	delivery_text?: string;
	user_pinned_category?: string | null;
	sender_category?: string | null;
}

export interface AttentionPolicy {
	domains: string[];
	owners: string[];
	reportSender: string;
	forwarded: Record<string, string>;
	names?: string[];
	attentionNames?: string[];
	excludedLocalParts?: string[];
	supportAddresses?: string[];
	timeZone?: string;
}

/** v2 overflow contract: stored with the frozen report, never re-selected by the UI. */
export interface MorningIssue {
	issue_id: string;
	email_id: string;
	thread_id: string | null;
	why_today: string;
	line: string;
	deadline: string | null;
	deadline_basis: string;
	duplicate_ids: string[];
	evidence_ids: string[];
	exclusion_reason: string | null;
	resolution_reason: string | null;
	score: number;
	state: string;
	urgent: boolean;
	kind: "request" | "answer" | "consequence";
	received_at: number;
}

export interface PresentedIssue extends MorningIssue {
	presented_at: number;
	reminded: boolean;
}

export interface AttentionDecision {
	email_id: string;
	issue_id?: string;
	reason: string;
	evidence_ids: string[];
	exclusion_reason?: string | null;
	resolution_reason?: string | null;
}

export interface MorningReportData {
	version: 2;
	local_date: string;
	since: number;
	until: number;
	complete: boolean;
	collection_errors: string[];
	collection_metrics?: MorningCollectionMetrics;
	sorting?: { state: "allowed" | "undecided" | "declined" | "unknown"; unsorted: number };
	issues: MorningIssue[];
	items: MorningIssue[];
	overflow_count: number;
	urgent_overflow_count: number;
	decisions: AttentionDecision[];
	history_next: PresentedIssue[];
}

interface SelectionOptions {
	since: number;
	until: number;
	localDate: string;
	policy: AttentionPolicy;
	complete: boolean;
	history: PresentedIssue[];
	collectionErrors?: string[];
	/** Content/relationship replay: archive transitions without timestamps cannot travel back. */
	historical?: boolean;
}

function addresses(json: string | null | undefined): string[] {
	try {
		const value: unknown = JSON.parse(json || "[]");
		return Array.isArray(value) ? value.filter((a): a is string => typeof a === "string") : [];
	} catch {
		return [];
	}
}

/** Never render credentials, source URLs or one-time codes into a report or audit line. */
export function redactReportText(value: string): string {
	return value
		.replace(/https?:\/\/[^\s<>")]+/gi, "[link]")
		.replace(
			/((?:verification|one.time|security|login|access)\s*(?:code|pin)[^\d\n]{0,40})[\d -]{4,12}/gi,
			"$1[redacted]",
		);
}

/** Quote splitting reuses the reader's new_text; explicit quote/header/signature guards also
 * cover missing earlier messages and the quote splitter's deliberate show-everything guards. */
function bodyOf(row: AttentionEmail): string {
	if (row.quote?.skipped) return "";
	const text = row.quote?.has_quoted ? row.quote.new_text : row.text_content || "";
	const lines: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (
			/^(?:On .{3,300}wrote:|From:|Sent:|Subject:|To:|Cc:|_{5,}|-{2,}\s*(?:Forwarded|Original)|Begin forwarded message:)/i.test(
				line,
			)
		)
			break;
		if (
			/^(?:--|Sent from my .+|Get Outlook for .+|Best(?: regards)?[,!]?|Regards[,!]?|Sincerely[,!]?|Thanks[,!]?|Thank you[,!]?)$/i.test(
				line,
			)
		)
			break;
		if (
			/^>/.test(line) ||
			/^(?:https?:|www\.|[<[]*(?:https?:|\[link\]|\[URL redacted\]))/i.test(line)
		)
			continue;
		if (line === row.from_name || line.toLowerCase() === row.from_address.toLowerCase()) continue;
		lines.push(line.replace(/https?:\/\/\S+|\[(?:link|URL redacted)\]/gi, "").trim());
	}
	return lines.join("\n").trim();
}

function ownedAddress(address: string, policy: AttentionPolicy): boolean {
	const a = address.toLowerCase();
	return (policy.supportAddresses ?? []).includes(a) || isOwnerAddress(a, policy.owners);
}

const TEST_ADDRESS = /^(?:e2e|test|fixture|mailclaw-e2e)(?:[+._-][^@]*)?@/i;
const REPORT_SUBJECT =
	/^(?:mail to read|nothing needs you today|morning (?:mail |email )?(?:report|digest))\b/i;

/** RFC 3464 failed-recipient block plus returned original headers. A DSN alone does not
 * prove this was our send: the original From must be ours, or its Message-ID must match sent mail. */
function deliveryFailure(row: AttentionEmail, rows: AttentionEmail[], policy: AttentionPolicy) {
	const text = (row.delivery_text || row.text_content || "")
		.replace(/\r\n/g, "\n")
		.replace(/\n[ \t]+/g, " ");
	const blocks = text.split(/\n\s*\n/);
	const original = blocks.find(
		(b) => /^From:/im.test(b) && /^Subject:/im.test(b) && /^(?:To|Message-ID):/im.test(b),
	);
	if (!original) return null;
	const header = (name: string) =>
		original.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() || "";
	const messageId = header("Message-ID").replace(/[<>]/g, "");
	const sent = rows.find(
		(r) =>
			r.direction === "outbound" &&
			r.mailbox_state !== "draft" &&
			r.received_at <= row.received_at &&
			!!messageId &&
			(r.message_id || r.provider_message_id)?.replace(/[<>]/g, "") === messageId,
	);
	const from = addressParser(header("From"), { flatten: true })[0]?.address?.toLowerCase();
	if (from === policy.reportSender || sent?.from_address.toLowerCase() === policy.reportSender)
		return null;
	if ((!from || !ownedAddress(from, policy)) && !sent) return null;
	const recipients = new Set(
		[
			...addresses(sent?.to_addresses_json),
			sent?.to_address || "",
			...addressParser(`${header("To")},${header("Cc")}`, { flatten: true }).map(
				(a) => a.address || "",
			),
		].map((a) => a.toLowerCase()),
	);
	const failed = blocks.find((b) => {
		const recipient = b
			.match(/^(?:Final|Original)-Recipient:[ \t]*[^;\n]+;[ \t]*([^\s<>]+@[^\s<>]+)[ \t]*$/im)?.[1]
			?.toLowerCase();
		return (
			/^Action:[ \t]*failed[ \t]*$/im.test(b) &&
			/^Status:[ \t]*5\./im.test(b) &&
			!!recipient &&
			ADDRESS.test(recipient) &&
			!TEST_ADDRESS.test(recipient) &&
			looksLikePerson(recipient, null) &&
			recipient !== policy.reportSender &&
			!ownedAddress(recipient, policy) &&
			recipients.has(recipient)
		);
	});
	if (!failed) return null;
	const recipient =
		failed
			.match(/^(?:Final|Original)-Recipient:[ \t]*[^;\n]+;[ \t]*([^\s<>]+@[^\s<>]+)[ \t]*$/im)?.[1]
			?.toLowerCase() || "";
	const subject = sent?.subject || decodeWords(header("Subject"));
	if (!subject || REPORT_SUBJECT.test(subject) || /mailclaw.?e2e|\[test\]/i.test(subject))
		return null;
	const diagnostic = failed.match(/^Diagnostic-Code:\s*(.+)$/im)?.[1] || "";
	const status = failed.match(/^Status:\s*(5\.\d+\.\d+)/im)?.[1] || "";
	const reason =
		/5\.1\.[01]|not exist|unknown (?:user|recipient)|not found|invalid (?:address|recipient)/i.test(
			`${status} ${diagnostic}`,
		)
			? "address not found"
			: /5\.2\.2|mailbox full|quota/i.test(`${status} ${diagnostic}`)
				? "mailbox full"
				: /5\.7\.|blocked|reject|policy/i.test(`${status} ${diagnostic}`)
					? "mail service rejected it"
					: "delivery refused";
	return {
		recipient,
		subject,
		reason,
		messageId: messageId || row.id,
		originalAt: sent?.sent_at || sent?.received_at,
	};
}

/** Re/Fwd prefixes, whitespace and MIME encoding do not make a different send topic. */
function normalizedSubject(subject: string): string {
	return decodeWords(subject)
		.normalize("NFKC")
		.trim()
		.replace(/^(?:(?:re|fw|fwd):\s*)+/gi, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function subjectTopic(row: AttentionEmail): string {
	const subject = (row.subject || "").replace(/^(?:(?:re|fw|fwd):\s*)+/gi, "");
	const safe = subject.replace(/https?:\/\/\S+|\[(?:link|URL redacted)\]|[<>]/gi, "").trim();
	return safe || "your message";
}

/** Paraphrase only the selected author's clean block; carried text never supplies line prose. */
function humanFact(row: AttentionEmail, kind: MorningIssue["kind"]): string {
	const body = bodyOf(row);
	const topic = subjectTopic(row);
	if (/^(?:fw|fwd):/i.test(row.subject || ""))
		return /offer/i.test(topic)
			? "forwarded the revised offer to review"
			: `forwarded ${topic} for review`;
	if (/next steps/i.test(body)) return "asks for next steps";
	if (/quick ping|follow.?up/i.test(body)) return `awaits your follow-up on ${topic}`;
	if (/please review/i.test(body)) return `asks you to review ${topic}`;
	if (/please (?:send|provide)/i.test(body)) return `asks for ${topic}`;
	if (/please (?:sign|confirm)|can you confirm/i.test(body)) return `asks you to confirm ${topic}`;
	if (kind === "request") return `asks about ${topic}`;
	return `sent an update on ${topic}`;
}

function reportLine(name: string, fact: string, date: string | null): string {
	const suffix = date
		? ` — ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}`
		: "";
	const prefix = `${name} — `;
	return `${prefix}${clean(redactReportText(fact), Math.max(10, 90 - prefix.length - suffix.length))}${suffix}`;
}

function terms(value: string, names: string[] = []): Set<string> {
	return new Set(
		(value.toLowerCase().match(/[a-z]{4,}/g) || []).filter(
			(x) =>
				!/^(please|thanks|thank|this|that|with|from|have|your|would|could|subject|regards)$/.test(
					x,
				) && !names.flatMap((n) => n.toLowerCase().split(/\s+/)).includes(x),
		),
	);
}

function responsive(request: AttentionEmail, reply: AttentionEmail, names: string[] = []): boolean {
	if (reply.direction !== "outbound" || reply.mailbox_state === "draft") return false;
	const text = bodyOf(reply);
	if (/^\s*(?:fyi|for your information)\b/i.test(text)) return false;
	const explicit =
		/\b(?:approv\w*|agreed|that works|yes|no[, .]|confirmed|done|signed|attached|let.s proceed|sounds good|thank you for|thanks for)\b/i.test(
			text,
		);
	const wanted = terms(`${request.subject} ${bodyOf(request).slice(0, 1500)}`, names);
	const overlap = [...terms(text.slice(0, 2000), names)].filter((x) => wanted.has(x)).length;
	return (explicit && overlap >= 1) || overlap >= 3;
}

function businessDate(ms: number, delta: number): string {
	const d = new Date(`${localClock(ms, "UTC").date}T12:00:00Z`);
	const step = delta < 0 ? -1 : 1;
	for (let remaining = Math.abs(delta); remaining > 0; ) {
		d.setUTCDate(d.getUTCDate() + step);
		if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) remaining--;
	}
	return d.toISOString().slice(0, 10);
}

function deadlineOf(row: AttentionEmail): { date: string | null; basis: string } {
	const text = `${row.subject || ""} ${bodyOf(row)}`;
	const interval = text.match(/\b(\d+) days (?:of|from|after) (?:the )?filing\b/i);
	if (interval) {
		// Approval/receipt is not filing. Compute only from an explicit source filing date.
		const anchor = text.match(
			/\bfiled on ((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d\d|20\d\d-\d\d-\d\d)/i,
		);
		const anchorMs = anchor ? Date.parse(anchor[1]) : Number.NaN;
		if (Number.isFinite(anchorMs))
			return {
				date: new Date(anchorMs + Number(interval[1]) * DAY_MS).toISOString().slice(0, 10),
				basis: `Computed from source: ${interval[0]}; ${anchor?.[0]}`,
			};
		return {
			date: null,
			basis: "Source-relative filing interval; filing date unknown; classifier date is unverified",
		};
	}
	// Only source dates near a due/change/action phrase, never trust the classifier's inferred date.
	const match = text.match(
		/(?:due|by|before|effective|starting|until|beginning|as of|grants from)\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d\d)?|20\d\d-\d\d-\d\d)/i,
	);
	if (!match)
		return {
			date: null,
			basis: row.action_due
				? "Classifier date not verified in source; exact deadline unknown"
				: "No exact deadline stated",
		};
	let dateText = match[1].replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
	if (!/20\d\d/.test(dateText)) dateText += ` ${new Date(row.received_at).getUTCFullYear()}`;
	const parsed = Date.parse(dateText);
	return Number.isFinite(parsed)
		? {
				date: new Date(parsed).toISOString().slice(0, 10),
				basis: clean(`Source states: ${match[0]}`, 150),
			}
		: { date: null, basis: "Source date could not be verified" };
}

function actionableDate(row: AttentionEmail, deadline: string): string {
	const text = bodyOf(row);
	const weeks = text.match(/(three|3|four|4|two|2) consecutive weeks/i)?.[1];
	if (weeks) {
		const count =
			({ two: 2, three: 3, four: 4 } as Record<string, number>)[weeks.toLowerCase()] ||
			Number(weeks);
		return new Date(Date.parse(`${deadline}T12:00:00Z`) - count * 7 * DAY_MS)
			.toISOString()
			.slice(0, 10);
	}
	return businessDate(Date.parse(`${deadline}T12:00:00Z`), -3);
}

function identifiers(text: string): { accounts: string[]; invoices: string[]; amounts: string[] } {
	return {
		accounts: [
			...text.matchAll(
				/(?:account|policy|case|application|ending)\s*(?:number|no\.)?\s*[#:]*\s*([\w*-]*\d[\w*-]*)/gi,
			),
		]
			.map((x) => x[1].toLowerCase())
			.sort(),
		invoices: [
			...text.matchAll(/\b(?:IN[V]?-\d+|invoice\s*(?:#|number|no\.|:)?\s*([A-Z]*[-]?\d[\w-]*))/gi),
		]
			.map((x) => (x[1] || x[0]).toLowerCase())
			.sort(),
		amounts: [...text.matchAll(/(?:\$|USD\s*)(\d[\d,]*\.\d\d)/g)].map((x) => x[1]).sort(),
	};
}

function service(row: AttentionEmail): string {
	return (row.from_address.toLowerCase().split("@").pop() || row.from_address)
		.split(".")
		.slice(-2)
		.join(".");
}

function issueKey(row: AttentionEmail, kind: MorningIssue["kind"], text: string): string {
	if (kind !== "consequence") return `person:${row.thread_id || row.message_id || row.id}`;
	const ids = identifiers(text);
	// A database host's notice that new tables need explicit grants, re-sent with a changed
	// subject, is one change: keyed by its effective date, not its wording.
	const grantsChange =
		/(?:new tables|tables in).{0,80}(?:public|grants)|explicit grants/i.test(text) &&
		/\bpublic\b/i.test(text) &&
		/\bgrants\b/i.test(text)
			? deadlineOf(row).date
			: null;
	const owner = [...addresses(row.to_addresses_json), row.to_address || ""].sort().join(",");
	let action = grantsChange
		? `public-table-grants:${grantsChange}` // key kept: past reports match issues by it
		: /cloudflared|tunnel|certificate/i.test(text)
			? "tunnel-remediation"
			: /reconnect|bank links?/i.test(text)
				? "bank-links"
				: /thermostat|hvac/i.test(text)
					? "thermostat"
					: /coverage|policy.*expir/i.test(text)
						? "coverage"
						: /payment|invoice|past.due|balance/i.test(text)
							? "billing"
							: "notice";
	// No sender-only merging: body identity is required; unknown obligations stay separate.
	if (
		!ids.accounts.length &&
		!ids.invoices.length &&
		!ids.amounts.length &&
		(action === "notice" || action === "billing" || action === "bank-links")
	)
		action += `:${row.thread_id || row.id}`;
	const property = text.match(/\b[\w]+\s+Lot\s+\d+\b/i)?.[0] || "";
	const site =
		action === "thermostat"
			? (text.match(/(?:upstairs|downstairs|thermostat\s+[\w-]+)/i)?.[0] || row.id).toLowerCase()
			: "";
	return [
		service(row),
		owner,
		action,
		ids.accounts.join(","),
		ids.invoices.join(","),
		ids.amounts.join(","),
		`${property.toLowerCase()}:${site}`,
	].join("|");
}

function financialResolution(a: AttentionEmail, b: AttentionEmail): boolean {
	if (service(a) !== service(b)) return false;
	const before = identifiers(`${a.subject} ${bodyOf(a)}`);
	const after = identifiers(`${b.subject} ${bodyOf(b)}`);
	const same = (x: string[], y: string[]) => x.length > 0 && x.join(",") === y.join(",");
	if (before.accounts.length && !same(before.accounts, after.accounts)) return false;
	if (before.invoices.length && !same(before.invoices, after.invoices)) return false;
	if (before.amounts.length && !same(before.amounts, after.amounts)) return false;
	// Amount/vendor alone is insufficient to settle a different utility account.
	return (
		(same(before.invoices, after.invoices) || same(before.accounts, after.accounts)) &&
		/\b(?:payment received|paid in full|fully repaid|payment successful|coverage (?:restored|reinstated)|no further action is needed|resolved)\b/i.test(
			bodyOf(b),
		)
	);
}

/** Pure, deterministic, read-only. Every piece of evidence is filtered to the same cutoff. */
export function selectMorningIssues(
	input: AttentionEmail[],
	options: SelectionOptions,
): MorningReportData {
	const { policy, until } = options;
	const history = options.history.filter((h) => h.presented_at <= until && h.received_at <= until);
	const rows = input
		.map((r) => ({ ...r }))
		.filter((r) => r.received_at <= until)
		.sort((a, b) => b.received_at - a.received_at || a.id.localeCompare(b.id));
	// Bound quote comparison to each collected conversation, using text prefixes already capped by
	// the collector. No HTML/R2 hydration and no cross-conversation text attribution.
	const conversations = new Map<string, AttentionEmail[]>();
	for (const row of rows) {
		const key = row.thread_id || row.id;
		const group = conversations.get(key) || [];
		group.push(row);
		conversations.set(key, group);
	}
	for (const group of conversations.values())
		if (group.length > 1) applyQuoteSplits(group as Email[], { annotateHtml: false });
	const bounces = new Map(
		rows.filter(isDeliveryNotice).map((r) => [r.id, deliveryFailure(r, rows, policy)]),
	);
	const acceptedSends = rows.filter(
		(r) =>
			r.direction === "outbound" &&
			r.mailbox_state !== "draft" &&
			!!r.provider_message_id &&
			ownedAddress(r.from_address, policy) &&
			r.from_address.toLowerCase() !== policy.reportSender &&
			(r.sent_at || r.received_at) <= until,
	);
	const decisions: AttentionDecision[] = [];
	const candidates: MorningIssue[] = [];
	const reject = (r: AttentionEmail, reason: string, evidence: string[] = []) =>
		decisions.push({
			email_id: r.id,
			reason,
			exclusion_reason: reason,
			resolution_reason: evidence.length ? reason : null,
			evidence_ids: [r.id, ...evidence],
		});
	for (const r of rows) {
		if (r.direction === "outbound") continue;
		const text = `${r.subject || ""}\n${bodyOf(r)}`;
		const recipients = [...addresses(r.to_addresses_json), ...addresses(r.cc_addresses_json)];
		if (!recipients.length && r.to_address) recipients.push(r.to_address);

		if (
			(r.domain && !policy.domains.includes(r.domain)) ||
			!recipients.some((a) => ownedAddress(a, policy)) ||
			recipients.every((a) => a.toLowerCase() in policy.forwarded)
		) {
			reject(r, "outside owner recipient scope");
			continue;
		}
		if (
			r.mailbox_state === "trash" ||
			r.category === "spam" ||
			r.is_muted ||
			(r.mailbox_state === "archived" && !options.historical)
		) {
			reject(r, "trashed, spam, muted or archived");
			continue;
		}
		if (r.action_done_at && r.action_done_at <= until) {
			reject(r, "explicitly completed");
			continue;
		}
		const bounce = bounces.get(r.id);
		if (bounce) {
			const failureState = `delivery:${bounce.messageId}:${bounce.recipient}`;
			const key = `delivery:${bounce.recipient}:${normalizedSubject(bounce.subject)}`;
			// An old DSN can arrive late: compare against its original send (or the first DSN
			// for that same Message-ID), never assume its arrival is a newer failed resend.
			const originalAt =
				bounce.originalAt ??
				Math.min(
					...rows
						.filter((p) => {
							const b = bounces.get(p.id);
							return b?.messageId === bounce.messageId && b.recipient === bounce.recipient;
						})
						.map((p) => p.received_at),
				);
			const resend = acceptedSends.find(
				(p) =>
					(p.sent_at || p.received_at) > originalAt &&
					normalizedSubject(p.subject || "") === normalizedSubject(bounce.subject) &&
					(p.message_id || p.provider_message_id)?.replace(/[<>]/g, "") !== bounce.messageId &&
					[
						p.to_address || "",
						...addresses(p.to_addresses_json),
						...addresses(p.cc_addresses_json),
					].some((a) => a.toLowerCase() === bounce.recipient) &&
					!rows.some((newer) => {
						const failure = bounces.get(newer.id);
						return (
							failure?.recipient === bounce.recipient &&
							normalizedSubject(failure.subject) === normalizedSubject(bounce.subject) &&
							newer.received_at >= (p.sent_at || p.received_at) &&
							(failure.messageId === p.message_id?.replace(/[<>]/g, "") ||
								failure.messageId === p.provider_message_id?.replace(/[<>]/g, "") ||
								failure.messageId === newer.id)
						);
					}),
			);
			if (resend) {
				reject(r, "resolved by later accepted resend to same recipient and subject", [resend.id]);
				continue;
			}
			if (
				history.some(
					(h) => h.issue_id === failureState || (h.issue_id === key && h.state === failureState),
				)
			) {
				reject(r, "delivery failure already presented");
				continue;
			}
			const prefix = "Not delivered: ";
			const suffix = ` to ${bounce.recipient} — ${bounce.reason}`;
			candidates.push({
				issue_id: key,
				email_id: r.id,
				thread_id: r.thread_id || null,
				why_today: "Your message was not delivered",
				line: `${prefix}${clean(redactReportText(bounce.subject), Math.max(10, 90 - prefix.length - suffix.length))}${suffix}`,
				deadline: null,
				deadline_basis: "No exact deadline stated",
				duplicate_ids: [],
				evidence_ids: [r.id],
				exclusion_reason: null,
				resolution_reason: null,
				score: 1100,
				state: failureState,
				urgent: true,
				kind: "consequence",
				received_at: r.received_at,
			});
			continue;
		}
		if (isDeliveryNotice(r)) {
			reject(r, "not a verified failure of a real personal send");
			continue;
		}
		if (
			r.from_address.toLowerCase() === policy.reportSender ||
			/\b(?:e2e(?:[+._-][^@\s]*)?@|mailclaw-e2e|\[mailclaw.e2e)/i.test(
				`${recipients.join(" ")} ${text}`,
			) ||
			/^(?:testing?|accepted:|declined:|tentative:|delivery status digest)\s*$/i.test(
				text.trim(),
			) ||
			/^(?:accepted|declined|tentative):/i.test(r.subject || "")
		) {
			reject(r, "test traffic, calendar receipt or own digest");
			continue;
		}
		if (
			/verification code|one.time (?:code|password)|your (?:security |login )?code|if (?:this|it) (?:was|wasn.t|was not|isn.t|is not) you|if you (?:didn.t|did not) (?:request|recognize)/i.test(
				text,
			) &&
			!/compromis|breach|vulnerab/i.test(text)
		) {
			reject(r, "conditional login or one-time credential, no incident");
			continue;
		}
		if (
			(policy.names ?? []).some((name) =>
				new RegExp(`^${regexEscape(name)}(?: via|$)`, "i").test(r.from_name || ""),
			) ||
			/signature (?:completed|complete)|document (?:completed|signed)|successfully signed/i.test(
				r.subject || "",
			)
		) {
			reject(r, "signature completion or own request copy");
			continue;
		}
		if (/updated invitation:/i.test(r.subject || "") && r.received_at <= options.since) {
			reject(r, "old calendar change; no current attendance decision evidenced");
			continue;
		}
		const effectiveFrom =
			addresses(r.reply_to_addresses_json).length === 1
				? addresses(r.reply_to_addresses_json)[0]
				: r.from_address;
		const prior = rows.some(
			(p) =>
				p.direction === "outbound" &&
				p.mailbox_state !== "draft" &&
				p.received_at <= r.received_at &&
				p.received_at > r.received_at - 365 * DAY_MS &&
				((p.thread_id && p.thread_id === r.thread_id) ||
					[
						...addresses(p.to_addresses_json),
						...addresses(p.cc_addresses_json),
						p.to_address || "",
					].includes(effectiveFrom)),
		);
		const relationship =
			r.people_signal ||
			prior ||
			(policy.domains.includes(effectiveFrom.split("@")[1]) &&
				!policy.owners.includes(effectiveFrom));
		const correction = r.sender_category || r.user_pinned_category;
		const ownAutomation =
			policy.domains.includes(r.from_address.toLowerCase().split("@")[1]) &&
			(!looksLikePerson(r.from_address, null) ||
				/^(?:automation|automated|bot|system|reports)(?:[+._-]|@)/i.test(r.from_address));
		const taggedRecipient = recipients.some((a) => a.includes("+") && ownedAddress(a, policy));
		const realReply =
			!!(r.people_signal || prior) && looksLikePerson(r.from_address, r.list_unsubscribe);
		const person =
			!ownAutomation &&
			(!taggedRecipient || realReply) &&
			(!correction || correction === "personal") &&
			(r.category === "personal" ||
				relationship ||
				recipients.some((a) => (policy.supportAddresses ?? []).includes(a.toLowerCase()))) &&
			looksLikePerson(effectiveFrom, r.list_unsubscribe) &&
			!policy.owners.includes(effectiveFrom.toLowerCase()) &&
			!isOwnerAddress(effectiveFrom, policy.owners) &&
			!(policy.excludedLocalParts ?? []).includes(
				effectiveFrom.toLowerCase().split("@")[0].split("+")[0],
			);
		const requestBody = bodyOf(r).replace(
			/let us know if there is anything else[^.!?]*[.!?]?/gi,
			"",
		);
		const forwardedReview =
			/^(?:fw|fwd):/i.test(r.subject || "") &&
			/offer|contract|proposal|review|signature/i.test(r.subject || "");
		const request =
			forwardedReview ||
			/\?|(?:wondering|asking) (?:if|whether) (?:we|you|I) should|please (?:review|let|send|confirm|sign|provide|advise)|let me know|let us know|your thoughts|quick ping|follow.?up|next steps|assigned to you|you.{0,50}(?:follow up|follow-up)/i.test(
				requestBody,
			) ||
			(policy.attentionNames ?? []).some((name) =>
				new RegExp(
					`assigned to ${regexEscape(name)}|${regexEscape(name)}.{0,50}(?:follow up|follow-up)`,
					"i",
				).test(requestBody),
			);
		const usefulAnswer =
			!!bodyOf(r) &&
			!!relationship &&
			!/shipping update|order confirmation|receipt|your order has|task.*due soon/i.test(
				r.subject || "",
			) &&
			/\b(?:supports?|requested|attached|estimate|answer|updated|changed|available|beta|proposal)\b/i.test(
				text,
			);
		const harm =
			/coverage.{0,100}expir|policy.{0,100}(?:expir|cancel)|compromised.{0,80}certificate|certificate.{0,80}compromis|upgrade cloudflared/i.test(
				text,
			);
		const incident =
			/thermostat|hvac/i.test(text) &&
			/(?:reported|detected|identified).{0,80}(?:diagnostic|serious issue|fault)|contact your service provider immediately/i.test(
				text,
			);
		const consequenceText = text.split(
			/(?:The Federal Equal Credit Opportunity Act|To receive cashback|Terms and Conditions|Privacy Policy)/i,
		)[0];
		const obligation =
			/payment (?:failed|declined)|failed (?:payment|settlement)|past.due|overdue|service (?:suspend|disconnect)|shut.?off|publish.{0,80}(?:notice|newspaper)|explicit grants|grants.{0,80}(?:change|tables)|reconnect.{0,80}(?:bank|account)|bank.{0,80}(?:disconnected|reconnect)/i.test(
				consequenceText,
			);
		const autoPay =
			/(?:autopay|automatic payment|will be charged|scheduled (?:payment|debit)).{0,100}(?:pay|charge|scheduled|process)|(?:will|scheduled to) (?:pay|debit|charge)/i.test(
				text,
			);
		if ((!person || (!request && !usefulAnswer)) && !harm && !incident && !obligation) {
			reject(r, "no evidenced request or consequence");
			continue;
		}
		if (
			(!person &&
				(r.category === "marketing" ||
					r.category === "newsletters" ||
					(r.category === "agents" && !harm && !incident && !obligation))) ||
			(autoPay && !harm && !/payment (?:failed|declined)/i.test(text))
		) {
			reject(r, "promotion, automation FYI or scheduled autopay");
			continue;
		}
		const kind: MorningIssue["kind"] =
			person && request ? "request" : person && usefulAnswer ? "answer" : "consequence";
		// Cross-category correspondence is still people mail: the 45-day consequence scan must
		// not turn an old auto-read marketing reply into fresh personal catch-up.
		if (
			kind !== "consequence" &&
			r.received_at <= until - MAX_WINDOW_MS &&
			!harm &&
			!incident &&
			!obligation
		) {
			reject(r, "older people mail outside the seven-day bootstrap");
			continue;
		}
		const later = rows.filter((p) => p.received_at > r.received_at && p.id !== r.id);
		const resolved = later.find((p) =>
			kind !== "consequence"
				? !!r.thread_id && p.thread_id === r.thread_id && responsive(r, p, policy.names)
				: financialResolution(r, p),
		);
		if (resolved) {
			reject(r, "resolved by same-obligation evidence", [resolved.id]);
			continue;
		}
		const deadline = deadlineOf(r);
		if (
			deadline.date &&
			deadline.date < options.localDate &&
			/invitation|meeting time|event|join us/i.test(text) &&
			!harm
		) {
			reject(r, "event already passed");
			continue;
		}
		if (
			kind === "consequence" &&
			r.received_at <= until - MAX_WINDOW_MS &&
			!harm &&
			!incident &&
			!(deadline.date && options.localDate >= actionableDate(r, deadline.date))
		) {
			reject(r, "older routine obligation; no new consequence or actionable deadline");
			continue;
		}
		const key = issueKey(r, kind, text);
		const state =
			kind !== "consequence"
				? `${r.id}:${deadline.date || "unknown"}`
				: `${key}:${deadline.date || "unknown"}:${harm ? "active-loss" : "action"}:${/(?:suspended|disconnected|shut off)/i.test(text) ? "interrupted" : "unchanged"}`;
		const previous = history.find((h) => h.issue_id === key);
		// Older members of an already-presented conversation are supporting context, not new
		// requests. Otherwise suppressing today's representative could expose yesterday's
		// duplicate on the next run and alternate forever.
		if (
			previous &&
			(r.received_at < previous.received_at || previous.duplicate_ids.includes(r.id))
		) {
			reject(r, "older member of an already-presented issue", [previous.email_id]);
			continue;
		}
		const humanRead = !!r.read_at && r.read_at <= until && !r.auto_read_at;
		let why =
			kind === "request"
				? "Person awaiting your response or review"
				: kind === "answer"
					? "New answer to a request you initiated"
					: "First discovery of a concrete consequence";
		if (
			previous &&
			(previous.state === state ||
				`${previous.state}:unchanged` === state ||
				(!harm &&
					previous.state === `${key}:${deadline.date || "unknown"}:interrupted` &&
					state.endsWith(":action:interrupted")))
		) {
			// An unanswered request never comes back on its own (owner decision, 2026-10-30); only a new
			// message or a source deadline brings it back.
			const reminder =
				deadline.date &&
				options.localDate >= actionableDate(r, deadline.date) &&
				localClock(previous.presented_at, policy.timeZone || "UTC").date <
					actionableDate(r, deadline.date);
			if (reminder) why = "Deadline reminder: source lead time or three business days before due";
			else {
				reject(r, "already presented; no new message or deadline");
				continue;
			}
		} else if ((kind === "answer" || kind === "request") && humanRead) {
			// The owner opened it: it has been seen.
			reject(r, "already opened by owner");
			continue;
		}
		const name = clean(r.from_name || r.from_address.split("@")[0], 32);
		let fact = kind === "consequence" ? `needs attention: ${subjectTopic(r)}` : humanFact(r, kind);
		if (/coverage.{0,100}expir|policy.{0,100}expir/i.test(text))
			fact = "says coverage expired; verify it has been restored";
		else if (/cloudflared|compromised.{0,80}certificate/i.test(text))
			fact = "says Tunnel security needs an update";
		else if (incident) fact = "reports a thermostat fault; confirm service is handled";

		const fresh = r.received_at > options.since;
		// Pending review/signature and next-step decisions retain their priority after arrival.
		// A first-seen routine device/payment notice must not outrank a real person waiting.
		const timeSensitiveRequest =
			kind === "request" &&
			(forwardedReview ||
				/before.{0,40}(?:sign|contract)|tonight|this evening/i.test(requestBody) ||
				(fresh && /please review|signature/i.test(requestBody)));
		const nearDeadline = !!deadline.date && options.localDate >= actionableDate(r, deadline.date);
		const decisionRequest =
			kind === "request" && /next steps|approve|your thoughts|decision/i.test(requestBody);
		const score = timeSensitiveRequest
			? 980
			: harm
				? /coverage.{0,100}expir|policy.{0,100}expir/i.test(text)
					? 950
					: 920
				: kind === "request"
					? decisionRequest
						? 900
						: /quick ping/i.test(requestBody)
							? 900
							: fresh
								? 880
								: 800
					: kind === "answer"
						? 700
						: nearDeadline
							? 820
							: incident
								? 650
								: 600;
		candidates.push({
			issue_id: key,
			email_id: r.id,
			thread_id: r.thread_id || null,
			why_today: why,
			line: reportLine(name, fact, deadline.date),
			deadline: deadline.date,
			deadline_basis: deadline.basis,
			duplicate_ids: [],
			evidence_ids: [r.id],
			exclusion_reason: null,
			resolution_reason: null,
			score,
			state,
			urgent: harm || timeSensitiveRequest,
			kind,
			received_at: r.received_at,
		});
	}
	const unique = new Map<string, MorningIssue>();
	const deliveries = new Map<string, MorningIssue>();
	const copies = new Map<string, MorningIssue>();
	for (const c of candidates) {
		const source = rows.find((r) => r.id === c.email_id);
		const identity = source?.message_id || c.email_id;
		const copyKey =
			source && c.kind !== "consequence"
				? JSON.stringify([
						source.from_address.toLowerCase(),
						normalizedSubject(source.subject || ""),
						bodyOf(source).replace(/\s+/g, " ").trim(),
					])
				: c.issue_id;
		const existing = unique.get(c.issue_id) || deliveries.get(identity) || copies.get(copyKey);
		if (existing) {
			existing.duplicate_ids.push(c.email_id);
			existing.evidence_ids.push(c.email_id);
			decisions.push({
				email_id: c.email_id,
				issue_id: existing.issue_id,
				reason: "duplicate of same issue",
				evidence_ids: [existing.email_id, c.email_id],
			});
		} else {
			unique.set(c.issue_id, c);
			deliveries.set(identity, c);
			copies.set(copyKey, c);
		}
	}
	const issues = [...unique.values()].sort(
		(a, b) =>
			b.score - a.score ||
			(a.deadline || "9999").localeCompare(b.deadline || "9999") ||
			b.received_at - a.received_at ||
			a.email_id.localeCompare(b.email_id),
	);
	const items = issues.slice(0, 5);
	for (const c of issues)
		decisions.push({
			email_id: c.email_id,
			issue_id: c.issue_id,
			reason: c.why_today,
			evidence_ids: c.evidence_ids,
		});
	const next = new Map(history.map((h) => [h.issue_id, h]));
	// Only the five actually exposed items count as presented. A broad Personal fallback cannot
	// prove that overflow was seen, and must never suppress it as acknowledged tomorrow.
	for (const item of items)
		next.set(item.issue_id, {
			...item,
			presented_at: until,
			reminded: item.why_today.includes("reminder") || next.get(item.issue_id)?.reminded || false,
		});
	return {
		version: 2,
		local_date: options.localDate,
		since: options.since,
		until,
		complete: options.complete,
		collection_errors: options.collectionErrors || [],
		issues,
		items,
		overflow_count: Math.max(0, issues.length - 5),
		urgent_overflow_count: issues.slice(5).filter((i) => i.urgent).length,
		decisions,
		history_next: [...next.values()].filter((h) => h.presented_at > until - 90 * DAY_MS),
	};
}

/** Bounded source discovery; safety limits and query failures never imply a quiet day. */
export async function collectMorningReport(
	env: CloudflareBindings,
	options: { since: number; until: number; localDate: string; historyKey?: string },
): Promise<MorningReportData> {
	const domains = getConfiguredDomains(env);
	const config = getMorningReportConfig(env);
	const policy: AttentionPolicy = {
		domains,
		owners: [...ownerAddresses(env), config?.to || ""].map((a) => a.toLowerCase()),
		reportSender: config?.from || "",
		...reportIdentity(env),
		timeZone: config?.time_zone || "UTC",
		forwarded: forwardedFor(env),
	};
	const { emails, history, errors, metrics } = await loadMorningReportSources(env.D1, {
		until: options.until,
		domains,
		historyKey: options.historyKey || "morning_report:history",
		supportAddresses: policy.supportAddresses,
	});
	errors.push(...(await loadMorningDeliveryEvidence(env, emails, options.until)));
	const data = selectMorningIssues(emails, {
		...options,
		policy,
		complete: errors.length === 0,
		history,
		collectionErrors: errors,
	});
	try {
		const decision = await env.D1.prepare(
			"SELECT state,version FROM ai_consent_decisions WHERE decided_at<=? ORDER BY id DESC LIMIT 1",
		)
			.bind(options.until)
			.first<{ state: "allowed" | "declined"; version: number }>();
		const state = !decision || decision.version !== CONSENT_VERSION ? "undecided" : decision.state;
		const unsorted = await countClassifyPending(
			env.D1,
			await getClassifyAfterMs(env.D1),
			options.until,
		);
		data.sorting = { state, unsorted };
	} catch {
		data.sorting = { state: "unknown", unsorted: 0 };
		data.complete = false;
		data.collection_errors.push("AI sorting status could not be checked");
	}
	data.collection_metrics = metrics;
	return data;
}

// --- Rendering ----------------------------------------------------------------------------------
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately remove mail control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
function clean(value: string, max = 140): string {
	const line = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (line.length <= max) return line;
	const prefix = line.slice(0, max - 1).trimEnd();
	const space = prefix.lastIndexOf(" ");
	return `${space >= max / 2 ? prefix.slice(0, space) : prefix}…`;
}
export interface RenderedReport {
	subject: string;
	html: string;
	text: string;
}
export function renderMorningReport(
	data: MorningReportData,
	options: { uiOrigin: string | null; timeZone: string },
): RenderedReport {
	const origin = options.uiOrigin || "";
	const site = origin ? new URL(origin).host : "your inbox";
	const date = new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${data.local_date}T12:00:00Z`));
	const sortingOff = data.sorting && data.sorting.state !== "allowed";
	const sortingBehind = data.sorting && data.sorting.unsorted >= 50;
	const quiet = data.complete && !sortingOff && !sortingBehind && !data.items.length;
	const title = quiet
		? `Nothing needs you today — ${date}`
		: `Mail to read: ${data.items.length} today${data.overflow_count ? `, ${data.overflow_count} more` : ""}${data.complete ? "" : " — incomplete"} — ${date}`;
	const text = [title, ""];
	const html = [
		`<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:24px auto;padding:0 16px;line-height:1.5"><h2>${escapeHtml(title)}</h2>`,
	];
	if (sortingOff || sortingBehind) {
		const line =
			data.sorting?.state === "unknown"
				? `AI sorting could not be checked — open ${site}`
				: sortingOff
					? `AI sorting is off — tap Allow at ${site} (${data.sorting?.unsorted} messages unsorted)`
					: `AI sorting is behind — open ${site} (${data.sorting?.unsorted} messages unsorted)`;
		text.push(line, origin, "");
		html.push(`<p><a href="${escapeHtml(origin)}">${escapeHtml(line)}</a></p>`);
	}
	for (const item of data.items) {
		const url = `${origin}/?email=${encodeURIComponent(item.email_id)}`;
		text.push(item.line, url, "");
		html.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(item.line)}</a></p>`);
	}
	if (data.overflow_count) {
		const line = `${data.overflow_count} more selected${data.urgent_overflow_count ? ` (${data.urgent_overflow_count} urgent)` : ""}. Open Personal; a dedicated full list is not available yet.`;
		text.push(line, `${origin}/?category=personal`, "");
		html.push(
			`<p>${escapeHtml(line)} <a href="${escapeHtml(origin)}/?category=personal">Personal</a></p>`,
		);
	}
	if (!data.complete) {
		const line =
			"Some mail could not be checked. Open Personal to review emails awaiting attention.";
		text.push(line, `${origin}/?category=personal`);
		html.push(`<p>${line} <a href="${escapeHtml(origin)}/?category=personal">Personal</a></p>`);
	} else if (quiet) {
		const line = "No emails need your attention this morning.";
		text.push(line);
		html.push(`<p>${line}</p>`);
	}
	html.push("</body></html>");
	return {
		subject: title,
		text: text.join("\n"),
		html: html.join("\n"),
	};
}

// --- Schedule and delivery ------------------------------------------------------------------------

export interface MorningReportRun {
	status: "off" | "not_due" | "already_sent" | "sent" | "send_failed";
	local_date: string | null;
	key?: string;
	http_status?: number;
	error_code?: string;
	email_id?: string | null;
	already_sent?: boolean;
}

/**
 * Send a JSON request through this Worker's own Hono app (no network hop). Imported lazily:
 * app.ts imports the admin routes, which import this module.
 */
async function callApi(
	env: CloudflareBindings,
	ctx: ExecutionContext,
	path: string,
	body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
	const { default: app } = await import("@/app");
	const response = await app.fetch(
		new Request(`https://mailclaw.internal${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.API_TOKEN ?? ""}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		}),
		env,
		ctx,
	);
	const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	return { status: response.status, json };
}

/**
 * Files the report itself (Decision 1: Personal) with a sender rule, so the sorter never sees it
 * and marketing auto-read never touches it. Leaves an existing rule alone: the owner may have
 * moved it.
 */
async function ensureReportSenderRule(db: D1Database, from: string): Promise<void> {
	if (await findSenderRule(db, from)) return;
	const result = await upsertSenderRule(db, {
		from_pattern: from,
		category: "personal",
		confidence: 1,
	});
	if (!result.success) {
		logError("morning_report_sender_rule_failed", { error: result.error?.message ?? "unknown" });
	}
}

/**
 * One tick. `ns` namespaces state and the idempotency key ("morning_report" in production; the
 * E2E uses its own so it never touches the real schedule). `nowMs` is overridable for the E2E.
 */
export async function runMorningReport(
	env: CloudflareBindings,
	ctx: ExecutionContext,
	options: { nowMs?: number; ns?: string; config?: MorningReportConfig | null } = {},
): Promise<MorningReportRun> {
	const config = options.config === undefined ? getMorningReportConfig(env) : options.config;
	if (!config || !env.API_TOKEN) return { status: "off", local_date: null };
	const db = env.D1;
	const ns = options.ns ?? "morning_report";
	const nowMs = options.nowMs ?? Date.now();
	const clock = localClock(nowMs, config.time_zone);
	if (clock.hour < config.hour) return { status: "not_due", local_date: clock.date };
	if ((await getState(db, `${ns}:last_date`)) === clock.date) {
		return { status: "already_sent", local_date: clock.date };
	}

	// Freeze today's message before the first attempt; later ticks resend it unchanged.
	let frozen: FrozenReport | null = null;
	const pending = await getState(db, `${ns}:pending`);
	if (pending) {
		try {
			const parsed = JSON.parse(pending) as FrozenReport;
			if (parsed.date === clock.date) frozen = parsed;
		} catch {
			frozen = null;
		}
	}
	if (!frozen) {
		const lastSentAt = Number(await getState(db, `${ns}:last_sent_at`));
		const since =
			Number.isFinite(lastSentAt) && lastSentAt > 0
				? Math.max(lastSentAt, nowMs - MAX_WINDOW_MS)
				: nowMs - DAY_MS;
		const data = await collectMorningReport(env, {
			since,
			until: nowMs,
			localDate: clock.date,
			historyKey: `${ns}:history`,
		});
		const rendered = renderMorningReport(data, {
			uiOrigin: env.UI_ORIGIN?.replace(/\/+$/, "") || null,
			timeZone: config.time_zone,
		});
		frozen = { date: clock.date, since, until: nowMs, ...rendered, data };
		await setState(db, `${ns}:pending`, JSON.stringify(frozen));
	}

	// Retain the same frozen evidence for the future read-only overflow view.
	await setState(db, `${ns}:report:${frozen.date}`, JSON.stringify(frozen));
	await ensureReportSenderRule(db, config.from);
	const key = `${ns.replace(/_/g, "-")}-${frozen.date}`;
	const { status, json } = await callApi(env, ctx, "/api/emails/send", {
		from: config.from,
		to: config.to,
		subject: frozen.subject,
		html: frozen.html,
		text: frozen.text,
		idempotency_key: key,
	});
	const data = (json?.data ?? null) as Record<string, unknown> | null;
	if (json?.success !== true) {
		const code = String((json?.error as { code?: string } | undefined)?.code ?? "UNKNOWN");
		logError("morning_report_send_failed", { key, status, code });
		return {
			status: "send_failed",
			local_date: clock.date,
			key,
			http_status: status,
			error_code: code,
		};
	}

	// `pending` stays until the next day's report replaces it: if this bookkeeping is lost, the
	// next tick resends the same frozen message under the same key and gets already_sent.
	if (frozen.data) await setState(db, `${ns}:history`, JSON.stringify(frozen.data.history_next));
	await setState(db, `${ns}:last_sent_at`, String(frozen.until));
	await setState(db, `${ns}:last_date`, frozen.date);
	const emailId = data?.email_id == null ? null : String(data.email_id);
	const alreadySent = data?.already_sent === true;
	logInfo("morning_report_sent", { key, email_id: emailId, already_sent: alreadySent });
	return {
		status: "sent",
		local_date: clock.date,
		key,
		http_status: status,
		email_id: emailId,
		already_sent: alreadySent,
	};
}
