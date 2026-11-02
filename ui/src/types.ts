export type EmailDirection = "inbound" | "outbound";
export type MailboxState = "inbox" | "sent" | "archived" | "trash" | "draft";
export type BatchAction =
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
	| "clear_category";
export type EmailCategory =
	| "personal"
	| "billing"
	| "agents"
	| "notifications"
	| "newsletters"
	| "marketing"
	| "spam"
	// Phase 4
	| "home_alerts"
	| "tax_documents";
export type InterestLevel =
	| "very_interested"
	| "interested"
	| "somewhat_interested"
	| "not_interested";

export interface ThreadParticipant {
	name: string | null;
	address: string;
}

export interface ConversationParticipant {
	name: string | null;
	address: string;
}

export interface EmailSummary {
	id: string;
	from_address: string;
	from_name: string | null;
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
	has_attachments: boolean;
	attachment_count: number;
	draft_revision?: number;
	editor_state_json?: string | null;
	snippet: string | null;
	/** 'attachment' when the search snippet matched only attachment filename/text. */
	snippet_source?: "attachment" | null;
	category: EmailCategory | null;
	interest_level: InterestLevel | null;
	interest_comment: string | null;
	thread_id: string | null;
	thread_count: number;
	thread_unread_count: number;
	thread_participants: ThreadParticipant[];
	thread_has_attachments: boolean;
	thread_is_muted: boolean;
	thread_is_starred: boolean;
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
	display_attachment_names?: string[];
	display_email_id: string | null;
	display_mailbox_state: MailboxState | null;
	display_direction: EmailDirection | null;
	display_from_address: string | null;
	display_from_name: string | null;
	display_to_address: string | null;
	display_to_name?: string | null;
	display_to_addresses: string[];
	display_cc_addresses: string[];
	display_bcc_addresses: string[];
	display_received_at: number | null;
	display_sent_at: number | null;
	display_snippet: string | null;
	display_snippet_source?: "attachment" | null;
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

export interface Email extends Omit<EmailSummary, "snippet"> {
	html_content: string | null;
	text_content: string | null;
	message_id: string | null;
	provider_message_id: string | null;
	in_reply_to: string | null;
	references_header: string | null;
	list_unsubscribe: string | null;
	attachments: EmailAttachment[];
	/** Server quoted-text split (ticket 06); present when something is hidden. */
	quote?: QuoteSplit;
}

/** Quoted blocks carry data-mc-quoted="<email id>" in html_content; text-only mail uses offsets. */
export interface QuoteSplit {
	has_quoted: boolean;
	new_text: string;
	quoted_chars: number;
	segments: { kind: "new" | "quoted"; source_id?: string; start?: number; end?: number }[];
	skipped?: string;
}

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
	/** Phase 1.3: restrict to emails-to-self under Personal (from === to). */
	self?: boolean;
	/** Phase 3.2: interest-level sub-filter under Marketing / Newsletters. */
	interest_level?: InterestLevel;
	/** Phase 4: sub-category sub-filter under Billing / Notifications / Agents / Home Alerts. */
	sub_category?: string;
	/** v54: threads of a forwarded-in person (their own view). */
	for_person?: string;
	limit?: number;
	offset?: number;
	cursor?: string;
	/**
	 * List sort order. Shared with ConversationFilters so EmailList can
	 * pass through the user's chosen sort to /api/conversations without
	 * a second type cast. Defaults to latest_desc (newest first).
	 */
	sort?: ConversationSort;
	/** Search only: "view" applies the open view's filters (default all: Gmail's All Mail). */
	scope?: "all" | "view";
}

export type ConversationSort = "latest_desc" | "latest_asc" | "sender" | "subject" | "unread_first";

export interface ConversationFilters {
	domain?: string;
	mailbox_state?: MailboxState;
	category?: EmailCategory | null;
	q?: string;
	to_address?: string;
	after?: number;
	before?: number;
	has_attachments?: boolean;
	is_read?: boolean;
	/** Phase 1.3: restrict to emails-to-self (from === to) under Personal. */
	self?: boolean;
	limit?: number;
	offset?: number;
	sort?: ConversationSort;
}

export interface PaginatedResponse<T> {
	emails: T[];
	total: number;
	limit: number;
	offset: number;
	next_cursor?: string | null;
	has_more?: boolean;
	search?: ConversationSearchInfo;
}

/** GET /api/conversations?q=: what ran (src/types.ts ConversationSearchInfo on the Worker). */
export interface ConversationSearchInfo {
	query: string;
	interpreted: string;
	scope: "all" | "view";
	view_filters?: Record<string, string | boolean>;
	corrected_from?: string;
	suggestion?: string;
}

export interface ConversationListResponse {
	conversations: ConversationSummary[];
	total: number;
	limit: number;
	offset: number;
	next_cursor?: string | null;
	has_more?: boolean;
}

export interface ConversationDetailResponse {
	conversation: ConversationSummary;
	emails: Email[];
	anchor_email_id?: string | null;
	remaining_email_count?: number;
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
	attachments?: SendAttachment[];
}

export interface SendAttachment {
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
}

export interface DraftRequest {
	from: string;
	to?: string | string[];
	subject?: string;
	html?: string | null;
	text?: string | null;
	cc?: string | string[];
	bcc?: string | string[];
	reply_to?: string | string[];
	attachments?: SendAttachment[];
	in_reply_to?: string;
	references?: string;
	draft_revision?: number;
	editor_state_json?: string | null;
}

export interface DraftMutationResponse {
	draft: Email;
	saved_at: number;
}

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
	category_counts: Record<string, number>;
	unread_count: number;
	conversation_count: number;
	conversation_mailbox_state_counts: Record<MailboxState, number>;
	conversation_category_counts: Record<string, number>;
	conversation_unread_count: number;
	/** Unread emails per category — drives sidebar badges. */
	conversation_category_unread_counts?: Record<string, number>;
	/** Unread emails per sub-category — drives sub-folder badges. */
	conversation_sub_category_unread_counts?: Record<string, number>;
	/** Threads per forwarded-in person (v54); category counts leave them out. */
	conversation_for_person_counts?: Record<string, number>;
	conversation_for_person_unread_counts?: Record<string, number>;
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
	sender_names?: Record<string, string>;
}

export interface ContactSuggestion {
	address: string;
	name: string | null;
	last_seen_at: number;
}

export interface ApiSuccess<T> {
	success: true;
	data: T;
}

export interface ApiError {
	success: false;
	error: { code: string; message: string };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** Blocked sender (v33): "Trash all + future" block entry. */
export interface BlockedSender {
	id: number;
	pattern_type: "address" | "domain";
	pattern: string;
	note: string | null;
	created_at: number;
}

export type AgentMessageType = "chat" | "classification_review" | "feedback_follow_up" | "system";

export type AgentMessageMetadata = Record<string, unknown> | null;

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

/** An open action note from GET /api/notes (v55): the "Needs you" strip on Personal. */
export interface ActionNote {
	email_id: string;
	thread_id: string | null;
	note: string;
	/** YYYY-MM-DD, or null when the email states no deadline. */
	due: string | null;
	from: { name: string | null; address: string };
	subject: string | null;
	received_at: number;
}
