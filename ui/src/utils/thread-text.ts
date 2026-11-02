/**
 * The long thread's text rules (round-2 build spec S2; prototype design/site/public/r2/data.js):
 * what a message says that is new, what repeats, who is "me", how a timeline folds.
 * apple/MailClaw/Views/ThreadText.swift is the same rules for the native app.
 */
import type { Email, EmailCategory } from "../types";
import { realFiles } from "./files";
import { parseEmailAddress, parseSenderName, personName } from "./sender";

/* ── What is new, what repeats ── */

// Quoted history: Outlook's rule and "From:/Sent:" block, "-----Original Message", "On … wrote:".
const HISTORY = [
	/^_{8,}\s*$/m,
	/^-{2,}\s*Original Message/im,
	/^From: [^\n]+\n(?:Sent|Date): /m,
	/^On [^\n]{4,140}(?:\n[^\n]{0,140})?wrote:\s*$/m,
	/^Get Outlook for /m,
];
const FOOTER =
	/^(?:CONFIDENTIAL(?:ITY)? (?:NOTICE|COMMUNICATION)|THIS ELECTRONIC MESSAGE|This (?:email|e-mail|message)(?: and any attachments)? (?:is|are) (?:intended|confidential))/im;

/** Plain text as people read it: no CR, cid stubs, bracketed URL echoes, logo alt text or zero-widths. */
export function tidy(text: string | null | undefined): string {
	return String(text ?? "")
		.replace(/\r/g, "")
		.replace(/\[cid:[^\]]*\]/g, "")
		.replace(/<(?:https?|mailto):[^>]*>/g, "")
		.replace(
			/\[[^\]\n]{0,160}(?:Description automatically generated|Image result for|logo)[^\]\n]*\]/gi,
			"",
		)
		.replace(/^\[EXTERNAL( EMAIL)?\]\s*$/gm, "")
		.replace(/[​-‏­﻿]|͏/g, "")
		.replace(/[  ]/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** [before, from the first history marker or footer on]. A marker at the very start is not a cut. */
function cutAt(text: string): [string, string] {
	let index = -1;
	for (const pattern of [...HISTORY, FOOTER]) {
		const match = pattern.exec(text);
		if (match && match.index > 0 && (index < 0 || match.index < index)) index = match.index;
	}
	return index < 0 ? [text, ""] : [text.slice(0, index), text.slice(index)];
}

/** Confidentiality paragraphs that open a message: [what they said, the rest]. */
function splitLeadFooter(text: string): [string, string] {
	let rest = text;
	const dropped: string[] = [];
	while (FOOTER.exec(rest)?.index === 0) {
		const end = rest.indexOf("\n\n");
		dropped.push(end < 0 ? rest : rest.slice(0, end));
		rest = end < 0 ? "" : rest.slice(end + 2).trim();
	}
	return [dropped.join("\n\n"), rest];
}

export interface MessageParts {
	/** The message's new text (WD-05, NI-08). */
	shown: string;
	/** History and legal footers, behind "Show trimmed text". */
	hidden: string;
}

const partsCache = new WeakMap<Email, MessageParts>();

/** The server's quote split first (`quote.new_text`), then the history and footer cuts. */
export function messageParts(email: Email): MessageParts {
	const cached = partsCache.get(email);
	if (cached) return cached;
	const [lead, full] = splitLeadFooter(tidy(email.text_content));
	const newText = email.quote?.has_quoted ? email.quote.new_text : "";
	const base = newText ? splitLeadFooter(tidy(newText))[1] : full;
	const shown = cutAt(base)[0].trim();
	let rest = cutAt(full)[1].trim();
	if (!rest && newText) rest = full.slice(Math.min(full.length, shown.length)).trim();
	const parts = { shown, hidden: [lead, rest].filter(Boolean).join("\n\n") };
	partsCache.set(email, parts);
	return parts;
}

/** Bulk mail keeps its own HTML; people's mail is set as text in the app's type (NM-15). */
export function isBulk(email: Email, category: EmailCategory | null | undefined): boolean {
	if (!email.html_content) return false;
	const kind = email.category ?? category;
	return (
		kind === "newsletters" ||
		kind === "marketing" ||
		kind === "notifications" ||
		!!email.list_unsubscribe ||
		/no-?reply|receipts?@|invoice\+|stripe\.com$/i.test(parseEmailAddress(email.from_address))
	);
}

/** Paragraphs as HTML: escaped, linked, single line breaks kept. */
export function textToHtml(text: string): string {
	return text
		.split(/\n{2,}/)
		.map(
			(paragraph) =>
				`<p>${escapeHtml(paragraph).replace(/\n/g, "<br>").replace(LINK, linkHtml)}</p>`,
		)
		.join("");
}

const LINK = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"&]/g;
const linkHtml = (url: string) =>
	`<a href="${url}" target="_blank" rel="noopener noreferrer">${url.length > 60 ? `${url.slice(0, 57)}…` : url}</a>`;
const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** One line for a closed box: the new text, else the files it carries. */
export function firstLine(email: Email): string {
	const shown = messageParts(email).shown;
	const text =
		shown ||
		realFiles(email)
			.map((file) => file.filename)
			.join(", ");
	return text.replace(/\s+/g, " ").slice(0, 200);
}

/* ── People ── */

/** Who the thread's people are: names seen in it, and which addresses are this mailbox's. */
export class People {
	private names = new Map<string, string>();
	private mine: Set<string>;

	constructor(
		emails: Email[],
		own: string[],
		participants: { name: string | null; address: string }[] = [],
	) {
		this.mine = new Set(own.map((a) => a.toLowerCase()));
		for (const e of emails) {
			this.mine.add(`${e.mailbox}@${e.domain}`.toLowerCase());
			this.learn(e.from_name, e.from_address);
		}
		for (const p of participants) this.learn(p.name, p.address);
	}

	private learn(name: string | null | undefined, address: string) {
		const key = parseEmailAddress(address).toLowerCase();
		if (!name || /@/.test(name) || this.names.has(key)) return;
		this.names.set(key, name);
	}

	isMe(address: string): boolean {
		return this.mine.has(parseEmailAddress(address).toLowerCase());
	}

	/** "Rivera, Sam" reads "Sam Rivera"; "(via …)" goes; an address with no name keeps parseSenderName's guess. */
	name(address: string, given?: string | null): string {
		const key = parseEmailAddress(address).toLowerCase();
		let name = personName(given ?? "");
		if (!name || /@/.test(name)) name = this.names.get(key) ?? "";
		if (!name) return parseSenderName(address);
		return personName(name);
	}

	/** The sender as a box names them: "me" for this mailbox. */
	sender(email: Email): string {
		return this.isMe(email.from_address) ? "me" : this.name(email.from_address, email.from_name);
	}

	/** "to me, Robin Example, Kai Sample" (and "and 2 more"): the button that reveals the addresses. */
	recipients(email: Email): string {
		const all = [...recipientsOf(email), ...email.cc_addresses];
		const names = all.map((a) => (this.isMe(a) ? "me" : this.name(a)));
		const shown =
			names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
		return `to ${shown || "undisclosed recipients"}`;
	}
}

export const recipientsOf = (email: Email): string[] =>
	email.to_addresses.length > 0 ? email.to_addresses : email.to_address ? [email.to_address] : [];

/* ── The timeline ── */

export type TimelineItem =
	| { kind: "message"; email: Email }
	| { kind: "stack"; key: "earlier" | "middle"; emails: Email[] };

/**
 * A split-off earlier conversation folds into one stack at the top. Own messages: four or fewer
 * all show; more show the first, a stack of the middle, and the last three. `open` holds the
 * stacks unfolded by hand.
 */
export function timelinePlan(
	own: Email[],
	earlier: Email[],
	open: ReadonlySet<string>,
): TimelineItem[] {
	const out: TimelineItem[] = [];
	const single = (email: Email) => out.push({ kind: "message", email });
	if (earlier.length > 0) {
		if (open.has("earlier")) earlier.forEach(single);
		else out.push({ kind: "stack", key: "earlier", emails: earlier });
	}
	if (own.length <= 4) {
		own.forEach(single);
		return out;
	}
	single(own[0]);
	const middle = own.slice(1, -3);
	if (open.has("middle") || middle.length < 2) middle.forEach(single);
	else out.push({ kind: "stack", key: "middle", emails: middle });
	own.slice(-3).forEach(single);
	return out;
}

/** "Re: Fwd: Project notes" and "project notes" are one subject. */
export function normalizeSubject(subject: string | null | undefined): string {
	return String(subject ?? "")
		.replace(/^\s*((re|fw|fwd|aw|sv|wg)\s*(\[\d+\])?\s*:\s*)+/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/* ── Dates (the viewer's time zone) ── */

const sameDay = (a: Date, b: Date) =>
	a.getFullYear() === b.getFullYear() &&
	a.getMonth() === b.getMonth() &&
	a.getDate() === b.getDate();
const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", options);
const TIME = fmt({ hour: "numeric", minute: "2-digit" });
const MONTH_DAY = fmt({ month: "short", day: "numeric" });
const MONTH_DAY_YEAR = fmt({ month: "short", day: "numeric", year: "numeric" });
const FULL = fmt({
	weekday: "short",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
const FULL_YEAR = fmt({
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

export const messageTime = (email: Email) => email.sent_at ?? email.received_at;

/** A closed box: 5:02 PM today, Yesterday, Oct 22, or Oct 22, 2025. */
export function shortDate(ms: number): string {
	const date = new Date(ms);
	const now = new Date();
	if (sameDay(date, now)) return TIME.format(date);
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (sameDay(date, yesterday)) return "Yesterday";
	return date.getFullYear() === now.getFullYear()
		? MONTH_DAY.format(date)
		: MONTH_DAY_YEAR.format(date);
}

/** An open box: Thu, Oct 22, 5:02 PM (with the year when it isn't this year). */
export function fullDate(ms: number): string {
	const date = new Date(ms);
	return date.getFullYear() === new Date().getFullYear()
		? FULL.format(date)
		: FULL_YEAR.format(date);
}

export const monthDay = (ms: number) => MONTH_DAY.format(new Date(ms));
