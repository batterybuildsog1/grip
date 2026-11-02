import { z } from "zod";
import {
	getAttachmentByteLength,
	getAttachmentsTotalBytes,
	MAX_HOSTED_ATTACHMENT_BYTES,
} from "@/utils/attachments";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = MAX_HOSTED_ATTACHMENT_BYTES;

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

const addressSchema = z.string().trim().email();
const optionalAddressListSchema = z.union([addressSchema, z.array(addressSchema)]).optional();

// Draft recipients are unfinished editor input, not delivery instructions.
// Persist their text while typing; sendEmailSchema validates before submission.
const draftRecipientSchema = z.string().trim().max(998);
const optionalDraftRecipientsSchema = z
	.union([draftRecipientSchema, z.array(draftRecipientSchema).max(1000)])
	.optional();

const idempotencyKeySchema = z.string().trim().min(1).max(200).optional();

export const sendEmailAttachmentSchema = z.object({
	filename: z.string().trim().min(1).max(255),
	content_type: z.string().trim().min(1).max(255),
	content_base64: z
		.string()
		.trim()
		.min(1)
		.regex(/^[A-Za-z0-9+/=\s]+$/, "Attachment content must be valid base64"),
	content_id: z.string().trim().min(1).max(255).optional(),
	disposition: z.enum(["attachment", "inline"]).optional(),
});

export const sendEmailSchema = z
	.object({
		from: addressSchema,
		to: z.union([addressSchema, z.array(addressSchema).min(1)]),
		subject: z.string().trim().min(1).max(998),
		html: z.string().optional(),
		text: z.string().optional(),
		cc: optionalAddressListSchema,
		bcc: optionalAddressListSchema,
		reply_to: optionalAddressListSchema,
		headers: z.record(z.string(), z.string()).optional(),
		tag: z.string().trim().min(1).max(100).optional(),
		tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
		message_stream: z.string().trim().min(1).max(100).optional(),
		attachments: z.array(sendEmailAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
		scheduled_at: z.string().optional(),
		idempotency_key: idempotencyKeySchema,
	})
	.superRefine((value, ctx) => {
		if (!value.html && !value.text) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Either html or text content is required",
				path: ["text"],
			});
		}

		if (Array.isArray(value.reply_to) && value.reply_to.length > 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "reply_to must contain at most one address",
				path: ["reply_to"],
			});
		}

		if (value.attachments) {
			const totalBytes = getAttachmentsTotalBytes(value.attachments);
			if (totalBytes > MAX_ATTACHMENT_BYTES) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Attachments exceed the ${formatBytes(MAX_ATTACHMENT_BYTES)} upload limit`,
					path: ["attachments"],
				});
			}

			for (const [index, attachment] of value.attachments.entries()) {
				if (getAttachmentByteLength(attachment) <= 0) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Attachment content must not be empty",
						path: ["attachments", index, "content_base64"],
					});
				}
			}
		}
	});

export const updateEmailSchema = z
	.object({
		mailbox_state: z.enum(["inbox", "sent", "archived", "trash"]).optional(),
		is_read: z.boolean().optional(),
		category: z
			.enum([
				"personal",
				"billing",
				"agents",
				"notifications",
				"newsletters",
				"marketing",
				"spam",
				// Phase 4: new top-level categories
				"home_alerts",
				"tax_documents",
			])
			.nullable()
			.optional(),
		// Phase 4: sub-category. Any string accepted because Home Alerts
		// uses dynamic customer labels. Length-capped to keep the DB clean.
		sub_category: z.string().trim().min(1).max(80).nullable().optional(),
		interest_level: z
			.enum(["very_interested", "interested", "somewhat_interested", "not_interested"])
			.nullable()
			.optional(),
		interest_comment: z.string().trim().max(2000).nullable().optional(),
		// Phase 1.4: user override for the 21-day auto-mark-read cron.
		user_kept_unread: z.boolean().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "At least one field must be provided",
	});

export const hydrateEmailSchema = z
	.object({
		html_content: z.string().nullable().optional(),
		text_content: z.string().nullable().optional(),
		attachment_names: z.string().max(10000).nullable().optional(),
		// v34: extracted attachment text for FTS. Length-capped well under the
		// D1 row limit; extractors should truncate before sending.
		attachment_search_text: z.string().max(200000).nullable().optional(),
	})
	.refine(
		(value) =>
			value.html_content !== undefined ||
			value.text_content !== undefined ||
			value.attachment_names !== undefined ||
			value.attachment_search_text !== undefined,
		{
			message:
				"At least one of html_content, text_content, attachment_names, or attachment_search_text must be provided",
		},
	);

export type HydrateEmailRequest = z.infer<typeof hydrateEmailSchema>;

/**
 * v34 sidecar bookkeeping: PATCH /api/admin/attachments/:id flips a row's
 * extraction status. `skipped:<reason>` is open-ended (size, no-text-layer,
 * type, …) so the extractor can record new skip reasons without a deploy.
 */
export const updateAttachmentExtractStatusSchema = z.object({
	extract_status: z
		.string()
		.regex(
			/^(pending|done|failed|skipped:[a-z0-9_-]+)$/,
			"extract_status must be pending, done, failed, or skipped:<reason>",
		),
});

export type UpdateAttachmentExtractStatusRequest = z.infer<
	typeof updateAttachmentExtractStatusSchema
>;

export const emailBatchActionSchema = z
	.object({
		ids: z.array(z.string().trim().min(1)).default([]),
		thread_ids: z.array(z.string().trim().min(1)).optional(),
		action: z.enum([
			"archive",
			"trash",
			"restore",
			"mark_read",
			"mark_unread",
			"mute",
			"unmute",
			"star",
			"unstar",
			"set_personal",
			"set_billing",
			"set_agents",
			"set_notifications",
			"set_newsletters",
			"set_marketing",
			"set_spam",
			// Phase 4
			"set_home_alerts",
			"set_tax_documents",
			"clear_category",
		]),
	})
	.refine((data) => data.ids.length > 0 || (data.thread_ids && data.thread_ids.length > 0), {
		message: "Either ids or thread_ids must have at least one entry",
	});

export const draftEmailSchema = z
	.object({
		from: addressSchema,
		to: optionalDraftRecipientsSchema,
		subject: z.string().trim().max(998).optional(),
		html: z.string().optional(),
		text: z.string().optional(),
		cc: optionalDraftRecipientsSchema,
		bcc: optionalDraftRecipientsSchema,
		reply_to: optionalDraftRecipientsSchema,
		attachments: z.array(sendEmailAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
		in_reply_to: z.string().trim().min(1).max(998).optional(),
		references: z.string().trim().min(1).max(4000).optional(),
		draft_revision: z.number().int().nonnegative().optional(),
		editor_state_json: z.string().max(500_000).nullable().optional(),
	})
	.superRefine((value, ctx) => {
		if (Array.isArray(value.reply_to) && value.reply_to.length > 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "reply_to must contain at most one address",
				path: ["reply_to"],
			});
		}

		if (value.attachments) {
			const totalBytes = getAttachmentsTotalBytes(value.attachments);
			if (totalBytes > MAX_ATTACHMENT_BYTES) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Attachments exceed the ${formatBytes(MAX_ATTACHMENT_BYTES)} upload limit`,
					path: ["attachments"],
				});
			}
		}
	});

export const replyEmailSchema = z
	.object({
		text: z.string().optional(),
		html: z.string().optional(),
		all: z.boolean().optional(),
		from: addressSchema.optional(),
		cc: z.array(addressSchema).optional(),
		bcc: z.array(addressSchema).optional(),
		quote: z.boolean().optional(),
		attachments: z.array(sendEmailAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
		idempotency_key: idempotencyKeySchema,
		dry_run: z.boolean().optional(),
	})
	.superRefine((value, ctx) => {
		if (!value.html?.trim() && !value.text?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Either html or text content is required",
				path: ["text"],
			});
		}
		if (value.attachments) {
			const totalBytes = getAttachmentsTotalBytes(value.attachments);
			if (totalBytes > MAX_ATTACHMENT_BYTES) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Attachments exceed the ${formatBytes(MAX_ATTACHMENT_BYTES)} upload limit`,
					path: ["attachments"],
				});
			}
		}
	});

export type ReplyEmailRequest = z.infer<typeof replyEmailSchema>;

export const importEmailSchema = z.object({
	from: z.string().trim().min(1),
	to: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]),
	cc: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]).optional(),
	bcc: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]).optional(),
	subject: z.string().max(998).nullable().optional(),
	html: z.string().nullable().optional(),
	text: z.string().nullable().optional(),
	date: z.number().int().positive(),
	message_id: z.string().trim().min(1).optional(),
	source_type: z.string().trim().min(1).max(100).nullable().optional(),
	source_path: z.string().trim().min(1).max(2048).nullable().optional(),
	source_folder: z.string().trim().min(1).max(255).nullable().optional(),
	source_message_id: z.string().trim().min(1).max(998).nullable().optional(),
	in_reply_to: z.string().trim().min(1).optional(),
	references: z.string().trim().min(1).optional(),
	domain: z.string().trim().min(1),
	mailbox: z.string().trim().min(1),
	direction: z.enum(["inbound", "outbound"]).default("inbound"),
	mailbox_state: z.enum(["inbox", "sent", "archived", "trash"]).default("inbox"),
	is_read: z.boolean().default(false),
	has_attachments: z.boolean().default(false),
	attachment_count: z.number().int().nonnegative().default(0),
	// v34: attachment metadata for importers that know filenames but do not
	// carry payloads (e.g. maildir backfills). Counted in has_attachments /
	// attachment_count and indexed via emails.attachment_names; no attachment
	// rows are created (attachments.object_key is NOT NULL).
	attachments_meta: z
		.array(
			z.object({
				filename: z.string().trim().min(1).max(255),
				mime_type: z.string().trim().min(1).max(255).nullable().optional(),
				size: z.number().int().nonnegative().nullable().optional(),
			}),
		)
		.max(100)
		.optional(),
	// FF3: attachment payloads (base64) for importers that DO carry binaries
	// (e.g. the maildir import, which parses the source .eml). These get decoded,
	// stored to R2, and inserted as attachment rows — unlike attachments_meta,
	// which is filename-only and never creates a row. Without them an imported
	// email shows a paperclip with no openable attachment.
	attachments: z
		.array(
			z.object({
				filename: z.string().trim().max(255).nullable().optional(),
				mime_type: z.string().trim().max(255).nullable().optional(),
				// ~26 MB binary cap per attachment (base64 inflates ~33%); bounds
				// worker memory on the import POST (Codex hardening).
				content_base64: z.string().min(1).max(35_000_000),
				disposition: z.string().trim().max(100).nullable().optional(),
				content_id: z.string().trim().max(255).nullable().optional(),
			}),
		)
		.max(100)
		.optional(),
});

export type ImportEmailRequest = z.infer<typeof importEmailSchema>;

// Attaches binary payloads to an EXISTING email (the repair/backfill path). The
// import endpoint dedups by message_id and bails before storing, so historical
// emails imported before the FF3 attachments path can never gain their
// binaries; this schema drives POST /api/emails/:id/attachments instead.
export const repairAttachmentsSchema = z.object({
	attachments: z
		.array(
			z.object({
				filename: z.string().trim().max(255).nullable().optional(),
				mime_type: z.string().trim().max(255).nullable().optional(),
				content_base64: z.string().min(1).max(35_000_000),
				disposition: z.string().trim().max(100).nullable().optional(),
				content_id: z.string().trim().max(255).nullable().optional(),
			}),
		)
		.min(1)
		.max(100),
});

export type RepairAttachmentsRequest = z.infer<typeof repairAttachmentsSchema>;

export const agentChatSchema = z.object({
	message: z.string().trim().min(1).max(2000),
	email_id: z.string().trim().min(1).optional(),
	conversation_id: z.string().trim().min(1).optional(),
});

export const agentFeedbackSchema = z
	.object({
		email_id: z.string().trim().min(1),
		category: z
			.enum([
				"personal",
				"billing",
				"agents",
				"notifications",
				"newsletters",
				"marketing",
				"spam",
				// Phase 4
				"home_alerts",
				"tax_documents",
			])
			.nullable()
			.optional(),
		// Codex phase: corrections can carry a sub-category (new content-based
		// billing/notifications values, agents subs, or a dynamic Home Alerts
		// customer label). Any string accepted, length-capped like
		// updateEmailSchema.
		sub_category: z.string().trim().min(1).max(80).nullable().optional(),
		comment: z.string().trim().min(1).max(2000).optional(),
	})
	.refine(
		(value) =>
			value.category !== undefined ||
			value.sub_category !== undefined ||
			value.comment !== undefined,
		{
			message: "Either category, sub_category, or comment is required",
		},
	);

export const senderRuleSchema = z.object({
	from_pattern: z.string().trim().min(1).max(255),
	category: z.enum([
		"personal",
		"billing",
		"agents",
		"notifications",
		"newsletters",
		"marketing",
		"spam",
		// Phase 4
		"home_alerts",
		"tax_documents",
	]),
	confidence: z.number().min(0).max(1).default(1.0),
});

/** Blocked senders (v33): pattern shape is further validated (address vs
 * bare domain + own-domain foot-gun guard) in validateBlockPattern. */
export const blockSenderSchema = z.object({
	pattern_type: z.enum(["address", "domain"]),
	pattern: z.string().trim().min(3).max(320),
	note: z.string().trim().max(500).optional(),
});

export type BlockSenderRequest = z.infer<typeof blockSenderSchema>;

// --- Codex classify-queue (worker-side sidecar protocol) ---

/** Content-based billing sub-categories (see classify_billing_sub_v1). */
export const billingSubCategorySchema = z.enum([
	"invoice_conversations",
	"failed_payments",
	"receipts",
	"other",
]);

/** Content-based notifications sub-categories (see classify_notification_sub_v1). */
export const notificationSubCategorySchema = z.enum([
	"security",
	"money",
	"orders_shipping",
	"calendar",
	"social",
	"product_noise",
	"other",
]);

const CLASSIFY_QUEUE_MAX_LIMIT = 25;
const CLASSIFY_QUEUE_DEFAULT_LIMIT = 10;
const CLASSIFY_QUEUE_DEFAULT_LEASE_MS = 600_000;

export const classifyQueueClaimSchema = z.object({
	usage_protocol: z.literal(1).optional(),
	worker_id: z.string().trim().min(1).max(100),
	// Clamp rather than reject: a sidecar asking for 100 gets 25.
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.transform((value) =>
			Math.min(value ?? CLASSIFY_QUEUE_DEFAULT_LIMIT, CLASSIFY_QUEUE_MAX_LIMIT),
		),
	lease_ms: z
		.number()
		.int()
		.optional()
		.transform((value) =>
			Math.min(Math.max(value ?? CLASSIFY_QUEUE_DEFAULT_LEASE_MS, 30_000), 3_600_000),
		),
});

const classifyQueueResultSchema = z.object({
	email_id: z.string().trim().min(1),
	category: z
		.enum([
			"personal",
			"billing",
			"agents",
			"notifications",
			"newsletters",
			"marketing",
			"spam",
			"home_alerts",
			"tax_documents",
		])
		.nullable(),
	confidence: z
		.number()
		.optional()
		.transform((value) => Math.min(Math.max(value ?? 0, 0), 1)),
	reasoning: z
		.string()
		.optional()
		.transform((value) => (value ?? "").slice(0, 500)),
	billing_sub: billingSubCategorySchema.nullable().optional(),
	notification_sub: notificationSubCategorySchema.nullable().optional(),
	interest_level: z
		.enum(["very_interested", "interested", "somewhat_interested", "not_interested"])
		.nullable()
		.optional(),
	tokens_used: z.number().int().nonnegative().optional(),
	error: z.string().trim().min(1).max(2000).nullable().optional(),
	// Memory map protocol 3 (v52). Parsed leniently AFTER the category write
	// (src/services/memory-map.ts parseEnrichment): a malformed value must never reject
	// the request, block the category, or trigger a re-ask (review #).
	entities: z.unknown().optional(),
	// An older daemon may still send `proposal`; accepted and ignored (queue cut 2026-10-22).
	proposal: z.unknown().optional(),
	// Action note (v55, 2026-10-14): a string or null, and a YYYY-MM-DD due. Normalized
	// in the route (src/database/notes.ts); a bad value drops, never rejects the batch.
	action_note: z.unknown().optional(),
	action_due: z.unknown().optional(),
});

export const classifyQueueResultsSchema = z.object({
	lease_token: z.string().trim().min(1).max(200),
	worker_id: z.string().trim().min(1).max(100),
	model: z.string().trim().min(1).max(100),
	reasoning_effort: z.string().trim().min(1).max(40).nullable().optional(),
	prompt_version: z.string().trim().min(1).max(100).nullable().optional(),
	results: z.array(classifyQueueResultSchema).min(1).max(CLASSIFY_QUEUE_MAX_LIMIT),
});

export type ClassifyQueueClaimRequest = z.infer<typeof classifyQueueClaimSchema>;
export type ClassifyQueueResultsRequest = z.infer<typeof classifyQueueResultsSchema>;

export const updateDraftSchema = z
	.object({
		from: addressSchema.optional(),
		to: optionalDraftRecipientsSchema,
		subject: z.string().trim().max(998).optional(),
		html: z.string().nullable().optional(),
		text: z.string().nullable().optional(),
		cc: optionalDraftRecipientsSchema,
		bcc: optionalDraftRecipientsSchema,
		reply_to: optionalDraftRecipientsSchema,
		attachments: z.array(sendEmailAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
		in_reply_to: z.string().trim().min(1).max(998).nullable().optional(),
		references: z.string().trim().min(1).max(4000).nullable().optional(),
		draft_revision: z.number().int().nonnegative().optional(),
		editor_state_json: z.string().max(500_000).nullable().optional(),
	})
	.superRefine((value, ctx) => {
		if (Array.isArray(value.reply_to) && value.reply_to.length > 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "reply_to must contain at most one address",
				path: ["reply_to"],
			});
		}

		if (value.attachments) {
			const totalBytes = getAttachmentsTotalBytes(value.attachments);
			if (totalBytes > MAX_ATTACHMENT_BYTES) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Attachments exceed the ${formatBytes(MAX_ATTACHMENT_BYTES)} upload limit`,
					path: ["attachments"],
				});
			}
		}
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "At least one field must be provided",
	});

// ---------------------------------------------------------------------------
// Memory map (v52): entities, links, import
// ---------------------------------------------------------------------------

const entityKindSchema = z.enum(["person", "company", "project", "prospect"]);
const shortStringList = z.array(z.string().max(200)).max(50);

export const entitySetSchema = z
	.object({
		kind: entityKindSchema.optional(),
		name: z.string().max(200).optional(),
		aliases_add: shortStringList.optional(),
		aliases_remove: shortStringList.optional(),
		addresses_add: shortStringList.optional(),
		addresses_remove: shortStringList.optional(),
		parent_id: z.string().trim().min(1).max(100).nullable().optional(),
		notes: z.string().max(2000).nullable().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "At least one field must be provided",
	});

/** The seed file shape (.prototypes/memory-map/seed-draft.json); unknown keys are ignored. */
export const entityImportSchema = z.object({
	dry_run: z.boolean().optional(),
	entities: z
		.array(
			z.object({
				id: z.string().trim().min(1).max(100),
				kind: entityKindSchema,
				name: z.string().max(200),
				aliases: shortStringList.optional(),
				addresses: shortStringList.optional(),
				parent: z.string().trim().min(1).max(100).nullable().optional(),
				notes: z.string().max(2000).nullable().optional(),
				review: z.string().max(500).nullable().optional(),
				owner_threads_12m: z.number().int().nonnegative().optional(),
				measured: z
					.object({ owner_wrote_threads_365d: z.number().int().nonnegative().optional() })
					.optional(),
			}),
		)
		.min(1)
		.max(500),
});

export const entityLinkSchema = z.object({
	target: z.string().trim().min(1).max(200),
	action: z.enum(["link", "unlink"]),
});
