import { createId } from "@paralleldrive/cuid2";
import { type Context, Hono } from "hono";
import type { ZodType } from "zod";
import { isPrivileged, ownerKey, sendKeyScope } from "@/auth/principal";
import * as db from "@/database/d1";
import {
	beginSendKeyDispatch,
	claimDraftSendKey,
	DRAFT_GUARD,
	getSendKey,
	markSendKeySubmitted,
	markSendKeyUnknown,
	publishSendKeyReady,
	recordSendOutcome,
	releaseSendKeyDispatch,
	replyRequestFingerprint,
	reserveSendKey,
	SEND_STALL_MS,
	type SendEvidence,
	type SendKey,
	sendFingerprint,
	sendKeyId,
	summarizeSendKey,
} from "@/database/send-keys";
import { createEmailProvider } from "@/providers";
import { EmailProviderError } from "@/providers/types";
import { importEmailRecord } from "@/services/import-email";
import { ingestRawEmail, MAX_RAW_BYTES } from "@/services/ingest";
import { applyQuoteSplits } from "@/services/quoted";
import {
	getEmailFidelityCheckByEmailId,
	getRawEmailArtifactByEmailId,
	sha256Hex,
} from "@/services/raw-email";
import { refreshThreadSafe, resolveThreadIdSafe } from "@/services/threads-loader";
import {
	finishUnsubscribeDecision,
	parseListUnsubscribe,
	postOneClickUnsubscribe,
	readListUnsubscribePost,
	startUnsubscribeDecision,
	unsubscribeMailto,
} from "@/services/unsubscribe";
import type {
	AppVariables,
	DraftEmailRequest,
	Email,
	EmailAttachment,
	EmailBatchActionRequest,
	EmailFilters,
	EmailRecord,
	SendEmailAttachment,
	SendEmailRequest,
	UpdateDraftRequest,
	UpdateEmailRequest,
} from "@/types";
import { createAttachmentDownloadToken } from "@/utils/attachment-links";
import {
	attachmentResponseHeaders,
	decodeBase64ToBytes,
	encodeBytesToBase64,
	getDirectAttachmentLimit,
} from "@/utils/attachments";
import { now, parseTimestamp } from "@/utils/helpers";
import { hydrateHtmlFromR2 } from "@/utils/html-offload";
import { ERR, OK } from "@/utils/http";
import { getRequestContext, logError, logInfo, logWarn } from "@/utils/logging";
import { canonicalizeOutgoingEmailContent } from "@/utils/mail";
import {
	buildAttachmentObjectKey,
	buildDraftAttachmentStagingKey,
	buildSendAttachmentKey,
	formatSenderAddress,
	getAllowedSenders,
	getAttachmentSize,
	getConfiguredDomains,
	getEmailProviderName,
	getSendMode,
	isSenderDomainAllowed,
	normalizeEmailAddress,
	parseRecipientParts,
} from "@/utils/platform";
import { consumeSendRateLimit } from "@/utils/rate-limit";
import { composeReply } from "@/utils/reply";
import { armSendFault, sendFault, sendFaultFails } from "@/utils/test-fault";
import {
	draftEmailSchema,
	emailBatchActionSchema,
	type HydrateEmailRequest,
	hydrateEmailSchema,
	type ImportEmailRequest,
	importEmailSchema,
	repairAttachmentsSchema,
	replyEmailSchema,
	sendEmailSchema,
	updateDraftSchema,
	updateEmailSchema,
} from "@/utils/validation";

const emails = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();
type AppContext = Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>;

function getDomainScope(env: CloudflareBindings): string[] {
	return getConfiguredDomains(env);
}

/** Owner of compose sessions (src/auth/principal.ts). */
function _getWorkspaceId(c: AppContext): string {
	return ownerKey(c);
}

function parseFilters(query: Record<string, string>): EmailFilters {
	const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
	const offset = Math.max(Number(query.offset) || 0, 0);
	const hasAttachments = query.has_attachments;
	const isRead = query.is_read;
	const category = query.category;

	return {
		from: query.from || undefined,
		to: query.to || undefined,
		domain: query.domain || undefined,
		mailbox: query.mailbox || undefined,
		direction:
			query.direction === "outbound"
				? "outbound"
				: query.direction === "inbound"
					? "inbound"
					: undefined,
		mailbox_state:
			query.mailbox_state === "inbox" ||
			query.mailbox_state === "sent" ||
			query.mailbox_state === "archived" ||
			query.mailbox_state === "trash" ||
			query.mailbox_state === "draft"
				? query.mailbox_state
				: undefined,
		q: query.q || undefined,
		cursor: query.cursor || undefined,
		after: query.after ? (parseTimestamp(query.after) ?? undefined) : undefined,
		before: query.before ? (parseTimestamp(query.before) ?? undefined) : undefined,
		has_attachments:
			hasAttachments === "true" ? true : hasAttachments === "false" ? false : undefined,
		is_read: isRead === "true" ? true : isRead === "false" ? false : undefined,
		category:
			category === "personal" ||
			category === "billing" ||
			category === "agents" ||
			category === "notifications" ||
			category === "newsletters" ||
			category === "marketing" ||
			category === "spam" ||
			// Phase 4
			category === "home_alerts" ||
			category === "tax_documents"
				? category
				: undefined,
		sub_category: query.sub_category?.trim() || undefined,
		limit,
		offset,
	};
}

function normalizeAddressList(value?: string | string[]): string[] {
	if (!value) return [];

	const items = Array.isArray(value) ? value : [value];
	return items.map((item) => normalizeEmailAddress(item)).filter(Boolean);
}

function getHeaderValue(
	headers: Record<string, string> | undefined,
	...keys: string[]
): string | null {
	if (!headers) {
		return null;
	}

	// Header names are case-insensitive per RFC 5322: a caller sending
	// "IN-REPLY-TO" must still persist into in_reply_to, or the delivered mail
	// threads correctly while MailClaw's own copy loses its threading fields.
	const wanted = new Set(keys.map((key) => key.trim().toLowerCase()));
	for (const [rawName, value] of Object.entries(headers)) {
		if (typeof value !== "string" || !value.trim()) continue;
		if (wanted.has(rawName.trim().toLowerCase())) {
			return value.trim();
		}
	}

	for (const key of keys) {
		if (headers[key]) {
			return headers[key];
		}
	}

	return null;
}

function validateDomainAccess(filters: EmailFilters, domainScope: string[]) {
	if (filters.domain && domainScope.length > 0 && !domainScope.includes(filters.domain)) {
		return ERR("FORBIDDEN_DOMAIN", "Requested domain is not one MailClaw serves");
	}

	return null;
}

async function parseJsonBody<T>(c: AppContext, schema: ZodType<T>) {
	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return { response: c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400) };
	}

	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		return {
			response: c.json(
				ERR("INVALID_BODY", parsed.error.issues.map((issue) => issue.message).join("; ")),
				400,
			),
		};
	}

	return { data: parsed.data };
}

/** RFC 5322 msg-id shape: "<local@domain>". Provider ids that aren't this
 * (e.g. Postmark's bare UUID) must not be stored as a Message-ID. */
function isRfcMessageId(value: string): boolean {
	return /^<[^<>@\s]+@[^<>@\s]+>$/.test(value.trim());
}

function buildEmailPersistenceRecord(
	emailId: string,
	sentAt: number,
	body: SendEmailRequest,
	providerMessageId: string,
): EmailRecord {
	const sender = parseRecipientParts(body.from);
	const toAddresses = normalizeAddressList(body.to);
	const ccAddresses = normalizeAddressList(body.cc);
	const bccAddresses = normalizeAddressList(body.bcc);
	const replyToAddresses = normalizeAddressList(body.reply_to);
	const attachmentCount = body.attachments?.length ?? 0;

	return {
		id: emailId,
		from_address: normalizeEmailAddress(body.from),
		to_address: toAddresses[0] || "",
		to_addresses: toAddresses,
		cc_addresses: ccAddresses,
		bcc_addresses: bccAddresses,
		reply_to_addresses: replyToAddresses,
		domain: sender.domain,
		mailbox: sender.mailbox,
		direction: "outbound",
		mailbox_state: "sent",
		subject: body.subject,
		received_at: sentAt,
		sent_at: sentAt,
		read_at: sentAt,
		html_content: body.html || null,
		text_content: body.text || null,
		// Both the SMTP and Cloudflare lanes return a real RFC 5322 Message-ID.
		// Persist it so inbound replies (whose In-Reply-To points at it) can
		// find their parent in resolveThreadId. Postmark returned a bare UUID,
		// which is not a Message-ID — hence the shape check rather than a
		// straight copy.
		message_id: isRfcMessageId(providerMessageId) ? providerMessageId : null,
		provider_message_id: providerMessageId,
		in_reply_to: getHeaderValue(body.headers, "in-reply-to", "In-Reply-To"),
		references_header: getHeaderValue(body.headers, "references", "References"),
		has_attachments: attachmentCount > 0,
		attachment_count: attachmentCount,
	};
}

type LinkableAttachment = Pick<EmailAttachment, "object_key" | "filename" | "mime_type" | "size">;

interface HostedAttachmentLink {
	filename: string;
	size: number;
	url: string;
}

const HOSTED_ATTACHMENT_LINK_TTL_SECONDS = 90 * 24 * 60 * 60;

function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function publicOrigin(c: AppContext): string {
	return (c.env.UI_ORIGIN || new URL(c.req.url).origin).replace(/\/$/, "");
}

async function buildHostedAttachmentLinks(
	c: AppContext,
	attachments: LinkableAttachment[],
	expiresAt: number,
): Promise<HostedAttachmentLink[]> {
	const origin = publicOrigin(c);

	return Promise.all(
		attachments.map(async (attachment) => {
			const filename = attachment.filename || "attachment";
			const token = await createAttachmentDownloadToken(c.env, {
				key: attachment.object_key,
				filename,
				mime_type: attachment.mime_type || "application/octet-stream",
				size: attachment.size || 0,
				exp: expiresAt,
			});
			return {
				filename,
				size: attachment.size || 0,
				url: `${origin}/api/public/attachments/${encodeURIComponent(token)}`,
			};
		}),
	);
}

async function withHostedAttachmentLinks(
	c: AppContext,
	body: SendEmailRequest,
	attachments: LinkableAttachment[],
	expiresAt: number,
): Promise<SendEmailRequest> {
	if (attachments.length === 0) return body;
	const links = await buildHostedAttachmentLinks(c, attachments, expiresAt);
	const textBlock = [
		"",
		"",
		"Attachments (secure download links):",
		...links.map((link) => `- ${link.filename} (${formatAttachmentSize(link.size)}): ${link.url}`),
	].join("\n");
	const htmlBlock = [
		'<div style="margin-top:16px;padding-top:12px;border-top:1px solid #dadce0">',
		'<p style="margin:0 0 8px 0"><strong>Attachments</strong> (secure download links)</p>',
		'<ul style="margin:0;padding-left:20px">',
		...links.map(
			(link) =>
				`<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.filename)}</a> <span style="color:#5f6368">(${escapeHtml(formatAttachmentSize(link.size))})</span></li>`,
		),
		"</ul>",
		"</div>",
	].join("");

	return {
		...body,
		attachments: undefined,
		text: body.text ? `${body.text}${textBlock}` : textBlock.trimStart(),
		html: body.html ? `${body.html}${htmlBlock}` : undefined,
	};
}

async function deleteAttachmentObjectsBestEffort(
	bucket: R2Bucket | undefined,
	keys: string[],
	event: string,
) {
	if (!bucket || keys.length === 0) return;
	const settled = await Promise.allSettled(keys.map((key) => bucket.delete(key)));
	const failed = settled.filter((result) => result.status === "rejected");
	if (failed.length > 0) {
		logWarn(event, {
			failed: failed.length,
			total: keys.length,
			errors: failed
				.slice(0, 5)
				.map((result) =>
					result.status === "rejected"
						? result.reason instanceof Error
							? result.reason.message
							: String(result.reason)
						: "",
				),
		});
	}
}

async function stageDraftAttachments(
	env: CloudflareBindings,
	draftId: string,
	attachments: NonNullable<DraftEmailRequest["attachments"]>,
	createdAt: number,
): Promise<{
	success: boolean;
	rows: EmailAttachment[];
	stagedKeys: string[];
	error?: Error;
}> {
	if (attachments.length === 0) {
		return { success: true, rows: [], stagedKeys: [] };
	}

	if (!env.ATTACHMENTS) {
		return {
			success: false,
			rows: [],
			stagedKeys: [],
			error: new Error("Attachment storage is required to save draft attachments"),
		};
	}

	const replacementId = createId();
	const rows: EmailAttachment[] = [];
	const stagedKeys: string[] = [];

	try {
		for (const [index, attachment] of attachments.entries()) {
			const attachmentId = createId();
			const objectKey = buildDraftAttachmentStagingKey(
				draftId,
				replacementId,
				index,
				attachment.filename,
			);
			const content = decodeBase64ToBytes(attachment.content_base64);

			await env.ATTACHMENTS.put(objectKey, content, {
				httpMetadata: {
					contentType: attachment.content_type || "application/octet-stream",
				},
			});
			stagedKeys.push(objectKey);

			rows.push({
				id: attachmentId,
				email_id: draftId,
				object_key: objectKey,
				filename: attachment.filename,
				mime_type: attachment.content_type || "application/octet-stream",
				size: getAttachmentSize(content),
				disposition: attachment.disposition || "attachment",
				content_id: attachment.content_id ?? null,
				created_at: createdAt,
			});
		}

		return { success: true, rows, stagedKeys };
	} catch (error) {
		await deleteAttachmentObjectsBestEffort(
			env.ATTACHMENTS,
			stagedKeys,
			"draft_attachment_stage_cleanup_failed",
		);
		return {
			success: false,
			rows: [],
			stagedKeys,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

export async function replaceDraftAttachments(
	env: CloudflareBindings,
	draftId: string,
	attachments: NonNullable<DraftEmailRequest["attachments"]>,
	createdAt: number,
	domainScope: string[] = [],
) {
	const { attachments: existing, error: existingError } = await db.getAttachmentsByEmailId(
		env.D1,
		draftId,
		domainScope,
	);
	if (existingError) {
		return { success: false, error: existingError };
	}

	const staged = await stageDraftAttachments(env, draftId, attachments, createdAt);
	if (!staged.success) {
		return { success: false, error: staged.error };
	}

	const replacement = await db.replaceDraftAttachmentsAtomic(
		env.D1,
		draftId,
		staged.rows,
		domainScope,
	);
	if (!replacement.success) {
		await deleteAttachmentObjectsBestEffort(
			env.ATTACHMENTS,
			staged.stagedKeys,
			"draft_attachment_stage_cleanup_failed",
		);
		return { success: false, error: replacement.error };
	}

	await deleteAttachmentObjectsBestEffort(
		env.ATTACHMENTS,
		existing.map((attachment) => attachment.object_key),
		"draft_attachment_old_delete_failed",
	);

	return { success: true, error: undefined };
}

function validateSendPermissions(c: AppContext, body: SendEmailRequest) {
	if (!isSenderDomainAllowed(c.env, body.from)) {
		return c.json(ERR("FORBIDDEN_FROM_DOMAIN", "Sender domain is not one MailClaw serves"), 403);
	}

	if (body.attachments && body.attachments.length > 0 && !c.env.ATTACHMENTS) {
		return c.json(
			ERR(
				"ATTACHMENTS_DISABLED",
				"Attachment storage is required to send messages with attachments",
			),
			503,
		);
	}

	return null;
}

type SendState = "sending" | "sent" | "failed" | "unconfirmed" | "retry";

/** Error response that also tells the caller what happened to the message. */
function sendError(
	c: AppContext,
	code: string,
	message: string,
	status: number,
	emailId: string | null,
	state: SendState,
	extra: Record<string, unknown> = {},
) {
	return c.json(
		{ ...ERR(code, message), data: { ...extra, email_id: emailId, state } },
		status as 400,
	);
}

const RETRY_MESSAGE =
	"MailClaw could not read or record this send's state. Nothing is known about delivery: repeat the same request unchanged with the same idempotency key.";

/**
 * `retry` (ticket 08): MailClaw could not read or record this send's state, or could not
 * finish storing the message. A response, not a delivery outcome: nothing is known about
 * delivery, so the caller repeats the same request unchanged with the same key, never a new
 * one (the key row then answers). Never `failed`, which promises nothing went out.
 */
function retryResponse(
	c: AppContext,
	emailId: string | null,
	code = "SEND_STATE_UNAVAILABLE",
	message = RETRY_MESSAGE,
) {
	const key = c.get("idempotencyKey");
	return sendError(c, code, message, 503, emailId, "retry", {
		retryable: true,
		...(key ? { idempotency_key: key } : {}),
	});
}

/**
 * The send quota (20 a minute per token, utils/rate-limit.ts) counts dispatches only:
 * answers from a key's stored status never reach it. With `emailId`, nothing went out and
 * rerunning the same key resumes.
 */
function enforceSendRateLimit(c: AppContext, emailId?: string): Response | null {
	const authToken = c.get("authToken");
	if (!authToken) {
		return c.json(ERR("UNAUTHORIZED", "Missing auth token"), 401);
	}
	const sendLimit = consumeSendRateLimit(authToken);
	if (!sendLimit.allowed) {
		c.header("Retry-After", String(sendLimit.retryAfter));
		logWarn("rate_limited", {
			...getRequestContext(c),
			scope: "send",
			retry_after: sendLimit.retryAfter,
		});
		return emailId
			? sendError(c, "RATE_LIMITED", "Too many send requests", 429, emailId, "failed")
			: c.json(ERR("RATE_LIMITED", "Too many send requests"), 429);
	}
	return null;
}

/** Accepted, but maybe without a sent copy: repair it and never resend. */
async function alreadySentResponse(
	c: AppContext,
	emailId: string,
	providerMessageId: string | null,
	acceptedAt: number,
) {
	if (providerMessageId) {
		await db.markDraftSendAcceptedFallback(
			c.env.D1,
			emailId,
			{
				provider_message_id: providerMessageId,
				message_id: isRfcMessageId(providerMessageId) ? providerMessageId : null,
				sent_at: acceptedAt,
			},
			getDomainScope(c.env),
		);
	}
	return c.json(
		OK({
			id: providerMessageId,
			provider: null,
			persisted: true,
			already_sent: true,
			email_id: emailId,
			state: "sent" as const,
		}),
	);
}

/** The dispatch a request holds: only it may submit to the provider. */
interface Dispatch {
	token: string;
	/** Caller-keyed (API/CLI idempotency key), as opposed to a keyless draft guard. */
	keyed: boolean;
}

/**
 * Every send dispatches through its send_idempotency_keys row (v50 + v48), the
 * only send guard. Keyed drafts already have one; a keyless draft gets one here
 * (key_id = draft id). The row must move to `dispatching` under this request's
 * token before any content is loaded, so only one request ever dispatches.
 * `charged`: the request already counted against the send quota.
 */
async function gateDispatch(
	c: AppContext,
	emailId: string,
	options: { charged: boolean },
): Promise<{ dispatch?: Dispatch; response?: Response }> {
	const inProgress = () =>
		sendError(
			c,
			"SEND_IN_PROGRESS",
			"This message is already being sent.",
			409,
			emailId,
			"sending",
		);
	const charge = () => (options.charged ? null : enforceSendRateLimit(c, emailId));
	const token = createId();

	let { key, error } = await getSendKey(c.env.D1, emailId);
	if (error) return { response: retryResponse(c, emailId) };
	if (!key) {
		const limited = charge();
		if (limited) return { response: limited };
		const claimed = await claimDraftSendKey(c.env.D1, emailId, token, now());
		if (claimed.error) return { response: retryResponse(c, emailId) };
		if (claimed.updated) return { dispatch: { token, keyed: false } };
		// A concurrent send of this draft claimed it first.
		({ key, error } = await getSendKey(c.env.D1, emailId));
		if (error || !key) return { response: retryResponse(c, emailId) };
	}
	const keyed = key.fingerprint !== DRAFT_GUARD;

	if (key.status === "sent") {
		return {
			response: await alreadySentResponse(c, emailId, key.provider_message_id, key.updated_at),
		};
	}
	if (key.status === "preparing") {
		// Only a request carrying the message itself can finish its preparation.
		return {
			response:
				now() - key.updated_at > SEND_STALL_MS
					? retryResponse(
							c,
							emailId,
							"SEND_STATE_UNAVAILABLE",
							"This message was never fully prepared, and nothing was sent. Repeat the original send unchanged with its idempotency key.",
						)
					: inProgress(),
		};
	}

	const stalled = key.status === "dispatching" && now() - key.updated_at > SEND_STALL_MS;
	if (key.status === "unknown" || (stalled && key.submitted_at != null)) {
		// The marker is set and no outcome was recorded. A saved sent copy
		// carries the provider id, which only acceptance produces: settle from it.
		const settled = await settleFromSentCopy(c, key);
		if (settled) return { response: settled };
		if (key.status === "dispatching") await markSendKeyUnknown(c.env.D1, key, now());
		return {
			response: sendError(
				c,
				"SEND_STATUS_UNKNOWN",
				"MailClaw could not confirm the delivery outcome. Check Sent before retrying.",
				409,
				emailId,
				"unconfirmed",
			),
		};
	}
	// Still in flight. A stalled dispatch without the marker never reached the
	// provider, so it falls through and is taken over below.
	if (key.status === "dispatching" && !stalled) return { response: inProgress() };

	const limited = charge();
	if (limited) return { response: limited };
	const begun = await beginSendKeyDispatch(c.env.D1, key, token, now());
	if (begun.error) return { response: retryResponse(c, emailId) };
	if (!begun.updated) return { response: inProgress() };
	return { dispatch: { token, keyed } };
}

/**
 * A submitted key whose outcome write was lost, but whose draft was finalized
 * into a sent copy (that write carries the provider message id). Records the
 * acceptance on the key and answers already_sent; null when there is no proof.
 */
async function settleFromSentCopy(c: AppContext, key: SendKey): Promise<Response | null> {
	const { email } = await db.getEmailById(c.env.D1, key.key_id, getDomainScope(c.env));
	const proof = sentCopyProviderId(email);
	if (!proof) return null;
	const provider = key.evidence.filter((entry) => entry.event === "submitted").at(-1)?.provider;
	const settled = await recordSendOutcome(c.env.D1, key.key_id, key.owner, "sent", {
		at: now(),
		event: "accepted",
		provider: provider ?? "unknown",
		provider_message_id: proof,
		response: "settled from the saved sent copy",
	});
	if (settled.error) return null;
	return alreadySentResponse(c, key.key_id, proof, email?.sent_at ?? now());
}

/** The provider id of a finalized sent copy: proof the provider accepted it. */
function sentCopyProviderId(email: Email | null): string | null {
	if (!email || email.direction !== "outbound" || email.mailbox_state === "draft") return null;
	return email.provider_message_id || null;
}

/** Bounded text of a provider error's details, for the evidence entry. */
function providerResponseText(details: unknown): string | undefined {
	if (details == null) return undefined;
	if (typeof details === "string") return details;
	try {
		return JSON.stringify(details);
	} catch {
		return undefined;
	}
}

/**
 * Dispatch a saved draft once and turn it into the sent copy. Every send (UI
 * draft, API/CLI send, reply) is a draft by the time it gets here, and the
 * caller holds its send key row (`dispatch`). The row records the submission
 * before the provider call and the provider's answer after it.
 */
async function sendAndPersistEmail(
	c: AppContext,
	body: SendEmailRequest,
	options: {
		draftId: string;
		hostedAttachmentCount?: number;
		storedAttachmentCount: number;
		threadId?: string | null;
		draftThreadId?: string | null;
		dispatch: Dispatch;
	},
) {
	const emailId = options.draftId;
	const { token } = options.dispatch;
	const logKeyWrite = (step: string, result: { updated: boolean; error?: Error }) => {
		if (result.error || !result.updated) {
			logError("send_key_write_failed", {
				...getRequestContext(c),
				draft_id: emailId,
				step,
				error: result.error?.message || "fence lost",
			});
		}
	};
	/** Stopped before the provider call: nothing went out. */
	const handBack = async () =>
		logKeyWrite("release", await releaseSendKeyDispatch(c.env.D1, emailId, token, now()));

	const canonicalizedBody = sendEmailSchema.safeParse(canonicalizeSendPayload(body));
	if (!canonicalizedBody.success) {
		await handBack();
		return sendError(
			c,
			"INVALID_BODY",
			canonicalizedBody.error.issues.map((issue) => issue.message).join("; "),
			400,
			emailId,
			"failed",
		);
	}

	body = canonicalizedBody.data;
	let submitted = false;
	let providerName = "unknown";
	let acceptedId: string | null = null;

	try {
		const senderDomain = parseRecipientParts(body.from).domain;
		const provider = createEmailProvider(c.env, senderDomain);
		providerName = provider.name;

		// The submission marker. Without it durable, never call the provider: a
		// lost marker would make a later "unknown" look like "never sent".
		const marked = await markSendKeySubmitted(c.env.D1, emailId, token, provider.name, now());
		if (marked.error || !marked.updated) {
			logKeyWrite("submitted", marked);
			if (marked.error) await handBack();
			return marked.error
				? retryResponse(c, emailId)
				: sendError(
						c,
						"SEND_IN_PROGRESS",
						"This message is already being sent.",
						409,
						emailId,
						"sending",
					);
		}
		submitted = true;

		logInfo("send_attempt", {
			...getRequestContext(c),
			draft_id: emailId,
			provider: provider.name,
			from_address: body.from,
			recipient_count: normalizeAddressList(body.to).length,
			attachment_count: body.attachments?.length ?? 0,
			hosted_attachment_count: options.hostedAttachmentCount || 0,
		});

		// Only the outgoing header carries the display name; storage, provider
		// choice and the idempotency fingerprint keep the bare address.
		const { response: providerResponse, ...result } = await provider.send({
			...body,
			from: formatSenderAddress(c.env, body.from),
		});
		acceptedId = result.id;
		await sendFault(c, "dispatch.accepted");
		const sentAt = now();
		const acceptance: SendEvidence = {
			at: sentAt,
			event: "accepted",
			provider: provider.name,
			provider_message_id: result.id,
			response: providerResponse,
		};
		// The acceptance is the one write that must not be lost: without it the
		// key stays "unknown" although the message went out. Retry once.
		let accepted = await recordSendOutcome(c.env.D1, emailId, token, "sent", acceptance);
		if (accepted.error) {
			accepted = await recordSendOutcome(c.env.D1, emailId, token, "sent", acceptance);
		}
		if (accepted.error || !accepted.updated) {
			logError("send_acceptance_record_failed", {
				...getRequestContext(c),
				draft_id: emailId,
				provider_message_id: result.id,
				error: accepted.error?.message || "key row was not updated",
			});
		}
		const record = buildEmailPersistenceRecord(emailId, sentAt, body, result.id);
		if (options.storedAttachmentCount > 0) {
			record.has_attachments = true;
			record.attachment_count = options.storedAttachmentCount;
		}

		// Keyed drafts (API/CLI sends and replies) keep the thread they were
		// created in; a reply re-resolved from References alone can split.
		record.thread_id =
			options.threadId ||
			(options.dispatch.keyed ? options.draftThreadId : null) ||
			(await resolveThreadIdSafe(c.env.D1, record));

		const draftResult = await db.finalizeDraftSend(
			c.env.D1,
			emailId,
			{
				from_address: record.from_address,
				to_addresses: record.to_addresses,
				cc_addresses: record.cc_addresses,
				bcc_addresses: record.bcc_addresses,
				reply_to_addresses: record.reply_to_addresses,
				subject: record.subject || "",
				html_content: record.html_content,
				text_content: record.text_content,
				provider_message_id: result.id,
				// Without the RFC-5322 message_id, inbound replies cannot resolve
				// their parent in resolveThreadId and split into a separate thread.
				message_id: record.message_id,
				thread_id: record.thread_id ?? null,
				in_reply_to: record.in_reply_to,
				references_header: record.references_header,
				has_attachments: record.has_attachments,
				attachment_count: record.attachment_count,
				sent_at: sentAt,
			},
			getDomainScope(c.env),
			{ bucket: c.env.ATTACHMENTS },
		);
		let persisted = draftResult.updated;
		let persistenceError = draftResult.error;

		// Once the provider accepts a draft, leaving it in Drafts is dangerous:
		// it looks retryable and can produce a duplicate later. If the full
		// sent-copy finalization fails, make a smaller atomic state transition
		// that preserves the existing body/attachment rows and records the
		// provider id. The key row (`sent`) keeps the repair context.
		if (!persisted) {
			const fallback = await db.markDraftSendAcceptedFallback(
				c.env.D1,
				emailId,
				{
					provider_message_id: result.id,
					message_id: record.message_id,
					sent_at: sentAt,
				},
				getDomainScope(c.env),
			);
			if (fallback.updated) {
				persisted = true;
				persistenceError = undefined;
				logWarn("send_persist_recovered", {
					...getRequestContext(c),
					draft_id: emailId,
					provider_message_id: result.id,
				});
			} else if (fallback.error) {
				persistenceError = fallback.error;
			}
		}

		if (!persisted) {
			logError("send_persist_failed", {
				...getRequestContext(c),
				email_id: emailId,
				error: persistenceError?.message || "unknown",
			});
			return sendError(
				c,
				"SENT_COPY_SAVE_FAILED",
				"Message was accepted by the email provider, but MailClaw could not save the sent copy.",
				500,
				emailId,
				"sent",
				{ ...result, persisted: false },
			);
		}

		// Refresh thread aggregate
		if (record.thread_id) {
			await refreshThreadSafe(c.env.D1, record.thread_id);
		}

		logInfo("send_success", {
			...getRequestContext(c),
			email_id: emailId,
			provider: result.provider,
			provider_message_id: result.id,
		});

		// Attachments over the provider's direct limit went as download links in
		// the body; say so, since the recipient did not get the files themselves.
		const hosted = options.hostedAttachmentCount || 0;
		return c.json(
			OK({
				...result,
				persisted: true,
				email_id: emailId,
				state: "sent" as const,
				...(hosted > 0 ? { hosted_attachments: hosted } : {}),
			}),
		);
	} catch (err) {
		if (acceptedId) {
			// Thrown after the provider accepted: it went out. Never say otherwise.
			logError("send_after_accept_failed", {
				...getRequestContext(c),
				draft_id: emailId,
				provider_message_id: acceptedId,
				error: err instanceof Error ? err.message : String(err),
			});
			return sendError(
				c,
				"SENT_COPY_SAVE_FAILED",
				"Message was accepted by the email provider, but MailClaw could not save the sent copy.",
				500,
				emailId,
				"sent",
				{ id: acceptedId, provider: providerName, persisted: false },
			);
		}
		if (!submitted) {
			// Provider construction failed (not configured): nothing went out.
			await handBack();
			const providerError = err instanceof EmailProviderError ? err : null;
			const message = err instanceof Error ? err.message : "Failed to send email";
			logWarn("send_failed", { ...getRequestContext(c), error: message, submitted: false });
			return sendError(
				c,
				providerError?.code ?? "SEND_FAILED",
				message,
				providerError?.status ?? 500,
				emailId,
				"failed",
			);
		}
		// A definite rejection (EmailProviderError.definite: 4xx, or an SMTP
		// refusal before the message was taken) is retryable. Anything else can
		// be a lost response after acceptance, so the key becomes `unknown` and
		// blind retries are blocked until the outcome is checked.
		const providerError = err instanceof EmailProviderError ? err : null;
		let definite = providerError?.definite ?? false;
		const message = err instanceof Error ? err.message : "Failed to send email";
		const failure: SendEvidence = {
			at: now(),
			event: definite ? "rejected" : "error",
			provider: providerName,
			status: providerError?.status,
			code: providerError?.code ?? "SEND_STATUS_UNKNOWN",
			error: message,
			response: providerResponseText(providerError?.details),
		};
		const outcomeState = definite ? "failed" : "unknown";
		let outcome = await recordSendOutcome(c.env.D1, emailId, token, outcomeState, failure);
		if (outcome.error) {
			outcome = await recordSendOutcome(c.env.D1, emailId, token, outcomeState, failure);
		}
		logKeyWrite("outcome", outcome);
		// An unrecorded rejection leaves the marker without an outcome, which the
		// next request must treat as unknown. Say what the server will say.
		if (outcome.error || !outcome.updated) definite = false;
		logWarn("send_failed", {
			...getRequestContext(c),
			error: message,
			code: providerError?.code,
			status: providerError?.status,
			definite,
		});
		if (providerError) {
			return sendError(
				c,
				providerError.code,
				message,
				providerError.status,
				emailId,
				definite ? "failed" : "unconfirmed",
			);
		}
		return sendError(c, "SEND_FAILED", message, 500, emailId, "unconfirmed");
	}
}

function buildDraftSendPayload(email: Email): SendEmailRequest {
	const body: SendEmailRequest = {
		from: email.from_address,
		to: email.to_addresses,
		subject: email.subject || "",
		cc: email.cc_addresses,
		bcc: email.bcc_addresses,
		reply_to: email.reply_to_addresses,
		html: email.html_content || undefined,
		text: email.text_content || undefined,
	};

	const headers: Record<string, string> = {};
	if (email.in_reply_to) {
		headers["In-Reply-To"] = email.in_reply_to;
	}
	if (email.references_header) {
		headers.References = email.references_header;
	}
	if (Object.keys(headers).length > 0) {
		body.headers = headers;
	}

	return body;
}

function canonicalizeSendPayload(body: SendEmailRequest): SendEmailRequest {
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		body.html ?? null,
		body.text ?? null,
	);

	return {
		...body,
		html: htmlContent ?? undefined,
		text: textContent ?? undefined,
	};
}

/**
 * 400 for caller mistakes in a mail query (bad cursor/operator); 503 when D1
 * ran out of CPU, either because the query is too broad (a very common word,
 * no filter) or because another job overloaded the database; 500 otherwise.
 */
function queryErrorResponse(c: AppContext, error: Error) {
	if (error instanceof db.QueryInputError) return c.json(ERR(error.code, error.message), 400);
	if (error.message.includes("exceeded its CPU time limit")) {
		return c.json(
			ERR(
				"QUERY_TOO_BROAD",
				"MailClaw's database ran out of CPU on this request. Retry once; if it fails again the search is too broad: add a filter (after/before, from, state) or a more specific term.",
			),
			503,
		);
	}
	return c.json(ERR("D1_ERROR", error.message), 500);
}

// List emails (metadata only). Default: conversations without q, messages
// with q. `rows=messages` returns every matching message, cursor-paged.
// `full=1` adds bodies; /api/emails/export is that same listing under its old URL, kept for
// existing API callers. Whole-instance export: `mailclaw export`.
emails.get("/api/emails/export", (c) => listEmails(c, true));
emails.get("/api/emails", (c) => listEmails(c, c.req.query("full") === "1"));

async function listEmails(
	c: Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>,
	full: boolean,
) {
	const filters = parseFilters(c.req.query());
	const domainScope = getDomainScope(c.env);
	const domainError = validateDomainAccess(filters, domainScope);
	if (domainError) return c.json(domainError, 403);

	const rowsParam = c.req.query("rows");
	if (rowsParam !== undefined && rowsParam !== "messages" && rowsParam !== "conversations") {
		return c.json(ERR("INVALID_QUERY", "rows must be messages or conversations"), 400);
	}
	const result = full
		? await db.getEmailsWithContent(c.env.D1, filters, domainScope)
		: await db.getEmails(c.env.D1, filters, domainScope, rowsParam);
	if (result.error) return queryErrorResponse(c, result.error);
	const interpreted = "interpreted" in result ? result.interpreted : undefined;
	return c.json(
		OK({
			emails: result.emails,
			total: result.total,
			limit: filters.limit,
			offset: filters.offset,
			next_cursor: result.next_cursor,
			...(interpreted ? { search: { interpreted } } : {}),
		}),
	);
}

// NOTE: /api/conversations is handled by conversations.ts (returns {conversations:[...]}).

emails.get("/api/emails/contacts", async (c) => {
	const query = (c.req.query("q") || "").trim();
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 8, 1), 20);
	const domainScope = getDomainScope(c.env);

	const { contacts, error } = await db.getContactSuggestions(c.env.D1, query, domainScope, limit);
	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	return c.json(OK({ contacts }));
});

// Get thread
emails.get("/api/emails/:id/thread", async (c) => {
	const domainScope = getDomainScope(c.env);
	const { emails: thread, error } = await db.getThreadByEmailId(
		c.env.D1,
		c.req.param("id"),
		domainScope,
	);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (thread.length === 0) return c.json(ERR("NOT_FOUND", "Email not found"), 404);
	await hydrateHtmlFromR2(c.env.ATTACHMENTS, thread);
	applyQuoteSplits(thread, { annotateHtml: false });
	return c.json(OK({ emails: thread }));
});

// Get single email
emails.get("/api/emails/:id", async (c) => {
	const domainScope = getDomainScope(c.env);
	const { email, error } = await db.getEmailById(c.env.D1, c.req.param("id"), domainScope, {
		bucket: c.env.ATTACHMENTS,
	});

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!email) return c.json(ERR("NOT_FOUND", "Email not found"), 404);
	// ?quoted=split: compare with the conversation and add `quote` (what the CLI reads).
	if (c.req.query("quoted") === "split") {
		const { emails: thread, error: threadError } = await db.getThreadByEmailId(
			c.env.D1,
			email.id,
			domainScope,
		);
		if (threadError) return c.json(ERR("D1_ERROR", threadError.message), 500);
		await hydrateHtmlFromR2(c.env.ATTACHMENTS, thread);
		applyQuoteSplits(thread, { annotateHtml: false });
		const quote = thread.find((entry) => entry.id === email.id)?.quote;
		if (quote) email.quote = quote;
	}
	if (email.direction === "outbound") {
		// Every send since v48 has a key row: say whether and how it went out, so
		// callers never have to guess whether a retry would double-send. A read
		// failure only drops the block; the message itself is still served.
		const { key, error: keyError } = await getSendKey(c.env.D1, email.id);
		if (keyError) {
			logWarn("send_key_read_failed", {
				...getRequestContext(c),
				email_id: email.id,
				error: keyError.message,
			});
		}
		if (key) {
			const send = summarizeSendKey(key, now());
			// Outcome write lost but the sent copy was saved: it went out.
			if (send.state === "unconfirmed" && sentCopyProviderId(email)) send.state = "sent";
			return c.json(OK({ ...email, send }));
		}
	}
	return c.json(OK(email));
});

emails.get("/api/emails/:id/raw", async (c) => {
	if (!c.env.ATTACHMENTS) {
		return c.json(ERR("ATTACHMENTS_DISABLED", "Raw email storage is not configured"), 503);
	}

	const emailId = c.req.param("id");
	const domainScope = getDomainScope(c.env);
	const { email, error } = await db.getEmailById(c.env.D1, emailId, domainScope);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!email) return c.json(ERR("NOT_FOUND", "Email not found"), 404);

	const { artifact, error: artifactError } = await getRawEmailArtifactByEmailId(c.env.D1, emailId);
	if (artifactError) return c.json(ERR("D1_ERROR", artifactError.message), 500);
	if (!artifact)
		return c.json(ERR("RAW_MISSING", "Raw email is not retained for this message"), 404);

	const object = await c.env.ATTACHMENTS.get(artifact.object_key);
	if (!object) {
		return c.json(ERR("RAW_OBJECT_MISSING", "Raw email object is missing from storage"), 404);
	}

	return new Response(object.body, {
		status: 200,
		headers: {
			"Content-Type": "message/rfc822",
			"Content-Disposition": `attachment; filename="${email.id}.eml"`,
			"Cache-Control": "no-store",
			"X-Raw-Sha256": artifact.sha256,
		},
	});
});

emails.get("/api/emails/:id/raw/headers", async (c) => {
	const emailId = c.req.param("id");
	const domainScope = getDomainScope(c.env);
	const { email, error } = await db.getEmailById(c.env.D1, emailId, domainScope);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!email) return c.json(ERR("NOT_FOUND", "Email not found"), 404);

	const [{ artifact, error: artifactError }, { check, error: checkError }] = await Promise.all([
		getRawEmailArtifactByEmailId(c.env.D1, emailId),
		getEmailFidelityCheckByEmailId(c.env.D1, emailId),
	]);

	if (artifactError) return c.json(ERR("D1_ERROR", artifactError.message), 500);
	if (checkError) return c.json(ERR("D1_ERROR", checkError.message), 500);

	return c.json(
		OK({
			email: {
				id: email.id,
				subject: email.subject,
				from_address: email.from_address,
				to_address: email.to_address,
				domain: email.domain,
				mailbox: email.mailbox,
				received_at: email.received_at,
			},
			artifact,
			raw_headers: check?.raw_headers ?? null,
			stored_headers: check?.stored_headers ?? null,
			envelope: check?.envelope ?? null,
		}),
	);
});

emails.get("/api/emails/:id/fidelity", async (c) => {
	const emailId = c.req.param("id");
	const domainScope = getDomainScope(c.env);
	const { email, error } = await db.getEmailById(c.env.D1, emailId, domainScope);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!email) return c.json(ERR("NOT_FOUND", "Email not found"), 404);

	const [{ artifact, error: artifactError }, { check, error: checkError }] = await Promise.all([
		getRawEmailArtifactByEmailId(c.env.D1, emailId),
		getEmailFidelityCheckByEmailId(c.env.D1, emailId),
	]);

	if (artifactError) return c.json(ERR("D1_ERROR", artifactError.message), 500);
	if (checkError) return c.json(ERR("D1_ERROR", checkError.message), 500);

	return c.json(OK({ artifact, check }));
});

/**
 * Phase 5: generate an .ics calendar file from an email so the user can
 * turn a kept-unread email into a scheduled reminder in their calendar
 * app of choice. Defaults to tomorrow 9am local (30-min block) and
 * includes a deep-link back to the email in MailClaw.
 *
 * Query params:
 *   - starts_at: optional unix ms override for the event start
 *   - duration:  optional duration in minutes (default 30)
 */
emails.get("/api/emails/:id/calendar.ics", async (c) => {
	const domainScope = getDomainScope(c.env);
	const emailId = c.req.param("id");
	const { email, error } = await db.getEmailById(c.env.D1, emailId, domainScope);
	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!email) return c.json(ERR("NOT_FOUND", "Email not found"), 404);

	const { buildEmailReminderIcs, defaultReminderStart, safeOrigin } = await import("@/utils/ics");
	const startsAtParam = c.req.query("starts_at");
	const durationParam = c.req.query("duration");
	const startsAtMs =
		startsAtParam && Number.isFinite(Number(startsAtParam))
			? Number(startsAtParam)
			: defaultReminderStart();
	const durationMinutes =
		durationParam && Number.isFinite(Number(durationParam))
			? Math.max(5, Math.min(240, Math.floor(Number(durationParam))))
			: 30;

	// Deep link to the email in the UI. Worker origin (api) ≠ Pages origin
	// (the SPA), so we resolve in priority order:
	//   1. explicit UI_ORIGIN env (most reliable in prod)
	//   2. x-mailclaw-ui-origin header (manual override for tooling)
	//   3. same-origin Referer (the Pages Function proxy sends requests
	//      with the Pages origin as Referer)
	//   4. fallback to the Worker origin (still works — the SPA shell
	//      redirects /?email=... to the right route in dev).
	const envUiOrigin = (c.env as { UI_ORIGIN?: string }).UI_ORIGIN;
	const headerOverride = c.req.header("x-mailclaw-ui-origin");
	const referer = c.req.header("referer");
	const refererOrigin = referer ? safeOrigin(referer) : null;
	const fallbackOrigin = new URL(c.req.url).origin;
	const appOrigin = envUiOrigin || headerOverride || refererOrigin || fallbackOrigin;
	const deepLink = `${appOrigin}/?email=${encodeURIComponent(email.id)}`;

	const subject = email.subject?.trim() || "(no subject)";
	const snippet = (email.text_content ?? "").slice(0, 500).trim();
	const description =
		`From: ${email.from_address}\n\n${snippet}\n\n` + `Open in MailClaw: ${deepLink}`;

	const ics = buildEmailReminderIcs({
		uid: email.id,
		summary: `Follow up: ${subject}`,
		description,
		startsAtMs,
		durationMinutes,
		url: deepLink,
	});

	return new Response(ics, {
		status: 200,
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": `attachment; filename="mailclaw-${email.id}.ics"`,
			"Cache-Control": "no-store",
		},
	});
});

// Download single attachment
emails.get("/api/emails/:id/attachments/:attachmentId", async (c) => {
	if (!c.env.ATTACHMENTS) {
		return c.json(ERR("ATTACHMENTS_DISABLED", "Attachment storage is not configured"), 503);
	}

	const emailId = c.req.param("id");
	const attachmentId = c.req.param("attachmentId");
	const domainScope = getDomainScope(c.env);
	const { attachment, error } = await db.getAttachmentById(
		c.env.D1,
		emailId,
		attachmentId,
		domainScope,
	);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!attachment) return c.json(ERR("NOT_FOUND", "Attachment not found"), 404);

	const object = await c.env.ATTACHMENTS.get(attachment.object_key);

	if (!object) {
		return c.json(ERR("ATTACHMENT_MISSING", "Attachment payload not found in storage"), 404);
	}

	const headers = attachmentResponseHeaders({
		mimeType: attachment.mime_type,
		filename: attachment.filename,
		inline: attachment.disposition === "inline",
	});

	return new Response(object.body, {
		status: 200,
		headers,
	});
});

// Repair/backfill: attach binary payloads to an EXISTING email. The import
// endpoint dedups by message_id and bails before storing, so emails that were
// imported from mailbox backups before the attachment path existed show a
// paperclip with no openable file. This stores the binaries to R2 + inserts the
// attachment rows (which stamp extract_status=pending and refresh
// attachment_names/FTS). Idempotent: if the email already has attachment rows it
// is a no-op, so the backfill driver can be re-run safely.
emails.post("/api/emails/:id/attachments", async (c) => {
	const emailId = c.req.param("id");
	const domainScope = getDomainScope(c.env);

	const parsed = await parseJsonBody(c, repairAttachmentsSchema);
	if ("response" in parsed) return parsed.response;
	const { attachments } = parsed.data;

	const locked = await keyedDraftLock(c, emailId);
	if (locked) return locked;

	const { email, error: emailError } = await db.getEmailById(c.env.D1, emailId, domainScope);
	if (emailError) return c.json(ERR("D1_ERROR", emailError.message), 500);
	if (!email) return c.json(ERR("NOT_FOUND", "Email not found"), 404);

	// Idempotency: never double-insert. If binaries already exist, skip.
	const { attachments: existing, error: existingError } = await db.getAttachmentsByEmailId(
		c.env.D1,
		emailId,
	);
	if (existingError) return c.json(ERR("D1_ERROR", existingError.message), 500);
	if (existing && existing.length > 0) {
		// Idempotent no-op for the binaries, but still heal the flags/thread in
		// case a prior repair inserted rows without reconciling them (e.g. rows
		// present while has_attachments=0 — the worklist-invisible failure class).
		const { threadId } = await db.reconcileEmailAttachmentFlags(c.env.D1, emailId, domainScope);
		if (threadId) await refreshThreadSafe(c.env.D1, threadId);
		return c.json(OK({ repaired: false, reason: "already_present", count: existing.length }));
	}

	if (!c.env.ATTACHMENTS) {
		return c.json(ERR("STORAGE_UNAVAILABLE", "Attachment storage is not configured"), 503);
	}

	const createdAt = email.received_at ?? now();
	const storedAttachments: EmailAttachment[] = [];
	try {
		for (const [index, attachment] of attachments.entries()) {
			const bytes = decodeBase64ToBytes(attachment.content_base64);
			const objectKey = buildAttachmentObjectKey(emailId, index, attachment.filename ?? null);
			await c.env.ATTACHMENTS.put(objectKey, bytes, {
				httpMetadata: { contentType: attachment.mime_type || "application/octet-stream" },
			});
			storedAttachments.push({
				id: createId(),
				email_id: emailId,
				object_key: objectKey,
				filename: attachment.filename ?? null,
				mime_type: attachment.mime_type || "application/octet-stream",
				size: getAttachmentSize(bytes),
				disposition: attachment.disposition ?? null,
				content_id: attachment.content_id ?? null,
				created_at: createdAt,
			});
		}
	} catch (e) {
		// A decode/put failure mid-loop would otherwise orphan the objects already
		// written (rows stay empty, so the idempotency skip wouldn't catch them).
		await deleteAttachmentObjectsBestEffort(
			c.env.ATTACHMENTS,
			storedAttachments.map((a) => a.object_key),
			"attachment_repair_put_cleanup_failed",
		);
		return c.json(
			ERR("STORAGE_ERROR", e instanceof Error ? e.message : "Failed to store attachment payloads"),
			500,
		);
	}

	const insertResult = await db.insertAttachments(c.env.D1, storedAttachments);
	if (!insertResult.success) {
		// Roll back the R2 objects we just wrote so a failed insert doesn't leave
		// orphaned binaries (the rows stay empty, so the idempotency skip wouldn't
		// catch them on re-run). Mirrors the send path's cleanup.
		await deleteAttachmentObjectsBestEffort(
			c.env.ATTACHMENTS,
			storedAttachments.map((a) => a.object_key),
			"attachment_repair_insert_cleanup_failed",
		);
		return c.json(
			ERR("D1_ERROR", insertResult.error?.message || "Failed to insert attachments"),
			500,
		);
	}

	// Reconcile emails.has_attachments / attachment_count with the rows just
	// inserted, then refresh the owning thread aggregate (thread_has_attachments,
	// which list rows read, is recomputed only by app paths — never by a trigger).
	const { threadId, error: reconcileError } = await db.reconcileEmailAttachmentFlags(
		c.env.D1,
		emailId,
		domainScope,
	);
	if (reconcileError) {
		logWarn("attachment_repair_flag_reconcile_failed", {
			...getRequestContext(c),
			email_id: emailId,
			error: reconcileError.message,
		});
	}
	if (threadId) await refreshThreadSafe(c.env.D1, threadId);

	logInfo("attachment_repair", {
		...getRequestContext(c),
		email_id: emailId,
		stored_count: storedAttachments.length,
	});
	return c.json(OK({ repaired: true, count: storedAttachments.length }));
});

// Delete single email
emails.delete("/api/emails/:id", async (c) => {
	const emailId = c.req.param("id");
	const domainScope = getDomainScope(c.env);
	const { attachments, error: attachmentsError } = await db.getAttachmentsByEmailId(
		c.env.D1,
		emailId,
		domainScope,
	);

	if (attachmentsError) return c.json(ERR("D1_ERROR", attachmentsError.message), 500);

	if (c.env.ATTACHMENTS) {
		await Promise.all(
			attachments.map((attachment) => c.env.ATTACHMENTS?.delete(attachment.object_key)),
		);
	}

	const { deleted, error } = await db.deleteEmailById(c.env.D1, emailId, domainScope);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!deleted) return c.json(ERR("NOT_FOUND", "Email not found"), 404);
	return c.json(OK({ message: "Email deleted" }));
});

// Update mailbox state / read state
emails.patch("/api/emails/:id", async (c) => {
	const parsed = await parseJsonBody(c, updateEmailSchema);
	if ("response" in parsed) return parsed.response;

	const domainScope = getDomainScope(c.env);
	const { updated, error } = await db.updateEmailById(
		c.env.D1,
		c.req.param("id"),
		parsed.data as UpdateEmailRequest,
		domainScope,
	);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!updated) return c.json(ERR("NOT_FOUND", "Email not found or no changes requested"), 404);
	return c.json(OK({ message: "Email updated" }));
});

// Hydrate email content (restore html_content / text_content from backups)
emails.patch("/api/emails/:id/hydrate", async (c) => {
	const parsed = await parseJsonBody(c, hydrateEmailSchema);
	if ("response" in parsed) return parsed.response;

	const locked = await keyedDraftLock(c, c.req.param("id"));
	if (locked) return locked;

	const domainScope = getDomainScope(c.env);
	const body = parsed.data as HydrateEmailRequest;
	const { updated, error } = await db.hydrateEmailContent(
		c.env.D1,
		c.req.param("id"),
		{
			html_content: body.html_content,
			text_content: body.text_content,
			attachment_names: body.attachment_names,
			attachment_search_text: body.attachment_search_text,
		},
		domainScope,
	);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!updated) return c.json(ERR("NOT_FOUND", "Email not found"), 404);
	return c.json(OK({ message: "Content hydrated" }));
});

// Batch mailbox actions
emails.post("/api/emails/actions", async (c) => {
	const parsed = await parseJsonBody(c, emailBatchActionSchema);
	if ("response" in parsed) return parsed.response;

	const domainScope = getDomainScope(c.env);
	const { updated, error } = await db.applyEmailBatchAction(
		c.env.D1,
		parsed.data as EmailBatchActionRequest,
		domainScope,
	);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	return c.json(OK({ updated }));
});

// Import email from external source (himalaya sync, Gmail push)
emails.post("/api/emails/import", async (c) => {
	const parsed = await parseJsonBody(c, importEmailSchema);
	if ("response" in parsed) return parsed.response;

	const body = parsed.data as ImportEmailRequest;
	const domainScope = getDomainScope(c.env);

	if (domainScope.length > 0 && !domainScope.includes(body.domain)) {
		return c.json(ERR("FORBIDDEN_DOMAIN", "Domain is not one MailClaw serves"), 403);
	}

	const result = await importEmailRecord(c.env, body, {
		loggingContext: {
			...getRequestContext(c),
			workspace_id: ownerKey(c),
		},
		// FF3: decode any base64 attachment payloads to bytes so they get stored
		// to R2 + an attachments row (the storage path in import-email.ts). Without
		// this they'd be metadata-only (filename counted, no openable file): a
		// paperclip with nothing to open.
		attachments: body.attachments?.map((attachment) => ({
			filename: attachment.filename ?? null,
			mimeType: attachment.mime_type ?? null,
			content: decodeBase64ToBytes(attachment.content_base64),
			disposition: attachment.disposition ?? null,
			contentId: attachment.content_id ?? null,
		})),
	});

	if (
		!result.imported &&
		(result.reason === "duplicate_message_id" || result.reason === "duplicate_content")
	) {
		return c.json(OK({ imported: false, reason: result.reason }));
	}
	if (!result.imported) {
		return c.json(ERR("D1_ERROR", result.reason || "Failed to import email"), 500);
	}
	return c.json(OK({ imported: true, id: result.emailId }));
});

// Store one raw RFC 822 message through the same path as Email Routing
// (src/services/ingest.ts). API token only: this is the transport-independent
// importer (an external IMAP sync today, a Gmail API sync later). Body: the
// raw bytes. Query: domain, mailbox, folder=inbox|sent, seen=0|1,
// lane=live|history (default history), repair_only=0|1 (never insert; the
// re-walk uses it past the trash-purge horizon), mailbox_date=<epoch ms> (the
// mailbox's own date, used only when the message has no Date header), dry_run=0|1.
const MIN_MAILBOX_DATE_MS = Date.UTC(2000, 0, 1);

emails.post("/api/emails/import-raw", async (c) => {
	if (!isPrivileged(c)) {
		return c.json(ERR("FORBIDDEN", "import-raw requires the API token or an administrator"), 403);
	}
	const q = (name: string) => c.req.query(name)?.trim() ?? "";
	const domain = q("domain").toLowerCase();
	const mailbox = q("mailbox").toLowerCase();
	const folder = q("folder") || "inbox";
	const seen = q("seen") || "0";
	const lane = q("lane") || "history";
	const dryRun = q("dry_run") === "1";
	const repairOnly = q("repair_only") === "1";
	// E2E fault injection, fixture mailbox only: the batch fails after the write-ahead and
	// the raw is kept (as Email Routing keeps it) for the replay sweep.
	const fault = q("fault") === "batch" ? "batch" : undefined;
	if (q("fault") && (!fault || mailbox !== "e2e")) {
		return c.json(ERR("VALIDATION_ERROR", "fault=batch is only accepted for mailbox e2e"), 400);
	}
	const domainScope = getDomainScope(c.env);

	if (!domain || !mailbox || mailbox.includes("@")) {
		return c.json(ERR("VALIDATION_ERROR", "domain and mailbox (local part) are required"), 400);
	}
	if (domainScope.length > 0 && !domainScope.includes(domain)) {
		return c.json(ERR("FORBIDDEN_DOMAIN", `Domain ${domain} is not configured`), 403);
	}
	if (folder !== "inbox" && folder !== "sent") {
		return c.json(ERR("VALIDATION_ERROR", "folder must be inbox or sent"), 400);
	}
	if (seen !== "0" && seen !== "1") {
		return c.json(ERR("VALIDATION_ERROR", "seen must be 0 or 1"), 400);
	}
	if (lane !== "live" && lane !== "history") {
		return c.json(ERR("VALIDATION_ERROR", "lane must be live or history"), 400);
	}
	// The mailbox's own date (IMAP INTERNALDATE, epoch ms); used only without a Date header.
	// No upper bound: the sync sends it for every message, and a header-dated message must not
	// fail on it. The lower bound (2000-01-01) rejects a value sent in seconds.
	const mailboxDateRaw = c.req.query("mailbox_date");
	const mailboxDate = mailboxDateRaw === undefined ? undefined : Number(mailboxDateRaw.trim());
	if (
		mailboxDate !== undefined &&
		(!Number.isSafeInteger(mailboxDate) || mailboxDate < MIN_MAILBOX_DATE_MS)
	) {
		return c.json(
			ERR("VALIDATION_ERROR", "mailbox_date must be epoch milliseconds (2000 or later)"),
			400,
		);
	}

	const declared = Number(c.req.header("Content-Length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_RAW_BYTES) {
		return c.json(
			ERR("TOO_LARGE", `Message is ${declared} bytes; the limit is ${MAX_RAW_BYTES}`),
			413,
		);
	}
	const raw = new Uint8Array(await c.req.arrayBuffer());
	if (raw.byteLength === 0) {
		return c.json(ERR("VALIDATION_ERROR", "Body must be the raw RFC 822 message"), 400);
	}

	const result = await ingestRawEmail(c.env, raw, {
		domain,
		mailbox,
		folder,
		seen: seen === "1",
		lane,
		source: `import-raw:${lane}`,
		sourceType: "import-raw",
		envelope: null,
		mailboxDate,
		domainScope,
		matchLegacy: true,
		rawIsOnlyCopy: Boolean(fault),
		faultInjection: fault,
		repairOnly,
		dryRun,
	});

	const context = { ...getRequestContext(c), domain, mailbox, folder, lane };
	switch (result.status) {
		case "rejected":
			logWarn("import_raw_rejected", { ...context, error: result.error });
			return c.json(ERR(result.code, result.error), 413);
		case "failed":
			logError("import_raw_failed", { ...context, stage: result.stage, error: result.error });
			return c.json(ERR("INGEST_FAILED", `${result.stage}: ${result.error}`), 500);
		case "purged":
			return c.json(OK({ status: "purged", id: null, dry_run: dryRun }));
		case "skipped":
			return c.json(OK({ status: "skipped", id: null, reason: result.reason, dry_run: dryRun }));
		case "imported":
			return c.json(
				OK({
					status: "imported",
					id: result.emailId,
					direction: result.direction,
					mailbox_state: result.mailboxState,
					dry_run: dryRun,
				}),
			);
		case "duplicate":
			return c.json(
				OK({ status: "duplicate", id: result.emailId, match: result.match, dry_run: dryRun }),
			);
		case "repaired":
			return c.json(
				OK({
					status: "repaired",
					id: result.emailId,
					match: result.match,
					repaired: result.repaired,
					dry_run: dryRun,
				}),
			);
	}
});

/** The emails row of a new draft (outbound, `draft`), with its thread resolved. */
async function buildDraftRecord(
	c: AppContext,
	body: DraftEmailRequest,
	draftId: string,
	threadId?: string | null,
): Promise<EmailRecord> {
	const sender = parseRecipientParts(body.from);
	const createdAt = now();
	const toAddresses = normalizeAddressList(body.to);
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		body.html ?? null,
		body.text ?? null,
	);

	// A reply pins the original's thread; resolving from References alone
	// can split it when the root was a MailClaw-id thread.
	const draftThreadId =
		threadId ||
		(await resolveThreadIdSafe(c.env.D1, {
			id: draftId,
			message_id: null,
			in_reply_to: body.in_reply_to || null,
			references_header: body.references || null,
			subject: body.subject || null,
		}));

	return {
		id: draftId,
		from_address: normalizeEmailAddress(body.from),
		to_address: toAddresses[0] || "",
		to_addresses: toAddresses,
		cc_addresses: normalizeAddressList(body.cc),
		bcc_addresses: normalizeAddressList(body.bcc),
		reply_to_addresses: normalizeAddressList(body.reply_to),
		domain: sender.domain,
		mailbox: sender.mailbox,
		direction: "outbound",
		mailbox_state: "draft",
		subject: body.subject || null,
		received_at: createdAt,
		sent_at: null,
		read_at: createdAt,
		html_content: htmlContent,
		text_content: textContent,
		message_id: null,
		provider_message_id: null,
		in_reply_to: body.in_reply_to || null,
		references_header: body.references || null,
		has_attachments: false,
		attachment_count: 0,
		draft_revision: 1,
		editor_state_json: body.editor_state_json ?? null,
		thread_id: draftThreadId,
	};
}

/**
 * Insert a draft row (plus attachments and thread aggregate) and return it.
 * With `atomic`, a draft whose attachments fail to save is deleted again, so
 * a send never dispatches a half-prepared message.
 */
async function createDraftRecord(
	c: AppContext,
	body: DraftEmailRequest,
	draftId: string,
	options: { atomic?: boolean; threadId?: string | null } = {},
): Promise<{ draft: Email } | { response: Response }> {
	if (!isSenderDomainAllowed(c.env, body.from)) {
		return {
			response: c.json(
				ERR("FORBIDDEN_FROM_DOMAIN", "Sender domain is not one MailClaw serves"),
				403,
			),
		};
	}

	const domainScope = getDomainScope(c.env);
	const record = await buildDraftRecord(c, body, draftId, options.threadId);
	const { success, error } = await db.createDraft(c.env.D1, record, {
		bucket: c.env.ATTACHMENTS,
	});

	if (!success) {
		return {
			response: c.json(ERR("D1_ERROR", error?.message || "Failed to create draft"), 500),
		};
	}

	if (body.attachments !== undefined) {
		const attachmentResult = await replaceDraftAttachments(
			c.env,
			draftId,
			body.attachments,
			record.received_at,
			domainScope,
		);
		if (!attachmentResult.success) {
			if (options.atomic) {
				await deleteDraftBestEffort(c, draftId);
			}
			return {
				response: c.json(
					ERR(
						"ATTACHMENT_SAVE_FAILED",
						attachmentResult.error?.message || "Failed to save draft attachments",
					),
					500,
				),
			};
		}
	}

	// Without this refresh, the thread row is never created for the draft,
	// which means the draft is invisible to every list/count query (they all
	// JOIN threads). Drafts appeared saved but never showed up in the
	// Drafts folder or the sidebar counter. See services/threads.ts for the
	// aggregate computation.
	if (record.thread_id) {
		await refreshThreadSafe(c.env.D1, record.thread_id);
	}

	const createdDraft = await db.getEmailById(c.env.D1, draftId, domainScope, {
		bucket: c.env.ATTACHMENTS,
	});
	if (createdDraft.error || !createdDraft.email) {
		if (options.atomic) {
			await deleteDraftBestEffort(c, draftId);
		}
		return {
			response: c.json(
				ERR("D1_ERROR", createdDraft.error?.message || "Failed to load created draft"),
				500,
			),
		};
	}
	return { draft: createdDraft.email };
}

/** Remove a draft that never became sendable, including its stored objects. */
async function deleteDraftBestEffort(c: AppContext, draftId: string): Promise<boolean> {
	const domainScope = getDomainScope(c.env);
	const { attachments } = await db.getAttachmentsByEmailId(c.env.D1, draftId, domainScope);
	await deleteAttachmentObjectsBestEffort(
		c.env.ATTACHMENTS,
		attachments.map((attachment) => attachment.object_key),
		"draft_cleanup_attachment_delete_failed",
	);
	const { error } = await db.deleteEmailById(c.env.D1, draftId, domainScope);
	if (error) {
		logWarn("draft_cleanup_failed", {
			...getRequestContext(c),
			draft_id: draftId,
			error: error.message,
		});
		return false;
	}
	return true;
}

// Create draft
emails.post("/api/emails/drafts", async (c) => {
	const parsed = await parseJsonBody(c, draftEmailSchema);
	if ("response" in parsed) return parsed.response;

	const created = await createDraftRecord(c, parsed.data as DraftEmailRequest, createId());
	if ("response" in created) return created.response;
	return c.json(OK({ draft: created.draft, saved_at: created.draft.received_at }));
});

/**
 * A draft created by an API/CLI send belongs to its idempotency key and is
 * immutable: editing it would let a retry of the old key send new content.
 * Delete it and send a new message instead. A keyless draft's guard row
 * (DRAFT_GUARD) commits to no content, so that draft stays editable.
 */
async function keyedDraftLock(c: AppContext, emailId: string): Promise<Response | null> {
	const { key, error } = await getSendKey(c.env.D1, emailId);
	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!key || key.fingerprint === DRAFT_GUARD) return null;
	return c.json(
		ERR(
			"DRAFT_LOCKED",
			"This message was submitted by the API/CLI and can't be edited. Delete it and send a new one.",
		),
		409,
	);
}

// Update draft
emails.patch("/api/emails/drafts/:id", async (c) => {
	const parsed = await parseJsonBody(c, updateDraftSchema);
	if ("response" in parsed) return parsed.response;

	const body = parsed.data as UpdateDraftRequest;
	const draftId = c.req.param("id");
	const domainScope = getDomainScope(c.env);
	if (body.from && !isSenderDomainAllowed(c.env, body.from)) {
		return c.json(ERR("FORBIDDEN_FROM_DOMAIN", "Sender domain is not one MailClaw serves"), 403);
	}

	const locked = await keyedDraftLock(c, draftId);
	if (locked) return locked;

	if (body.draft_revision !== undefined) {
		const latestDraft = await db.getEmailById(c.env.D1, draftId, domainScope, {
			bucket: c.env.ATTACHMENTS,
		});
		if (latestDraft.error) return c.json(ERR("D1_ERROR", latestDraft.error.message), 500);
		if (!latestDraft.email || latestDraft.email.mailbox_state !== "draft") {
			return c.json(ERR("NOT_FOUND", "Draft not found"), 404);
		}
		if ((latestDraft.email.draft_revision ?? 0) !== body.draft_revision) {
			return c.json(
				{
					success: false as const,
					error: {
						code: "DRAFT_CONFLICT",
						message: "A newer version of this draft exists.",
					},
					data: {
						latest_draft: latestDraft.email,
						latest_saved_at: latestDraft.email.received_at,
					},
				},
				409,
			);
		}
	}

	const updates: UpdateDraftRequest = { ...body };
	if (body.from) {
		const sender = parseRecipientParts(body.from);
		updates.domain = sender.domain;
		updates.mailbox = sender.mailbox;
	}
	if (body.html !== undefined || body.text !== undefined) {
		const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
			body.html ?? null,
			body.text ?? null,
		);
		updates.html = htmlContent;
		updates.text = textContent;
	}
	if (body.draft_revision !== undefined) {
		updates.draft_revision = body.draft_revision + 1;
	}
	if (body.editor_state_json !== undefined) {
		updates.editor_state_json = body.editor_state_json;
	}

	const updateResult = await db.updateDraftById(c.env.D1, draftId, updates, domainScope, {
		bucket: c.env.ATTACHMENTS,
		expectedDraftRevision: body.draft_revision,
	});

	if (updateResult.error) return c.json(ERR("D1_ERROR", updateResult.error.message), 500);
	if (!updateResult.updated) {
		const latestDraft = await db.getEmailById(c.env.D1, draftId, domainScope, {
			bucket: c.env.ATTACHMENTS,
		});
		if (latestDraft.error) return c.json(ERR("D1_ERROR", latestDraft.error.message), 500);
		if (!latestDraft.email || latestDraft.email.mailbox_state !== "draft") {
			return c.json(ERR("NOT_FOUND", "Draft not found"), 404);
		}
		if (body.draft_revision !== undefined) {
			return c.json(
				{
					success: false as const,
					error: {
						code: "DRAFT_CONFLICT",
						message: "A newer version of this draft exists.",
					},
					data: {
						latest_draft: latestDraft.email,
						latest_saved_at: latestDraft.email.received_at,
					},
				},
				409,
			);
		}
		return c.json(ERR("NOT_FOUND", "Draft not found"), 404);
	}

	if (body.attachments !== undefined) {
		const attachmentResult = await replaceDraftAttachments(
			c.env,
			draftId,
			body.attachments,
			now(),
			domainScope,
		);
		if (!attachmentResult.success) {
			return c.json(
				ERR(
					"ATTACHMENT_SAVE_FAILED",
					attachmentResult.error?.message || "Failed to save draft attachments",
				),
				500,
			);
		}
	}

	const updatedDraft = await db.getEmailById(c.env.D1, draftId, domainScope, {
		bucket: c.env.ATTACHMENTS,
	});
	if (updatedDraft.error || !updatedDraft.email) {
		return c.json(
			ERR("D1_ERROR", updatedDraft.error?.message || "Failed to load updated draft"),
			500,
		);
	}

	// Subject/body/participants changes affect thread aggregates (subject
	// line for grouping, latest_email_id for list queries, participants for
	// the summary row). Refresh after any update.
	if (updatedDraft.email.thread_id) {
		await refreshThreadSafe(c.env.D1, updatedDraft.email.thread_id);
	}

	return c.json(OK({ draft: updatedDraft.email, saved_at: updatedDraft.email.received_at }));
});

/**
 * Send a saved draft. Shared by the UI draft route, API/CLI sends and
 * replies; `threadId` pins a keyless reply to its original's thread (a keyed
 * draft keeps the thread it was prepared in).
 */
async function sendDraftById(
	c: AppContext,
	draftId: string,
	options: { threadId?: string | null; charged: boolean },
): Promise<Response> {
	// The gate runs before any content is read, so a draft can only be
	// dispatched by the one request that moved its key row to `dispatching`.
	const gate = await gateDispatch(c, draftId, { charged: options.charged });
	if (gate.response) return gate.response;
	const dispatch = gate.dispatch as Dispatch;
	try {
		await sendFault(c, "dispatch.begun");
		return await sendDraftContent(c, draftId, { threadId: options.threadId, dispatch });
	} catch (err) {
		return dispatchThrew(c, draftId, dispatch, err);
	} finally {
		// If it stopped before the submission marker (validation, missing
		// attachment, not a draft, a thrown R2 read), hand the row back so the
		// same key can be retried. A no-op once the marker is set.
		const released = await releaseSendKeyDispatch(c.env.D1, draftId, dispatch.token, now());
		if (released.error) {
			logError("send_key_release_failed", {
				...getRequestContext(c),
				draft_id: draftId,
				error: released.error.message,
			});
		}
	}
}

/**
 * The dispatch threw. sendAndPersistEmail catches everything after the submission marker, so
 * this is normally before it (nothing went out); if this dispatch's marker is set anyway, the
 * provider may have the message.
 */
async function dispatchThrew(
	c: AppContext,
	emailId: string,
	dispatch: Dispatch,
	err: unknown,
): Promise<Response> {
	logError("send_dispatch_threw", {
		...getRequestContext(c),
		draft_id: emailId,
		error: err instanceof Error ? err.message : String(err),
	});
	const { key, error } = await getSendKey(c.env.D1, emailId);
	if (!error && key?.owner === dispatch.token && key.submitted_at != null) {
		return sendError(
			c,
			"SEND_STATUS_UNKNOWN",
			"MailClaw could not confirm the delivery outcome. Check Sent before retrying.",
			409,
			emailId,
			"unconfirmed",
		);
	}
	return retryResponse(c, emailId);
}

async function sendDraftContent(
	c: AppContext,
	draftId: string,
	options: { threadId?: string | null; dispatch: Dispatch },
): Promise<Response> {
	const domainScope = getDomainScope(c.env);
	const { email, error } = await db.getEmailById(c.env.D1, draftId, domainScope, {
		bucket: c.env.ATTACHMENTS,
	});

	if (error) return retryResponse(c, draftId);
	if (!email) {
		return c.json(ERR("NOT_FOUND", "Draft not found"), 404);
	}
	if (email.mailbox_state !== "draft") {
		// Only provider acceptance proves delivery; mailbox_state alone does
		// not (an unsent draft can be archived or trashed).
		if (email.direction === "outbound" && email.provider_message_id) {
			const senderDomain = parseRecipientParts(email.from_address).domain;
			const provider =
				getSendMode(c.env) === "record" ? "record" : getEmailProviderName(c.env, senderDomain);
			return c.json(
				OK({
					id: email.provider_message_id,
					provider,
					persisted: true,
					already_sent: true,
					email_id: email.id,
					state: "sent" as const,
				}),
			);
		}
		return c.json(ERR("NOT_FOUND", "Draft not found"), 404);
	}
	if (email.html_in_r2 && !email.html_content) {
		// The stored HTML could not be read: never send the message without it.
		return retryResponse(
			c,
			draftId,
			"DRAFT_BODY_UNAVAILABLE",
			"MailClaw could not read this message's stored HTML, so nothing was sent. Try again (with the same idempotency key, if it has one).",
		);
	}

	let sendPayload = canonicalizeSendPayload(buildDraftSendPayload(email));
	let hostedAttachmentCount = 0;

	// Hydrate small attachments into the outbound message. Larger sets become
	// signed secure download links, Gmail-style, so the send provider does not
	// reject the message after MIME/base64 expansion.
	if (email.attachments.length > 0) {
		const attachmentsBucket = c.env.ATTACHMENTS;
		if (!attachmentsBucket) {
			return c.json(
				ERR("ATTACHMENTS_DISABLED", "Attachment storage is required to send this draft"),
				503,
			);
		}
		const missing = (att: EmailAttachment) =>
			c.json(
				ERR("DRAFT_ATTACHMENT_MISSING", `Draft attachment is missing: ${att.filename || att.id}`),
				409,
			);
		const inlineAttachments = email.attachments.filter((att) => Boolean(att.content_id));
		const hostableAttachments = email.attachments.filter((att) => !att.content_id);
		const hostableAttachmentBytes = hostableAttachments.reduce(
			(total, att) => total + (att.size || 0),
			0,
		);
		// The draft path decides hosted-vs-inline BEFORE a provider exists, so
		// derive the limit from the sender domain's routing directly.
		const draftSenderDomain = parseRecipientParts(sendPayload.from).domain;
		const draftProviderName = getEmailProviderName(c.env, draftSenderDomain);
		const hydrateAttachmentRows = async (rows: EmailAttachment[]) => {
			const hydrated = [];
			for (const att of rows) {
				const object = await attachmentsBucket.get(att.object_key);
				if (!object) return { error: missing(att) };
				const bytes = new Uint8Array(await object.arrayBuffer());
				hydrated.push({
					filename: att.filename || "attachment",
					content_type: att.mime_type || "application/octet-stream",
					content_base64: encodeBytesToBase64(bytes),
					content_id: att.content_id || undefined,
					disposition: (att.disposition as "attachment" | "inline") || "attachment",
				});
			}
			return { hydrated };
		};

		if (hostableAttachmentBytes > getDirectAttachmentLimit(draftProviderName)) {
			// A link must lead to its file: check every one before promising it.
			for (const att of hostableAttachments) {
				if (!(await attachmentsBucket.head(att.object_key))) return missing(att);
			}
			// A keyed message's links are frozen to when it was prepared, so every
			// attempt sends the same body; they expire 90 days after that. Deleting
			// the message deletes the files behind them.
			const issuedAt = options.dispatch.keyed ? email.received_at : now();
			sendPayload = await withHostedAttachmentLinks(
				c,
				sendPayload,
				hostableAttachments,
				Math.floor(issuedAt / 1000) + HOSTED_ATTACHMENT_LINK_TTL_SECONDS,
			);
			hostedAttachmentCount = hostableAttachments.length;
			// cid: parts can never become download links: the HTML references
			// require those MIME parts to travel with the message.
			const inline = await hydrateAttachmentRows(inlineAttachments);
			if (inline.error) return inline.error;
			if (inline.hydrated && inline.hydrated.length > 0) {
				sendPayload.attachments = inline.hydrated;
			}
		} else {
			const all = await hydrateAttachmentRows(email.attachments);
			if (all.error) return all.error;
			sendPayload.attachments = all.hydrated;
		}
	}

	const validated = sendEmailSchema.safeParse(sendPayload);
	if (!validated.success) {
		return c.json(
			ERR("INVALID_DRAFT", validated.error.issues.map((issue) => issue.message).join("; ")),
			400,
		);
	}

	const permissionError = validateSendPermissions(c, validated.data);
	if (permissionError) return permissionError;

	return sendAndPersistEmail(c, validated.data, {
		draftId: email.id,
		hostedAttachmentCount,
		storedAttachmentCount: email.attachments.length,
		threadId: options.threadId,
		draftThreadId: email.thread_id,
		dispatch: options.dispatch,
	});
}

type NewDraft = DraftEmailRequest & { to: string[]; subject: string };
type Composed = { draft: NewDraft; threadId?: string | null } | { response: Response };

/** A new message for sendNewMessage: an API/CLI send, or a reply composed from its original. */
interface NewMessage {
	/**
	 * The message to store (without its files). A reply composes it from the original, which
	 * can change over time, so it runs only when a draft row must still be written. Returns a
	 * refusal (404, 400, 403) as a response; throws on storage errors.
	 */
	compose: () => Promise<Composed>;
	/** The files as requested. Fixed by the request, so known without composing. */
	attachments: SendEmailAttachment[];
	/** What a key commits to: the content for /send, the request for /reply. */
	fingerprint: () => Promise<string>;
	/** The fingerprint an old Worker stored for the same request (a reply's composed content). */
	legacyFingerprint?: () => Promise<string | null>;
}

/** Content fingerprint of a new message (v50); /send keys commit to it. */
function contentFingerprint(draft: NewDraft, attachments: SendEmailAttachment[]) {
	return sendFingerprint({
		from: draft.from,
		to: draft.to,
		cc: normalizeAddressList(draft.cc),
		bcc: normalizeAddressList(draft.bcc),
		reply_to: normalizeAddressList(draft.reply_to),
		subject: draft.subject,
		text: draft.text ?? null,
		html: draft.html ?? null,
		in_reply_to: draft.in_reply_to ?? null,
		references: draft.references ?? null,
		attachments,
	});
}

/**
 * Send a new message (API/CLI send or reply). It becomes a draft first, so the draft's send
 * key row guards dispatch. With an idempotency key the draft id is derived from the key, and
 * the key row is read before anything else: a known key is answered from its stored status
 * (free of the send quota); an unreadable one is answered `retry` (ticket 08).
 */
async function sendNewMessage(
	c: AppContext,
	message: NewMessage,
	idempotencyKey: string | undefined,
): Promise<Response> {
	if (!idempotencyKey) return sendUnkeyed(c, message);
	c.set("idempotencyKey", idempotencyKey);

	const keyId = await sendKeyId(sendKeyScope(c), idempotencyKey);
	const fingerprint = await message.fingerprint();
	const lookup = sendFaultFails(c, "lookup")
		? { key: null, error: new Error("test fault injected at lookup") }
		: await getSendKey(c.env.D1, keyId);
	if (lookup.error) {
		logError("send_key_lookup_failed", {
			...getRequestContext(c),
			key_id: keyId,
			error: lookup.error.message,
		});
		return retryResponse(c, keyId);
	}

	let key = lookup.key;
	let composed: Composed | undefined;
	try {
		if (!key) {
			// A new key: refuse what can't be sent before committing the key to it.
			composed = await message.compose();
			if ("response" in composed) return composed.response;
			const reservation = await reserveSendKey(c.env.D1, keyId, fingerprint, createId(), now());
			if (reservation.error || (!reservation.reserved && !reservation.existing)) {
				throw reservation.error ?? new Error("key row vanished");
			}
			key = reservation.existing;
		}
		if (
			key &&
			key.fingerprint !== fingerprint &&
			key.fingerprint !== (await message.legacyFingerprint?.())
		) {
			return c.json(
				ERR(
					"IDEMPOTENCY_KEY_REUSED",
					"This idempotency key was already used for a different message. Use a new key.",
				),
				409,
			);
		}
	} catch (err) {
		logError("send_key_reserve_failed", {
			...getRequestContext(c),
			key_id: keyId,
			error: err instanceof Error ? err.message : String(err),
		});
		return retryResponse(c, keyId);
	}
	if (key && key.status !== "preparing") return answerKnownKey(c, key);

	// `preparing`: reserved just now, or by an attempt that died or is still running.
	// Either way this request writes whatever is missing and publishes the message.
	try {
		await sendFault(c, "prepare.reserved");
		const refused = await prepareKeyedMessage(c, keyId, message, composed);
		if (refused) return refused;
		const published = await publishSendKeyReady(c.env.D1, keyId, now());
		if (published.error) throw published.error;
		await sendFault(c, "prepare.ready");
	} catch (err) {
		logError("send_prepare_incomplete", {
			...getRequestContext(c),
			key_id: keyId,
			error: err instanceof Error ? err.message : String(err),
		});
		return retryResponse(c, keyId);
	}
	return sendDraftById(c, keyId, { charged: false });
}

/** A key past preparation: the gate answers from its status, or dispatches it. */
async function answerKnownKey(c: AppContext, key: SendKey): Promise<Response> {
	const keyId = key.key_id;
	const domainScope = getDomainScope(c.env);
	const { email, error } = await db.getEmailById(c.env.D1, keyId, domainScope);
	if (error) return retryResponse(c, keyId);
	if (email) return sendDraftById(c, keyId, { charged: false });
	// The email row is gone; the key alone still knows the outcome.
	// Re-read it: a concurrent send may have settled it meanwhile.
	const { key: current, error: keyError } = await getSendKey(c.env.D1, keyId);
	if (keyError || !current) return retryResponse(c, keyId);
	if (current.status === "sent") {
		return c.json(
			OK({
				id: current.provider_message_id,
				provider: null,
				persisted: false,
				already_sent: true,
				email_id: keyId,
				state: "sent" as const,
			}),
		);
	}
	const submitted = current.status === "dispatching" && current.submitted_at != null;
	if (current.status === "unknown" || submitted) {
		return sendError(
			c,
			"SEND_STATUS_UNKNOWN",
			"MailClaw could not confirm the delivery outcome. Check Sent before retrying.",
			409,
			keyId,
			"unconfirmed",
		);
	}
	if (current.status === "dispatching") {
		if (now() - current.updated_at <= SEND_STALL_MS) {
			return sendError(
				c,
				"SEND_IN_PROGRESS",
				"This message is already being sent.",
				409,
				keyId,
				"sending",
			);
		}
		// Stalled before its submission marker: fence the old dispatcher
		// out (it can no longer mark or submit), then hand the key back.
		const fence = createId();
		const taken = await beginSendKeyDispatch(c.env.D1, current, fence, now());
		if (taken.error) return retryResponse(c, keyId);
		if (!taken.updated) {
			return sendError(
				c,
				"SEND_IN_PROGRESS",
				"This message is already being sent.",
				409,
				keyId,
				"sending",
			);
		}
		await releaseSendKeyDispatch(c.env.D1, keyId, fence, now());
	}
	// ready or failed: provably not delivered, and the draft was deleted.
	return sendError(
		c,
		"SEND_CANCELLED",
		"This message's draft was deleted before it was sent. Use a new key to send it.",
		410,
		keyId,
		"failed",
	);
}

/**
 * Write a keyed message's immutable pieces, or finish the ones a dead or concurrent attempt
 * left missing, and verify all of them (ticket 08). Every attempt with the key writes the same
 * thing (the fingerprint pins it; a reply's first composition is frozen in its row), every
 * write is insert-if-missing, and nothing is deleted, so overlapping attempts can't damage
 * each other and a dead one strands nothing. Returns a refusal, or null when the draft row,
 * its body and its files are complete. Throws on storage errors (the caller answers `retry`).
 */
async function prepareKeyedMessage(
	c: AppContext,
	keyId: string,
	message: NewMessage,
	composed?: Composed,
): Promise<Response | null> {
	const domainScope = getDomainScope(c.env);
	let { email, error } = await db.getEmailById(c.env.D1, keyId, domainScope);
	if (error) throw error;
	if (!email) {
		const built = composed ?? (await message.compose());
		if ("response" in built) return built.response;
		if (!isSenderDomainAllowed(c.env, built.draft.from)) {
			return c.json(ERR("FORBIDDEN_FROM_DOMAIN", "Sender domain is not one MailClaw serves"), 403);
		}
		const record = await buildDraftRecord(c, built.draft, keyId, built.threadId);
		const inserted = await db.insertEmail(c.env.D1, record, {
			bucket: c.env.ATTACHMENTS,
			preparedBody: true,
			ifMissing: true,
		});
		if (!inserted.success) throw inserted.error ?? new Error("Failed to create draft");
		if (record.thread_id) await refreshThreadSafe(c.env.D1, record.thread_id);
		({ email, error } = await db.getEmailById(c.env.D1, keyId, domainScope));
		if (error || !email) throw error ?? new Error("keyed draft row missing after insert");
	}
	// Already dispatched (or moved out of Drafts): the gate answers from the key.
	if (email.mailbox_state !== "draft") return null;
	if (
		email.html_in_r2 &&
		email.r2_html_key &&
		!(await c.env.ATTACHMENTS?.head(email.r2_html_key))
	) {
		throw new Error(`prepared body missing: ${email.r2_html_key}`);
	}
	await sendFault(c, "prepare.body");

	const rows: EmailAttachment[] = [];
	if (message.attachments.length > 0) {
		const bucket = c.env.ATTACHMENTS;
		if (!bucket) throw new Error("Attachment storage is required to send attachments");
		for (const [index, attachment] of message.attachments.entries()) {
			const bytes = decodeBase64ToBytes(attachment.content_base64);
			const sha256 = await sha256Hex(bytes);
			const objectKey = buildSendAttachmentKey(keyId, index, sha256, attachment.filename);
			const contentType = attachment.content_type || "application/octet-stream";
			await putImmutableObject(bucket, objectKey, bytes, sha256, contentType);
			await sendFault(c, `prepare.object.${index}`);
			rows.push({
				// The id carries the position: rows share created_at and read back by id.
				id: `${keyId}a${String(index).padStart(2, "0")}`,
				email_id: keyId,
				object_key: objectKey,
				filename: attachment.filename,
				mime_type: contentType,
				size: bytes.byteLength,
				disposition: attachment.disposition || "attachment",
				content_id: attachment.content_id ?? null,
				created_at: email.received_at,
			});
		}
	}
	await sendFault(c, "prepare.objects");

	const written = await db.ensureSendAttachments(c.env.D1, keyId, rows);
	if (written.error) throw written.error;
	await sendFault(c, "prepare.rows");

	const stored = await db.getAttachmentsByEmailId(c.env.D1, keyId, domainScope);
	if (stored.error) throw stored.error;
	const field = (row: EmailAttachment) =>
		JSON.stringify([
			row.id,
			row.object_key,
			row.filename,
			row.mime_type,
			row.size,
			row.disposition,
			row.content_id ?? null,
		]);
	if (stored.attachments.map(field).join("\n") !== rows.map(field).join("\n")) {
		// Changed under us: an old Worker still preparing, or the draft just left Drafts.
		throw new Error("keyed draft attachment rows do not match the prepared files");
	}
	return null;
}

function hex(buffer: ArrayBuffer | undefined): string | null {
	if (!buffer) return null;
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Create-only write of content-addressed bytes (its key names its sha256), verified. Safe to
 * repeat and to race: R2 checks the uploaded bytes against `sha256`, and an object that is
 * already there must carry the same checksum.
 */
async function putImmutableObject(
	bucket: R2Bucket,
	key: string,
	bytes: Uint8Array,
	sha256: string,
	contentType: string,
): Promise<void> {
	const options = { sha256, httpMetadata: { contentType } };
	const written = await bucket.put(key, bytes, {
		...options,
		onlyIf: new Headers({ "If-None-Match": "*" }),
	});
	if (written) return;
	// null: the precondition failed, an earlier or concurrent attempt wrote it first.
	const existing = await bucket.head(key);
	if (!existing) throw new Error(`attachment object ${key} vanished`);
	if (hex(existing.checksums.sha256) === sha256) return;
	// Not ours (no checksum, or other bytes): replace exactly that version.
	const replaced = await bucket.put(key, bytes, {
		...options,
		onlyIf: { etagMatches: existing.etag },
	});
	if (!replaced) throw new Error(`attachment object ${key} changed while being repaired`);
}

/** A keyless send: a fresh draft, dispatched once; deleted again if dispatch never started. */
async function sendUnkeyed(c: AppContext, message: NewMessage): Promise<Response> {
	const limited = enforceSendRateLimit(c);
	if (limited) return limited;
	let composed: Composed;
	try {
		composed = await message.compose();
	} catch (err) {
		return c.json(ERR("D1_ERROR", err instanceof Error ? err.message : String(err)), 500);
	}
	if ("response" in composed) return composed.response;
	const draftId = createId();
	const created = await createDraftRecord(
		c,
		{
			...composed.draft,
			attachments: message.attachments.length > 0 ? message.attachments : undefined,
		},
		draftId,
		{ atomic: true, threadId: composed.threadId },
	);
	if ("response" in created) return created.response;
	const response = await sendDraftById(c, draftId, {
		threadId: composed.threadId,
		charged: true,
	});
	// Failed before any dispatch: nothing was sent, so leave no draft behind.
	if (!response.ok && !(await dispatchStateOf(response))) {
		await deleteDraftBestEffort(c, draftId);
		return withSendState(response, null, "failed");
	}
	return response;
}

/** `data.state` of a send response, if dispatch was reached. */
async function dispatchStateOf(response: Response): Promise<SendState | null> {
	const payload = (await response.clone().json()) as { data?: { state?: SendState } };
	return payload.data?.state ?? null;
}

async function withSendState(response: Response, emailId: string | null, state: SendState) {
	const payload = (await response.json()) as Record<string, unknown> & {
		data?: Record<string, unknown>;
	};
	return new Response(
		JSON.stringify({ ...payload, data: { ...(payload.data ?? {}), email_id: emailId, state } }),
		{ status: response.status, headers: { "Content-Type": "application/json" } },
	);
}

function getIdempotencyKey(c: AppContext, bodyKey: string | undefined): string | undefined {
	return bodyKey?.trim() || c.req.header("Idempotency-Key")?.trim() || undefined;
}

// Send draft
emails.post("/api/emails/drafts/:id/send", async (c) => {
	return sendDraftById(c, c.req.param("id"), { charged: false });
});

const THREADING_HEADERS = new Set(["in-reply-to", "references"]);

// Send email
emails.post("/api/emails/send", async (c) => {
	const parsed = await parseJsonBody(c, sendEmailSchema);
	if ("response" in parsed) return parsed.response;

	const validated = sendEmailSchema.safeParse(
		canonicalizeSendPayload(parsed.data as SendEmailRequest),
	);
	if (!validated.success) {
		return c.json(
			ERR("INVALID_BODY", validated.error.issues.map((issue) => issue.message).join("; ")),
			400,
		);
	}

	const body = validated.data;
	const permissionError = validateSendPermissions(c, body);
	if (permissionError) return permissionError;

	// No live provider implements scheduling. Silently ignoring it would send
	// a "scheduled for tomorrow" message tonight AND record it as sent.
	if (body.scheduled_at) {
		return c.json(ERR("UNSUPPORTED_FIELD", "scheduled_at is not supported"), 400);
	}
	// Every send is stored as a draft first, and drafts only carry the
	// threading headers. Refuse others rather than drop them silently.
	const unsupportedHeaders = Object.keys(body.headers ?? {}).filter(
		(name) => !THREADING_HEADERS.has(name.trim().toLowerCase()),
	);
	if (unsupportedHeaders.length > 0) {
		return c.json(
			ERR(
				"UNSUPPORTED_HEADER",
				`Only In-Reply-To and References headers are supported (got: ${unsupportedHeaders.join(", ")})`,
			),
			400,
		);
	}

	const draft: NewDraft = {
		from: body.from,
		to: normalizeAddressList(body.to),
		subject: body.subject,
		html: body.html,
		text: body.text,
		cc: body.cc,
		bcc: body.bcc,
		reply_to: body.reply_to,
		in_reply_to: getHeaderValue(body.headers, "in-reply-to", "In-Reply-To") ?? undefined,
		references: getHeaderValue(body.headers, "references", "References") ?? undefined,
	};
	const attachments = body.attachments ?? [];
	armSendFault(c, [
		...draft.to,
		...normalizeAddressList(body.cc),
		...normalizeAddressList(body.bcc),
	]);
	return sendNewMessage(
		c,
		{
			compose: async () => ({ draft }),
			attachments,
			fingerprint: () => contentFingerprint(draft, attachments),
		},
		getIdempotencyKey(c, body.idempotency_key),
	);
});

// One user-initiated action. The retired automatic unsubscribe pipeline stays retired.
emails.post("/api/emails/:id/unsubscribe", async (c) => {
	const { email, error } = await db.getEmailById(
		c.env.D1,
		c.req.param("id"),
		getDomainScope(c.env),
	);
	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!email) return c.json(ERR("NOT_FOUND", "Email not found"), 404);
	if (email.direction !== "inbound") {
		return c.json(ERR("INVALID_UNSUBSCRIBE", "Unsubscribe from a received message"), 400);
	}
	const { url, mailto } = parseListUnsubscribe(email.list_unsubscribe);
	const post = url ? await readListUnsubscribePost(c.env, email) : null;
	if (url && /^List-Unsubscribe\s*=\s*One-Click$/i.test(post?.trim() ?? "")) {
		const limited = enforceSendRateLimit(c);
		if (limited) return limited;
		const logId = await startUnsubscribeDecision(c.env.D1, email, "one_click");
		// SEND_MODE=record (SPEC §4): nothing leaves the Worker, the sender's URL included.
		const recorded = getSendMode(c.env) === "record";
		const result = recorded ? { ok: true } : await postOneClickUnsubscribe(url);
		await finishUnsubscribeDecision(c.env.D1, logId, result);
		const data = {
			outcome: result.ok ? "unsubscribed" : "failed",
			method: "one_click",
			http_status: ("status" in result ? result.status : undefined) ?? null,
			...(recorded ? { recorded: true } : {}),
		};
		return result.ok
			? c.json(OK(data))
			: c.json({ ...ERR("UNSUBSCRIBE_FAILED", `Unsubscribe failed: ${result.error}`), data }, 502);
	}
	const mail = mailto ? unsubscribeMailto(mailto) : null;
	if (mail) {
		// The receiving account is the delivery's domain/mailbox, not the visible
		// To header (which may name a list or a forwarded-in address).
		const from = `${email.mailbox}@${email.domain}`;
		const parsed = sendEmailSchema.safeParse({ from, ...mail });
		if (!parsed.success) {
			return c.json(ERR("INVALID_UNSUBSCRIBE", "The unsubscribe mailto address is invalid"), 400);
		}
		const permissionError = validateSendPermissions(c, parsed.data);
		if (permissionError) return permissionError;
		const draft: NewDraft = { from, to: [mail.to], subject: mail.subject, text: mail.text };
		const logId = await startUnsubscribeDecision(c.env.D1, email, "mailto");
		const response = await sendNewMessage(
			c,
			{
				compose: async () => ({ draft }),
				attachments: [],
				fingerprint: () => contentFingerprint(draft, []),
			},
			`unsubscribe-${email.id}`,
		);
		const payload = (await response.json()) as {
			error?: { message?: string };
			data?: { state?: string; email_id?: string };
		};
		const sent = payload.data?.state === "sent";
		const unconfirmed = ["unconfirmed", "sending", "retry"].includes(payload.data?.state ?? "");
		await finishUnsubscribeDecision(c.env.D1, logId, {
			ok: sent,
			status: response.status,
			error: sent ? undefined : (payload.error?.message ?? "Unsubscribe send not confirmed"),
		});
		const data = {
			outcome: sent ? "unsubscribed" : unconfirmed ? "unconfirmed" : "failed",
			method: "mailto",
			email_id: payload.data?.email_id ?? null,
		};
		return sent
			? c.json(OK(data))
			: c.json(
					{
						...ERR(
							"UNSUBSCRIBE_FAILED",
							payload.error?.message ?? "Unsubscribe send not confirmed",
						),
						data,
					},
					502,
				);
	}
	if (url) {
		const logId = await startUnsubscribeDecision(c.env.D1, email, "link");
		await finishUnsubscribeDecision(c.env.D1, logId, { ok: false });
		return c.json(OK({ outcome: "link", method: "link", url }));
	}
	return c.json(
		ERR("INVALID_UNSUBSCRIBE", "This message has no supported unsubscribe method"),
		400,
	);
});

// Reply to an email: recipients, subject, threading headers, From and quote
// are derived from the original. dry_run returns the composed reply only. A
// keyed reply commits to the request; its first composition is frozen.
emails.post("/api/emails/:id/reply", async (c) => {
	const parsed = await parseJsonBody(c, replyEmailSchema);
	if ("response" in parsed) return parsed.response;
	const body = parsed.data;
	const originalId = c.req.param("id");
	const domainScope = getDomainScope(c.env);
	const attachments = body.attachments ?? [];

	let summary: Record<string, unknown> | null = null;
	let dryRun: Record<string, unknown> | null = null;
	const compose = async (): Promise<Composed> => {
		const { email: original, error } = await db.getEmailById(c.env.D1, originalId, domainScope, {
			bucket: c.env.ATTACHMENTS,
		});
		if (error) throw error;
		if (!original) return { response: c.json(ERR("NOT_FOUND", "Email not found"), 404) };
		if (original.mailbox_state === "draft") {
			return {
				response: c.json(ERR("CANNOT_REPLY_TO_DRAFT", "Send or edit the draft instead"), 400),
			};
		}
		const composed = composeReply(
			original,
			{ identities: getAllowedSenders(c.env), sendDomains: domainScope },
			body,
		);
		if (!composed.ok) return { response: c.json(ERR(composed.code, composed.message), 400) };
		const reply = composed.reply;
		if (!isSenderDomainAllowed(c.env, reply.from)) {
			return {
				response: c.json(
					ERR("FORBIDDEN_FROM_DOMAIN", "Sender domain is not one MailClaw serves"),
					403,
				),
			};
		}
		summary = {
			from: reply.from,
			to: reply.to,
			cc: reply.cc,
			subject: reply.subject,
			warnings: reply.warnings,
		};
		dryRun = { ...reply, thread_id: original.thread_id ?? null };
		return {
			draft: {
				from: reply.from,
				to: reply.to,
				cc: reply.cc,
				bcc: reply.bcc,
				subject: reply.subject,
				text: reply.text,
				html: reply.html,
				in_reply_to: reply.in_reply_to ?? undefined,
				references: reply.references ?? undefined,
			},
			threadId: original.thread_id,
		};
	};

	if (body.dry_run) {
		let composed: Composed;
		try {
			composed = await compose();
		} catch (err) {
			return c.json(ERR("D1_ERROR", err instanceof Error ? err.message : String(err)), 500);
		}
		if ("response" in composed) return composed.response;
		return c.json(OK(dryRun));
	}

	const response = await sendNewMessage(
		c,
		{
			compose,
			attachments,
			fingerprint: () => replyRequestFingerprint(originalId, body),
			legacyFingerprint: async () => {
				const composed = await compose();
				return "response" in composed ? null : contentFingerprint(composed.draft, attachments);
			},
		},
		getIdempotencyKey(c, body.idempotency_key),
	);
	const payload = (await response.json()) as { data?: Record<string, unknown> };
	const emailId = payload.data?.email_id;
	if (!summary && typeof emailId === "string") {
		// A replay never composed: describe the frozen reply that was stored.
		const { email } = await db.getEmailById(c.env.D1, emailId, domainScope);
		if (email) {
			summary = {
				from: email.from_address,
				to: email.to_addresses,
				cc: email.cc_addresses,
				subject: email.subject,
				warnings: [],
			};
		}
	}
	return c.json(
		{ ...payload, data: { ...(payload.data ?? {}), ...(summary ?? {}) } },
		response.status as 200,
	);
});

export default emails;
