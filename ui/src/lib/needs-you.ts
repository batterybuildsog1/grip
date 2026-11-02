import type { ActionNote } from "../types";

/**
 * Needs you: the open notes (GET /api/notes) as jobs, grouped and ranked on the client
 * (design r2 §4 S1; audit WD-01/WP-01/NI-01: twelve notes buried the inbox).
 *
 * A job is one sender's notes, or every bounce about the same address (12 notes became 7).
 * Rank: urgent (log in, password, new device, security) → due within 14 days → recent →
 * due later → bounces of MailClaw's own test sends.
 */
export interface Job {
	/** The group key: a sender address, or "bounce|<address>". */
	id: string;
	/** Newest first. */
	notes: ActionNote[];
	/** The fullest note of the group, as a sentence. */
	text: string;
	/** "Example Agency", or "Example Agency · 2 emails" / "Mail Delivery Subsystem · 3 bounces". */
	source: string;
	/** Soonest due date of the group (YYYY-MM-DD). */
	due: string | null;
	urgent: boolean;
	/** The note to open: the fullest one. */
	lead: ActionNote;
	/** Newest note's received_at. */
	at: number;
	rank: number;
}

const URGENT = /log ?in|password|new device|sign-?in|security/i;
const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const BOUNCER = /mailer-daemon|postmaster|mail delivery subsystem/i;
/** Bounces of MailClaw's own E2E sends (e2e-…@, test-…@): nothing to do, ranked last. */
const TEST_TARGET = /^(e2e|test)[\w.+-]*@/i;
const DAY_MS = 86_400_000;

const isBounce = (note: ActionNote) =>
	BOUNCER.test(note.from.address) || BOUNCER.test(note.from.name ?? "");

/** Whole days from today (local date) to a YYYY-MM-DD due date; negative when overdue. */
export function daysUntil(due: string, now = Date.now()): number {
	const today = new Date(now);
	const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
	return Math.round((Date.parse(`${due}T00:00:00Z`) - start) / DAY_MS);
}

export function buildJobs(notes: ActionNote[], now = Date.now()): Job[] {
	const groups = new Map<string, ActionNote[]>();
	for (const note of notes) {
		const target = isBounce(note) ? (note.note.match(ADDRESS)?.[0] ?? "").toLowerCase() : "";
		const key = target ? `bounce|${target}` : note.from.address.toLowerCase();
		const group = groups.get(key);
		if (group) group.push(note);
		else groups.set(key, [note]);
	}
	const jobs: Job[] = [];
	for (const [id, list] of groups) {
		list.sort((a, b) => b.received_at - a.received_at);
		const lead = [...list].sort((a, b) => b.note.length - a.note.length)[0];
		const due =
			list
				.map((n) => n.due)
				.filter((d): d is string => !!d)
				.sort()[0] ?? null;
		const urgent = URGENT.test(list.map((n) => `${n.note} ${n.subject ?? ""}`).join(" "));
		const bounce = id.startsWith("bounce|");
		const test = bounce && TEST_TARGET.test(id.slice("bounce|".length));
		const days = due ? daysUntil(due, now) : null;
		let rank = 2 + (now - list[0].received_at) / 1e12;
		if (urgent) rank = 0;
		else if (days !== null && days <= 14) rank = 1 + days / 1000;
		else if (days !== null) rank = 3 + days / 1e6;
		if (test) rank = 4;
		const sender = lead.from.name || lead.from.address;
		const more = list.length > 1 ? ` · ${list.length} ${bounce ? "bounces" : "emails"}` : "";
		jobs.push({
			id,
			notes: list,
			text: lead.note.trim().replace(/\s*[.!?]?$/, (end) => (end.trim() ? end.trim() : ".")),
			source: `${sender}${more}`,
			due,
			urgent,
			lead,
			at: list[0].received_at,
			rank,
		});
	}
	return jobs.sort((a, b) => a.rank - b.rank);
}

const dueFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

/**
 * The due date in words against today (design-taste X5): "Overdue since yesterday", "Overdue since
 * Oct 20", "Due today", "Due tomorrow", "Due Nov 13". The due date is a calendar date, so it is
 * read in UTC.
 */
export function dueLabel(due: string, now = Date.now()): string {
	const days = daysUntil(due, now);
	const date = dueFormat.format(Date.parse(`${due}T12:00:00Z`));
	if (days === -1) return "Overdue since yesterday";
	if (days < -1) return `Overdue since ${date}`;
	if (days === 0) return "Due today";
	if (days === 1) return "Due tomorrow";
	return `Due ${date}`;
}
