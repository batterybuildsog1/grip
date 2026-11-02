/** Literal invitation subjects become a plain action; no model call, inference or AI consent required. */
import { normalizeActionNote } from "@/database/notes";
import { isVerificationCode } from "@/services/code-note";

export function invitationNote(subject: string | null, from: string): string | null {
	const words = subject?.replace(/\s+/g, " ").trim();
	if (!words || isVerificationCode(words)) return null;
	if (/\b(?:accepted|declined|cancell?ed|expired|revoked)\b/i.test(words)) return null;
	let note: string | null = null;
	const test = /^(?:you(?:'|’)re|you are) invited to test\s+(.+?)[.!]?$/i.exec(words);
	if (test && /^(?:no_reply|noreply)@email\.apple\.com$/i.test(from)) {
		note = `Accept the TestFlight invite for ${test[1]}.`;
	} else if (
		/\b(?:invited you to|you(?:'|’)re invited to|you are invited to|invitation to (?:join|access)|join .+ (?:team|workspace)|(?:team|workspace|account|app) invitation)\b/i.test(
			words,
		)
	) {
		note = `Accept the invite: ${words.replace(/[.!]+$/, "")}.`;
	}
	return normalizeActionNote(note, null).note;
}

/** First note wins, including completed notes. Category guard also fences late results. */
export async function ensureInvitationNote(db: D1Database, emailId: string): Promise<void> {
	const row = await db
		.prepare(
			"SELECT subject, from_address FROM emails WHERE id = ? AND category = 'notifications' AND action_note IS NULL AND action_done_at IS NULL",
		)
		.bind(emailId)
		.first<{ subject: string | null; from_address: string }>();
	if (!row) return;
	const note = invitationNote(row.subject, row.from_address);
	if (!note) return;
	await db
		.prepare(`UPDATE emails SET action_note = ?, action_due = NULL
		WHERE id = ? AND category = 'notifications' AND action_note IS NULL AND action_done_at IS NULL`)
		.bind(note, emailId)
		.run();
}
