/**
 * Phase 5: RFC 5545 calendar file (ICS) generation for email → calendar
 * integration. Called when the user wants to turn a kept-unread email into
 * a scheduled reminder.
 *
 * Minimal generator — no recurrence, no attendees. VEVENT only. The event
 * description includes the email subject + a truncated preview + a deep
 * link back to the email in MailClaw so the user can jump straight in
 * when the reminder fires.
 */

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function formatUtc(ms: number): string {
	const d = new Date(ms);
	return (
		`${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T` +
		`${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
	);
}

/**
 * Escape a value for ICS text fields per RFC 5545 §3.3.11.
 * Commas, semicolons, backslashes, and newlines need escaping.
 */
function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}

/**
 * Fold long lines per RFC 5545 §3.1 (no line > 75 octets; continuation
 * lines start with a space). Naïve by-char split — good enough for our
 * short descriptions.
 */
function foldIcsLine(line: string): string {
	if (line.length <= 75) return line;
	const chunks: string[] = [];
	let i = 0;
	chunks.push(line.slice(0, 75));
	i = 75;
	while (i < line.length) {
		chunks.push(` ${line.slice(i, i + 74)}`);
		i += 74;
	}
	return chunks.join("\r\n");
}

export interface BuildIcsInput {
	/** Stable unique id for the event — we reuse the email id. */
	uid: string;
	/** Short summary — the email subject. */
	summary: string;
	/** Long-form description (email snippet, link back to MailClaw). */
	description: string;
	/** Milliseconds since epoch for the reminder start. */
	startsAtMs: number;
	/** Duration in minutes. Defaults to 30. */
	durationMinutes?: number;
	/** Optional URL the calendar client can open — deep link to the email. */
	url?: string;
}

export function buildEmailReminderIcs(input: BuildIcsInput): string {
	const duration = input.durationMinutes ?? 30;
	const endsAtMs = input.startsAtMs + duration * 60 * 1000;
	const nowMs = Date.now();

	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//MailClaw//Email Reminder 1.0//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"BEGIN:VEVENT",
		`UID:${escapeIcsText(input.uid)}@mailclaw`,
		`DTSTAMP:${formatUtc(nowMs)}`,
		`DTSTART:${formatUtc(input.startsAtMs)}`,
		`DTEND:${formatUtc(endsAtMs)}`,
		foldIcsLine(`SUMMARY:${escapeIcsText(input.summary)}`),
		foldIcsLine(`DESCRIPTION:${escapeIcsText(input.description)}`),
	];
	if (input.url) {
		lines.push(foldIcsLine(`URL:${escapeIcsText(input.url)}`));
	}
	lines.push("STATUS:CONFIRMED");
	lines.push("TRANSP:OPAQUE");
	lines.push("END:VEVENT");
	lines.push("END:VCALENDAR");

	// ICS files use CRLF line endings.
	return `${lines.join("\r\n")}\r\n`;
}

/**
 * Default reminder time: tomorrow at 16:00 UTC (the server has no user time
 * zone). Callers can pass an explicit startsAtMs when the user picks a time.
 */
export function defaultReminderStart(nowMs: number = Date.now()): number {
	const d = new Date(nowMs);
	d.setUTCDate(d.getUTCDate() + 1);
	d.setUTCHours(16, 0, 0, 0);
	return d.getTime();
}

/**
 * Safe URL origin parse — returns null on bad input instead of throwing.
 * Used when resolving the correct UI origin for deep-links.
 */
export function safeOrigin(urlish: string): string | null {
	try {
		return new URL(urlish).origin;
	} catch {
		return null;
	}
}
