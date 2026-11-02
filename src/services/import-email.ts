/**
 * JSON email import (POST /api/emails/import): for importers that already
 * parsed the message (maildir and Gmail backups). Raw RFC 822 mail goes
 * through src/services/ingest.ts instead (Email Routing, import-raw).
 */
import { createId } from "@paralleldrive/cuid2";
import { getUserRuleClassification, logUserRuleClassification } from "@/agent/classify";
import { isBlockedSender } from "@/database/blocked-senders";
import * as db from "@/database/d1";
import { ensureInvitationNote } from "@/services/invitation-note";
import { isSystemMail } from "@/services/system-mail";
import { refreshThreadSafe, resolveThreadIdSafe } from "@/services/threads-loader";
import type { EmailAttachment } from "@/types";
import { logError, logInfo } from "@/utils/logging";
import { messageIdForms } from "@/utils/message-id";
import {
	buildAttachmentObjectKey,
	getAttachmentSize,
	normalizeEmailAddress,
} from "@/utils/platform";
import type { ImportEmailRequest } from "@/utils/validation";

export interface ImportEmailResult {
	imported: boolean;
	emailId?: string;
	reason?: string;
}

interface ImportAttachmentSource {
	filename?: string | null;
	mimeType?: string | null;
	content?: Uint8Array | ArrayBuffer | string | null;
	disposition?: string | null;
	contentId?: string | null;
	/** Declared size for metadata-only attachments (no payload to measure). */
	size?: number | null;
}

function normalizeAddressList(value?: string | string[]): string[] {
	if (!value) return [];
	const items = Array.isArray(value) ? value : [value];
	return items.map((item) => normalizeEmailAddress(item)).filter(Boolean);
}

/**
 * Import a single email record. Dedups by `message_id`, resolves the thread,
 * inserts the row, and refreshes the thread aggregate.
 *
 * Mail matching SYSTEM_MAIL_RULES_JSON is Agents; other mail uses the tier-1
 * USER sender-rule short-circuit. Everything else inserts with category NULL
 * and is classified by the Codex sidecar via the classify-queue.
 *
 * @param env   Worker env (D1 + ATTACHMENTS).
 * @param body  Validated ImportEmailRequest (same shape the HTTP handler uses).
 * @param options.loggingContext Optional context merged into log entries.
 */
export async function importEmailRecord(
	env: CloudflareBindings,
	body: ImportEmailRequest,
	options?: {
		loggingContext?: Record<string, unknown>;
		attachments?: ImportAttachmentSource[];
	},
): Promise<ImportEmailResult> {
	const messageId = messageIdForms(body.message_id)?.canonical ?? null;

	if (messageId) {
		const exists = await db.emailExistsByMessageId(env.D1, messageId, {
			domain: body.domain,
			mailbox: body.mailbox,
			direction: body.direction,
		});
		if (exists) {
			return { imported: false, reason: "duplicate_message_id" };
		}
	}

	const emailId = createId();
	const fromAddress = normalizeEmailAddress(body.from);
	const receivedAt = body.date < 1e11 ? body.date * 1000 : body.date;
	const toAddresses = normalizeAddressList(body.to);

	if (!messageId) {
		const exists = await db.emailExistsByContent(env.D1, {
			domain: body.domain,
			mailbox: body.mailbox,
			direction: body.direction,
			fromAddress,
			toAddress: toAddresses[0] || "",
			subject: body.subject ?? null,
			receivedAt,
		});
		if (exists) {
			return { imported: false, reason: "duplicate_content" };
		}
	}
	const ccAddresses = normalizeAddressList(body.cc);
	const bccAddresses = normalizeAddressList(body.bcc);

	// Blocked-sender enforcement (v33): decided BEFORE classification and any
	// notification side-effects. Blocked inbound mail is stored straight to
	// Trash and skips classification entirely.
	let mailboxState = body.mailbox_state;
	const senderBlocked =
		body.direction === "inbound" && (await isBlockedSender(env.D1, fromAddress));
	if (senderBlocked && mailboxState !== "trash") {
		mailboxState = "trash";
	}

	// Keep JSON imports aligned with the shared raw-ingest path.
	const systemMail =
		body.direction === "inbound" &&
		!senderBlocked &&
		isSystemMail(env, {
			from_address: fromAddress,
			subject: body.subject ?? null,
			to_addresses: toAddresses,
			cc_addresses: ccAddresses,
			bcc_addresses: bccAddresses,
		});
	const userRule =
		body.direction === "inbound" && !senderBlocked && !systemMail
			? await getUserRuleClassification(env.D1, fromAddress, env.HOME_ALERTS_JSON)
			: null;

	const threadId = await resolveThreadIdSafe(env.D1, {
		id: emailId,
		message_id: messageId,
		in_reply_to: body.in_reply_to ?? null,
		references_header: body.references ?? null,
		subject: body.subject ?? null,
	});

	// v34 split: attachments WITH a payload get the unchanged R2 + attachments
	// row path. Metadata-only attachments (filename known, no payload — e.g.
	// importer-declared `attachments_meta`) get NO attachments row, because
	// attachments.object_key is NOT NULL; their filenames are still counted
	// and indexed via emails.attachment_names below.
	const attachmentInputs: ImportAttachmentSource[] = [
		...(options?.attachments ?? []),
		...(body.attachments_meta ?? []).map((meta) => ({
			filename: meta.filename,
			mimeType: meta.mime_type ?? null,
			content: null,
			size: meta.size ?? null,
		})),
	];
	const attachmentSources = attachmentInputs.filter((attachment) => attachment.content);
	const metadataOnlyAttachments = attachmentInputs.filter((attachment) => !attachment.content);
	const storedAttachments: EmailAttachment[] = [];

	if (env.ATTACHMENTS && attachmentSources.length > 0) {
		for (const [index, attachment] of attachmentSources.entries()) {
			const attachmentId = createId();
			const objectKey = buildAttachmentObjectKey(emailId, index, attachment.filename || null);
			const content = attachment.content;
			if (!content) continue;

			await env.ATTACHMENTS.put(objectKey, content, {
				httpMetadata: {
					contentType: attachment.mimeType || "application/octet-stream",
				},
			});

			storedAttachments.push({
				id: attachmentId,
				email_id: emailId,
				object_key: objectKey,
				filename: attachment.filename || null,
				mime_type: attachment.mimeType || "application/octet-stream",
				size: getAttachmentSize(content),
				disposition: attachment.disposition || null,
				content_id: attachment.contentId ?? null,
				created_at: receivedAt,
			});
		}
	}

	// Metadata-only attachments count toward has_attachments/attachment_count
	// even though they never become attachments rows.
	const importedAttachmentCount = storedAttachments.length + metadataOnlyAttachments.length;
	const hasImportAttachments = attachmentInputs.length > 0;
	const hasAttachments = hasImportAttachments ? importedAttachmentCount > 0 : body.has_attachments;
	const attachmentCount = hasImportAttachments ? importedAttachmentCount : body.attachment_count;

	const { success, error } = await db.insertEmail(
		env.D1,
		{
			id: emailId,
			from_address: fromAddress,
			to_address: toAddresses[0] || "",
			to_addresses: toAddresses,
			cc_addresses: ccAddresses,
			bcc_addresses: bccAddresses,
			reply_to_addresses: [],
			domain: body.domain,
			mailbox: body.mailbox,
			direction: body.direction,
			mailbox_state: mailboxState,
			subject: body.subject ?? null,
			received_at: receivedAt,
			sent_at: body.direction === "outbound" ? receivedAt : null,
			read_at: body.is_read ? receivedAt : null,
			html_content: body.html ?? null,
			text_content: body.text ?? null,
			message_id: messageId,
			provider_message_id: null,
			source_type: body.source_type ?? null,
			source_path: body.source_path ?? null,
			source_folder: body.source_folder ?? null,
			source_message_id: body.source_message_id ?? null,
			in_reply_to: body.in_reply_to ?? null,
			references_header: body.references ?? null,
			has_attachments: hasAttachments,
			attachment_count: attachmentCount,
			thread_id: threadId,
			category: systemMail ? "agents" : (userRule?.category ?? null),
			sub_category: userRule?.sub_category ?? null,
		},
		{ bucket: env.ATTACHMENTS },
	);

	if (!success) {
		const reason = error?.message || "insertEmail failed";
		return { imported: false, reason };
	}

	if (storedAttachments.length > 0) {
		const attachmentResult = await db.insertAttachments(env.D1, storedAttachments);
		if (!attachmentResult.success) {
			const reason = attachmentResult.error?.message || "insertAttachments failed";
			return { imported: false, reason };
		}
	}

	// Metadata-only attachments have no rows for refreshAttachmentNames (run
	// inside insertAttachments) to pick up, so write the combined filename
	// list from ALL attachments explicitly. The v34 UPDATE OF trigger syncs
	// emails_fts. Runs after insertAttachments so it wins over the row-derived
	// recompute.
	if (metadataOnlyAttachments.length > 0) {
		const combinedAttachmentNames = attachmentInputs
			.map((attachment) => attachment.filename?.trim() || "")
			.filter(Boolean)
			.join(" ");
		const namesResult = await db.setEmailAttachmentNames(env.D1, emailId, combinedAttachmentNames);
		if (namesResult.error) {
			logError("import_attachment_names_update_failed", {
				...(options?.loggingContext ?? {}),
				email_id: emailId,
				error: namesResult.error.message,
			});
		}
	}

	if (threadId) {
		await refreshThreadSafe(env.D1, threadId);
	}

	if (userRule?.category === "notifications") {
		await ensureInvitationNote(env.D1, emailId).catch((error) => {
			logError("import_invitation_note_failed", { email_id: emailId, error: String(error) });
		});
	}

	logInfo("email_imported", {
		...(options?.loggingContext ?? {}),
		email_id: emailId,
		from_address: body.from,
		domain: body.domain,
		message_id: messageId,
		source_type: body.source_type ?? null,
		blocked_sender: senderBlocked,
	});

	// Audit trail for the at-ingest user-rule stamp (method='sender_rule').
	if (userRule) {
		await logUserRuleClassification(env.D1, emailId, fromAddress, body.subject ?? null, userRule);
	}

	return { imported: true, emailId };
}
