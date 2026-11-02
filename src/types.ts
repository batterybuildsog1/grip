import type { QuoteSplit } from "@/services/quoted";
export type EmailDirection = "inbound" | "outbound";
export type MailboxState = "inbox" | "sent" | "archived" | "trash" | "draft";
export type EmailCategory =
	| "personal"
	| "billing"
	| "agents"
	| "notifications"
	| "newsletters"
	| "marketing"
	| "spam"
	// Phase 4: new top-level categories.
	| "home_alerts"
	| "tax_documents";
export type InterestLevel =
	| "very_interested"
	| "interested"
	| "somewhat_interested"
	| "not_interested";

/**
 * Phase 4: sub-category taxonomy under each top-level EmailCategory.
 * Not every category has sub-categories (Personal, Newsletters, Marketing,
 * Spam, Tax Documents don't split further — Newsletters and Marketing use
 * the interest_level axis instead of sub_category). Home Alerts uses
 * customer_label strings from src/utils/classify.ts, not a fixed enum.
 */
/**
 * Codex-phase taxonomy: Billing sub-categories are CONTENT-based (does money
 * still need to move?), replacing the sender-based trio
 * (saas_subscriptions / business_vendors / utilities). Old values may still
 * exist on rows in the DB and render via raw-key fallback in the UI.
 */
export type BillingSubCategory = "invoice_conversations" | "failed_payments" | "receipts" | "other";
/**
 * Codex-phase taxonomy: Notifications sub-categories are CONTENT-based,
 * replacing the sender-pattern buckets (security_account / orders_deliveries
 * / activity_mentions / updates_newsletters).
 */
export type NotificationSubCategory =
	| "security"
	| "money"
	| "orders_shipping"
	| "calendar"
	| "social"
	| "product_noise"
	| "other";
export type AgentsSubCategory = "broken" | "vendor_status" | "bot_admin";
/**
 * Full enum of statically-known sub-categories. Home Alerts sub-categories
 * are customer_label strings (src/utils/classify.ts) and are not
 * represented here; the classifier writes them verbatim to sub_category.
 */
export type EmailSubCategory = BillingSubCategory | NotificationSubCategory | AgentsSubCategory;

export interface EmailRecord {
	id: string;
	from_address: string;
	from_name?: string | null;
	to_address: string;
	to_addresses: string[];
	cc_addresses: string[];
	bcc_addresses: string[];
	reply_to_addresses: string[];
	domain: string;
	mailbox: string;
	direction: EmailDirection;
	mailbox_state: MailboxState;
	subject: string | null;
	received_at: number;
	sent_at: number | null;
	read_at: number | null;
	html_content: string | null;
	text_content: string | null;
	message_id: string | null;
	provider_message_id: string | null;
	source_type?: string | null;
	source_path?: string | null;
	source_folder?: string | null;
	source_message_id?: string | null;
	in_reply_to: string | null;
	references_header: string | null;
	has_attachments: boolean;
	attachment_count: number;
	list_unsubscribe?: string | null;
	list_unsubscribe_post?: string | null;
	draft_revision?: number;
	editor_state_json?: string | null;
	thread_id?: string | null;
	category?: EmailCategory | null;
	/** Phase 4: sub-category under the top-level category. */
	sub_category?: string | null;
	/** Set with read_at when the auto-read cron marked it; NULL = a human opened it. */
	auto_read_at?: number | null;
	interest_level?: InterestLevel | null;
	interest_comment?: string | null;
	/**
	 * Set to 1 when html_content has been offloaded to R2 (bucket
	 * ATTACHMENTS, key = r2_html_key). When 1, the D1 html_content column
	 * is NULL and callers must hydrate from R2.
	 */
	html_in_r2?: boolean | number;
	/** R2 key where the offloaded HTML body lives, or null if inline in D1. */
	r2_html_key?: string | null;
	/** Read-time quoted-text split (src/services/quoted.ts); absent when nothing is hidden. */
	quote?: QuoteSplit;
}

export interface EmailAttachment {
	id: string;
	email_id: string;
	object_key: string;
	filename: string | null;
	mime_type: string;
	size: number;
	disposition: string | null;
	content_id: string | null;
	created_at: number;
}

export interface Email extends EmailRecord {
	attachments: EmailAttachment[];
}

export type EmailSummary = Omit<
	EmailRecord,
	"html_content" | "text_content" | "message_id" | "in_reply_to" | "references_header"
> & {
	snippet: string | null;
	/** 'attachment' when the search snippet matched only attachment filename/text (FTS cols 9/10). */
	snippet_source?: "attachment" | null;
	thread_id: string | null;
	thread_count: number;
	thread_unread_count: number;
	thread_participants: Array<{ name: string | null; address: string }>;
	thread_has_attachments: boolean;
	thread_is_muted: boolean;
	thread_is_starred: boolean;
};

export interface ConversationParticipant {
	name: string | null;
	address: string;
}

export interface ConversationSummary {
	id: string;
	domain: string;
	subject: string | null;
	latest_message_at: number;
	started_at: number;
	message_count: number;
	unread_count: number;
	mailbox_state: MailboxState;
	has_attachments: boolean;
	attachment_count: number;
	snippet: string | null;
	participants: ConversationParticipant[];
	is_muted: boolean;
	is_starred: boolean;
	category: EmailCategory | null;
	latest_email_id: string | null;
	display_attachment_names: string[];
	display_email_id: string | null;
	display_mailbox_state: MailboxState | null;
	display_direction: EmailDirection | null;
	display_from_address: string | null;
	display_from_name: string | null;
	display_to_address: string | null;
	/**
	 * The name of `display_to_address` on an outbound display message (sent, draft), found at read
	 * time: stored recipients are bare addresses. Null = no name known; show the address.
	 */
	display_to_name: string | null;
	display_to_addresses: string[];
	display_cc_addresses: string[];
	display_bcc_addresses: string[];
	display_received_at: number | null;
	display_sent_at: number | null;
	display_snippet: string | null;
	/** 'attachment' when the search snippet matched only attachment filename/text (FTS cols 9/10). */
	display_snippet_source?: "attachment" | null;
	/**
	 * Subject of the display message. In search results that is the message that matched,
	 * whose subject can differ from the conversation's (`subject`, the first message's).
	 */
	display_subject?: string | null;
}

export type ConversationSort = "latest_desc" | "latest_asc" | "sender" | "subject" | "unread_first";

export interface ConversationFilters {
	domain?: string;
	mailbox_state?: MailboxState;
	category?: EmailCategory | null;
	q?: string;
	/**
	 * Search only. `all` (default): All Mail; the view filters (category, sub_category,
	 * interest_level, self, for_person, mailbox_state, is_read) are not applied and are echoed
	 * in `search.view_filters`. `view`: they are applied, narrowing search to the current view.
	 */
	scope?: "all" | "view";
	/** Search only, per message: one of our addresses (you@example.com). */
	account?: string;
	/** Search only, per message: exact sender / recipient address and direction. */
	from?: string;
	to?: string;
	direction?: EmailDirection;
	after?: number;
	before?: number;
	has_attachments?: boolean;
	is_read?: boolean;
	/**
	 * Phase 1.3: when true, restrict to threads where the user has emailed
	 * themselves (from_address === to_address, both belonging to a configured
	 * mailbox). Sub-folder of Personal.
	 */
	self?: boolean;
	/**
	 * Phase 3.2: interest-level sub-filter under Marketing / Newsletters.
	 */
	interest_level?: InterestLevel;
	/**
	 * Phase 4: sub-category sub-filter (SaaS & Subscriptions, Security &
	 * Account, a HOME_ALERTS_JSON customer label). Passed as a string because
	 * Home Alerts sub-folders are dynamic customer labels.
	 */
	sub_category?: string;
	/** v54 person lane: threads of this forwarded-in person (threads.for_person). */
	for_person?: string;
	/** Set by the server, never from the query: a restricted user's persons (ticket 09). */
	for_persons?: string[];
	/**
	 * Set by the server, never from the query: the caller's allowed domains (the
	 * configured MAIL_DOMAINS); search applies them before its candidate cuts.
	 */
	for_domains?: string[];
	limit: number;
	offset: number;
	cursor?: string;
	/**
	 * Sort order for the conversation list. Defaults to latest_desc (newest
	 * first). Ignored when q is set — search always uses relevance×recency.
	 */
	sort?: ConversationSort;
}

export interface ConversationListResponse {
	conversations: ConversationSummary[];
	total: number;
	limit: number;
	offset: number;
	next_cursor?: string | null;
	has_more?: boolean;
	/** Present when q was set. */
	search?: ConversationSearchInfo;
}

export interface ConversationSearchInfo {
	/** The query as sent. */
	query: string;
	/** What was searched, in operator form (filler dropped, date phrases as after:/before:). */
	interpreted: string;
	scope: "all" | "view";
	/** scope=all only: the view filters the request carried and search did not apply. */
	view_filters?: Record<string, string | boolean>;
	/** Set when the query matched nothing and these results are for a spelling correction. */
	corrected_from?: string;
	/** "Did you mean": a corrected query, when the results are few or none. */
	suggestion?: string;
}

export interface ConversationDetailResponse {
	conversation: ConversationSummary;
	emails: Email[];
	anchor_email_id?: string | null;
	remaining_email_count?: number;
}

export type EmailExport = EmailRecord;

export interface EmailFilters {
	from?: string;
	to?: string;
	domain?: string;
	mailbox?: string;
	direction?: EmailDirection;
	mailbox_state?: MailboxState;
	q?: string;
	after?: number;
	before?: number;
	has_attachments?: boolean;
	is_read?: boolean;
	category?: EmailCategory | null;
	/** Comma list of sub-categories, ORed (billing/notifications folders). */
	sub_category?: string;
	limit: number;
	offset: number;
	cursor?: string;
}

export interface PaginatedResponse<T> {
	emails: T[];
	total: number;
	limit: number;
	offset: number;
	next_cursor?: string | null;
	has_more?: boolean;
}

export interface SendEmailRequest {
	from: string;
	to: string | string[];
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	reply_to?: string | string[];
	headers?: Record<string, string>;
	tag?: string;
	tags?: { name: string; value: string }[];
	message_stream?: string;
	attachments?: SendEmailAttachment[];
	scheduled_at?: string;
	idempotency_key?: string;
}

export interface SendEmailAttachment {
	filename: string;
	content_type: string;
	content_base64: string;
	content_id?: string;
	disposition?: "attachment" | "inline";
}

export interface SendEmailResponse {
	id: string;
	provider: string;
	persisted?: boolean;
	/** The provider's acceptance in its own words (SMTP reply line, API message). Evidence only. */
	response?: string;
}

export interface UpdateEmailRequest {
	mailbox_state?: MailboxState;
	is_read?: boolean;
	category?: EmailCategory | null;
	interest_level?: InterestLevel | null;
	interest_comment?: string | null;
	/**
	 * Phase 1.4: explicit "keep this email unread" override. When true, the
	 * nightly auto-mark-read-at-21d cron will skip this email. User sets this
	 * via a UI action on unread emails they want to preserve for later.
	 */
	user_kept_unread?: boolean;
	/**
	 * Phase 1.5: flag set by the classifier when confidence was below 0.7 and
	 * the email was routed to Personal as a safety fallback. Drives the
	 * "unsure" badge in the UI and the 30-day archive cron.
	 */
	classification_uncertain?: boolean;
	/**
	 * Phase 4: sub-category under the top-level EmailCategory. Either a
	 * statically-known EmailSubCategory value or, for Home Alerts, a
	 * customer_label string (src/utils/classify.ts).
	 */
	sub_category?: string | null;
}

export interface EmailBatchActionRequest {
	ids: string[];
	thread_ids?: string[];
	action:
		| "archive"
		| "trash"
		| "restore"
		| "mark_read"
		| "mark_unread"
		| "mute"
		| "unmute"
		| "star"
		| "unstar"
		| "set_personal"
		| "set_billing"
		| "set_agents"
		| "set_notifications"
		| "set_newsletters"
		| "set_marketing"
		| "set_spam"
		// Phase 4
		| "set_home_alerts"
		| "set_tax_documents"
		| "clear_category";
}

export interface DraftEmailRequest {
	from: string;
	to?: string | string[];
	subject?: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	reply_to?: string | string[];
	attachments?: SendEmailAttachment[];
	in_reply_to?: string;
	references?: string;
	draft_revision?: number;
	editor_state_json?: string | null;
}

export interface UpdateDraftRequest {
	from?: string;
	domain?: string;
	mailbox?: string;
	to?: string | string[];
	subject?: string;
	html?: string | null;
	text?: string | null;
	cc?: string | string[];
	bcc?: string | string[];
	reply_to?: string | string[];
	attachments?: SendEmailAttachment[];
	in_reply_to?: string | null;
	references?: string | null;
	has_attachments?: boolean;
	attachment_count?: number;
	draft_revision?: number;
	editor_state_json?: string | null;
}

export interface AppVariables {
	/** Who is calling (src/auth/principal.ts), set by the auth middleware. */
	principal?: import("@/auth/principal").Principal;
	authToken?: string;
	requestId?: string;
	/** The caller's send idempotency key, echoed in `retry` responses. */
	idempotencyKey?: string;
	/** E2E fault injection armed for this request (utils/test-fault.ts). */
	sendFault?: Map<string, SendFaultAction>;
}

export type SendFaultAction =
	| { kind: "abort" }
	| { kind: "error" }
	| { kind: "stall"; seconds: number };

export interface DomainMailboxSummary {
	mailbox: string;
	address: string;
	email_count: number;
	latest_received_at: number | null;
}

export interface DomainSummary {
	domain: string;
	email_count: number;
	latest_received_at: number | null;
	mailboxes: DomainMailboxSummary[];
}

export interface PlatformMeta {
	configured_domains: string[];
	active_domains: DomainSummary[];
	mailbox_state_counts: Record<MailboxState, number>;
	unread_count: number;
	category_counts: Record<string, number>;
	conversation_count: number;
	conversation_mailbox_state_counts: Record<MailboxState, number>;
	conversation_unread_count: number;
	conversation_category_counts: Record<string, number>;
	conversation_category_unread_counts: Record<string, number>;
	conversation_sub_category_unread_counts: Record<string, number>;
	conversation_for_person_counts: Record<string, number>;
	conversation_for_person_unread_counts: Record<string, number>;
	features: {
		attachments: boolean;
		send: boolean;
		send_configured: boolean;
		spam: boolean;
		agent: boolean;
		compose_rte_enabled: boolean;
	};
	allowed_senders: string[];
	/** The owner's display name per allowed sender (SENDER_NAMES_JSON): who "me" is on screen. */
	sender_names: Record<string, string>;
}

export interface ContactSuggestion {
	address: string;
	name: string | null;
	last_seen_at: number;
}

// --- Agent types ---
export type AgentMessageType = "chat" | "classification_review" | "feedback_follow_up" | "system";

export type AgentMessageMetadata = Record<string, unknown> | null;

export interface SenderRule {
	id: string;
	domain: string;
	from_pattern: string;
	category: EmailCategory;
	confidence: number;
	created_at: number;
	updated_at: number;
}

export interface AgentMessage {
	id: string;
	workspace_id: string;
	role: "user" | "assistant" | "system";
	content: string;
	email_id: string | null;
	message_type: AgentMessageType;
	metadata: AgentMessageMetadata;
	created_at: number;
}

export type ClassificationFeedbackScope = "email" | "sender" | "domain" | "workspace";

export interface ClassificationFeedbackEntry {
	id: string;
	workspace_id: string;
	email_id: string;
	from_address: string;
	domain: string;
	previous_category: EmailCategory | null;
	corrected_category: EmailCategory | null;
	user_comment: string | null;
	resolution_scope: ClassificationFeedbackScope | null;
	agent_summary: string | null;
	follow_up_question: string | null;
	created_at: number;
	updated_at: number;
}

export interface AgentMemoryEntry {
	key: string;
	workspace_id: string;
	value: string;
	updated_at: number;
}

export interface ClassificationLogEntry {
	id: string;
	email_id: string;
	from_address: string;
	subject: string | null;
	category: EmailCategory | null;
	previous_category: EmailCategory | null;
	/** "ai_error" marks an attempt where the AI call failed (logged so the
	 * per-email retry cooldown applies; error detail goes to structured logs).
	 * "codex" rows come from the Codex CLI sidecar via the classify-queue
	 * results endpoint; error attempts log method "codex" with null category
	 * so the same cooldown applies. */
	method:
		| "sender_rule"
		| "people_rule"
		| "heuristic"
		| "ai"
		| "ai_error"
		| "user_feedback"
		| "codex";
	confidence: number | null;
	ai_tokens_used: number | null;
	created_at: number;
}
