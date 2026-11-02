import { convert } from "html-to-text";
import type { Email } from "@/types";

// Server-side twin of the UI's reply rules (ui/src/utils/reply-format.ts
// buildReplyRecipients / withCanonicalSubjectPrefix and the reply identity
// block in ComposeWindow.tsx). The UI cannot import worker code, so keep the
// two in step when either changes.

const MAX_REFERENCES_LENGTH = 3990;
const MAX_QUOTED_TEXT_LENGTH = 20_000;

export interface ReplyOptions {
	text?: string;
	html?: string;
	all?: boolean;
	from?: string;
	cc?: string[];
	bcc?: string[];
	quote?: boolean;
}

export interface ComposedReply {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	in_reply_to: string | null;
	references: string | null;
	text: string | undefined;
	html: string | undefined;
	warnings: string[];
}

export type ReplyResult =
	| { ok: true; reply: ComposedReply }
	| { ok: false; code: "FROM_REQUIRED" | "NO_RECIPIENTS"; message: string };

function domainOf(address: string): string {
	return address.split("@")[1]?.trim().toLowerCase() ?? "";
}

function dedupe(values: Array<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const address = value?.trim();
		if (!address) continue;
		const key = address.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(address);
	}
	return result;
}

export function withReplySubject(subject: string | null | undefined): string {
	let stripped = subject?.trim() ?? "";
	const prefixPattern = /^(?:re|fwd|fw|forward)(?:\[\d+\])?:\s*/i;
	while (prefixPattern.test(stripped)) {
		stripped = stripped.replace(prefixPattern, "").trimStart();
	}
	return stripped ? `Re: ${stripped}` : "Re:";
}

function buildReferences(original: Email): string | null {
	if (!original.message_id) return null;
	const tokens = `${original.references_header ?? ""} ${original.message_id}`.match(/<[^<>\s]+>/g);
	if (!tokens) return null;
	const unique = dedupe(tokens);
	// RFC 5322 keeps the first (thread root) and the most recent ids; drop the
	// oldest middle entries until the header fits the draft column limit.
	while (unique.length > 2 && unique.join(" ").length > MAX_REFERENCES_LENGTH) {
		unique.splice(1, 1);
	}
	return unique.join(" ");
}

function htmlToText(html: string): string {
	try {
		return convert(html, {
			wordwrap: false,
			selectors: [
				{ selector: "img", format: "skip" },
				{ selector: "a", options: { ignoreHref: true } },
			],
		});
	} catch {
		return "";
	}
}

function originalPlainText(original: Email): string {
	if (original.text_content?.trim()) return original.text_content;
	return original.html_content ? htmlToText(original.html_content) : "";
}

/** The whole original, as Gmail quotes it, within the size cap. */
function quoteText(text: string): string {
	const kept = text.replace(/\r\n?/g, "\n").trim();
	return kept.length > MAX_QUOTED_TEXT_LENGTH
		? `${kept.slice(0, MAX_QUOTED_TEXT_LENGTH)}\n[…]`
		: kept;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function attribution(original: Email): string {
	const at = original.sent_at ?? original.received_at;
	const date = new Date(at < 1e11 ? at * 1000 : at).toUTCString();
	const sender = original.from_name?.trim()
		? `${original.from_name.trim()} <${original.from_address}>`
		: original.from_address;
	return `On ${date}, ${sender} wrote:`;
}

/**
 * Compose a reply to `original`.
 *
 * `identities` are the caller's own addresses (ALLOWED_SENDERS, the same list
 * the UI offers as From options); they and the chosen From are never
 * recipients. `sendDomains` are the domains the caller may send from.
 */
export function composeReply(
	original: Email,
	scope: { identities: string[]; sendDomains: string[] },
	options: ReplyOptions,
): ReplyResult {
	const identities = new Set(scope.identities.map((address) => address.trim().toLowerCase()));
	const sendDomains = new Set(scope.sendDomains.map((domain) => domain.toLowerCase()));
	const inSendDomain = (address: string) =>
		sendDomains.size === 0 || sendDomains.has(domainOf(address));

	let from = options.from?.trim() || "";
	if (!from) {
		if (original.direction === "outbound") {
			from = original.from_address;
		} else {
			// Inbound: reply from the account that received it. to_address is the
			// envelope recipient (the copy we hold was delivered there), so it
			// wins; then any of our identities in To/Cc.
			const received = [original.to_address, ...original.to_addresses, ...original.cc_addresses]
				.map((address) => address?.trim())
				.filter((address): address is string => Boolean(address));
			from =
				(original.to_address && inSendDomain(original.to_address) ? original.to_address : "") ||
				received.find((address) => identities.has(address.toLowerCase())) ||
				received.find((address) => sendDomains.size > 0 && inSendDomain(address)) ||
				"";
		}
	}
	if (!from) {
		return {
			ok: false,
			code: "FROM_REQUIRED",
			message: "Could not tell which of your addresses received this email. Pass --from.",
		};
	}
	const fromKey = from.toLowerCase();
	const isOwn = (address: string) => {
		const key = address.trim().toLowerCase();
		// Exact identities only, like the UI; a colleague at the same domain
		// stays a recipient.
		return key === fromKey || identities.has(key);
	};

	const originalTo =
		original.to_addresses.length > 0 ? original.to_addresses : [original.to_address];
	const primary =
		original.direction === "outbound"
			? originalTo
			: original.reply_to_addresses.length > 0
				? original.reply_to_addresses
				: [original.from_address];
	const candidates = dedupe([
		...primary,
		...(original.direction !== "outbound" && original.reply_to_addresses.length === 0
			? [original.from_address]
			: []),
		...originalTo,
		...original.cc_addresses,
	]);
	const external = candidates.filter((address) => !isOwn(address));
	// Replying to our own sent mail addressed to ourselves: fall back to the
	// original recipients rather than refusing.
	const to = external[0] ?? primary.find((address) => address.toLowerCase() !== fromKey);
	if (!to) {
		return { ok: false, code: "NO_RECIPIENTS", message: "This email has no one to reply to." };
	}
	const toKey = to.toLowerCase();
	const cc = dedupe([
		...(options.all ? external.filter((address) => address.toLowerCase() !== toKey) : []),
		...(options.cc ?? []),
	]);

	const warnings: string[] = [];
	if (!original.message_id) warnings.push("NO_MESSAGE_ID_THREADING_BY_SUBJECT");

	// The plain-text part must carry the reply itself: an HTML-only reply
	// derives it from the HTML before the quote is appended.
	let text = options.text ?? (options.html ? htmlToText(options.html) : undefined);
	let html = options.html;
	if (options.quote !== false) {
		const quoted = quoteText(originalPlainText(original));
		if (quoted) {
			const header = attribution(original);
			const quotedLines = quoted
				.split("\n")
				.map((line) => (line ? `> ${line}` : ">"))
				.join("\n");
			text = `${text ?? ""}\n\n${header}\n${quotedLines}`.trimStart();
			if (html !== undefined) {
				html =
					`${html}<br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(header)}</div>` +
					`<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">` +
					`${escapeHtml(quoted).replace(/\n/g, "<br>")}</blockquote></div>`;
			}
		}
	}

	return {
		ok: true,
		reply: {
			from,
			to: [to],
			cc,
			bcc: dedupe(options.bcc ?? []),
			subject: withReplySubject(original.subject),
			in_reply_to: original.message_id ?? null,
			references: buildReferences(original),
			text,
			html,
			warnings,
		},
	};
}
