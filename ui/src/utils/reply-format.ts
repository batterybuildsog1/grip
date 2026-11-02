import type { Email } from "../types";
import { plainTextToHtml, sanitizeHtml } from "./sanitize";

export interface DraftQuotePayload {
	html: string;
	text: string;
}

export interface ReplyRecipients {
	to: string;
	cc: string[];
}

interface QuotableContent {
	html: string | null;
	text: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function normalizePlainText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function decodeEntities(value: string): string {
	return value
		.replace(/&#160;|&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'");
}

function htmlToPlainText(html: string): string {
	const withBreaks = html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|div|section|article|header|footer|h[1-6]|table|tr|ul|ol|blockquote)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<\/li>/gi, "")
		.replace(/<[^>]+>/g, "");

	return normalizePlainText(decodeEntities(withBreaks));
}

function formatMailbox(name: string | null | undefined, address: string): string {
	return name?.trim() ? `${name.trim()} <${address}>` : address;
}

export function withCanonicalSubjectPrefix(
	subject: string | null | undefined,
	prefix: "Re" | "Fwd",
): string {
	let stripped = subject?.trim() ?? "";
	const prefixPattern = /^(?:re|fwd|fw|forward)(?:\[\d+\])?:\s*/i;
	while (prefixPattern.test(stripped)) {
		stripped = stripped.replace(prefixPattern, "").trimStart();
	}
	return stripped ? `${prefix}: ${stripped}` : `${prefix}: `;
}

function deduplicateAddresses(values: Array<string | null | undefined>): string[] {
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

export function buildReplyRecipients(email: Email, ownAddresses: string[]): ReplyRecipients {
	const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()));
	const originalTo = email.to_addresses.length > 0 ? email.to_addresses : [email.to_address];
	const primaryCandidates =
		email.direction === "outbound"
			? originalTo
			: email.reply_to_addresses.length > 0
				? email.reply_to_addresses
				: [email.from_address];
	const allCandidates = deduplicateAddresses([
		...primaryCandidates,
		...(email.direction !== "outbound" && email.reply_to_addresses.length === 0
			? [email.from_address]
			: []),
		...originalTo,
		...email.cc_addresses,
	]);
	const external = allCandidates.filter((address) => !own.has(address.toLowerCase()));
	const to = external[0] ?? allCandidates[0] ?? "";
	const toKey = to.toLowerCase();
	return {
		to,
		cc: external.filter((address) => address.toLowerCase() !== toKey),
	};
}

function resolveObservedAt(email: Email): number {
	return email.sent_at ?? email.received_at;
}

export function formatReplyDate(timestamp: number): string {
	const date = new Date(timestamp < 1e11 ? timestamp * 1000 : timestamp);
	const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
	const month = date.toLocaleDateString("en-US", { month: "short" });
	const day = date.getDate();
	const year = date.getFullYear();
	const time = date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
	return `${weekday}, ${month} ${day}, ${year} at ${time}`;
}

/** The whole original, as Gmail quotes it: nothing is trimmed. */
function getQuotableContent(email: Email): QuotableContent {
	const html = email.html_content?.trim() ? sanitizeHtml(email.html_content) : null;
	const text = normalizePlainText(email.text_content || (html ? htmlToPlainText(html) : ""));
	return { html: html || (text ? plainTextToHtml(text) : null), text };
}

/**
 * The quote under a plain-text reply (the composer's "Quoted text", 2026-10-24): an empty line
 * after the answer, then the original quoted with "> ". Without it replies went out with no
 * history at all (m1-17).
 */
export function buildPlainReplyBody(email: Email): string {
	const content = getQuotableContent(email);
	const sender = formatMailbox(email.from_name, email.from_address);
	const attribution = `On ${formatReplyDate(resolveObservedAt(email))}, ${sender} wrote:`;
	const quoted = content.text
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
	return `\n\n${attribution}\n${quoted}`;
}

function joinAddressList(primary: string | null | undefined, extras: string[]): string {
	const values = extras.length > 0 ? extras : primary ? [primary] : [];
	return values.filter(Boolean).join(", ");
}

export function buildForwardDraftPayload(email: Email): DraftQuotePayload {
	const content = getQuotableContent(email);
	const observedAt = formatReplyDate(resolveObservedAt(email));
	const fromLine = formatMailbox(email.from_name, email.from_address);
	const toLine = joinAddressList(email.to_address, email.to_addresses);
	const ccLine = email.cc_addresses.join(", ");
	const subjectLine = email.subject || "";
	const htmlBody = sanitizeHtml(content.html ?? plainTextToHtml(content.text));

	const textLines = [
		"",
		"",
		"---------- Forwarded message ----------",
		`From: ${fromLine}`,
		`Date: ${observedAt}`,
		`Subject: ${subjectLine}`,
		`To: ${toLine}`,
		ccLine ? `Cc: ${ccLine}` : "",
		"",
		content.text,
	].filter((line, index, all) => line !== "" || index >= all.length - 2 || all[index - 1] !== "");

	let headerHtml =
		`<p><br></p><div class="gmail_quote">` +
		`<strong>---------- Forwarded message ----------</strong><br>` +
		`From: <strong>${escapeHtml(fromLine)}</strong><br>` +
		`Date: ${escapeHtml(observedAt)}<br>` +
		`Subject: ${escapeHtml(subjectLine)}<br>` +
		`To: ${escapeHtml(toLine)}<br>`;
	if (ccLine) {
		headerHtml += `Cc: ${escapeHtml(ccLine)}<br>`;
	}
	headerHtml += `<br>${htmlBody}</div>`;

	return {
		text: textLines.join("\n"),
		html: headerHtml,
	};
}
