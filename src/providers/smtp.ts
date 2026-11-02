import type { SendEmailRequest, SendEmailResponse } from "@/types";
import { encodeBytesToBase64 } from "@/utils/attachments";
import { type EmailProvider, EmailProviderError, type SmtpAccountConfig } from "./types";

function normalizeAddressList(value?: string | string[]): string[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
}

/** Extract bare email from "Name <email>" or plain "email" format */
function extractBareEmail(address: string): string {
	const match = address.match(/<([^>]+)>/);
	return match ? match[1] : address.trim();
}

/**
 * Encode a string to base64. btoa() alone throws on any code point above
 * U+00FF, so UTF-8 the string first — otherwise a single em-dash in a subject
 * or body takes the whole send down with a 500.
 */
function b64(str: string): string {
	return encodeBytesToBase64(new TextEncoder().encode(str));
}

/** RFC 2045: base64 bodies travel in lines of at most 76 characters */
function wrapBase64(encoded: string): string {
	return (encoded.match(/.{1,76}/g) ?? []).join("\r\n");
}

function isAsciiPrintable(value: string): boolean {
	return /^[\x20-\x7e]*$/.test(value);
}

// RFC 2047: an encoded-word is at most 75 chars including delimiters, and
// base64 expands every 3 source bytes to 4 output characters.
const ENCODED_WORD_MAX_BYTES = Math.floor((75 - "=?UTF-8?B??=".length) / 4) * 3;

/**
 * RFC 2047 encoded-word for a header value. Headers are ASCII-only on the
 * wire, so a raw UTF-8 subject arrives as mojibake even where it doesn't crash
 * the encoder. Chunking iterates code points rather than bytes so multi-byte
 * characters are never split across an encoded-word boundary.
 */
function encodeHeaderValue(value: string): string {
	if (!value) return "";
	if (isAsciiPrintable(value)) return value;

	const encoder = new TextEncoder();
	const words: string[] = [];
	let chunk: number[] = [];

	const flush = () => {
		if (chunk.length === 0) return;
		words.push(`=?UTF-8?B?${encodeBytesToBase64(Uint8Array.from(chunk))}?=`);
		chunk = [];
	};

	for (const char of value) {
		const bytes = encoder.encode(char);
		if (chunk.length + bytes.length > ENCODED_WORD_MAX_BYTES) flush();
		chunk.push(...bytes);
	}
	flush();

	// Fold continuations with CRLF + a single space (RFC 5322 §2.2.3)
	return words.join("\r\n ");
}

/** Encode the display name of "Name <email>", leaving the addr-spec bare */
function encodeAddress(address: string): string {
	const match = address.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
	if (!match) return address.trim();

	const email = match[2].trim();
	const name = match[1].replace(/^"(.*)"$/, "$1");
	if (!name) return `<${email}>`;
	if (!isAsciiPrintable(name)) return `${encodeHeaderValue(name)} <${email}>`;

	// A bare display name may not contain RFC 5322 specials — quote if it does
	return /[()<>@,;:\\".[\]]/.test(name)
		? `"${name.replace(/(["\\])/g, "\\$1")}" <${email}>`
		: `${name} <${email}>`;
}

/** Header values are single-line; fold chars would otherwise inject headers */
function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

/** Attachment metadata reaches part headers; it may come from inbound mail, so no control chars. */
function stripControlChars(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		out += code < 0x20 || code === 0x7f ? " " : ch;
	}
	return out.trim();
}

/** RFC 5322 field name: printable ASCII except ":" (no space, no CR/LF). */
const HEADER_NAME = /^[!-9;-~]+$/;

/** RFC 5321 §4.5.2: a line of DATA that starts with "." gets one more. */
export function dotStuff(message: string): string {
	return message.replace(/(^|\r\n)\./g, "$1..");
}

/** Generate a unique Message-ID */
function generateMessageId(domain: string): string {
	const random = crypto.randomUUID().replace(/-/g, "");
	return `<${random}@${domain}>`;
}

/** Build an RFC 5322 message from the send request */
export function buildMimeMessage(request: SendEmailRequest, messageId: string): string {
	const to = normalizeAddressList(request.to);
	const cc = normalizeAddressList(request.cc);
	const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, "")}`;
	const hasHtml = Boolean(request.html);
	const hasText = Boolean(request.text);
	const hasAttachments = Boolean(request.attachments?.length);

	const lines: string[] = [];
	lines.push(`From: ${encodeAddress(request.from)}`);
	lines.push(`To: ${to.map(encodeAddress).join(", ")}`);
	if (cc.length > 0) lines.push(`Cc: ${cc.map(encodeAddress).join(", ")}`);
	const replyTo = normalizeAddressList(request.reply_to);
	if (replyTo.length > 0) lines.push(`Reply-To: ${replyTo.map(encodeAddress).join(", ")}`);
	lines.push(`Subject: ${encodeHeaderValue(request.subject || "")}`);
	lines.push(`Date: ${new Date().toUTCString()}`);
	lines.push(`Message-ID: ${messageId}`);
	lines.push("MIME-Version: 1.0");

	// Custom headers (In-Reply-To, References, etc.)
	if (request.headers) {
		for (const [name, value] of Object.entries(request.headers)) {
			if (name && value && HEADER_NAME.test(name))
				lines.push(`${name}: ${sanitizeHeaderValue(value)}`);
		}
	}

	if (hasAttachments) {
		// Multipart mixed (body + attachments)
		lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		lines.push("");

		// Body part
		lines.push(`--${boundary}`);
		if (hasHtml && hasText) {
			const altBoundary = `----=_Alt_${crypto.randomUUID().replace(/-/g, "")}`;
			lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
			lines.push("");
			lines.push(`--${altBoundary}`);
			lines.push("Content-Type: text/plain; charset=utf-8");
			lines.push("Content-Transfer-Encoding: base64");
			lines.push("");
			lines.push(wrapBase64(b64(request.text!)));
			lines.push(`--${altBoundary}`);
			lines.push("Content-Type: text/html; charset=utf-8");
			lines.push("Content-Transfer-Encoding: base64");
			lines.push("");
			lines.push(wrapBase64(b64(request.html!)));
			lines.push(`--${altBoundary}--`);
		} else if (hasHtml) {
			lines.push("Content-Type: text/html; charset=utf-8");
			lines.push("Content-Transfer-Encoding: base64");
			lines.push("");
			lines.push(wrapBase64(b64(request.html!)));
		} else {
			lines.push("Content-Type: text/plain; charset=utf-8");
			lines.push("Content-Transfer-Encoding: base64");
			lines.push("");
			lines.push(wrapBase64(b64(request.text || "")));
		}

		// Attachment parts
		for (const att of request.attachments!) {
			// Encoded-word in a filename param isn't strictly RFC 2231, but every
			// major client decodes it and it beats emitting raw UTF-8 in a header.
			const filename = encodeHeaderValue(stripControlChars(att.filename)).replace(
				/(["\\])/g,
				"\\$1",
			);
			const contentType = stripControlChars(att.content_type) || "application/octet-stream";
			const disposition = att.disposition === "inline" ? "inline" : "attachment";
			lines.push(`--${boundary}`);
			lines.push(`Content-Type: ${contentType}; name="${filename}"`);
			lines.push("Content-Transfer-Encoding: base64");
			lines.push(`Content-Disposition: ${disposition}; filename="${filename}"`);
			const contentId = att.content_id
				? stripControlChars(att.content_id).replace(/^<|>$/g, "")
				: "";
			if (contentId) lines.push(`Content-ID: <${contentId}>`);
			lines.push("");
			// Callers may hand us one unbroken base64 string; SMTP caps lines at 998
			lines.push(wrapBase64(att.content_base64.replace(/\s+/g, "")));
		}

		lines.push(`--${boundary}--`);
	} else if (hasHtml && hasText) {
		// Multipart alternative (text + html)
		lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		lines.push("");
		lines.push(`--${boundary}`);
		lines.push("Content-Type: text/plain; charset=utf-8");
		lines.push("Content-Transfer-Encoding: base64");
		lines.push("");
		lines.push(b64(request.text!));
		lines.push(`--${boundary}`);
		lines.push("Content-Type: text/html; charset=utf-8");
		lines.push("Content-Transfer-Encoding: base64");
		lines.push("");
		lines.push(wrapBase64(b64(request.html!)));
		lines.push(`--${boundary}--`);
	} else if (hasHtml) {
		lines.push("Content-Type: text/html; charset=utf-8");
		lines.push("Content-Transfer-Encoding: base64");
		lines.push("");
		lines.push(wrapBase64(b64(request.html!)));
	} else {
		lines.push("Content-Type: text/plain; charset=utf-8");
		lines.push("Content-Transfer-Encoding: base64");
		lines.push("");
		lines.push(wrapBase64(b64(request.text || "")));
	}

	return lines.join("\r\n");
}

export class SmtpProvider implements EmailProvider {
	readonly name = "smtp";

	constructor(private config: SmtpAccountConfig) {}

	async send(request: SendEmailRequest): Promise<SendEmailResponse> {
		// A shared provider domain is not authority to send as another Gmail customer.
		if (
			extractBareEmail(request.from).toLowerCase().endsWith("@gmail.com") &&
			(this.config.host !== "smtp.gmail.com" ||
				this.config.port !== 465 ||
				extractBareEmail(request.from).toLowerCase() !== this.config.username.toLowerCase())
		) {
			throw new EmailProviderError("Gmail From must match the configured Gmail SMTP account", {
				status: 403,
				code: "GMAIL_SENDER_MISMATCH",
				definite: true,
			});
		}
		const to = normalizeAddressList(request.to);
		const cc = normalizeAddressList(request.cc);
		const bcc = normalizeAddressList(request.bcc);

		if (to.length === 0) {
			throw new EmailProviderError("At least one recipient is required", {
				status: 400,
				code: "INVALID_RECIPIENTS",
			});
		}

		const allRecipients = [...to, ...cc, ...bcc].map(extractBareEmail);
		const senderDomain = extractBareEmail(request.from).split("@")[1] || "localhost";
		const messageId = generateMessageId(senderDomain);
		const mimeMessage = buildMimeMessage(request, messageId);

		let reply: string;
		try {
			reply = await this.sendViaSMTP(extractBareEmail(request.from), allRecipients, mimeMessage);
		} catch (err) {
			if (err instanceof EmailProviderError) throw err;
			// Only setup (connect, stream readers) throws here, before any dialogue.
			throw new EmailProviderError(err instanceof Error ? err.message : "SMTP send failed", {
				status: 502,
				code: "SMTP_ERROR",
				definite: true,
			});
		}

		return { id: messageId, provider: this.name, response: reply };
	}

	/** Runs the SMTP dialogue; resolves to the server's reply to the end of DATA. */
	private async sendViaSMTP(
		sender: string,
		recipients: string[],
		message: string,
	): Promise<string> {
		const { connect } = await import("cloudflare:sockets");

		// Connect with implicit TLS (port 465)
		const socket = connect(
			{ hostname: this.config.host, port: this.config.port },
			{ secureTransport: "on", allowHalfOpen: false },
		);

		const reader = socket.readable.getReader();
		const writer = socket.writable.getWriter();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const readResponse = async (): Promise<string> => {
			let response = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				response += decoder.decode(value, { stream: true });
				// SMTP responses end with \r\n and multi-line uses "XXX-" prefix
				if (/^\d{3} /m.test(response)) break;
			}
			return response.trim();
		};

		const sendCommand = async (cmd: string): Promise<string> => {
			await writer.write(encoder.encode(`${cmd}\r\n`));
			return readResponse();
		};

		// Which step of the dialogue failed: anything before "DATA end" means the
		// server never took the message. Recorded as send evidence.
		let stage = "greeting";
		const assertOk = (response: string, ...codes: number[]) => {
			const code = Number.parseInt(response.slice(0, 3), 10);
			if (!codes.includes(code)) {
				// A reply that is not the expected one is the server refusing: the
				// message was not taken, even at "data_end" (a 4xx/5xx to the final
				// dot is a rejection). Only no reply at "data_end" is uncertain.
				throw new EmailProviderError(`SMTP error: ${response || "no reply"}`, {
					status: 502,
					code: "SMTP_PROTOCOL_ERROR",
					details: { stage, smtp_code: Number.isNaN(code) ? null : code, reply: response },
					definite: Number.isNaN(code) ? stage !== "data_end" : true,
				});
			}
		};

		try {
			// Read server greeting
			const greeting = await readResponse();
			assertOk(greeting, 220);

			// EHLO
			stage = "ehlo";
			const ehlo = await sendCommand(`EHLO mailclaw`);
			assertOk(ehlo, 250);

			// AUTH LOGIN
			stage = "auth";
			const authStart = await sendCommand("AUTH LOGIN");
			assertOk(authStart, 334);

			const userResp = await sendCommand(b64(this.config.username));
			assertOk(userResp, 334);

			const passResp = await sendCommand(b64(this.config.password));
			assertOk(passResp, 235);

			// MAIL FROM
			stage = "mail_from";
			const mailFrom = await sendCommand(`MAIL FROM:<${sender}>`);
			assertOk(mailFrom, 250);

			// RCPT TO (each recipient)
			stage = "rcpt_to";
			for (const rcpt of recipients) {
				const rcptTo = await sendCommand(`RCPT TO:<${rcpt}>`);
				assertOk(rcptTo, 250, 251);
			}

			// DATA
			stage = "data";
			const dataResp = await sendCommand("DATA");
			assertOk(dataResp, 354);

			// Send message body (end with \r\n.\r\n)
			stage = "data_end";
			await writer.write(encoder.encode(`${dotStuff(message)}\r\n.\r\n`));
			const sendResp = await readResponse();
			assertOk(sendResp, 250);

			// QUIT
			await sendCommand("QUIT").catch(() => {}); // Don't fail on quit
			return sendResp;
		} catch (err) {
			if (err instanceof EmailProviderError) throw err;
			// Socket/TLS failure. Before the final dot the server cannot have
			// taken the message; from then on it may have.
			throw new EmailProviderError(err instanceof Error ? err.message : "SMTP send failed", {
				status: 502,
				code: "SMTP_ERROR",
				details: { stage },
				definite: stage !== "data_end",
			});
		} finally {
			reader.releaseLock();
			writer.releaseLock();
			socket.close().catch(() => {});
		}
	}
}
