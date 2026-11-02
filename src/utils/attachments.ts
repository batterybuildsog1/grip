import type { SendEmailAttachment } from "@/types";

export const MAX_DIRECT_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_HOSTED_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Cloudflare Email Service caps the ENTIRE encoded message at 5 MiB, and
 * base64 inflates payloads by 4/3. 3 MiB of raw attachment ≈ 4 MiB encoded,
 * leaving room for the body, headers and MIME framing under the provider's
 * 4.5 MiB wire-size preflight.
 */
export const MAX_DIRECT_ATTACHMENT_BYTES_CLOUDFLARE = 3 * 1024 * 1024;

/**
 * Largest attachment payload a given provider can carry inline. Anything
 * above this is staged to R2 and sent as a signed hosted link instead —
 * the fallback that already exists, just triggered earlier for Cloudflare.
 */
export function getDirectAttachmentLimit(providerName: string): number {
	return providerName === "cloudflare"
		? MAX_DIRECT_ATTACHMENT_BYTES_CLOUDFLARE
		: MAX_DIRECT_ATTACHMENT_BYTES;
}

function normalizeBase64(value: string): string {
	return value.replace(/\s+/g, "");
}

function getBase64ByteLength(value: string): number {
	const normalized = normalizeBase64(value);
	if (normalized.length === 0) return 0;

	const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
	return Math.floor((normalized.length * 3) / 4) - padding;
}

/**
 * Base64-encode raw bytes in 32 KiB chunks. A per-byte string build makes one
 * string node per byte, which ran a 13.9 MiB attachment out of Worker memory
 * (sender-identity E2E A2, 2026-10-01); chunks also stay under the call
 * argument limit.
 */
export function encodeBytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function decodeBase64ToBytes(value: string): Uint8Array {
	const normalized = normalizeBase64(value);
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);

	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	return bytes;
}

export function getAttachmentByteLength(attachment: SendEmailAttachment): number {
	return getBase64ByteLength(attachment.content_base64);
}

export function getAttachmentsTotalBytes(attachments: SendEmailAttachment[] = []): number {
	return attachments.reduce((total, attachment) => total + getAttachmentByteLength(attachment), 0);
}

/**
 * Mime types the local extraction pipeline can pull text out of (v34
 * attachment search). Newly ingested attachment rows with one of these are
 * marked extract_status='pending'; everything else 'skipped:type'.
 */
const EXTRACTABLE_MIME_TYPES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
	"application/msword", // .doc
	"application/rtf",
	"text/rtf",
	"text/plain",
	"text/csv",
	"application/csv",
]);

const EXTRACTABLE_EXTENSIONS = new Set(["pdf", "docx", "doc", "rtf", "txt", "csv"]);

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export function resolveAttachmentExtractStatus(
	mimeType: string | null | undefined,
	filename: string | null | undefined,
): "pending" | "skipped:type" {
	const mime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
	if (EXTRACTABLE_MIME_TYPES.has(mime)) return "pending";
	// Mailers routinely send PDFs/doc files as octet-stream — fall back to the
	// filename extension when the mime type carries no information.
	if (GENERIC_MIME_TYPES.has(mime)) {
		const extension = (filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
		if (extension && EXTRACTABLE_EXTENSIONS.has(extension)) return "pending";
	}
	return "skipped:type";
}

/**
 * Types a browser can show inline without running sender-controlled script. Everything else
 * (HTML, SVG, XML, unknown) is forced to download: attachments are served from the app's own
 * origin, where script would act with the user's session.
 */
const PASSIVE_INLINE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/avif",
	"image/heic",
	"image/heif",
	"application/pdf",
	"text/plain",
]);

function isPassiveInlineType(mimeType: string): boolean {
	return (
		PASSIVE_INLINE_TYPES.has(mimeType) ||
		mimeType.startsWith("audio/") ||
		mimeType.startsWith("video/")
	);
}

/** Response headers for serving a stored attachment (authenticated route and signed public link). */
export function attachmentResponseHeaders(attachment: {
	mimeType: string | null | undefined;
	filename: string | null | undefined;
	inline?: boolean;
}): Headers {
	const contentType = attachment.mimeType || "application/octet-stream";
	const essence = contentType.split(";")[0].trim().toLowerCase();
	const filename = attachment.filename || "attachment";
	// RFC 6266: an ASCII fallback (header values must be Latin-1) plus the UTF-8 name.
	const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const disposition = attachment.inline && isPassiveInlineType(essence) ? "inline" : "attachment";

	const headers = new Headers();
	headers.set("Content-Type", contentType);
	headers.set(
		"Content-Disposition",
		`${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
	);
	headers.set("Cache-Control", "private, no-store");
	headers.set("X-Content-Type-Options", "nosniff");
	// No script in an attachment document, even if a browser renders one. PDF is left out:
	// Chrome's PDF viewer refuses to load in a sandboxed document.
	if (essence !== "application/pdf") headers.set("Content-Security-Policy", "sandbox");
	return headers;
}
