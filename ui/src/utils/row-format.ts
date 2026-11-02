/**
 * What a list row shows (design r2 §4 S1): its time and the new text of its message.
 */

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const yearFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
});
const fullFormat = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

const toMs = (ts: number) => (ts < 1e11 ? ts * 1000 : ts);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "5:02 PM" today, "Yesterday", "Mon" this week, "Oct 3" this year, else "Oct 3, 2025". */
export function rowTime(ts: number, now = Date.now()): string {
	if (!ts) return "";
	const ms = toMs(ts);
	const date = new Date(ms);
	const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000);
	if (days <= 0) return timeFormat.format(ms);
	if (days === 1) return "Yesterday";
	if (days < 7) return weekdayFormat.format(ms);
	return date.getFullYear() === new Date(now).getFullYear()
		? dayFormat.format(ms)
		: yearFormat.format(ms);
}

/** The row's tooltip: "Thu, Oct 23, 2026, 5:02 PM". */
export function fullTime(ts: number): string {
	return ts ? fullFormat.format(toMs(ts)) : "";
}

/**
 * Where repeated history or a legal footer starts in a one-line snippet: an "On … wrote:" line,
 * "-----Original Message", an Outlook "From: … Sent:" header, a rule of underscores, "Get
 * Outlook for", a confidentiality notice. The same cuts the reader makes (WD-05/NI-08).
 */
const HISTORY = [
	/\bOn\s.{4,160}?\bwrote:/,
	/-{2,}\s*Original Message/i,
	/\bFrom:\s.{1,200}?\b(?:Sent|Date):/,
	/_{8,}/,
	/\bGet Outlook for\b/,
	/\b(?:CONFIDENTIAL(?:ITY)? (?:NOTICE|COMMUNICATION)|THIS ELECTRONIC MESSAGE)\b/i,
];

const ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

function decode(text: string): string {
	return text
		.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

/**
 * The new text of a snippet: tags other than <mark> and inline image/link debris dropped, cut
 * before any quoted history. A snippet that is nothing but history has no new text ("").
 */
export function newText(snippet: string | null | undefined): string {
	if (!snippet) return "";
	const clean = decode(
		snippet
			.replace(/<mark\b[^>]*>/gi, "<mark>")
			.replace(/<\/mark>/gi, "</mark>")
			.replace(/<(?!\/?mark>)[^>]*>/gi, ""),
	)
		.replace(/\[cid:[^\]]*\]/g, "")
		.replace(/<(?:https?|mailto):[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	let cut = clean.length;
	for (const re of HISTORY) {
		const m = re.exec(clean);
		if (m && m.index < cut) cut = m.index;
	}
	return clean.slice(0, cut).trim();
}

/** A snippet split into plain and <mark>ed runs (search results highlight their match). */
export function markedRuns(text: string): { text: string; marked: boolean }[] {
	const runs: { text: string; marked: boolean }[] = [];
	let marked = false;
	for (const part of text.split(/(<mark>|<\/mark>)/i)) {
		const lower = part.toLowerCase();
		if (lower === "<mark>") marked = true;
		else if (lower === "</mark>") marked = false;
		else if (part) runs.push({ text: part, marked });
	}
	return runs;
}
