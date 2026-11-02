/**
 * Quoted-text split (ticket 06): hide text only when the same text is already visible
 * earlier in this conversation, the way Gmail does it (US 7,222,299).
 *
 * Each message is read in the representation the UI displays (HTML when there is any,
 * else text), tokenised as Unicode letters/digits (CJK per character), and compared with
 * every earlier message of the conversation through 5-token hashes. A block (HTML element
 * or text line) is quoted only when it lies wholly inside ONE contiguous match of at least
 * MIN_MATCH tokens against ONE earlier message, so a changed amount or a one-word
 * interjection breaks the match and stays visible, and inline answers survive. No quote
 * markers are used, except to absorb a single attribution line ("On ... wrote:",
 * gmail_attr) directly above a quoted run. Nothing is removed: the UI hides blocks marked
 * `data-mc-quoted="<email id>"`; agents get `new_text`.
 *
 * Guards (show everything): an earlier body could not be loaded (R2), the conversation is
 * over the token or work cap, or the new text would have no letters/digits.
 */
import { parseDocument } from "htmlparser2";
import type { Email } from "@/types";

export type QuoteSkip = "missing_body" | "too_large" | "nothing_new";

export interface QuoteSegment {
	kind: "new" | "quoted";
	/** Earlier message the quoted run matched. */
	source_id?: string;
	/** Offsets into text_content (text-only messages). */
	start?: number;
	end?: number;
}

export interface QuoteSplit {
	has_quoted: boolean;
	new_text: string;
	quoted_chars: number;
	segments: QuoteSegment[];
	skipped?: QuoteSkip;
}

const SHINGLE = 5;
const MIN_MATCH = 20;
const MAX_CANDIDATES = 64; // per 5-gram; repetitive text stays bounded
const MAX_TOKENS = 150_000; // earlier + current, per message
const MAX_WORK = 3_000_000; // token comparisons per message

const TOKEN =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}\p{M}])+/gu;
const HAS_WORD = /[\p{L}\p{N}]/u;
const ATTRIBUTION = [
	/^on\b.{3,300}\bwrote\s*:$/i,
	/^am\b.{3,300}\bschrieb\b.{0,200}:$/i,
	/^le\b.{3,300}\ba écrit\s*:$/i,
	/^el\b.{3,300}\bescribió\s*:$/i,
	/^op\b.{3,300}\bschreef\b.{0,200}:$/i,
	/^il\b.{3,300}\bha scritto\s*:$/i,
	/^em\b.{3,300}\bescreveu\s*:$/i,
];
const SKIP_TAGS = new Set(["script", "style", "head", "title", "template"]);
const BLOCK_TAGS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"center",
	"dd",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tr",
	"ul",
]);

// ── tokens ──

type Vocab = Map<string, number>;

function tokenize(text: string, vocab: Vocab, out: number[]) {
	for (const match of text.matchAll(TOKEN)) {
		const word = match[0].toLowerCase();
		let id = vocab.get(word);
		if (id === undefined) {
			id = vocab.size;
			vocab.set(word, id);
		}
		out.push(id);
	}
}

const isAttribution = (text: string) =>
	text.length <= 400 && ATTRIBUTION.some((re) => re.test(text.replace(/\s+/g, " ").trim()));

// ── representations ──

interface HtmlNode {
	type: string;
	name?: string;
	attribs?: Record<string, string>;
	data?: string;
	children?: HtmlNode[];
	startIndex?: number | null;
	/** token range [t0, t1) */
	t0: number;
	t1: number;
	mark?: string;
}

interface TextLine {
	start: number;
	end: number;
	t0: number;
	t1: number;
	mark?: string;
}

interface Doc {
	tokens: number[];
	html?: { source: string; root: HtmlNode };
	text?: { source: string; lines: TextLine[] };
}

function readHtml(source: string, vocab: Vocab): Doc {
	const root = parseDocument(source, { withStartIndices: true }) as unknown as HtmlNode;
	const tokens: number[] = [];
	const walk = (node: HtmlNode) => {
		node.t0 = tokens.length;
		if (node.type === "text") tokenize(node.data ?? "", vocab, tokens);
		else if (node.type === "tag" || node.type === "root") {
			if (!SKIP_TAGS.has(node.name ?? "")) for (const child of node.children ?? []) walk(child);
		}
		node.t1 = tokens.length;
	};
	walk(root);
	return { tokens, html: { source, root } };
}

function readText(source: string, vocab: Vocab): Doc {
	const tokens: number[] = [];
	const lines: TextLine[] = [];
	let start = 0;
	while (start <= source.length) {
		const nl = source.indexOf("\n", start);
		const end = nl === -1 ? source.length : nl + 1;
		const t0 = tokens.length;
		tokenize(source.slice(start, end), vocab, tokens);
		lines.push({ start, end, t0, t1: tokens.length });
		if (nl === -1) break;
		start = end;
	}
	return { tokens, text: { source, lines } };
}

/** The representation the UI displays; null when there is no body. */
function readEmail(email: Email, vocab: Vocab): Doc | null {
	if (email.html_content?.trim()) return readHtml(email.html_content, vocab);
	if (email.text_content?.trim()) return readText(email.text_content, vocab);
	return null;
}

// ── matching ──

const gramHash = (tokens: number[], i: number) => {
	let h = 0;
	for (let k = 0; k < SHINGLE; k++) h = (Math.imul(h, 1_000_003) + tokens[i + k]) | 0;
	return h;
};

class EarlierIndex {
	private grams = new Map<number, number[]>(); // hash -> [doc, pos, doc, pos, ...]
	readonly docs: { id: string; tokens: number[] }[] = [];
	tokenCount = 0;

	add(id: string, tokens: number[]) {
		const doc = this.docs.length;
		this.docs.push({ id, tokens });
		this.tokenCount += tokens.length;
		for (let i = 0; i + SHINGLE <= tokens.length; i++) {
			const h = gramHash(tokens, i);
			let list = this.grams.get(h);
			if (!list) {
				list = [];
				this.grams.set(h, list);
			}
			if (list.length < MAX_CANDIDATES * 2) list.push(doc, i);
		}
	}

	/**
	 * For every token position p of `cur`: the furthest end of a single contiguous match
	 * (>= MIN_MATCH tokens, one earlier message) that starts at or before p, and its source.
	 * null when the work cap is hit.
	 */
	reach(cur: number[]): { end: Int32Array; source: Int32Array } | null {
		const n = cur.length;
		const end = new Int32Array(n).fill(-1);
		const source = new Int32Array(n).fill(-1);
		let work = 0;
		for (let i = 0; i + SHINGLE <= n; i++) {
			const list = this.grams.get(gramHash(cur, i));
			if (!list) continue;
			for (let c = 0; c < list.length; c += 2) {
				const tokens = this.docs[list[c]].tokens;
				const j = list[c + 1];
				// Only maximal starts: a continuation was already measured from its start.
				if (i > 0 && j > 0 && cur[i - 1] === tokens[j - 1]) continue;
				let k = 0;
				while (i + k < n && j + k < tokens.length && cur[i + k] === tokens[j + k]) k++;
				work += k + 1;
				if (work > MAX_WORK) return null;
				if (k >= MIN_MATCH && i + k > end[i]) {
					end[i] = i + k;
					source[i] = list[c];
				}
			}
		}
		for (let i = 1; i < n; i++) {
			if (end[i - 1] > end[i]) {
				end[i] = end[i - 1];
				source[i] = source[i - 1];
			}
		}
		return { end, source };
	}
}

// ── decisions ──

type Reach = { end: Int32Array; source: Int32Array };

/** Source doc index when tokens [t0, t1) lie inside one match, else -1. */
const coveredBy = (reach: Reach, t0: number, t1: number) =>
	t1 > t0 && reach.end[t0] >= t1 ? reach.source[t0] : -1;

function markHtml(node: HtmlNode, reach: Reach, ids: string[]) {
	const src = node.type === "tag" ? coveredBy(reach, node.t0, node.t1) : -1;
	if (src >= 0) {
		node.mark = ids[src];
		return;
	}
	const children = node.children ?? [];
	for (const child of children) {
		if (child.type === "tag" || child.type === "root") markHtml(child, reach, ids);
	}
	// Sibling runs: words in an unmarked child break a run; empty children (spacers,
	// images) between two marked siblings join it; one attribution element directly
	// above a run joins it.
	const items = children.filter((c) => c.type === "tag" || c.t1 > c.t0);
	const hasWords = (c: HtmlNode) => c.t1 > c.t0;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item.mark) continue;
		let prev = i - 1;
		while (prev >= 0 && !hasWords(items[prev])) prev--;
		if (prev >= 0 && items[prev].mark) {
			for (let k = prev + 1; k < i; k++) if (items[k].type === "tag") items[k].mark = item.mark;
		} else if (prev >= 0 && items[prev].type === "tag") {
			const above = items[prev];
			if (
				/\bgmail_attr\b/.test(above.attribs?.class ?? "") ||
				isAttribution(renderHtml(above, false))
			) {
				above.mark = item.mark;
				for (let k = prev + 1; k < i; k++) if (items[k].type === "tag") items[k].mark = item.mark;
			}
		}
	}
}

function renderHtml(node: HtmlNode, skipMarked: boolean): string {
	const parts: string[] = [];
	const walk = (n: HtmlNode) => {
		if (skipMarked && n.mark) return;
		if (n.type === "text") {
			parts.push((n.data ?? "").replace(/\s+/g, " "));
			return;
		}
		if (n.type !== "tag" && n.type !== "root") return;
		const name = n.name ?? "";
		if (SKIP_TAGS.has(name)) return;
		if (name === "br") {
			parts.push("\n");
			return;
		}
		const block = BLOCK_TAGS.has(name);
		if (block) parts.push("\n");
		else if (name === "td" || name === "th") parts.push(" ");
		for (const child of n.children ?? []) walk(child);
		if (block) parts.push("\n");
	};
	walk(node);
	return tidy(parts.join(""));
}

const tidy = (text: string) =>
	text
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

function markText(source: string, lines: TextLine[], reach: Reach, ids: string[]) {
	for (const line of lines) {
		const src = coveredBy(reach, line.t0, line.t1);
		if (src >= 0) line.mark = ids[src];
	}
	const hasWords = (l: TextLine) => l.t1 > l.t0;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].mark || (i > 0 && lines[i - 1].mark)) continue;
		let prev = i - 1;
		while (prev >= 0 && !hasWords(lines[prev])) prev--;
		if (prev < 0) continue;
		const fill = (from: number) => {
			for (let k = from; k < i; k++) lines[k].mark = lines[i].mark;
		};
		if (lines[prev].mark) {
			fill(prev + 1);
			continue;
		}
		// One attribution line above the run, possibly wrapped onto two lines.
		const line = (k: number) => source.slice(lines[k].start, lines[k].end);
		if (isAttribution(line(prev))) fill(prev);
		else if (
			prev > 0 &&
			hasWords(lines[prev - 1]) &&
			isAttribution(`${line(prev - 1)} ${line(prev)}`)
		) {
			fill(prev - 1);
		}
	}
}

/** Insert `data-mc-quoted="<id>"` right after the tag name of every marked element. */
function annotate(source: string, root: HtmlNode, emailId: string): string {
	const at: number[] = [];
	const walk = (n: HtmlNode) => {
		if (n.mark && n.startIndex != null && source[n.startIndex] === "<") {
			const name = /^[^\s/>]+/.exec(source.slice(n.startIndex + 1, n.startIndex + 64));
			if (name) at.push(n.startIndex + 1 + name[0].length);
			return;
		}
		for (const child of n.children ?? []) walk(child);
	};
	walk(root);
	let out = source;
	for (const pos of at.sort((a, b) => b - a)) {
		out = `${out.slice(0, pos)} data-mc-quoted="${emailId}"${out.slice(pos)}`;
	}
	return out;
}

function segmentsFromFlags(flags: (string | null)[]): QuoteSegment[] {
	const segments: QuoteSegment[] = [];
	for (const flag of flags) {
		const last = segments.at(-1);
		const kind = flag ? "quoted" : "new";
		if (last && last.kind === kind && last.source_id === (flag ?? undefined)) continue;
		segments.push(flag ? { kind, source_id: flag } : { kind });
	}
	return segments;
}

// ── conversation ──

const when = (email: Email) => email.sent_at ?? email.received_at ?? 0;

/**
 * Split every message of a conversation (any order) against the messages before it.
 * Sets `email.quote` when something is hidden or a guard fired; with `annotateHtml`,
 * marks quoted HTML blocks in `email.html_content` for the UI.
 */
export function applyQuoteSplits(emails: Email[], options: { annotateHtml: boolean }) {
	const ordered = [...emails].sort((a, b) => when(a) - when(b) || (a.id < b.id ? -1 : 1));
	const vocab: Vocab = new Map();
	const index = new EarlierIndex();
	const seen = new Set<string>();
	let missing = false;
	for (const email of ordered) {
		const offloadedButMissing = Boolean(email.html_in_r2) && !email.html_content;
		const doc = offloadedButMissing ? null : readEmail(email, vocab);
		// A second copy of the same message is neither split nor "earlier" text.
		const copy = Boolean(email.message_id && seen.has(email.message_id));
		if (doc && !copy && (missing || index.docs.length > 0)) {
			const split = splitOne(email, doc, index, missing, options.annotateHtml);
			if (split) email.quote = split;
		}
		if (offloadedButMissing) missing = true;
		if (doc && !copy) index.add(email.id, doc.tokens);
		if (email.message_id) seen.add(email.message_id);
	}
}

function splitOne(
	email: Email,
	doc: Doc,
	index: EarlierIndex,
	missing: boolean,
	annotateHtml: boolean,
): QuoteSplit | null {
	const skip = (skipped: QuoteSkip): QuoteSplit => ({
		has_quoted: false,
		new_text: "",
		quoted_chars: 0,
		segments: [],
		skipped,
	});
	if (missing) return skip("missing_body");
	if (index.tokenCount + doc.tokens.length > MAX_TOKENS) return skip("too_large");
	const reach = index.reach(doc.tokens);
	if (!reach) return skip("too_large");
	const ids = index.docs.map((d) => d.id);
	const flags: (string | null)[] = new Array(doc.tokens.length).fill(null);

	if (doc.html) {
		markHtml(doc.html.root, reach, ids);
		const walk = (n: HtmlNode, mark: string | null) => {
			const m = n.mark ?? mark;
			if (m) for (let t = n.t0; t < n.t1; t++) flags[t] = m;
			else for (const child of n.children ?? []) walk(child, null);
		};
		walk(doc.html.root, null);
		if (!flags.some(Boolean)) return null;
		const full = renderHtml(doc.html.root, false);
		const newText = renderHtml(doc.html.root, true);
		if (!HAS_WORD.test(newText)) return skip("nothing_new");
		if (annotateHtml) email.html_content = annotate(doc.html.source, doc.html.root, email.id);
		return {
			has_quoted: true,
			new_text: newText,
			quoted_chars: Math.max(full.length - newText.length, 0),
			segments: segmentsFromFlags(flags),
		};
	}

	if (!doc.text) return null;
	const { source, lines } = doc.text;
	markText(source, lines, reach, ids);
	if (!lines.some((l) => l.mark)) return null;
	const newText = tidy(
		lines
			.filter((l) => !l.mark)
			.map((l) => source.slice(l.start, l.end))
			.join(""),
	);
	if (!HAS_WORD.test(newText)) return skip("nothing_new");
	const segments: QuoteSegment[] = [];
	for (const line of lines) {
		const kind = line.mark ? "quoted" : "new";
		const last = segments.at(-1);
		if (last && last.kind === kind && last.source_id === line.mark) last.end = line.end;
		else
			segments.push(
				line.mark
					? { kind, source_id: line.mark, start: line.start, end: line.end }
					: { kind, start: line.start, end: line.end },
			);
	}
	const quotedChars = segments
		.filter((s) => s.kind === "quoted")
		.reduce((n, s) => n + ((s.end ?? 0) - (s.start ?? 0)), 0);
	return { has_quoted: true, new_text: newText, quoted_chars: quotedChars, segments };
}
