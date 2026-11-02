/** Read-only DSN evidence. MIME payloads stay ephemeral; only selector lines are frozen. */
import PostalMime, { decodeWords } from "postal-mime";
import type { AttentionEmail } from "@/services/morning-report";

export const DELIVERY_LIMITS = { messages: 20, rawBytes: 128 * 1024, totalBytes: 1024 * 1024 };
export const isDeliveryNotice = (row: AttentionEmail) =>
	/mailer-daemon|postmaster|delivery (?:status|fail)|undeliver/i.test(
		`${row.from_address} ${row.subject}`,
	);

/** Read only the machine status and returned header sections, never the original body. */
export async function deliveryTextFromMime(raw: string): Promise<string> {
	const parsed = await PostalMime.parse(raw, {
		rfc822Attachments: true,
		maxNestingDepth: 8,
		maxHeadersSize: 32768,
	});
	const parts: string[] = [parsed.text || ""];
	for (const attachment of parsed.attachments) {
		const text =
			typeof attachment.content === "string"
				? attachment.content
				: new TextDecoder().decode(attachment.content);
		if (attachment.mimeType === "message/delivery-status") parts.push(text);
		if (attachment.mimeType === "message/rfc822" || attachment.mimeType === "text/rfc822-headers") {
			// Decode encoded subjects with the same parser used by ingest, but retain only needed headers.
			const headers = text
				.split(/\r?\n\r?\n/, 1)[0]
				.replace(/\r\n/g, "\n")
				.replace(/\n[ \t]+/g, " ");
			parts.push(
				headers
					.split("\n")
					.filter((l) => /^(?:from|to|cc|subject|message-id):/i.test(l))
					.map((l) => (/^subject:/i.test(l) ? decodeWords(l) : l))
					.join("\n"),
			);
		}
	}
	return parts.join("\n\n");
}

// Raw MIME is kept 30 days by default (raw_email_purge). A notice older than this whose raw copy
// is gone was purged by retention, not lost: skip it rather than mark every report incomplete.
const RAW_RETENTION_GRACE_MS = 28 * 24 * 60 * 60 * 1000;

export async function loadMorningDeliveryEvidence(
	env: CloudflareBindings,
	rows: AttentionEmail[],
	until: number,
): Promise<string[]> {
	const errors: string[] = [];
	let count = 0,
		bytes = 0;
	for (const row of rows) {
		if (!isDeliveryNotice(row) || row.direction === "outbound") continue;
		// Some providers include these in the readable body. No raw fetch needed in that case.
		if (
			/^Final-Recipient:/im.test(row.text_content || "") &&
			/^Subject:/im.test(row.text_content || "")
		)
			continue;
		if (!env.ATTACHMENTS) continue;
		try {
			if (++count > DELIVERY_LIMITS.messages) throw new Error("DSN count budget");
			const artifact =
				await env.D1.prepare(`SELECT substr(object_key,1,256) AS object_key,size,length(object_key) AS key_length
    FROM raw_email_artifacts WHERE email_id=? LIMIT 1`)
					.bind(row.id)
					.first<{ object_key: string; size: number; key_length: number }>();
			if (!artifact && row.received_at < until - RAW_RETENTION_GRACE_MS) {
				count--;
				continue;
			}
			if (!artifact || artifact.key_length > 256 || artifact.size > DELIVERY_LIMITS.rawBytes)
				throw new Error("DSN unavailable or oversized");
			const head = await env.ATTACHMENTS.head(artifact.object_key);
			if (
				!head ||
				head.size > DELIVERY_LIMITS.rawBytes ||
				bytes + head.size > DELIVERY_LIMITS.totalBytes
			)
				throw new Error("DSN byte budget");
			bytes += head.size;
			// Range bounds the response even if an object was replaced after HEAD.
			const object = await env.ATTACHMENTS.get(artifact.object_key, {
				range: { offset: 0, length: DELIVERY_LIMITS.rawBytes + 1 },
			});
			if (!object || object.size > DELIVERY_LIMITS.rawBytes)
				throw new Error("DSN object unavailable or oversized");
			const raw = await object.text();
			if (new TextEncoder().encode(raw).byteLength > DELIVERY_LIMITS.rawBytes)
				throw new Error("DSN body budget");
			row.delivery_text = await deliveryTextFromMime(raw);
		} catch {
			errors.push("A delivery failure could not be verified; collection incomplete");
			break;
		}
	}
	return errors;
}
