import type { Email, EmailAttachment } from "../types";

/** Images a sender embeds (signature logos, Outlook's image001.png): shown in the mail, not files. */
const EMBEDDED_IMAGE_TYPE = /^image\/(png|jpe?g|gif)$/i;
const EMBEDDED_IMAGE_NAME = /^(image|outlook)[-_]?\d*\.(png|jpe?g|gif)$/i;

/**
 * The attachments a person would call files: not the images the HTML shows inline, not signature
 * logos, and one card per name and size (round-2 spec S3, the prototype's isRealFile).
 */
export function realFiles(email: Email): EmailAttachment[] {
	const seen = new Set<string>();
	return email.attachments.filter((a) => {
		if (a.disposition === "inline" && a.content_id) return false;
		if (
			EMBEDDED_IMAGE_TYPE.test(a.mime_type) &&
			(a.content_id || EMBEDDED_IMAGE_NAME.test(a.filename ?? ""))
		) {
			return false;
		}
		const key = `${a.filename ?? ""}|${a.size}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Flagged as having attachments but none stored: an older import kept only the count. */
export function missingFileCount(email: Email): number {
	if (email.attachments.length > 0) return 0;
	if (email.attachment_count > 0) return email.attachment_count;
	return email.has_attachments ? 1 : 0;
}

const essence = (mime: string) => mime.toLowerCase().split(";")[0].trim();
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const PREVIEW_IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;

export type PreviewKind = "pdf" | "image";

/** What the preview dialog can show: a PDF (by type, or a generic type named .pdf) or an image. */
export function previewKind(att: EmailAttachment): PreviewKind | null {
	const mime = essence(att.mime_type);
	if (mime === "application/pdf") return "pdf";
	if (GENERIC_TYPES.has(mime) && /\.pdf$/i.test(att.filename ?? "")) return "pdf";
	if (PREVIEW_IMAGE_TYPE.test(mime)) return "image";
	return null;
}

export function fileSize(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "PDF", "PNG", "XLSX": the name's extension, else the type's. */
export function fileType(att: EmailAttachment): string {
	if (previewKind(att) === "pdf") return "PDF";
	const ext = (att.filename ?? "").match(/\.([a-z0-9]{1,8})$/i)?.[1];
	if (ext) return ext.toUpperCase().slice(0, 4);
	const sub = essence(att.mime_type).split("/")[1]?.split(/[.+-]/)[0];
	return sub ? sub.toUpperCase().slice(0, 4) : "File";
}

/** "PDF · 57 KB" */
export const fileMeta = (att: EmailAttachment) => `${fileType(att)} · ${fileSize(att.size)}`;
