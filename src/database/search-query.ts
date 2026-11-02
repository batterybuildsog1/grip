/**
 * The one search-query compiler. Web (/api/conversations), the API and the CLI
 * (/api/emails, /api/emails?full=1) all turn the typed query into FTS5 MATCH
 * strings and structured filters here, so they cannot disagree on what a query
 * means. Anything it cannot apply is reported in `invalid`; callers refuse such
 * queries (QueryInputError) instead of silently widening the result.
 *
 * Beyond Gmail operators it reads simple natural language: filler words
 * ("find", "the", "emails about") are dropped when other words remain, and
 * date phrases ("from September", "last month", "past 2 weeks") become
 * after:/before: bounds. Plain words are matched by prefix after light
 * stemming ("receipts" and "deliveries" find "receipt" and "delivery").
 * `interpreted` echoes what was actually searched.
 */
import type { MailboxState } from "@/types";

/** A caller mistake in a mail query: bad cursor, operator, or unsearchable text. */
export class QueryInputError extends Error {
	constructor(
		readonly code: "INVALID_QUERY" | "INVALID_CURSOR" | "UNSUPPORTED" | "QUERY_TOO_BROAD",
		message: string,
	) {
		super(message);
	}
}

export const SEARCH_OPERATORS =
	"from: to: subject: filename: has:attachment is:read|unread in:inbox|sent|archived|trash|draft|anywhere category: after: before: newer_than: older_than:";

export interface SearchFilters {
	has_attachment?: boolean;
	is_read?: boolean;
	category?: string;
	after?: number;
	before?: number;
	mailbox_state?: MailboxState;
	/** in:anywhere: Trash and Spam are searched too. */
	anywhere?: boolean;
}

/**
 * FTS MATCH inputs. At most one field is set:
 * - `match`: positive FTS5 query (may embed trailing NOT terms).
 * - `exclude`: only for negation-only queries ('-newsletter'). FTS5 cannot
 *   evaluate a bare NOT, so the negated terms come back as a POSITIVE query the
 *   caller applies as `rowid NOT IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)`.
 * Both null: no free-text terms (operator-only or empty).
 */
export interface FtsMatchQueries {
	match: string | null;
	exclude: string | null;
}

export interface ParsedSearch {
	fts: FtsMatchQueries;
	filters: SearchFilters;
	/** Positive plain words as typed (lowercase), after filler removal: spelling + name boost. */
	words: string[];
	/** What was searched, in operator form: "delivery invoice after:2026-09-01 before:2026-10-01". */
	interpreted: string;
	/** Operators or terms that could not be applied, e.g. "in:bogus", "label:x". */
	invalid: string[];
}

const ALL_COLUMNS =
	"{subject text_content from_address from_name to_address to_addresses_json cc_addresses_json bcc_addresses_json reply_to_addresses_json attachment_names attachment_search_text}";
const COLUMN_SCOPE: Record<string, string> = {
	from: "{from_address from_name}",
	to: "{to_address to_addresses_json}",
	subject: "subject",
	filename: "attachment_names",
};
const KNOWN_OPERATORS = new Set([
	"from",
	"to",
	"subject",
	"filename",
	"has",
	"is",
	"category",
	"after",
	"before",
	"older_than",
	"newer_than",
	"in",
]);
const MAILBOX_STATES = new Set(["inbox", "sent", "trash", "archived", "draft"]);
/** Words that carry no meaning in a mail search; dropped when other words remain. */
const FILLER = new Set(
	"a an the find show search get give me my mine i all any some every email emails mail mails message messages thread threads conversation conversations about regarding re for from with of on in at to by and or that which where what please did was were is are".split(
		" ",
	),
);
const FTS5_KEYWORDS = new Set(["AND", "OR", "NOT", "NEAR"]);
const MAX_TERMS = 10;

/**
 * Split a raw token into the fragments the unicode61 tokenizer would produce:
 * 'robin@example.com' -> ['robin', 'example', 'com'].
 */
function ftsTokenFragments(token: string): string[] {
	return token
		.replace(/[^\p{L}\p{N}_]/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((fragment) => fragment.toLowerCase());
}

/**
 * A token as an FTS5 term: single fragments bare, several as one quoted phrase
 * ('robin@example.com' -> '"robin example com"') so they match the indexed
 * tokenization instead of truncating to the first fragment.
 */
function sanitizeFtsToken(token: string): string {
	const fragments = ftsTokenFragments(token);
	if (fragments.length === 0) return "";
	if (fragments.length > 1) return `"${fragments.join(" ")}"`;
	// FTS5 keywords are case-sensitive (AND is a keyword, and is not).
	return FTS5_KEYWORDS.has(fragments[0].toUpperCase()) ? fragments[0].toLowerCase() : fragments[0];
}

/**
 * Prefix-match a term unless its last fragment is a single character: a
 * one-letter prefix ("12-A" -> "12 a"*) expands to most of the index and
 * costs hundreds of ms per FTS evaluation on a large mailbox; exact is about 1 ms.
 */
function withPrefix(term: string): string {
	const last = term.replace(/"$/, "").split(" ").pop() ?? "";
	return last.length >= 2 ? `${term}*` : term;
}

/**
 * Light stemming to a prefix: plural and -y endings are cut so the prefix
 * match finds every form ("deliveries"/"delivery" -> deliver*, "receipts" ->
 * receipt*). Only plain letter words of 5+ letters; "-ss", "-us", "-is" stay.
 */
export function stemPrefix(word: string): string {
	if (!/^[a-z]{5,}$/.test(word)) return word;
	let stem = word;
	if (stem.endsWith("ies")) stem = stem.slice(0, -3);
	else if (stem.endsWith("s") && !/(ss|us|is)$/.test(stem)) stem = stem.slice(0, -1);
	if (stem.endsWith("y") && stem.length > 4) stem = stem.slice(0, -1);
	return stem.length >= 4 ? stem : word;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];
const MONTH_RE =
	"(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";

function monthIndex(word: string): number {
	const w = word.toLowerCase();
	return MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
}

/** Dates outside 1970-2099 are refused: they are typos, and Date can't format them all. */
const MIN_DATE_MS = Date.UTC(1970, 0, 1);
const MAX_DATE_MS = Date.UTC(2100, 0, 1);
const inRange = (ms: number) => Number.isFinite(ms) && ms >= MIN_DATE_MS && ms < MAX_DATE_MS;

/**
 * yyyy-mm-dd, yyyy/mm/dd, an ISO timestamp, or epoch seconds/ms -> epoch ms (UTC).
 * Impossible calendar dates (2026-02-30) and out-of-range values are null.
 */
export function parseDateValue(value: string): number | null {
	if (/^\d{1,13}$/.test(value)) {
		const n = Number(value);
		const ms = n < 1e11 ? n * 1000 : n;
		return n > 0 && inRange(ms) ? ms : null;
	}
	const m = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:([T ])(.+))?$/);
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const day = new Date(Date.UTC(y, mo - 1, d));
	if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d)
		return null;
	const ms = m[4]
		? new Date(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T${m[5]}`).getTime()
		: day.getTime();
	return inRange(ms) ? ms : null;
}

/** Relative duration like "3d", "2w", "2m", "1y" in ms (at most 200 years). */
function parseRelativeDuration(value: string): number | null {
	const match = value.match(/^(\d{1,5})([dwmy])$/i);
	if (!match) return null;
	const n = Number.parseInt(match[1], 10);
	const days = { d: 1, w: 7, m: 30, y: 365 }[match[2].toLowerCase() as "d" | "w" | "m" | "y"];
	return n * days <= 200 * 365 ? n * days * DAY_MS : null;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface DateWindow {
	after?: number;
	before?: number;
}

/** [start, end) of the calendar unit containing `now` shifted by `offset` units (UTC; weeks start Monday). */
function calendarUnit(unit: string, now: number, offset: number): [number, number] {
	const d = new Date(now);
	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	if (unit === "day") {
		const start = Date.UTC(y, m, d.getUTCDate() + offset);
		return [start, start + DAY_MS];
	}
	if (unit === "week") {
		const monday = Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7 * offset);
		return [monday, monday + 7 * DAY_MS];
	}
	if (unit === "month") return [Date.UTC(y, m + offset, 1), Date.UTC(y, m + offset + 1, 1)];
	return [Date.UTC(y + offset, 0, 1), Date.UTC(y + offset + 1, 0, 1)];
}

/**
 * Apply a preposition to a window starting at `start`: since/after keep only the
 * start, before makes the start the end bound, none/from/in/during keep both ends
 * (`end` undefined = open-ended up to now).
 */
function windowFor(prep: string | undefined, start: number, end: number | undefined): DateWindow {
	const p = prep?.toLowerCase();
	if (p === "since" || p === "after") return { after: start };
	if (p === "before") return { before: start };
	return end === undefined ? { after: start } : { after: start, before: end };
}

const ROLLING_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const;

/**
 * Natural-language date phrases inside one run of plain words (operators and
 * quoted phrases never reach here). Each match is removed and becomes a window.
 */
function extractDatePhrases(
	text: string,
	now: number,
): { rest: string; window: DateWindow; phrases: string[] } {
	const window: DateWindow = {};
	const phrases: string[] = [];
	const merge = (w: DateWindow) => {
		if (w.after !== undefined) window.after = Math.max(window.after ?? w.after, w.after);
		if (w.before !== undefined) window.before = Math.min(window.before ?? w.before, w.before);
	};
	const PREP = "(?:(from|in|during|since|after|before)\\s+)?(?:the\\s+)?";
	const rules: { re: RegExp; apply: (m: RegExpExecArray) => DateWindow }[] = [
		{
			// "last 3 days", "in the past 2 weeks", "before the last 2 weeks": rolling, ending now
			re: new RegExp(`\\b${PREP}(?:last|past)\\s+(\\d{1,3})\\s+(day|week|month|year)s?\\b`, "i"),
			apply: (m) => {
				const unit = m[3].toLowerCase() as keyof typeof ROLLING_DAYS;
				return windowFor(m[1], now - Number(m[2]) * ROLLING_DAYS[unit] * DAY_MS, undefined);
			},
		},
		{
			// "last month", "this year", "past week", "before last week"
			re: new RegExp(`\\b${PREP}(last|previous|this|past)\\s+(week|month|year)\\b`, "i"),
			apply: (m) => {
				const which = m[2].toLowerCase();
				const unit = m[3].toLowerCase() as "week" | "month" | "year";
				if (which === "past") return windowFor(m[1], now - ROLLING_DAYS[unit] * DAY_MS, undefined);
				const [start, end] = calendarUnit(unit, now, which === "this" ? 0 : -1);
				return windowFor(m[1], start, which === "this" ? undefined : end);
			},
		},
		{
			re: new RegExp(`\\b${PREP}(today|yesterday)\\b`, "i"),
			apply: (m) => {
				const [start, end] = calendarUnit("day", now, m[2].toLowerCase() === "today" ? 0 : -1);
				return windowFor(m[1], start, end);
			},
		},
		{
			// "September 2026", "sept 2025", "in March 2026"
			re: new RegExp(`\\b${PREP}${MONTH_RE}\\.?\\s+(\\d{4})\\b`, "i"),
			apply: (m) => {
				const month = monthIndex(m[2]);
				const year = Number(m[3]);
				return windowFor(m[1], Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1));
			},
		},
		{
			// "from September", "since March": a full month name after a preposition, the most
			// recent one that has started. Abbreviations need a year ("Jan" is also a name).
			re: /\b(from|in|during|since|after|before)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
			apply: (m) => {
				const month = monthIndex(m[2]);
				const d = new Date(now);
				const year = month > d.getUTCMonth() ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
				return windowFor(m[1], Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1));
			},
		},
		{
			// "in 2025", "since 2024"
			re: /\b(from|in|during|since|after|before)\s+(19[89]\d|20\d\d)\b/i,
			apply: (m) => {
				const year = Number(m[2]);
				return windowFor(m[1], Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
			},
		},
	];
	let rest = text;
	for (const rule of rules) {
		for (let m = rule.re.exec(rest); m; m = rule.re.exec(rest)) {
			merge(rule.apply(m));
			phrases.push(m[0].trim());
			rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
		}
	}
	return { rest, window, phrases };
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** Whole query at most this long; any one token at most MAX_TOKEN_CHARS; at most MAX_TOKENS tokens. */
const MAX_QUERY_CHARS = 1000;
const MAX_TOKEN_CHARS = 200;
const MAX_TOKENS = 30;

type Token =
	| { kind: "phrase"; text: string; negated: boolean; raw: string }
	| { kind: "op"; op: string; value: string; negated: boolean; raw: string }
	| { kind: "word"; raw: string; start: number; end: number };

/**
 * Lookalikes typed on phones and pasted from documents become their ASCII
 * forms (one char for one char, so offsets are unchanged): curly quotes, the
 * fullwidth colon, non-breaking and other wide spaces.
 */
function normalizeQuery(input: string): string {
	return input
		.replace(/[“”„‟″]/g, '"')
		.replace(/：/g, ":")
		.replace(/[  -​ 　]/g, " ");
}

/**
 * Split a query into quoted phrases, operators (with bare or quoted values) and
 * plain words. Quotes are lexed first, so `"invoice in:trash"` is one literal
 * phrase; `subject:"project notes"` is one operator. An unbalanced quote is an error.
 */
function lex(input: string): { tokens: Token[]; error?: string } {
	const tokens: Token[] = [];
	const n = input.length;
	let i = 0;
	const closing = (from: number) => input.indexOf('"', from);
	while (i < n) {
		if (/\s/.test(input[i])) {
			i++;
			continue;
		}
		const negatedPhrase = input[i] === "-" && input[i + 1] === '"';
		if (input[i] === '"' || negatedPhrase) {
			const open = negatedPhrase ? i + 1 : i;
			const close = closing(open + 1);
			if (close < 0) return { tokens, error: `Unbalanced quote in ${input.slice(i, i + 40)}` };
			tokens.push({
				kind: "phrase",
				text: input.slice(open + 1, close),
				negated: negatedPhrase,
				raw: input.slice(i, close + 1),
			});
			i = close + 1;
			continue;
		}
		let j = i;
		while (j < n && !/\s/.test(input[j]) && input[j] !== '"') j++;
		const raw = input.slice(i, j);
		const op = raw.match(/^(-?)([a-z_]+):(.*)$/i);
		if (op && KNOWN_OPERATORS.has(op[2].toLowerCase())) {
			if (op[3] === "" && input[j] === '"') {
				const close = closing(j + 1);
				if (close < 0) return { tokens, error: `Unbalanced quote in ${input.slice(i, i + 40)}` };
				tokens.push({
					kind: "op",
					op: op[2].toLowerCase(),
					value: input.slice(j + 1, close),
					negated: op[1] === "-",
					raw: input.slice(i, close + 1),
				});
				i = close + 1;
				continue;
			}
			tokens.push({
				kind: "op",
				op: op[2].toLowerCase(),
				value: op[3],
				negated: op[1] === "-",
				raw,
			});
		} else {
			tokens.push({ kind: "word", raw, start: i, end: j });
		}
		i = j;
	}
	return { tokens };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse without throwing: unsupported parts are listed in `invalid`. */
export function parseSearch(rawInput: string, now: number = Date.now()): ParsedSearch {
	const filters: SearchFilters = {};
	const invalid: string[] = [];
	const columnTerms: string[] = []; // scoped terms ({from_address from_name}: x*), may start with NOT
	const phrases: string[] = []; // positive "exact phrase" FTS strings
	const negativePhrases: string[] = [];
	const interpretedOps: string[] = [];
	const interpretedPhrases: string[] = [];
	let dateOpsUsed = false;
	const empty = (): ParsedSearch => ({
		fts: { match: null, exclude: null },
		filters: {},
		words: [],
		interpreted: "",
		invalid,
	});

	const input = normalizeQuery(rawInput);
	if (input.length > MAX_QUERY_CHARS) {
		invalid.push(`(query longer than ${MAX_QUERY_CHARS} characters)`);
		return empty();
	}
	const { tokens, error } = lex(input);
	if (error) {
		invalid.push(`(${error})`);
		return empty();
	}
	if (tokens.length > MAX_TOKENS) {
		invalid.push(`(${tokens.length} terms; at most ${MAX_TOKENS})`);
		return empty();
	}
	const long = tokens.find((t) => t.raw.length > MAX_TOKEN_CHARS);
	if (long) {
		invalid.push(`(a term longer than ${MAX_TOKEN_CHARS} characters)`);
		return empty();
	}

	const setAfter = (ts: number) => {
		filters.after = Math.max(filters.after ?? ts, ts);
	};
	const setBefore = (ts: number) => {
		filters.before = Math.min(filters.before ?? ts, ts);
	};

	// 1. Operators.
	for (const token of tokens) {
		if (token.kind !== "op") continue;
		const { op, negated, raw } = token;
		const value = token.value.trim();
		const reject = () => {
			invalid.push(raw);
		};
		switch (op) {
			case "from":
			case "to":
			case "subject":
			case "filename": {
				const term = sanitizeFtsToken(value);
				if (!term) {
					reject();
					break;
				}
				columnTerms.push(`${negated ? "NOT " : ""}${COLUMN_SCOPE[op]}: ${withPrefix(term)}`);
				interpretedOps.push(raw);
				break;
			}
			case "has":
				if (value.toLowerCase() === "attachment") {
					filters.has_attachment = !negated;
					interpretedOps.push(raw);
				} else reject();
				break;
			case "is":
				if (value.toLowerCase() === "unread") filters.is_read = negated;
				else if (value.toLowerCase() === "read") filters.is_read = !negated;
				else {
					reject();
					break;
				}
				interpretedOps.push(raw);
				break;
			case "category":
				if (filters.category && filters.category !== value.toLowerCase()) reject();
				else if (!negated && /^[a-z_]+$/i.test(value)) {
					filters.category = value.toLowerCase();
					interpretedOps.push(raw);
				} else reject();
				break;
			case "in": {
				const state = value.toLowerCase();
				// Two different in: values can't both hold.
				if (negated || (filters.mailbox_state && filters.mailbox_state !== state)) reject();
				else if (state === "anywhere") {
					filters.anywhere = true;
					interpretedOps.push(raw);
				} else if (MAILBOX_STATES.has(state)) {
					filters.mailbox_state = state as MailboxState;
					interpretedOps.push(raw);
				} else reject();
				break;
			}
			default: {
				// after before newer_than older_than
				const relative = op === "newer_than" || op === "older_than";
				const offset = relative ? parseRelativeDuration(value) : null;
				const ts = relative ? (offset !== null ? now - offset : null) : parseDateValue(value);
				if (ts === null || !inRange(ts) || negated) reject();
				else {
					if (op === "after" || op === "newer_than") setAfter(ts);
					else setBefore(ts);
					dateOpsUsed = true;
				}
			}
		}
	}

	// 2. Exact phrases: one quoted FTS string so adjacency is enforced.
	for (const token of tokens) {
		if (token.kind !== "phrase") continue;
		const fragments = token.text.split(/\s+/).filter(Boolean).flatMap(ftsTokenFragments);
		if (fragments.length === 0) {
			if (token.text.trim()) invalid.push(token.raw);
			continue;
		}
		(token.negated ? negativePhrases : phrases).push(`"${fragments.join(" ")}"`);
		interpretedPhrases.push(token.raw);
	}

	// 3. Plain words, one run per stretch between operators/phrases (a date phrase
	// never spans a quote), with natural-language dates taken out.
	const runs: string[][] = [[]];
	for (const token of tokens) {
		if (token.kind === "word") runs[runs.length - 1].push(token.raw);
		else if (runs[runs.length - 1].length > 0) runs.push([]);
	}
	const plain: string[] = [];
	for (const run of runs) {
		if (run.length === 0) continue;
		const dates = extractDatePhrases(run.join(" "), now);
		if (dates.window.after !== undefined) setAfter(dates.window.after);
		if (dates.window.before !== undefined) setBefore(dates.window.before);
		if (dates.phrases.length > 0) dateOpsUsed = true;
		plain.push(...dates.rest.split(/\s+/).filter(Boolean));
	}

	// 4. Free text.
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const token of plain) {
		// unicode61 does not index pictographs. Decorative unquoted emoji should
		// not invalidate the searchable words beside them (m3-04). Quoted or
		// negated symbols still require an explicit error; operators stay strict.
		if (
			/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(token) &&
			/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0e|\ufe0f)+$/u.test(
				token,
			)
		)
			continue;
		const op = token.match(/^-?([a-z_]+):(.*)$/i);
		if (op) {
			const word = op[1].toLowerCase();
			if (["http", "https", "mailto"].includes(word)) {
				positives.push(token);
			} else if (op[2] === "" && !KNOWN_OPERATORS.has(word)) {
				// "Re:", "Fwd:", "Note:": ordinary words followed by a colon.
				positives.push(token.slice(0, -1));
			} else {
				// "cc:robin", "label:x".
				invalid.push(token);
			}
			continue;
		}
		if (token.startsWith("-") && token.length > 1) negatives.push(token);
		else positives.push(token);
	}
	const isFiller = (t: string) => FILLER.has(t.toLowerCase());
	const meaningful = positives.filter((t) => !isFiller(t));
	const kept =
		meaningful.length > 0 || phrases.length > 0 || columnTerms.some((t) => !t.startsWith("NOT "))
			? meaningful
			: positives;
	const textTokens = [...kept, ...negatives];
	if (textTokens.length > MAX_TERMS) {
		invalid.push(`(${textTokens.length - MAX_TERMS} terms over the ${MAX_TERMS}-term limit)`);
	}
	const words: string[] = [];
	const positiveTerms: string[] = [];
	for (const token of kept.slice(0, MAX_TERMS)) {
		const fragments = ftsTokenFragments(token);
		if (fragments.length === 0) {
			invalid.push(token);
			continue;
		}
		if (fragments.length > 1) {
			positiveTerms.push(withPrefix(`"${fragments.join(" ")}"`));
			continue;
		}
		const word = fragments[0];
		words.push(word);
		const term = FTS5_KEYWORDS.has(word.toUpperCase()) ? word.toLowerCase() : word;
		positiveTerms.push(withPrefix(stemPrefix(term)));
	}
	const negativeTerms: string[] = [];
	for (const token of negatives.slice(0, Math.max(0, MAX_TERMS - kept.length))) {
		const clean = sanitizeFtsToken(token.slice(1));
		if (clean) negativeTerms.push(`NOT ${ALL_COLUMNS}: ${withPrefix(clean)}`);
		else invalid.push(token);
	}

	// An empty or inverted date range can only be a mistake.
	if (
		filters.after !== undefined &&
		filters.before !== undefined &&
		filters.after > filters.before
	) {
		invalid.push(`(after ${ymd(filters.after)} is later than before ${ymd(filters.before)})`);
	}

	// 5. FTS strings: positive terms AND-ed, NOT terms appended (FTS5 implicit AND NOT).
	const positive = [
		...phrases.map((p) => `${ALL_COLUMNS}: ${p}`),
		...positiveTerms.map((t) => `${ALL_COLUMNS}: ${t}`),
		...columnTerms.filter((t) => !t.startsWith("NOT ")),
	];
	const negative = [
		...columnTerms.filter((t) => t.startsWith("NOT ")),
		...negativePhrases.map((p) => `NOT ${ALL_COLUMNS}: ${p}`),
		...negativeTerms,
	];
	let fts: FtsMatchQueries = { match: null, exclude: null };
	if (positive.length > 0)
		fts = { match: [positive.join(" AND "), ...negative].join(" "), exclude: null };
	else if (negative.length > 0)
		fts = { match: null, exclude: negative.map((t) => t.slice(4)).join(" OR ") };

	const interpreted = [
		...kept.slice(0, MAX_TERMS),
		...interpretedPhrases,
		...negatives,
		...interpretedOps,
		...(dateOpsUsed && filters.after !== undefined ? [`after:${ymd(filters.after)}`] : []),
		...(dateOpsUsed && filters.before !== undefined ? [`before:${ymd(filters.before)}`] : []),
	].join(" ");

	return { fts, filters, words, interpreted, invalid };
}

/**
 * Parse a query that must apply exactly: throws QueryInputError when any part
 * is unsupported or nothing in it is searchable.
 */
export function compileSearch(input: string, now: number = Date.now()): ParsedSearch {
	const parsed = parseSearch(input, now);
	if (parsed.invalid.length > 0) {
		throw new QueryInputError(
			"INVALID_QUERY",
			`Unsupported search terms: ${parsed.invalid.join(" ")}. Operators: ${SEARCH_OPERATORS}`,
		);
	}
	const hasFilter = Object.values(parsed.filters).some((value) => value !== undefined);
	if (!parsed.fts.match && !parsed.fts.exclude && !hasFilter) {
		throw new QueryInputError("INVALID_QUERY", `Nothing searchable in "${input.trim()}"`);
	}
	return parsed;
}

export function buildFtsMatchQueries(input: string): FtsMatchQueries {
	return parseSearch(input).fts;
}

// ---------------------------------------------------------------------------
// Spelling
// ---------------------------------------------------------------------------

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** Damerau edit-distance-1 neighbours of a lowercase letter word. */
function edits1(word: string): string[] {
	const out = new Set<string>();
	for (let i = 0; i <= word.length; i++) {
		const left = word.slice(0, i);
		const right = word.slice(i);
		if (right) out.add(left + right.slice(1));
		if (right.length > 1) out.add(left + right[1] + right[0] + right.slice(2));
		for (const c of ALPHABET) {
			if (right) out.add(left + c + right.slice(1));
			out.add(left + c + right);
		}
	}
	out.delete(word);
	return [...out].filter((w) => w.length >= 3);
}

const SPELL_PROBE_CAP = 200;

/**
 * Where spelling may look: the caller's searchable corpus, as extra joins and
 * conditions over `emails_fts` (aliases: `cand` = emails, `t` = threads). The
 * same conditions the search applies, so a suggestion never reveals a word
 * from mail the caller can't search (review F1).
 */
export interface SpellingCorpus {
	joins: string;
	conditions: string[];
	params: unknown[];
}

/**
 * "Did you mean": for each plain word that matches nothing (or almost nothing
 * while a one-edit neighbour is common) in the caller's corpus, its most
 * frequent neighbour there. One bounded D1 statement: every candidate is an
 * exact-term FTS probe capped at 200 rows (tens of ms for a few hundred
 * candidates). Words must be 4-15 letters; at most two are checked.
 * Returns word -> replacement.
 */
export async function suggestSpelling(
	db: D1Database,
	words: string[],
	corpus: SpellingCorpus,
): Promise<Map<string, string>> {
	const checked = [...new Set(words.filter((w) => /^[a-z]{4,15}$/.test(w)))].slice(0, 2);
	const fixes = new Map<string, string>();
	if (checked.length === 0) return fixes;
	// Candidates are generated from [a-z] only, so inlining them is injection-safe and
	// avoids D1's 100-parameter limit.
	const rows: string[] = [];
	for (const word of checked) {
		rows.push(`('${word}','${word}*',1)`);
		for (const candidate of edits1(word)) rows.push(`('${word}','${candidate}',0)`);
	}
	const where = corpus.conditions.map((c) => ` AND ${c}`).join("");
	const { results } = await db
		.prepare(
			`WITH c(w, t, self) AS (VALUES ${rows.join(",")})
			 SELECT w, t, self, (
				SELECT COUNT(*) FROM (
					SELECT 1 FROM emails_fts ${corpus.joins}
					WHERE emails_fts MATCH c.t${where}
					LIMIT ${SPELL_PROBE_CAP}
				)
			 ) AS n
			 FROM c`,
		)
		.bind(...corpus.params)
		.all<{ w: string; t: string; self: number; n: number }>();
	for (const word of checked) {
		const mine = (results ?? []).filter((r) => r.w === word);
		const own = Number(mine.find((r) => r.self === 1)?.n ?? 0);
		const best = mine
			.filter((r) => r.self === 0 && Number(r.n) > 0)
			.sort((a, b) => Number(b.n) - Number(a.n) || a.t.localeCompare(b.t))[0];
		if (!best) continue;
		const n = Number(best.n);
		// Unknown word: any neighbour that exists. Rare word: only a far more common one.
		if (own === 0 || (own <= 3 && n >= 30 && n >= 20 * Math.max(own, 1))) {
			fixes.set(word, best.t);
		}
	}
	return fixes;
}

/**
 * The query with each corrected word replaced, in plain words only: quoted
 * phrases and operator values are never rewritten (review F4).
 */
export function applySpelling(query: string, fixes: Map<string, string>): string {
	const input = normalizeQuery(query);
	const { tokens, error } = lex(input);
	if (error) return query;
	let out = "";
	let at = 0;
	for (const token of tokens) {
		if (token.kind !== "word" || token.raw.startsWith("-")) continue;
		const replaced = token.raw.replace(/[A-Za-z]+/g, (w) => fixes.get(w.toLowerCase()) ?? w);
		if (replaced === token.raw) continue;
		out += input.slice(at, token.start) + replaced;
		at = token.end;
	}
	return out + input.slice(at);
}
