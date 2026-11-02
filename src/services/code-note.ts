/**
 * Verification, sign-in, 2FA and activation codes by email become a short-lived Needs-you note
 * (owner decision, 2026-10-30). Literal words, no model call and no AI consent: it works before
 * and whatever the sorter files the mail under. The note names the sender, never the code; the
 * mail holds it.
 *
 * Near misses it must leave alone: news about a code setting ("Two-step codes turned on for your
 * account") and sign-in alerts with nothing to type ("New sign-in to your account").
 */
import { normalizeActionNote } from "@/database/notes";
import type { EmailRecord } from "@/types";

/**
 * A code is usually dead within minutes, and most are opened right away. The note leaves Needs you
 * an hour after the mail arrives: long enough to find a code opened late, short enough that they
 * never pile up.
 */
export const CODE_NOTE_TTL_MS = 60 * 60 * 1000;

const KIND = `(?:verification|verify|security|sign[ -]?in|log[ -]?in|login|one[ -]?time|single[ -]?use|authentication|access|activation|2fa|mfa|two[ -]?(?:factor|step))`;
/** Words before "code" that make it something else: a product, an offer, a booking, a parcel. */
const NOT_A_CODE = `(?:claude|vs|t3|studio|source|qr|zip|postal|promo|promotional|discount|coupon|gift|referral|reward|rewards|offer|bonus|voucher|redemption|tracking|booking|reservation|order|invite|invitation|dress|tax|error|status|sale|exclusive)`;

const SUBJECT_CODE: RegExp[] = [
	// "Your Example Pay verification code", "Example Portal login code", "Sign In Code (…)"
	new RegExp(String.raw`\b${KIND}\s+(?:code|pin|passcode)s?\b`, "i"),
	/\b(?:passcode|one[ -]?time password|temporary password|otp)\b/i,
	// "Your confirmation code is 123456", "Example sign-in code: 123-456"
	/\bcode\s*(?:is\b|:)\s*[A-Z]*\d/i,
	// "1234 is your verification code"
	/^\s*\d[\d -]{2,8}\s+is your\b/i,
	// "Your Example code", "Your single-use code", "Your example wallet activation code"
	new RegExp(
		String.raw`\byour\s+(?:(?!${NOT_A_CODE}\s)[\w&.'’-]+\s+){0,3}code\s*(?:$|[-–—:.!(]|is\b|for\b|to\b)`,
		"i",
	),
	// "Portal code"
	new RegExp(String.raw`^\s*(?:(?!${NOT_A_CODE}\s)[\w&.'’-]+\s+){1,2}code\s*$`, "i"),
	// "Verify your account: 123456", "123456 - Verification", "Use code 1234 … verify email"
	/^(?=.*\b(?:verif\w*|confirm\w*|sign[ -]?in|log[ -]?in|login)\b)(?=.*(?:\b\d{6,8}\b|\b\d{3}-\d{3}\b|\bcode\b))/i,
];
/** A code that was set up, turned on or off: news about the account, nothing to type. */
const SETTING_CHANGED =
	/\b(?:set up|setup|enabled|disabled|turned (?:on|off)|now (?:on|off|active)|activated|deactivated|added|removed)\b/i;
/** Asked for in the subject, sent in the body: "[Example] Please verify your device". */
const SUBJECT_ASKS =
	/\b(?:verif\w*|confirm\w*|sign[ -]?in|log[ -]?in|login|device|security|authenticat\w*|2fa|mfa|two[ -]?(?:factor|step)|activat\w*)\b/i;
const BODY_CODE =
	/\b(?:code|passcode|pin|otp)\b(?:\s*(?:is\b|:)\s*(?:\d{4,8}\b|\d{3}[- ]\d{3}\b)|[^\n\d]{0,30}?\b(?:\d{6,8}|\d{3}[- ]\d{3})\b)/i;

/** Whether this mail carries a one-time code for the reader to type. Body only for non-bulk mail. */
export function isVerificationCode(
	subject: string | null,
	text?: string | null,
	bulk = false,
): boolean {
	const words = subject?.replace(/\s+/g, " ").trim() ?? "";
	// A forward or a reply is a person passing something on, never the code's own message.
	if (/^(?:re|fw|fwd|aw|wg)\s*:/i.test(words) || SETTING_CHANGED.test(words)) return false;
	if (SUBJECT_CODE.some((pattern) => pattern.test(words))) return true;
	if (bulk || !text || !SUBJECT_ASKS.test(words)) return false;
	return BODY_CODE.test(text.slice(0, 4000));
}

/** "Verification code from Example Bank": the sender, never the code. */
export function codeNote(subject: string | null, fromName: string | null, from: string): string {
	const words = subject ?? "";
	const kind = /activat/i.test(words)
		? "Activation code"
		: /sign[ -]?in|log[ -]?in|login/i.test(words)
			? "Sign-in code"
			: "Verification code";
	const name =
		fromName?.replace(/["“”]/g, "").replace(/\s+/g, " ").trim() ||
		(from.split("@")[1] ?? from).replace(
			/^(?:mail|email|e|notify|notifications|messaging|info|accounts?)\./i,
			"",
		);
	return normalizeActionNote(`${kind} from ${name.slice(0, 80)}`, null).note ?? kind;
}

/**
 * New live inbound mail only (ingest's gate). First note wins: an agent's or the sorter's note on
 * the same email stays. The note expires CODE_NOTE_TTL_MS after the mail arrived.
 */
export async function ensureCodeNote(
	db: D1Database,
	email: Pick<
		EmailRecord,
		| "id"
		| "subject"
		| "from_name"
		| "from_address"
		| "text_content"
		| "list_unsubscribe"
		| "received_at"
	>,
): Promise<boolean> {
	const bulk = !!email.list_unsubscribe?.trim();
	if (!isVerificationCode(email.subject, email.text_content, bulk)) return false;
	const note = codeNote(email.subject ?? null, email.from_name ?? null, email.from_address);
	const { meta } = await db
		.prepare(
			`UPDATE emails SET action_note = ?, action_due = NULL, action_expires_at = ?
			 WHERE id = ? AND action_note IS NULL AND action_done_at IS NULL`,
		)
		.bind(note, email.received_at + CODE_NOTE_TTL_MS, email.id)
		.run();
	return (meta?.changes ?? 0) > 0;
}
