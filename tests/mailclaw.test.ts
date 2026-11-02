// DOM polyfill MUST come before any import that touches sanitize/reply-format.
// See tests/setup-dom.ts for rationale.
import "./setup-dom";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { getUserRuleClassification } from "../src/agent/classify";
import {
	BILLING_SUB_CATEGORY_VALUES,
	BILLING_SUB_PROMPT_VERSION,
} from "../src/agent/prompts/classify_billing_sub_v1";
import {
	NOTIFICATION_SUB_CATEGORY_VALUES,
	NOTIFICATION_SUB_PROMPT_VERSION,
} from "../src/agent/prompts/classify_notification_sub_v1";
import {
	buildThreadConsistencyLine,
	CLASSIFIER_PROMPT_VERSION,
	formatAsymmetricFeedback,
} from "../src/agent/prompts/classify_v2";
import { parseListUnsubscribe } from "../src/services/unsubscribe";
import {
	getSenderMatchKeys,
	validateBlockPattern,
} from "../src/database/blocked-senders";
import {
	buildClaimQueueUpdate,
	CLASSIFY_QUEUE_RETRY_COOLDOWN_MS,
} from "../src/database/classifier";
import {
	buildFtsMatchQueries,
	buildThreadCollapsedWhereClause,
	buildThreadConversationJoinClause,
	getConversationDetailByThreadId,
	getThreadByEmailId,
	hydrateEmailContent,
	updateAttachmentExtractStatus,
	updateDraftById,
} from "../src/database/d1";
import {
	buildMatchSnippetSourceSubquery,
	buildMatchSnippetSubquery,
} from "../src/database/fts-snippet";
import { resetTableCache } from "../src/database/tables";
import { resolveInboundHeaderAddresses } from "../src/handlers/email";
import { CloudflareProvider } from "../src/providers/cloudflare";
import { buildMimeMessage } from "../src/providers/smtp";
import { replaceDraftAttachments } from "../src/routes/emails";
import { importEmailRecord } from "../src/services/import-email";
import {
	buildEmailFidelityCheck,
	buildRawEmailObjectKey,
	type ParsedEmailForFidelity,
} from "../src/services/raw-email";
import { repairDraftThreadsPage } from "../src/services/threads";
import { resolveAttachmentExtractStatus } from "../src/utils/attachments";
import { agentsSubCategory, homeAlertsSubCategory } from "../src/utils/classify";
import { buildContactSuggestions } from "../src/utils/contacts";
import { buildEmailReminderIcs, defaultReminderStart } from "../src/utils/ics";
import { canonicalizeOutgoingEmailContent } from "../src/utils/mail";
import {
	getFeatureFlags,
} from "../src/utils/platform";
import {
	agentFeedbackSchema,
	classifyQueueClaimSchema,
	classifyQueueResultsSchema,
	draftEmailSchema,
	hydrateEmailSchema,
	importEmailSchema,
	sendEmailSchema,
	updateAttachmentExtractStatusSchema,
	updateDraftSchema,
} from "../src/utils/validation";
import { toConversationSummaryRecord } from "../ui/src/lib/cache";
import type { Email as UiEmail } from "../ui/src/types";
import {
	buildForwardDraftPayload,
	buildReplyRecipients,
	withCanonicalSubjectPrefix,
} from "../ui/src/utils/reply-format";

function makeEnv(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return {
		API_TOKEN: "admin-token",
		...overrides,
	} as CloudflareBindings;
}

function makeUiEmail(overrides: Partial<UiEmail> = {}): UiEmail {
	return {
		id: "email_1",
		from_address: "sender@example.com",
		from_name: "Sender Example",
		to_address: "recipient@example.com",
		to_addresses: ["recipient@example.com"],
		cc_addresses: [],
		bcc_addresses: [],
		reply_to_addresses: [],
		domain: "example.com",
		mailbox: "inbox",
		direction: "inbound",
		mailbox_state: "inbox",
		subject: "Test subject",
		received_at: Date.parse("2026-04-13T15:47:00Z"),
		sent_at: null,
		read_at: null,
		has_attachments: false,
		attachment_count: 0,
		category: null,
		interest_level: null,
		interest_comment: null,
		thread_id: "thread_1",
		thread_count: 1,
		thread_unread_count: 0,
		thread_participants: [],
		thread_has_attachments: false,
		thread_is_muted: false,
		thread_is_starred: false,
		html_content: null,
		text_content: null,
		message_id: "<message@example.com>",
		provider_message_id: null,
		in_reply_to: null,
		references_header: null,
		list_unsubscribe: null,
		attachments: [],
		...overrides,
	};
}

type FakeRow = Record<string, unknown>;

class FakePreparedStatement {
	constructor(
		private readonly db: FakeD1,
		private readonly sql: string,
	) {}

	private params: unknown[] = [];

	bind(...params: unknown[]) {
		this.params = params;
		return this;
	}

	async first<T = FakeRow>() {
		return (this.db.execute(this.sql, this.params, "first") as T | null) ?? null;
	}

	async all<T = FakeRow>() {
		return {
			results: this.db.execute(this.sql, this.params, "all") as T[],
		};
	}
}

class FakeD1 {
	public readonly observedSql: string[] = [];

	constructor(
		private readonly state: {
			threads: FakeRow[];
			emails: FakeRow[];
			attachments: FakeRow[];
		},
	) {}

	prepare(sql: string) {
		const normalizedSql = sql.replace(/\s+/g, " ").trim();
		this.observedSql.push(normalizedSql);
		return new FakePreparedStatement(this, normalizedSql);
	}

	async batch(statements: FakePreparedStatement[]) {
		return Promise.all(statements.map((statement) => statement.all()));
	}

	execute(sql: string, params: unknown[], mode: "first" | "all") {
		const threadId = String(params[0] ?? "");

		if (
			sql.includes("message_id IN (") ||
			sql.includes("in_reply_to IN (") ||
			sql.includes("INSTR(references_header")
		) {
			throw new Error(`legacy header crawl should not run in this test: ${sql}`);
		}

		if (sql.startsWith("SELECT * FROM emails WHERE id = ?")) {
			const email = this.state.emails.find((row) => String(row.id) === String(params[0]));
			return mode === "first" ? (email ?? null) : email ? [email] : [];
		}

		if (sql.startsWith("SELECT * FROM emails WHERE id IN (")) {
			const ids = new Set(params.map(String));
			const rows = this.state.emails.filter((row) => ids.has(String(row.id)));
			return mode === "first" ? (rows[0] ?? null) : rows;
		}

		if (sql.startsWith("SELECT id FROM emails WHERE thread_id = ?")) {
			const rows = this.state.emails
				.filter((row) => String(row.thread_id) === threadId)
				.map((row) => ({ id: row.id }));
			return mode === "first" ? (rows[0] ?? null) : rows;
		}

		if (sql.startsWith("SELECT id, from_address")) {
			const thread = this.state.threads.find((row) => String(row.id) === threadId);
			return mode === "first" ? (thread ?? null) : thread ? [thread] : [];
		}

		if (sql.startsWith("SELECT") && sql.includes("FROM threads t")) {
			const thread = this.state.threads.find((row) => String(row.id) === threadId);
			return mode === "first" ? (thread ?? null) : thread ? [thread] : [];
		}

		if (sql.startsWith("SELECT") && sql.includes("FROM attachments")) {
			const ids = new Set(params.map(String));
			const rows = this.state.attachments.filter((row) => ids.has(String(row.email_id)));
			return mode === "first" ? (rows[0] ?? null) : rows;
		}

		if (sql.startsWith("SELECT") && sql.includes("FROM sqlite_master")) {
			return mode === "first" ? null : [];
		}

		throw new Error(`Unexpected SQL in fake D1: ${sql}`);
	}
}

class FakeDraftUpdatePreparedStatement {
	private params: unknown[] = [];

	constructor(
		private readonly db: FakeDraftUpdateD1,
		private readonly sql: string,
	) {}

	bind(...params: unknown[]) {
		this.params = params;
		return this;
	}

	async all<T = FakeRow>() {
		if (this.sql === "PRAGMA table_info(emails)") {
			return {
				results: [{ name: "draft_revision" }, { name: "editor_state_json" }] as unknown as T[],
			};
		}
		return { results: [] as T[] };
	}

	async run() {
		this.db.lastUpdateSql = this.sql;
		this.db.lastUpdateParams = [...this.params];
		const expectedRevision = Number(this.params.at(-1));
		return {
			meta: {
				changes: expectedRevision === this.db.currentRevision ? 1 : 0,
			},
		};
	}
}

class FakeDraftUpdateD1 {
	public lastUpdateSql = "";
	public lastUpdateParams: unknown[] = [];

	constructor(public readonly currentRevision: number) {}

	prepare(sql: string) {
		return new FakeDraftUpdatePreparedStatement(this, sql.replace(/\s+/g, " ").trim());
	}
}

class FakeDraftRepairPreparedStatement {
	private params: unknown[] = [];

	constructor(
		private readonly db: FakeDraftRepairD1,
		private readonly sql: string,
	) {}

	bind(...params: unknown[]) {
		this.params = params;
		return this;
	}

	async first<T = FakeRow>() {
		return (this.db.execute(this.sql, this.params, "first") as T | null) ?? null;
	}

	async all<T = FakeRow>() {
		return {
			results: this.db.execute(this.sql, this.params, "all") as T[],
		};
	}

	async run() {
		return this.db.run(this.sql, this.params);
	}
}

class FakeDraftRepairD1 {
	public readonly observedSql: string[] = [];
	public readonly refreshUpserts: string[] = [];

	constructor(
		private readonly state: {
			emails: FakeRow[];
			threads: FakeRow[];
		},
	) {}

	prepare(sql: string) {
		const normalizedSql = sql.replace(/\s+/g, " ").trim();
		this.observedSql.push(normalizedSql);
		return new FakeDraftRepairPreparedStatement(this, normalizedSql);
	}

	async batch<T = FakeRow>(statements: FakeDraftRepairPreparedStatement[]) {
		return Promise.all(statements.map((statement) => statement.all<T>()));
	}

	execute(sql: string, params: unknown[], mode: "first" | "all") {
		if (sql === "PRAGMA table_info(emails)") {
			return mode === "first" ? null : [];
		}

		if (sql.startsWith("SELECT e.id, e.thread_id")) {
			const limit = Number(params.at(-1) ?? 100);
			const rows = this.state.emails
				.filter((email) => email.mailbox_state === "draft")
				.sort((a, b) => String(a.id).localeCompare(String(b.id)))
				.slice(0, limit)
				.map((email) => {
					const threadId = email.thread_id == null ? null : String(email.thread_id);
					const thread = threadId
						? this.state.threads.find((candidate) => String(candidate.id) === threadId)
						: null;
					const actualThreadMembers = threadId
						? this.state.emails.filter((candidate) => candidate.thread_id === threadId)
						: [];
					return {
						id: email.id,
						thread_id: email.thread_id ?? null,
						message_id: email.message_id ?? null,
						in_reply_to: email.in_reply_to ?? null,
						references_header: email.references_header ?? null,
						subject: email.subject ?? null,
						domain: email.domain,
						received_at: email.received_at,
						thread_exists: thread ? 1 : 0,
						thread_latest_email_id: thread?.latest_email_id ?? null,
						thread_message_count: thread?.message_count ?? 0,
						actual_thread_message_count: actualThreadMembers.length,
						thread_draft_members: actualThreadMembers.filter(
							(candidate) => candidate.mailbox_state === "draft",
						).length,
					};
				});
			return mode === "first" ? (rows[0] ?? null) : rows;
		}

		if (sql.startsWith("SELECT COUNT(*) AS total FROM emails e")) {
			const total = this.state.emails.filter((email) => {
				if (email.mailbox_state !== "draft") return false;
				const threadId = email.thread_id == null ? null : String(email.thread_id);
				const thread = threadId
					? this.state.threads.find((candidate) => String(candidate.id) === threadId)
					: null;
				const actualThreadMembers = threadId
					? this.state.emails.filter((candidate) => candidate.thread_id === threadId)
					: [];
				return (
					!threadId ||
					!thread ||
					thread.latest_email_id == null ||
					Number(thread.message_count ?? 0) !== actualThreadMembers.length ||
					actualThreadMembers.filter((candidate) => candidate.mailbox_state === "draft").length <= 0
				);
			}).length;
			return { total };
		}

		if (sql.startsWith("SELECT id, root_subject FROM threads WHERE id = ?")) {
			const thread = this.state.threads.find((row) => String(row.id) === String(params[0]));
			return mode === "first" ? (thread ?? null) : thread ? [thread] : [];
		}

		if (sql.startsWith("SELECT root_subject FROM threads WHERE id = ?")) {
			const thread = this.state.threads.find((row) => String(row.id) === String(params[0]));
			const result = thread ? { root_subject: thread.root_subject ?? null } : null;
			return mode === "first" ? result : result ? [result] : [];
		}

		if (sql.startsWith("SELECT e.thread_id, e.message_id, t.root_subject FROM emails e")) {
			const ids = new Set(params.map(String));
			const rows = this.state.emails
				.filter((row) => row.thread_id != null && ids.has(String(row.message_id)))
				.slice(0, 64)
				.map((row) => ({
					thread_id: row.thread_id,
					message_id: row.message_id,
					root_subject: this.state.threads.find((t) => t.id === row.thread_id)?.root_subject ?? null,
				}));
			return mode === "first" ? (rows[0] ?? null) : rows;
		}

		if (sql.startsWith("SELECT t.id FROM threads t")) {
			const [domain, rootSubject] = params.map(String);
			const thread = this.state.threads.find(
				(row) => row.domain === domain && row.root_subject === rootSubject,
			);
			const result = thread ? { id: thread.id } : null;
			return mode === "first" ? result : result ? [result] : [];
		}

		if (sql.startsWith("WITH thread_data AS")) {
			const threadId = String(params[0]);
			const members = this.state.emails.filter((row) => String(row.thread_id) === threadId);
			if (members.length === 0) {
				return mode === "first" ? null : [];
			}
			const sorted = [...members].sort(
				(a, b) => Number(a.sent_at ?? a.received_at ?? 0) - Number(b.sent_at ?? b.received_at ?? 0),
			);
			const latest = sorted[sorted.length - 1];
			const earliest = sorted[0];
			const result = {
				message_count: members.length,
				unread_count: 0,
				latest_message_at: Number(latest.sent_at ?? latest.received_at ?? 0),
				started_at: Number(earliest.sent_at ?? earliest.received_at ?? 0),
				has_attachments: members.some((row) => row.has_attachments) ? 1 : 0,
				total_attachment_count: members.reduce(
					(total, row) => total + Number(row.attachment_count ?? 0),
					0,
				),
				domain: latest.domain,
				computed_mailbox_state: members.some((row) => row.mailbox_state === "inbox")
					? "inbox"
					: members.some((row) => row.mailbox_state === "sent")
						? "sent"
						: members.some((row) => row.mailbox_state === "draft")
							? "draft"
							: "archived",
				latest_id: latest.id,
				snippet: latest.text_content ?? null,
				category: latest.category ?? null,
				latest_sub_category: latest.sub_category ?? null,
				root_subject: earliest.subject ?? latest.subject ?? null,
				participants_json: JSON.stringify(
					members.map((row) => ({
						addr: row.from_address,
						name: row.from_name ?? "",
					})),
				),
				member_max_priority: latest.category ?? null,
				existing_priority: null,
				existing_user_pinned: null,
				is_muted: 0,
				is_starred: 0,
			};
			return mode === "first" ? result : [result];
		}

		throw new Error(`Unexpected SQL in draft repair fake: ${sql}`);
	}

	async run(sql: string, params: unknown[]) {
		if (sql.startsWith("UPDATE emails SET thread_id = ?")) {
			const [threadId, id] = params.map(String);
			const email = this.state.emails.find((row) => String(row.id) === id);
			if (!email || email.mailbox_state !== "draft") {
				return { meta: { changes: 0 } };
			}
			email.thread_id = threadId;
			return { meta: { changes: 1 } };
		}

		if (sql.startsWith("INSERT INTO threads")) {
			const id = String(params[0]);
			const existing = this.state.threads.find((row) => String(row.id) === id);
			const row = {
				id,
				domain: params[1],
				root_subject: params[2],
				latest_message_at: params[3],
				started_at: params[4],
				message_count: params[5],
				unread_count: params[6],
				mailbox_state: params[7],
				has_attachments: params[8],
				attachment_count: params[9],
				snippet: params[10],
				latest_email_id: params[19],
			};
			if (existing) {
				Object.assign(existing, row);
			} else {
				this.state.threads.push(row);
			}
			this.refreshUpserts.push(id);
			return { meta: { changes: 1 } };
		}

		if (sql.startsWith("DELETE FROM threads WHERE id = ?")) {
			const index = this.state.threads.findIndex((row) => String(row.id) === String(params[0]));
			if (index >= 0) this.state.threads.splice(index, 1);
			return { meta: { changes: index >= 0 ? 1 : 0 } };
		}

		throw new Error(`Unexpected run SQL in draft repair fake: ${sql}`);
	}
}

class FakeAttachmentReplacementPreparedStatement {
	private params: unknown[] = [];

	constructor(
		private readonly db: FakeAttachmentReplacementD1,
		private readonly sql: string,
	) {}

	bind(...params: unknown[]) {
		this.params = params;
		return this;
	}

	async all<T = FakeRow>() {
		return {
			results: this.db.execute(this.sql, this.params, "all") as T[],
		};
	}

	async first<T = FakeRow>() {
		return (this.db.execute(this.sql, this.params, "first") as T | null) ?? null;
	}

	async run() {
		return this.db.run(this.sql, this.params);
	}
}

class FakeAttachmentReplacementD1 {
	constructor(
		private readonly state: {
			emails: FakeRow[];
			attachments: FakeRow[];
			failBatch?: boolean;
		},
	) {}

	prepare(sql: string) {
		return new FakeAttachmentReplacementPreparedStatement(this, sql.replace(/\s+/g, " ").trim());
	}

	async batch(statements: FakeAttachmentReplacementPreparedStatement[]) {
		if (this.state.failBatch) {
			throw new Error("forced D1 batch failure");
		}
		return Promise.all(statements.map((statement) => statement.run()));
	}

	execute(sql: string, params: unknown[], mode: "first" | "all") {
		if (sql.startsWith("SELECT") && sql.includes("FROM attachments")) {
			const emailId = String(params[0]);
			const rows = this.state.attachments.filter((row) => String(row.email_id) === emailId);
			return mode === "first" ? (rows[0] ?? null) : rows;
		}

		throw new Error(`Unexpected SQL in attachment fake: ${sql}`);
	}

	async run(sql: string, params: unknown[]) {
		if (sql.startsWith("DELETE FROM attachments WHERE email_id = ?")) {
			const emailId = String(params[0]);
			const before = this.state.attachments.length;
			this.state.attachments = this.state.attachments.filter(
				(row) => String(row.email_id) !== emailId,
			);
			return { meta: { changes: before - this.state.attachments.length } };
		}

		if (sql.startsWith("INSERT INTO attachments")) {
			this.state.attachments.push({
				id: params[0],
				email_id: params[1],
				object_key: params[2],
				filename: params[3],
				mime_type: params[4],
				size: params[5],
				disposition: params[6],
				content_id: params[7],
				created_at: params[8],
			});
			return { meta: { changes: 1 } };
		}

		if (sql.startsWith("UPDATE emails SET has_attachments = ?")) {
			const [hasAttachments, attachmentCount, id] = params;
			const email = this.state.emails.find((row) => String(row.id) === String(id));
			if (!email || email.mailbox_state !== "draft") {
				return { meta: { changes: 0 } };
			}
			email.has_attachments = hasAttachments;
			email.attachment_count = attachmentCount;
			return { meta: { changes: 1 } };
		}

		throw new Error(`Unexpected run SQL in attachment fake: ${sql}`);
	}
}

class FakeR2Bucket {
	public readonly putKeys: string[] = [];
	public readonly deletedKeys: string[] = [];
	public failPut = false;

	constructor(public readonly objects = new Set<string>()) {}

	async put(key: string) {
		if (this.failPut) {
			throw new Error("forced R2 put failure");
		}
		this.putKeys.push(key);
		this.objects.add(key);
	}

	async delete(key: string) {
		this.deletedKeys.push(key);
		this.objects.delete(key);
	}
}

function makeThreadDetailDb() {
	const sharedThreadId = "thread-123";
	const olderEmail = {
		id: "email-older",
		from_address: "alice@example.com",
		from_name: "Alice",
		to_address: "bob@example.com",
		to_addresses_json: JSON.stringify(["bob@example.com"]),
		cc_addresses_json: "[]",
		bcc_addresses_json: "[]",
		reply_to_addresses_json: "[]",
		domain: "example.com",
		mailbox: "inbox",
		direction: "inbound",
		mailbox_state: "inbox",
		subject: "Thread subject",
		received_at: 1710000000000,
		sent_at: 1710000000000,
		read_at: null,
		html_content: null,
		text_content: "Earlier reply",
		message_id: "<older@example.com>",
		provider_message_id: null,
		source_type: null,
		source_path: null,
		source_folder: null,
		source_message_id: null,
		in_reply_to: "<unrelated@example.com>",
		references_header: "<unrelated@example.com>",
		has_attachments: false,
		attachment_count: 0,
		draft_revision: 0,
		editor_state_json: null,
		thread_id: sharedThreadId,
		category: "personal",
		interest_level: null,
		interest_comment: null,
		list_unsubscribe: null,
	};

	const newerEmail = {
		id: "email-newer",
		from_address: "bob@example.com",
		from_name: "Bob",
		to_address: "alice@example.com",
		to_addresses_json: JSON.stringify(["alice@example.com"]),
		cc_addresses_json: "[]",
		bcc_addresses_json: "[]",
		reply_to_addresses_json: "[]",
		domain: "example.com",
		mailbox: "inbox",
		direction: "outbound",
		mailbox_state: "inbox",
		subject: "Re: Thread subject",
		received_at: 1710000100000,
		sent_at: 1710000100000,
		read_at: null,
		html_content: null,
		text_content: "Newest reply",
		message_id: "<newer@example.com>",
		provider_message_id: null,
		source_type: null,
		source_path: null,
		source_folder: null,
		source_message_id: null,
		in_reply_to: "<totally-different@example.com>",
		references_header: "<totally-different@example.com>",
		has_attachments: false,
		attachment_count: 0,
		draft_revision: 0,
		editor_state_json: null,
		thread_id: sharedThreadId,
		category: "personal",
		interest_level: null,
		interest_comment: null,
		list_unsubscribe: null,
	};

	const threadSummary = {
		id: sharedThreadId,
		from_address: newerEmail.from_address,
		from_name: newerEmail.from_name,
		to_address: newerEmail.to_address,
		to_addresses_json: newerEmail.to_addresses_json,
		cc_addresses_json: newerEmail.cc_addresses_json,
		bcc_addresses_json: newerEmail.bcc_addresses_json,
		reply_to_addresses_json: newerEmail.reply_to_addresses_json,
		domain: newerEmail.domain,
		mailbox: newerEmail.mailbox,
		direction: newerEmail.direction,
		mailbox_state: "inbox",
		subject: "Thread subject",
		received_at: newerEmail.received_at,
		sent_at: newerEmail.sent_at,
		read_at: newerEmail.read_at,
		provider_message_id: newerEmail.provider_message_id,
		source_type: newerEmail.source_type,
		source_path: newerEmail.source_path,
		source_folder: newerEmail.source_folder,
		source_message_id: newerEmail.source_message_id,
		has_attachments: false,
		attachment_count: 0,
		thread_id: sharedThreadId,
		category: "personal",
		interest_level: null,
		interest_comment: null,
		thread_snippet: "Newest reply",
		thread_count: 2,
		thread_unread_count: 0,
		thread_participant_names: JSON.stringify(["Bob", "Alice"]),
		thread_participant_addresses: JSON.stringify(["bob@example.com", "alice@example.com"]),
		thread_has_attachments: false,
		thread_is_muted: false,
		thread_is_starred: false,
		latest_email_id: newerEmail.id,
		root_subject: "Thread subject",
		latest_message_at: newerEmail.sent_at,
		started_at: olderEmail.sent_at,
		message_count: 2,
		unread_count: 0,
		snippet: "Newest reply",
		participant_names: JSON.stringify(["Bob", "Alice"]),
		participant_addresses: JSON.stringify(["bob@example.com", "alice@example.com"]),
		is_muted: false,
		is_starred: false,
	};

	return {
		db: new FakeD1({
			threads: [threadSummary],
			emails: [olderEmail, newerEmail],
			attachments: [],
		}),
		sharedThreadId,
		olderEmail,
		newerEmail,
	};
}

/** The positive MATCH string, or the match-nothing sentinel. */
const buildFtsQuery = (q: string) => buildFtsMatchQueries(q).match ?? '""';

test("quoted phrases compile to one FTS phrase so adjacency is enforced", () => {
	const query = buildFtsQuery('"project kickoff"');
	// One quoted string: tokens must be adjacent in the document.
	assert.match(query, /: "project kickoff"$/);
	// Separately-quoted words would be plain AND semantics, not a phrase.
	assert.doesNotMatch(query, /"project"\s+"kickoff"/);
});

test("negation-only queries produce an exclude query instead of an invalid bare NOT", () => {
	const negationOnly = buildFtsMatchQueries("-newsletter");
	assert.equal(negationOnly.match, null);
	assert.match(negationOnly.exclude ?? "", /newsletter\*/);
	// The exclude query is a POSITIVE match (used via rowid NOT IN ...), so it
	// must not carry the NOT operator that made the old query a syntax error.
	assert.doesNotMatch(negationOnly.exclude ?? "", /\bNOT\b/);

	const multiNegation = buildFtsMatchQueries("-newsletter -promo");
	assert.equal(multiNegation.match, null);
	assert.match(multiNegation.exclude ?? "", /newsletter\*.* OR .*promo\*/);

	// Mixed queries keep NOT inline in the positive match query.
	const mixed = buildFtsMatchQueries("invoice -newsletter");
	assert.equal(mixed.exclude, null);
	assert.match(mixed.match ?? "", /invoice\*/);
	assert.match(mixed.match ?? "", /NOT .*newsletter\*/);

	// Operator-only queries have neither: callers fall back to plain listing.
	const operatorOnly = buildFtsMatchQueries("in:inbox");
	assert.equal(operatorOnly.match, null);
	assert.equal(operatorOnly.exclude, null);
	assert.equal(buildFtsQuery("in:inbox"), '""');
});

test("email-address tokens expand to the full unicode61 phrase, not the first fragment", () => {
	const query = buildFtsQuery("owner@business.example");
	// Phrase + prefix star matches the tokenized form of the indexed address.
	assert.match(query, /"owner business example"\*/);
	// The old behavior truncated to 'owner*', matching far too much.
	assert.doesNotMatch(query, /: owner\*/);
});

test("to: operator routes through the v31 FTS recipient columns", () => {
	// Partial addresses prefix-match; the old exact-equality SQL never could.
	assert.equal(buildFtsQuery("to:team@"), "{to_address to_addresses_json}: team*");
	assert.equal(
		buildFtsQuery("to:owner@business.example"),
		'{to_address to_addresses_json}: "owner business example"*',
	);

	const negated = buildFtsMatchQueries("invoice -to:team@");
	assert.match(negated.match ?? "", /NOT \{to_address to_addresses_json\}: team\*/);
});

test("search field migration indexes participants and attachment filenames", () => {
	const migration = readFileSync(
		new URL("../sql/migrate-v31-search-fields.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /ALTER TABLE emails ADD COLUMN attachment_names TEXT/);
	assert.match(migration, /to_addresses_json/);
	assert.match(migration, /cc_addresses_json/);
	assert.match(migration, /reply_to_addresses_json/);
	assert.match(migration, /attachment_names/);
	assert.match(migration, /CREATE VIRTUAL TABLE emails_fts USING fts5/);
});

test("attachment extraction sidecar hydrates attachment_search_text only", () => {
	const script = readFileSync(
		new URL("../scripts/sidecar/extract-attachment-text.mjs", import.meta.url),
		"utf8",
	);
	// Pulls work from the admin extraction queue and downloads payloads.
	assert.match(script, /\/api\/admin\/attachments/);
	assert.match(script, /\/attachments\/\$\{encodeURIComponent\(/);
	// Extracts with the local toolchain.
	assert.match(script, /pdftotext/);
	assert.match(script, /textutil/);
	assert.match(script, /skipped:no-text-layer/);
	assert.match(script, /skipped:size/);
	// ABSOLUTE RULE: hydrate carries attachment_search_text and nothing else.
	assert.match(script, /attachment_search_text/);
	assert.doesNotMatch(script, /text_content/);
	assert.doesNotMatch(script, /html_content/);
});

test("thread_id-backed conversation detail loads the whole thread without header crawling", async () => {
	const { db, sharedThreadId, olderEmail, newerEmail } = makeThreadDetailDb();

	const detail = await getThreadByEmailId(db as unknown as D1Database, newerEmail.id);

	assert.equal(detail.error, undefined);
	assert.deepEqual(
		detail.emails.map((email) => email.id),
		[olderEmail.id, newerEmail.id],
	);
	assert.ok(detail.emails.every((email) => email.thread_id === sharedThreadId));
	assert.equal(detail.emails[0]?.id, olderEmail.id);
	assert.equal(detail.emails[1]?.id, newerEmail.id);
	assert.equal(detail.emails[1]?.text_content, "Newest reply");
	assert.ok(db.observedSql.some((sql) => sql.includes("FROM emails WHERE thread_id = ?")));
	assert.equal(
		db.observedSql.some(
			(sql) =>
				sql.includes("message_id IN (") ||
				sql.includes("in_reply_to IN (") ||
				sql.includes("INSTR(references_header"),
		),
		false,
	);
});

test("conversation detail helper resolves directly by thread id", async () => {
	const { db, sharedThreadId, olderEmail, newerEmail } = makeThreadDetailDb();

	const detail = await getConversationDetailByThreadId(db as unknown as D1Database, sharedThreadId);

	assert.equal(detail.error, undefined);
	assert.equal(detail.conversation?.id, sharedThreadId);
	assert.equal(detail.conversation?.thread_count, 2);
	assert.equal(detail.conversation?.thread_id, sharedThreadId);
	assert.deepEqual(
		detail.emails.map((email) => email.id),
		[olderEmail.id, newerEmail.id],
	);
	assert.ok(detail.emails.every((email) => email.thread_id === sharedThreadId));
});

test("send validation rejects malformed payloads and supports attachments", () => {
	const invalid = sendEmailSchema.safeParse({
		from: "sender@business.example",
		to: ["recipient@example.com"],
		subject: "Hello",
	});

	assert.equal(invalid.success, false);

	const valid = sendEmailSchema.safeParse({
		from: "sender@business.example",
		to: ["recipient@example.com"],
		subject: "Hello",
		text: "Body",
		reply_to: "reply@business.example",
		attachments: [
			{
				filename: "invoice.pdf",
				content_type: "application/pdf",
				content_base64: "UERG",
			},
		],
	});

	assert.equal(valid.success, true);
});

test("draft validation supports attachments and keeps update rules aligned", () => {
	const createValid = draftEmailSchema.safeParse({
		from: "sender@business.example",
		to: ["recipient@example.com"],
		subject: "Draft",
		text: "Body",
		draft_revision: 1,
		editor_state_json: '{"type":"doc"}',
		attachments: [
			{
				filename: "notes.txt",
				content_type: "text/plain",
				content_base64: "SGVsbG8=",
			},
		],
	});

	assert.equal(createValid.success, true);

	const updateInvalid = updateDraftSchema.safeParse({
		reply_to: ["one@business.example", "two@business.example"],
	});

	assert.equal(updateInvalid.success, false);

	const clearValid = updateDraftSchema.safeParse({
		to: [],
		cc: [],
		bcc: [],
		subject: "",
		draft_revision: 2,
	});

	assert.equal(clearValid.success, true);
});

test("rich compose validation accepts html-first payloads and draft clears", () => {
	const sendValid = sendEmailSchema.safeParse({
		from: "sender@business.example",
		to: ["recipient@example.com"],
		subject: "Rich body",
		html: "<p><strong>Hello</strong></p>",
		attachments: [
			{
				filename: "inline.png",
				content_type: "image/png",
				content_base64: "aGVsbG8=",
				content_id: "cid-inline",
				disposition: "inline",
			},
		],
	});
	assert.equal(sendValid.success, true);

	const draftValid = draftEmailSchema.safeParse({
		from: "sender@business.example",
		to: ["recipient@example.com"],
		html: "<p>Hello</p>",
		editor_state_json: '{"mode":"rich-text"}',
	});
	assert.equal(draftValid.success, true);

	const updateValid = updateDraftSchema.safeParse({
		html: null,
		text: null,
		references: null,
		editor_state_json: null,
		draft_revision: 2,
	});
	assert.equal(updateValid.success, true);
});

test("conversation summary mapper prefers mailbox-specific display anchors", () => {
	const sentRecord = toConversationSummaryRecord({
		id: "thread-sent",
		domain: "business.example",
		subject: "Mixed thread",
		latest_message_at: 2000,
		started_at: 1000,
		message_count: 2,
		unread_count: 0,
		mailbox_state: "inbox",
		has_attachments: false,
		attachment_count: 0,
		snippet: "Latest inbound snippet",
		participants: [
			{ name: "Customer", address: "customer@example.com" },
			{ name: "owner", address: "owner@business.example" },
		],
		is_muted: false,
		is_starred: false,
		category: null,
		latest_email_id: "inbound-latest",
		display_email_id: "sent-member",
		display_mailbox_state: "sent",
		display_direction: "outbound",
		display_from_address: "owner@business.example",
		display_from_name: "owner",
		display_to_address: "recipient@example.com",
		display_to_addresses: ["recipient@example.com"],
		display_cc_addresses: ["cc@example.com"],
		display_bcc_addresses: [],
		display_received_at: 1500,
		display_sent_at: 1500,
		display_snippet: "Sent body snippet",
	});

	assert.equal(sentRecord.latest_email_id, "inbound-latest");
	assert.equal(sentRecord.display_email_id, "sent-member");
	assert.equal(sentRecord.mailbox_state, "sent");
	assert.equal(sentRecord.direction, "outbound");
	assert.equal(sentRecord.from_address, "owner@business.example");
	assert.equal(sentRecord.to_address, "recipient@example.com");
	assert.deepEqual(sentRecord.to_addresses, ["recipient@example.com"]);
	assert.equal(sentRecord.snippet, "Sent body snippet");

	const draftRecord = toConversationSummaryRecord({
		id: "thread-draft",
		domain: "business.example",
		subject: "Draft thread",
		latest_message_at: 3000,
		started_at: 1000,
		message_count: 3,
		unread_count: 0,
		mailbox_state: "inbox",
		has_attachments: true,
		attachment_count: 1,
		snippet: "Latest thread snippet",
		participants: [{ name: "Customer", address: "customer@example.com" }],
		is_muted: false,
		is_starred: false,
		category: "personal",
		latest_email_id: "latest-thread-member",
		display_email_id: "draft-member",
		display_mailbox_state: "draft",
		display_direction: "outbound",
		display_from_address: "owner@business.example",
		display_from_name: "owner",
		display_to_address: "draft-recipient@example.com",
		display_to_addresses: ["draft-recipient@example.com"],
		display_cc_addresses: [],
		display_bcc_addresses: [],
		display_received_at: 2500,
		display_sent_at: null,
		display_snippet: "Draft body snippet",
	});

	assert.equal(draftRecord.display_email_id, "draft-member");
	assert.equal(draftRecord.latest_email_id, "latest-thread-member");
	assert.equal(draftRecord.mailbox_state, "draft");
	assert.equal(draftRecord.snippet, "Draft body snippet");
	assert.equal(draftRecord.to_address, "draft-recipient@example.com");
	assert.equal(draftRecord.received_at, 2500);
});

test("draft updates are guarded by the expected revision", async () => {
	const fakeDb = new FakeDraftUpdateD1(7);

	const result = await updateDraftById(
		fakeDb as unknown as D1Database,
		"draft-1",
		{ text: "newer text", draft_revision: 8 },
		[],
		{ expectedDraftRevision: 7 },
	);

	assert.equal(result.updated, true);
	assert.match(fakeDb.lastUpdateSql, /draft_revision = \?/);
	assert.deepEqual(fakeDb.lastUpdateParams, ["newer text", 8, "draft-1", 7]);
});

test("draft updates can clear recipients and subject explicitly", async () => {
	const fakeDb = new FakeDraftUpdateD1(3);

	const result = await updateDraftById(
		fakeDb as unknown as D1Database,
		"draft-1",
		{ to: [], cc: [], bcc: [], subject: "", draft_revision: 4 },
		[],
		{ expectedDraftRevision: 3 },
	);

	assert.equal(result.updated, true);
	assert.match(fakeDb.lastUpdateSql, /to_address = \?/);
	assert.match(fakeDb.lastUpdateSql, /to_addresses_json = \?/);
	assert.match(fakeDb.lastUpdateSql, /cc_addresses_json = \?/);
	assert.match(fakeDb.lastUpdateSql, /bcc_addresses_json = \?/);
	assert.match(fakeDb.lastUpdateSql, /subject = \?/);
	assert.deepEqual(fakeDb.lastUpdateParams, ["", "[]", "[]", "[]", null, 4, "draft-1", 3]);
});

test("stale draft updates do not report success", async () => {
	const fakeDb = new FakeDraftUpdateD1(8);

	const result = await updateDraftById(
		fakeDb as unknown as D1Database,
		"draft-1",
		{ text: "stale text", draft_revision: 8 },
		[],
		{ expectedDraftRevision: 7 },
	);

	assert.equal(result.updated, false);
	assert.equal(result.error, undefined);
});

test("draft thread repair dry run reports missing backing thread without mutating", async () => {
	resetTableCache();
	const state = {
		emails: [
			{
				id: "draft-a",
				thread_id: "draft-a",
				message_id: null,
				in_reply_to: null,
				references_header: null,
				subject: "Draft A",
				domain: "business.example",
				from_address: "owner@business.example",
				mailbox_state: "draft",
				received_at: 1776000000000,
				text_content: "body",
				attachment_count: 0,
			},
		],
		threads: [] as FakeRow[],
	};
	const db = new FakeDraftRepairD1(state);

	const result = await repairDraftThreadsPage(db as unknown as D1Database, {
		dryRun: true,
		limit: 10,
	});

	assert.equal(result.checked, 1);
	assert.equal(result.selected, 1);
	assert.equal(result.reasons.missing_thread_row, 1);
	assert.equal(result.repaired, 0);
	assert.equal(state.threads.length, 0);
});

test("draft thread repair rebuilds missing backing thread rows", async () => {
	resetTableCache();
	const state = {
		emails: [
			{
				id: "draft-b",
				thread_id: "draft-b",
				message_id: null,
				in_reply_to: null,
				references_header: null,
				subject: "Draft B",
				domain: "business.example",
				from_address: "owner@business.example",
				mailbox_state: "draft",
				received_at: 1776000000000,
				text_content: "draft body",
				attachment_count: 0,
			},
		],
		threads: [] as FakeRow[],
	};
	const db = new FakeDraftRepairD1(state);

	const result = await repairDraftThreadsPage(db as unknown as D1Database, {
		dryRun: false,
		limit: 10,
	});

	assert.equal(result.reasons.missing_thread_row, 1);
	assert.equal(result.refreshed_threads, 1);
	assert.equal(result.repaired, 1);
	assert.deepEqual(db.refreshUpserts, ["draft-b"]);
	assert.equal(state.threads[0]?.id, "draft-b");
	assert.equal(state.threads[0]?.mailbox_state, "draft");
	assert.equal(state.threads[0]?.latest_email_id, "draft-b");
});

test("draft thread repair moves stale draft thread IDs to parent thread", async () => {
	resetTableCache();
	const state = {
		emails: [
			{
				id: "parent-email",
				thread_id: "parent-thread",
				message_id: "<parent@example.com>",
				in_reply_to: null,
				references_header: null,
				subject: "Parent subject",
				domain: "business.example",
				from_address: "sender@example.com",
				mailbox_state: "inbox",
				received_at: 1775000000000,
				text_content: "parent body",
				attachment_count: 0,
			},
			{
				id: "draft-c",
				thread_id: "stale-thread",
				message_id: null,
				in_reply_to: "<parent@example.com>",
				references_header: null,
				subject: "Re: Parent subject",
				domain: "business.example",
				from_address: "owner@business.example",
				mailbox_state: "draft",
				received_at: 1776000000000,
				text_content: "reply draft",
				attachment_count: 0,
			},
		],
		threads: [
			{
				id: "parent-thread",
				domain: "business.example",
				root_subject: "Parent subject",
				latest_email_id: "parent-email",
				message_count: 1,
			},
		] as FakeRow[],
	};
	const db = new FakeDraftRepairD1(state);

	const result = await repairDraftThreadsPage(db as unknown as D1Database, {
		dryRun: false,
		limit: 10,
	});

	assert.equal(result.reasons.stale_thread_id, 1);
	assert.equal(result.updated_thread_ids, 1);
	assert.equal(state.emails[1]?.thread_id, "parent-thread");
	assert.ok(db.refreshUpserts.includes("parent-thread"));
});

test("draft attachment replacement keeps old objects when D1 commit fails", async () => {
	const state = {
		emails: [
			{
				id: "draft-attach-1",
				mailbox_state: "draft",
				has_attachments: true,
				attachment_count: 1,
			},
		],
		attachments: [
			{
				id: "old-attachment",
				email_id: "draft-attach-1",
				object_key: "emails/draft-attach-1/0-old.txt",
				filename: "old.txt",
				mime_type: "text/plain",
				size: 3,
				disposition: "attachment",
				content_id: null,
				created_at: 1,
			},
		],
		failBatch: true,
	};
	const r2 = new FakeR2Bucket(new Set(["emails/draft-attach-1/0-old.txt"]));
	const env = makeEnv({
		D1: new FakeAttachmentReplacementD1(state) as unknown as D1Database,
		ATTACHMENTS: r2 as unknown as R2Bucket,
	});

	const result = await replaceDraftAttachments(
		env,
		"draft-attach-1",
		[
			{
				filename: "new.txt",
				content_type: "text/plain",
				content_base64: "bmV3",
			},
		],
		2,
	);

	assert.equal(result.success, false);
	assert.equal(state.attachments[0]?.object_key, "emails/draft-attach-1/0-old.txt");
	assert.equal(r2.objects.has("emails/draft-attach-1/0-old.txt"), true);
	assert.equal(r2.putKeys.length, 1);
	assert.equal(r2.objects.has(r2.putKeys[0] ?? ""), false);
	assert.deepEqual(r2.deletedKeys, [r2.putKeys[0]]);
});

test("draft attachment replacement deletes old objects only after commit", async () => {
	const state = {
		emails: [
			{
				id: "draft-attach-2",
				mailbox_state: "draft",
				has_attachments: true,
				attachment_count: 1,
			},
		],
		attachments: [
			{
				id: "old-attachment",
				email_id: "draft-attach-2",
				object_key: "emails/draft-attach-2/0-old.txt",
				filename: "old.txt",
				mime_type: "text/plain",
				size: 3,
				disposition: "attachment",
				content_id: null,
				created_at: 1,
			},
		],
	};
	const r2 = new FakeR2Bucket(new Set(["emails/draft-attach-2/0-old.txt"]));
	const env = makeEnv({
		D1: new FakeAttachmentReplacementD1(state) as unknown as D1Database,
		ATTACHMENTS: r2 as unknown as R2Bucket,
	});

	const result = await replaceDraftAttachments(
		env,
		"draft-attach-2",
		[
			{
				filename: "new.txt",
				content_type: "text/plain",
				content_base64: "bmV3",
			},
		],
		2,
	);

	assert.equal(result.success, true);
	assert.equal(state.attachments.length, 1);
	assert.match(String(state.attachments[0]?.object_key), /draft-attachments/);
	assert.equal(r2.objects.has(String(state.attachments[0]?.object_key)), true);
	assert.deepEqual(r2.deletedKeys, ["emails/draft-attach-2/0-old.txt"]);
	assert.equal(state.emails[0]?.has_attachments, true);
	assert.equal(state.emails[0]?.attachment_count, 1);
});

test("empty draft attachment replacement clears rows before deleting old objects", async () => {
	const state = {
		emails: [
			{
				id: "draft-attach-3",
				mailbox_state: "draft",
				has_attachments: true,
				attachment_count: 1,
			},
		],
		attachments: [
			{
				id: "old-attachment",
				email_id: "draft-attach-3",
				object_key: "emails/draft-attach-3/0-old.txt",
				filename: "old.txt",
				mime_type: "text/plain",
				size: 3,
				disposition: "attachment",
				content_id: null,
				created_at: 1,
			},
		],
	};
	const r2 = new FakeR2Bucket(new Set(["emails/draft-attach-3/0-old.txt"]));
	const env = makeEnv({
		D1: new FakeAttachmentReplacementD1(state) as unknown as D1Database,
		ATTACHMENTS: r2 as unknown as R2Bucket,
	});

	const result = await replaceDraftAttachments(env, "draft-attach-3", [], 2);

	assert.equal(result.success, true);
	assert.equal(state.attachments.length, 0);
	assert.deepEqual(r2.deletedKeys, ["emails/draft-attach-3/0-old.txt"]);
	assert.equal(state.emails[0]?.has_attachments, false);
	assert.equal(state.emails[0]?.attachment_count, 0);
});

test("outgoing canonicalization keeps a safe subset and derives plain text", () => {
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		`<div class="outer"><script>alert(1)</script><b>Hello</b> <a href="javascript:alert(1)" onclick="boom()">bad</a> <a href="https://example.com" style="color:red">good</a><blockquote data-x="1">Quoted</blockquote></div>`,
		null,
	);

	assert.equal(
		htmlContent,
		'<p><strong>Hello</strong> bad <a href="https://example.com">good</a><blockquote>Quoted</blockquote></p>',
	);
	assert.equal(textContent, "Hello bad good\n\n> Quoted");

	const textOnly = canonicalizeOutgoingEmailContent("<script>nope()</script>", "Fallback body");
	assert.equal(textOnly.htmlContent, null);
	assert.equal(textOnly.textContent, "Fallback body");
});

test("outgoing canonicalization preserves safe rich structures for compose round-trips", () => {
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		`<div>Intro</div><ul><li>First item</li><li>Second item</li></ul><blockquote>Quoted line</blockquote><a href="mailto:writer@example.com" onclick="evil()">Mail me</a><a href="javascript:alert(1)">Bad link</a>`,
		null,
	);

	assert.equal(htmlContent?.includes("<p>Intro</p>"), true);
	assert.equal(htmlContent?.includes("<ul><li>First item</li><li>Second item</li></ul>"), true);
	assert.equal(htmlContent?.includes("<blockquote>Quoted line</blockquote>"), true);
	assert.equal(htmlContent?.includes('<a href="mailto:writer@example.com">Mail me</a>'), true);
	assert.equal(htmlContent?.includes("javascript:"), false);
	assert.equal(htmlContent?.includes("onclick"), false);
	assert.match(textContent ?? "", /Intro/);
	assert.match(textContent ?? "", /First item/);
	assert.match(textContent ?? "", /Second item/);
	assert.match(textContent ?? "", /> Quoted line/);
	assert.match(textContent ?? "", /Mail me/);
});

test("canonicalization handles Google Docs font-weight wrappers", () => {
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		'<div><span style="font-weight:normal"><strong>Bold text</strong></span> normal</div>',
		null,
	);
	assert.equal(htmlContent?.includes("<strong>Bold text</strong>"), true);
	assert.equal(htmlContent?.includes("font-weight"), false);
	assert.match(textContent ?? "", /Bold text normal/);
});

test("canonicalization strips Outlook conditional comments and mso styles", () => {
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		'<!--[if mso]><div class="mso-wrapper"><![endif]--><div><p>Outlook content</p><!--[if mso]></div><![endif]-->',
		null,
	);
	assert.equal(htmlContent?.includes("mso"), false);
	assert.equal(htmlContent?.includes("<!--"), false);
	assert.match(textContent ?? "", /Outlook content/);
});

test("canonicalization normalizes nested lists without corruption", () => {
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		"<ul><li>Item 1<ul><li>Nested 1</li><li>Nested 2</li></ul></li><li>Item 2</li></ul>",
		null,
	);
	assert.equal(htmlContent?.includes("<ul>"), true);
	assert.equal(htmlContent?.includes("<li>"), true);
	assert.match(textContent ?? "", /Item 1/);
	assert.match(textContent ?? "", /Nested 1/);
	assert.match(textContent ?? "", /Item 2/);
});

test("canonicalization removes malicious script injection attempts", () => {
	const { htmlContent, textContent } = canonicalizeOutgoingEmailContent(
		'<p>Safe content</p><img src=x onerror="alert(1)"><script>steal()</script><svg onload="bad()"><p>More safe</p>',
		null,
	);
	assert.equal(htmlContent?.includes("script"), false);
	assert.equal(htmlContent?.includes("onerror"), false);
	assert.equal(htmlContent?.includes("onload"), false);
	assert.equal(htmlContent?.includes("svg"), false);
	assert.match(htmlContent ?? "", /Safe content/);
	assert.match(htmlContent ?? "", /More safe/);
});

test("forward draft payload rebuilds clean headers", () => {
	const payload = buildForwardDraftPayload(
		makeUiEmail({
			from_address: "owner@business.example",
			from_name: "owner",
			to_address: "recipient@partner.example",
			to_addresses: ["recipient@partner.example", "ops@business.example"],
			cc_addresses: ["finance@business.example"],
			subject: "Re: Project update",
			html_content:
				"<div>Fresh forward summary</div><div>---------- Forwarded message ----------</div><div>Older forwarded chain</div>",
			text_content:
				"Fresh forward summary\n\n---------- Forwarded message ----------\nOlder forwarded chain",
		}),
	);

	assert.match(payload.text, /---------- Forwarded message ----------/);
	assert.match(payload.text, /From: owner <owner@business\.example>/);
	assert.match(payload.text, /To: recipient@partner\.example, ops@business\.example/);
	assert.match(payload.text, /Cc: finance@business\.example/);
	assert.match(payload.text, /Fresh forward summary/);
	assert.match(payload.html, /Fresh forward summary/);
});

test("reply-all recipients exclude every configured identity and deduplicate casing", () => {
	const recipients = buildReplyRecipients(
		makeUiEmail({
			from_address: "customer@example.com",
			reply_to_addresses: ["Support@vendor.example"],
			to_address: "owner@business.example",
			to_addresses: ["owner@business.example", "Partner@Example.com"],
			cc_addresses: ["partner@example.com", "owner@work.example", "ops@example.com"],
		}),
		["owner@business.example", "owner@work.example"],
	);

	assert.equal(recipients.to, "Support@vendor.example");
	assert.deepEqual(recipients.cc, ["Partner@Example.com", "ops@example.com"]);
});

test("replying to outbound mail targets the external recipient rather than the sender identity", () => {
	const recipients = buildReplyRecipients(
		makeUiEmail({
			direction: "outbound",
			from_address: "owner@business.example",
			to_address: "nadia@work.example",
			to_addresses: ["nadia@work.example"],
		}),
		["owner@business.example"],
	);

	assert.equal(recipients.to, "nadia@work.example");
	assert.deepEqual(recipients.cc, []);
});

test("subject prefixes collapse repeated reply and forward chains", () => {
	assert.equal(withCanonicalSubjectPrefix("Re: FWD: FW[2]: Project", "Fwd"), "Fwd: Project");
	assert.equal(withCanonicalSubjectPrefix("fwd: Re: Project", "Re"), "Re: Project");
});

test("inbound header addresses preserve external introduction recipients", () => {
	const headers = resolveInboundHeaderAddresses({
		deliveredTo: "owner@business.example",
		to: [{ address: "owner@business.example" }, { address: "Recipient@partner.example" }],
		cc: [{ address: "Copy@partner.example" }],
	});

	assert.deepEqual(headers.toAddresses, ["owner@business.example", "recipient@partner.example"]);
	assert.deepEqual(headers.ccAddresses, ["copy@partner.example"]);
	assert.deepEqual(headers.bccAddresses, []);
});

test("raw email object keys are partitioned by received date", () => {
	assert.equal(
		buildRawEmailObjectKey("email-123", Date.parse("2026-04-29T17:11:09.000Z")),
		"raw-inbound/2026/04/29/email-123.eml",
	);
});

test("email fidelity check detects stripped external recipients", () => {
	const parsed: ParsedEmailForFidelity = {
		from: { address: "Sender@partner.example", name: "Example Sender" },
		to: [{ address: "owner@business.example" }, { address: "Recipient@partner.example" }],
		cc: [{ address: "Copy@partner.example" }],
		subject: "Introductions - Example Partners",
		messageId: "<intro@example.com>",
	};
	const check = buildEmailFidelityCheck({
		email: {
			...makeUiEmail({
				id: "email-raw-1",
				from_address: "sender@partner.example",
				from_name: "Example Sender",
				to_address: "owner@business.example",
				to_addresses: ["owner@business.example"],
				cc_addresses: [],
				subject: "Introductions - Example Partners",
				message_id: "<intro@example.com>",
			}),
			source_type: null,
			source_path: null,
			source_folder: null,
			source_message_id: null,
		},
		parsed,
		envelope: { from: "Sender@partner.example", to: "owner@business.example" },
		rawSha256: "abc123",
		rawSize: 1200,
		checkedAt: Date.parse("2026-04-29T17:11:09.000Z"),
	});

	assert.equal(check.status, "fail");
	assert.deepEqual(
		check.mismatches.map((mismatch) => mismatch.field),
		["to_addresses", "cc_addresses"],
	);
});

test("import validation accepts source provenance fields", () => {
	const valid = importEmailSchema.safeParse({
		from: "Example Importer <importer@partner.example>",
		to: ["owner@business.example"],
		subject: "Example import",
		text: "Body",
		date: Date.now(),
		domain: "business.example",
		mailbox: "owner",
		direction: "inbound",
		mailbox_state: "inbox",
		source_type: "maildir",
		source_path: "/var/mail/maildir/Priority/cur/example",
		source_folder: "Priority",
		source_message_id: "<abc123@example.com>",
	});

	assert.equal(valid.success, true);
});

test("hydrate validation accepts attachment search names", () => {
	const valid = hydrateEmailSchema.safeParse({
		attachment_names: "Invoice_INV-0042_from_Example_Supply.pdf",
	});

	assert.equal(valid.success, true);
});

test("compose feature flags can be enabled independently", () => {
	const env = makeEnv({
		COMPOSE_RTE_ENABLED: "true",
	});

	assert.deepEqual(getFeatureFlags(env), {
		attachments: false,
		send: true,
		send_configured: false,
		spam: false,
		agent: false,
		compose_rte_enabled: true,
	});
});

test("cloudflare provider emits raw attachment bytes and preserves safe thread headers", async () => {
	let captured: Record<string, unknown> | null = null;
	const binding = {
		async send(payload: Record<string, unknown>) {
			captured = payload;
			return { messageId: "<cf-message@business.example>" };
		},
	} as unknown as SendEmail;
	const provider = new CloudflareProvider(binding);

	const result = await provider.send({
		from: "owner <owner@business.example>",
		to: ["nadia@work.example"],
		subject: "Forward",
		html: '<p>Logo <img src="cid:logo-1"></p>',
		text: "Logo",
		headers: {
			"In-Reply-To": "<parent@example.com>",
			References: "<parent@example.com>",
			"Message-ID": "<must-be-filtered@example.com>",
		},
		attachments: [
			{
				filename: "report.pdf",
				content_type: "application/pdf",
				content_base64: "UERG",
				disposition: "attachment",
			},
			{
				filename: "logo.png",
				content_type: "image/png",
				content_base64: "iVBORw==",
				content_id: "logo-1",
				disposition: "attachment",
			},
		],
	});

	assert.deepEqual(result, { id: "<cf-message@business.example>", provider: "cloudflare" });
	assert.ok(captured);
	assert.deepEqual(captured.headers, {
		"In-Reply-To": "<parent@example.com>",
		References: "<parent@example.com>",
	});
	const attachments = captured.attachments as Array<{
		disposition: string;
		content: Uint8Array;
		contentId?: string;
	}>;
	assert.deepEqual(Array.from(attachments[0].content), [80, 68, 70]);
	assert.equal(attachments[0].disposition, "attachment");
	assert.equal(attachments[1].disposition, "inline");
	assert.equal(attachments[1].contentId, "logo-1");
});

test("contact suggestions prioritize matching names and recent recipients", () => {
	const contacts = buildContactSuggestions(
		[
			{
				from_address: "alerts@vendor.example",
				from_name: "Alerts",
				last_seen_at: 10,
			},
			{
				from_address: "quentin@other.example",
				from_name: "Quentin Brown",
				last_seen_at: 20,
			},
			{
				to_addresses: ["quentin@business.example", "ops@business.example"],
				last_seen_at: 30,
			},
		],
		"quentin",
		8,
	);

	assert.deepEqual(
		contacts.map((contact) => contact.address),
		["quentin@other.example", "quentin@business.example"],
	);
	assert.equal(contacts[0]?.name, "Quentin Brown");
});

// ── Compose session schema validation ──────────────────────────────

test("compose feature flags default to false and toggle independently", () => {
	const base = makeEnv();
	const flags = getFeatureFlags(base);
	assert.equal(flags.compose_rte_enabled, false);

	const rteOnly = makeEnv({ COMPOSE_RTE_ENABLED: "true" });
	const rteFlags = getFeatureFlags(rteOnly);
	assert.equal(rteFlags.compose_rte_enabled, true);
});

test("Phase 2.3: asymmetric feedback weighting triplicates missed-personal corrections", () => {
	const missedPersonal = formatAsymmetricFeedback([
		{
			id: "f1",
			workspace_id: "business",
			email_id: "e1",
			from_address: "alice@example.com",
			domain: "example.com",
			previous_category: "marketing",
			corrected_category: "personal",
			user_comment: null,
			resolution_scope: "sender",
			agent_summary: null,
			follow_up_question: null,
			created_at: 1,
			updated_at: 1,
		},
	]);
	// Missed-personal corrections appear 3 times.
	assert.equal(missedPersonal.length, 3);
	for (const entry of missedPersonal) {
		assert.match(entry.value, /missed-personal/);
		assert.match(entry.value, /marketing -> personal/);
	}
});

test("Phase 2.3: symmetric corrections (personal -> non-personal) count once", () => {
	const symmetric = formatAsymmetricFeedback([
		{
			id: "f2",
			workspace_id: "business",
			email_id: "e2",
			from_address: "newsletter@example.com",
			domain: "example.com",
			previous_category: "personal",
			corrected_category: "newsletters",
			user_comment: null,
			resolution_scope: "sender",
			agent_summary: null,
			follow_up_question: null,
			created_at: 1,
			updated_at: 1,
		},
	]);
	assert.equal(symmetric.length, 1);
	assert.doesNotMatch(symmetric[0].value, /missed-personal/);
});

test("Phase 2.4: thread consistency line only emits when thread has prior messages", () => {
	assert.equal(buildThreadConsistencyLine({ priorityCategory: null, memberMessageCount: 3 }), null);
	assert.equal(
		buildThreadConsistencyLine({ priorityCategory: "personal", memberMessageCount: 0 }),
		null,
	);
	const line = buildThreadConsistencyLine({
		priorityCategory: "personal",
		memberMessageCount: 4,
	});
	assert.ok(line);
	assert.match(line, /priority "personal"/);
	assert.match(line, /4 message/);
});

test("Phase 3.6: parseListUnsubscribe handles HTTPS and mailto variants", () => {
	const both = parseListUnsubscribe(
		"<https://example.com/unsub?token=x>, <mailto:unsub@example.com>",
	);
	assert.equal(both.url, "https://example.com/unsub?token=x");
	assert.equal(both.mailto, "mailto:unsub@example.com");

	const httpsOnly = parseListUnsubscribe("<https://example.com/u>");
	assert.equal(httpsOnly.url, "https://example.com/u");
	assert.equal(httpsOnly.mailto, null);

	const empty = parseListUnsubscribe(null);
	assert.equal(empty.url, null);
	assert.equal(empty.mailto, null);
});

test("Phase 5: buildEmailReminderIcs emits a valid VEVENT with escaped fields", () => {
	const ics = buildEmailReminderIcs({
		uid: "email-abc-123",
		summary: "Follow up: Lunch Thursday; bring the deck",
		description: "From: bob@example.com\n\nHey, want to grab lunch?",
		startsAtMs: Date.UTC(2026, 4, 1, 16, 0, 0),
		durationMinutes: 30,
		url: "https://mail.example.com/?email=email-abc-123",
	});
	// Basic shape
	assert.match(ics, /^BEGIN:VCALENDAR/);
	assert.match(ics, /END:VCALENDAR\r\n$/);
	assert.match(ics, /BEGIN:VEVENT/);
	assert.match(ics, /END:VEVENT/);
	// Escaped semicolons
	assert.match(ics, /Lunch Thursday\\; bring the deck/);
	// Escaped newlines in description (single \n in source → \\n in ICS)
	assert.match(ics, /From: bob@example\.com\\n\\nHey/);
	// DTSTART formatted UTC
	assert.match(ics, /DTSTART:20260501T160000Z/);
	// CRLF line endings
	assert.match(ics, /\r\n/);
	// URL line
	assert.match(ics, /URL:https:\/\/mail\.example\.com/);
});

test("Phase 5: defaultReminderStart lands in the future", () => {
	const now = Date.UTC(2026, 3, 24, 10, 0, 0);
	const reminder = defaultReminderStart(now);
	assert.ok(reminder > now, "default reminder must be after now");
	// 16:00 UTC tomorrow = 30 hours from 10:00 today, so within 48h.
	assert.ok(reminder - now < 48 * 60 * 60 * 1000);
});

// Phase 4 sub-category heuristic tests. Regression gate — silent
// drift here directly breaks sidebar sub-folder population.
test("Phase 4: homeAlertsSubCategory resolves configured sensor domains", () => {
	const config = JSON.stringify([
		{ domain: "sensors.example", label: "Customer A — Sensors" },
		{ domain: "meter.example", label: "Site B — Meter" },
	]);
	assert.equal(homeAlertsSubCategory("a@sensors.example", config), "Customer A — Sensors");
	assert.equal(homeAlertsSubCategory("monitor@mail.meter.example", config), "Site B — Meter");
	assert.equal(homeAlertsSubCategory("a@notsensors.example", config), null);
	assert.equal(homeAlertsSubCategory("random@example.com", config), null);
	assert.equal(homeAlertsSubCategory("malformed-address", config), null);
	assert.equal(homeAlertsSubCategory("a@sensors.example"), null);
	assert.equal(homeAlertsSubCategory("a@sensors.example", "not json"), null);
});

test("Phase 4: agentsSubCategory splits broken / vendor-status / bot-admin", () => {
	assert.equal(agentsSubCategory(["security", "vercel.com"].join("@")), "broken");
	assert.equal(agentsSubCategory(["noreply", "statuspage.io"].join("@")), "vendor_status");
	assert.equal(agentsSubCategory(["notifications", "vercel.com"].join("@")), "bot_admin");
	assert.equal(agentsSubCategory(["noreply", "github.com"].join("@")), "bot_admin");
});

test("Codex: content-based sub-category enums match the prompt files", () => {
	assert.deepEqual(
		[...BILLING_SUB_CATEGORY_VALUES].sort(),
		["failed_payments", "invoice_conversations", "other", "receipts"].sort(),
	);
	assert.deepEqual(
		[...NOTIFICATION_SUB_CATEGORY_VALUES].sort(),
		["calendar", "money", "orders_shipping", "other", "product_noise", "security", "social"].sort(),
	);
	assert.match(BILLING_SUB_PROMPT_VERSION, /^billing-sub-v/);
	assert.match(NOTIFICATION_SUB_PROMPT_VERSION, /^notification-sub-v/);
});

test("Codex: classifyQueueClaimSchema clamps limit and lease_ms", () => {
	const defaults = classifyQueueClaimSchema.parse({ worker_id: "codex-1" });
	assert.equal(defaults.limit, 10);
	assert.equal(defaults.lease_ms, 600_000);

	const clamped = classifyQueueClaimSchema.parse({
		worker_id: "codex-1",
		limit: 100,
		lease_ms: 99_999_999,
	});
	assert.equal(clamped.limit, 25);
	assert.equal(clamped.lease_ms, 3_600_000);

	const floor = classifyQueueClaimSchema.parse({ worker_id: "codex-1", lease_ms: 1 });
	assert.equal(floor.lease_ms, 30_000);

	assert.equal(classifyQueueClaimSchema.safeParse({ worker_id: "" }).success, false);
	assert.equal(classifyQueueClaimSchema.safeParse({}).success, false);
});

test("Codex: classifyQueueResultsSchema validates enums, clamps confidence, truncates reasoning", () => {
	const base = {
		lease_token: "tok",
		worker_id: "codex-1",
		model: "gpt-5.5",
		results: [
			{
				email_id: "em1",
				category: "billing",
				confidence: 1.7,
				reasoning: "x".repeat(900),
				billing_sub: "failed_payments",
				tokens_used: 123,
			},
		],
	};
	const parsed = classifyQueueResultsSchema.parse(base);
	assert.equal(parsed.results[0].confidence, 1);
	assert.equal(parsed.results[0].reasoning.length, 500);
	assert.equal(parsed.results[0].billing_sub, "failed_payments");

	const negative = classifyQueueResultsSchema.parse({
		...base,
		results: [{ email_id: "em1", category: null, confidence: -3, error: "timeout" }],
	});
	assert.equal(negative.results[0].confidence, 0);
	assert.equal(negative.results[0].error, "timeout");

	// Old sender-based sub values are rejected.
	assert.equal(
		classifyQueueResultsSchema.safeParse({
			...base,
			results: [{ email_id: "em1", category: "billing", billing_sub: "utilities" }],
		}).success,
		false,
	);
	// Categories outside the 9-enum are rejected.
	assert.equal(
		classifyQueueResultsSchema.safeParse({
			...base,
			results: [{ email_id: "em1", category: "junk" }],
		}).success,
		false,
	);
	// Notification subs validate against the new enum.
	assert.equal(
		classifyQueueResultsSchema.safeParse({
			...base,
			results: [{ email_id: "em1", category: "notifications", notification_sub: "money" }],
		}).success,
		true,
	);
	assert.equal(
		classifyQueueResultsSchema.safeParse({
			...base,
			results: [
				{ email_id: "em1", category: "notifications", notification_sub: "security_account" },
			],
		}).success,
		false,
	);
	// Batch size is capped at 25.
	assert.equal(
		classifyQueueResultsSchema.safeParse({
			...base,
			results: Array.from({ length: 26 }, (_, i) => ({
				email_id: `em${i}`,
				category: null,
			})),
		}).success,
		false,
	);
});

test("Codex: agentFeedbackSchema accepts sub-category-only corrections", () => {
	const subOnly = agentFeedbackSchema.parse({
		email_id: "em1",
		sub_category: "failed_payments",
	});
	assert.equal(subOnly.sub_category, "failed_payments");

	const withCategory = agentFeedbackSchema.parse({
		email_id: "em1",
		category: "notifications",
		sub_category: "security",
	});
	assert.equal(withCategory.sub_category, "security");

	// Must provide at least one of category / sub_category / comment.
	assert.equal(agentFeedbackSchema.safeParse({ email_id: "em1" }).success, false);
});

test("Codex: buildClaimQueueUpdate emits the lease query with bound params in order", () => {
	const { sql, params } = buildClaimQueueUpdate({
		nowMs: 1_000_000,
		leaseMs: 600_000,
		classifyAfter: 1_774_567_864_000,
		limit: 25,
		leaseToken: "tok-abc",
	});

	// Queue conditions
	assert.match(sql, /SET classify_lease_until = \?, classify_leased_by = \?/);
	assert.match(sql, /e\.category IS NULL/);
	assert.match(sql, /e\.direction = 'inbound'/);
	assert.match(sql, /e\.mailbox_state = 'inbox'/);
	assert.match(sql, /e\.received_at > \?/);
	assert.match(sql, /e\.classify_lease_until IS NULL OR e\.classify_lease_until < \?/);
	assert.match(sql, /cl\.method IN \('ai', 'codex'\)/);
	assert.match(sql, /cl\.created_at > \?/);
	assert.match(sql, /ORDER BY e\.received_at DESC/);
	assert.match(sql, /LIMIT \?/);

	// Param order: lease_until, token, classify_after, now, cooldown cutoff, limit
	assert.deepEqual(params, [
		1_000_000 + 600_000,
		"tok-abc",
		1_774_567_864_000,
		1_000_000,
		1_000_000 - CLASSIFY_QUEUE_RETRY_COOLDOWN_MS,
		25,
	]);
	assert.equal(CLASSIFY_QUEUE_RETRY_COOLDOWN_MS, 21_600_000);
});

// ── Blocked senders (v33) ────────────────────────────────────────────────

test("blocked senders: getSenderMatchKeys folds case and extracts domain", () => {
	assert.deepEqual(getSenderMatchKeys(" Alice@Example.COM "), {
		address: "alice@example.com",
		domain: "example.com",
	});
	assert.deepEqual(getSenderMatchKeys("no-at-sign"), { address: "no-at-sign", domain: "" });
	assert.deepEqual(getSenderMatchKeys("trailing@"), { address: "trailing@", domain: "" });
});

test("blocked senders: validation accepts addresses and bare domains", () => {
	const ok1 = validateBlockPattern("address", " Spammer@Example.com ", []);
	assert.deepEqual(ok1, { ok: true, pattern: "spammer@example.com" });

	const ok2 = validateBlockPattern("domain", "Bad-Actor.example.io", []);
	assert.deepEqual(ok2, { ok: true, pattern: "bad-actor.example.io" });
});

test("blocked senders: validation rejects malformed patterns", () => {
	assert.equal(validateBlockPattern("address", "not-an-address", []).ok, false);
	assert.equal(validateBlockPattern("address", "two@@example.com", []).ok, false);
	assert.equal(validateBlockPattern("address", "spaces in@example.com", []).ok, false);
	assert.equal(validateBlockPattern("domain", "example", []).ok, false);
	assert.equal(validateBlockPattern("domain", "user@example.com", []).ok, false);
	assert.equal(validateBlockPattern("domain", "-bad.com", []).ok, false);
	assert.equal(validateBlockPattern("domain", "bad-.com", []).ok, false);
	assert.equal(validateBlockPattern("domain", "exa_mple.com", []).ok, false);
	assert.equal(validateBlockPattern("domain", "%@evil.com", []).ok, false);
	assert.equal(validateBlockPattern("domain", "", []).ok, false);
});

test("blocked senders: validation refuses the user's own workspace domains", () => {
	const protectedDomains = ["business.example", "example.org"];

	const domainAttempt = validateBlockPattern("domain", "Business.Example", protectedDomains);
	assert.equal(domainAttempt.ok, false);

	const addressAttempt = validateBlockPattern("address", "owner@business.example", protectedDomains);
	assert.equal(addressAttempt.ok, false);

	// Other domains stay blockable even when protections are configured
	const fine = validateBlockPattern("domain", "example.com", protectedDomains);
	assert.deepEqual(fine, { ok: true, pattern: "example.com" });
});

// ─── Phase 4 (v34): attachment search ───────────────────────────────────────

test("v34 migration enumerates attachment_search_text in all four FTS triggers", () => {
	const migration = readFileSync(
		new URL("../sql/migrate-v34-attachment-search-text.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /ALTER TABLE emails ADD COLUMN attachment_search_text TEXT/);
	assert.match(migration, /ALTER TABLE attachments ADD COLUMN extract_status TEXT/);
	assert.match(migration, /ALTER TABLE attachments ADD COLUMN text_extracted_at INTEGER/);
	assert.match(migration, /CREATE VIRTUAL TABLE emails_fts USING fts5/);

	// Full reindex INSERT present
	assert.match(migration, /INSERT INTO emails_fts\(\s*rowid,[\s\S]*?FROM emails;/);

	// THE V30 LESSON: every trigger body must enumerate every FTS column.
	const triggers = migration.split(/CREATE TRIGGER/).slice(1);
	assert.equal(triggers.length, 4);
	for (const trigger of triggers) {
		assert.match(trigger, /attachment_names/);
		assert.match(trigger, /attachment_search_text/);
	}

	// Both UPDATE OF column lists include the new column.
	const updateOfLists = migration.match(/UPDATE OF [^\n]+ ON emails/g) ?? [];
	assert.equal(updateOfLists.length, 2);
	for (const list of updateOfLists) {
		assert.match(list, /attachment_search_text/);
	}
});

test("default FTS column scope includes attachment text", () => {
	const query = buildFtsQuery("warranty");
	assert.match(query, /attachment_names attachment_search_text\}/);
});

test("hydrate validation accepts attachment search text", () => {
	const valid = hydrateEmailSchema.safeParse({
		attachment_search_text: "service agreement section 4 renewal rate",
	});
	assert.equal(valid.success, true);

	const overLimit = hydrateEmailSchema.safeParse({
		attachment_search_text: "x".repeat(200001),
	});
	assert.equal(overLimit.success, false);
});

test("import validation accepts metadata-only attachments", () => {
	const valid = importEmailSchema.safeParse({
		from: "billing@supply.example",
		to: ["owner@business.example"],
		subject: "Invoice attached",
		text: "Body",
		date: Date.now(),
		domain: "business.example",
		mailbox: "owner",
		attachments_meta: [
			{ filename: "Invoice_INV-0042.pdf", mime_type: "application/pdf", size: 48211 },
			{ filename: "Price_Sheet.pdf" },
		],
	});
	assert.equal(valid.success, true);

	const noFilename = importEmailSchema.safeParse({
		from: "billing@supply.example",
		to: ["owner@business.example"],
		date: Date.now(),
		domain: "business.example",
		mailbox: "owner",
		attachments_meta: [{ mime_type: "application/pdf" }],
	});
	assert.equal(noFilename.success, false);
});

test("attachment extract status: extractable mimes pending, others skipped", () => {
	assert.equal(resolveAttachmentExtractStatus("application/pdf", "doc.pdf"), "pending");
	assert.equal(
		resolveAttachmentExtractStatus(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"contract.docx",
		),
		"pending",
	);
	assert.equal(resolveAttachmentExtractStatus("application/msword", "old.doc"), "pending");
	assert.equal(resolveAttachmentExtractStatus("text/rtf", "memo.rtf"), "pending");
	assert.equal(resolveAttachmentExtractStatus("text/plain", "notes.txt"), "pending");
	assert.equal(resolveAttachmentExtractStatus("text/csv", "usage.csv"), "pending");
	// charset suffixes don't break matching
	assert.equal(resolveAttachmentExtractStatus("text/plain; charset=utf-8", "a.txt"), "pending");
	// generic mime falls back to the filename extension
	assert.equal(
		resolveAttachmentExtractStatus("application/octet-stream", "statement.pdf"),
		"pending",
	);
	assert.equal(resolveAttachmentExtractStatus(null, "report.docx"), "pending");
	// non-extractable types are skipped
	assert.equal(resolveAttachmentExtractStatus("image/png", "logo.png"), "skipped:type");
	assert.equal(resolveAttachmentExtractStatus("application/zip", "bundle.zip"), "skipped:type");
	assert.equal(
		resolveAttachmentExtractStatus("application/octet-stream", "blob.bin"),
		"skipped:type",
	);
	assert.equal(resolveAttachmentExtractStatus(null, null), "skipped:type");
	// a concrete (non-generic) mime wins over a misleading extension
	assert.equal(resolveAttachmentExtractStatus("image/png", "fake.pdf"), "skipped:type");
});

/** Minimal recording D1: PRAGMA-aware, records every write, returns benign results. */
class RecordingD1 {
	public readonly writes: Array<{ sql: string; params: unknown[] }> = [];

	constructor(
		private readonly pragmas: {
			emails: string[];
			attachments: string[];
		},
	) {}

	prepare(sql: string) {
		const normalized = sql.replace(/\s+/g, " ").trim();
		const self = this;
		let bound: unknown[] = [];
		const statement = {
			bind(...params: unknown[]) {
				bound = params;
				return statement;
			},
			async all() {
				return { results: self.execute(normalized, bound) };
			},
			async first() {
				return self.execute(normalized, bound)[0] ?? null;
			},
			async run() {
				self.record(normalized, bound);
				return { success: true, meta: { changes: 1 } };
			},
			_exec() {
				// batch entries may be reads (PRAGMA) or writes
				if (/^(INSERT|UPDATE|DELETE)/i.test(normalized)) {
					self.record(normalized, bound);
					return { success: true, meta: { changes: 1 }, results: [] };
				}
				return { success: true, results: self.execute(normalized, bound) };
			},
		};
		return statement;
	}

	async batch(statements: Array<{ _exec: () => unknown }>) {
		return statements.map((statement) => statement._exec());
	}

	private record(sql: string, params: unknown[]) {
		this.writes.push({ sql, params });
	}

	private execute(sql: string, _params: unknown[]): Record<string, unknown>[] {
		if (sql === "PRAGMA table_info(emails)") {
			return this.pragmas.emails.map((name) => ({ name }));
		}
		if (sql === "PRAGMA table_info(attachments)") {
			return this.pragmas.attachments.map((name) => ({ name }));
		}
		if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) {
			this.record(sql, _params);
			return [];
		}
		// sqlite_master probes (threads/blocked_senders/contacts/raw artifacts):
		// nothing exists in this fake.
		return [];
	}
}

const V34_EMAILS_PRAGMA = ["id", "text_content", "attachment_names", "attachment_search_text"];
const V34_ATTACHMENTS_PRAGMA = ["id", "email_id", "extract_status", "text_extracted_at"];

test("attachment extract-status PATCH schema accepts known statuses only", () => {
	for (const status of ["pending", "done", "failed", "skipped:size", "skipped:no-text-layer"]) {
		const parsed = updateAttachmentExtractStatusSchema.safeParse({ extract_status: status });
		assert.equal(parsed.success, true, `expected ${status} to validate`);
	}
	for (const status of ["", "DONE", "skipped", "skipped:", "running", "skipped:Bad Reason"]) {
		const parsed = updateAttachmentExtractStatusSchema.safeParse({ extract_status: status });
		assert.equal(parsed.success, false, `expected ${status || "(empty)"} to be rejected`);
	}
});

test("updateAttachmentExtractStatus stamps text_extracted_at only on done", async () => {
	resetTableCache();
	const db = new RecordingD1({ emails: V34_EMAILS_PRAGMA, attachments: V34_ATTACHMENTS_PRAGMA });

	const done = await updateAttachmentExtractStatus(db as unknown as D1Database, "att_1", "done", [
		"business.example",
	]);
	assert.equal(done.updated, true);
	const doneWrite = db.writes.find((write) => write.sql.startsWith("UPDATE attachments SET"));
	assert.ok(doneWrite, "expected an UPDATE attachments statement");
	assert.match(doneWrite.sql, /extract_status = \?/);
	assert.match(doneWrite.sql, /text_extracted_at = \?/);
	// Domain scope is enforced through the parent email.
	assert.match(doneWrite.sql, /email_id IN \(SELECT id FROM emails WHERE domain IN \(\?\)\)/);
	assert.equal(doneWrite.params[0], "done");
	assert.equal(doneWrite.params.at(-1), "business.example");

	db.writes.length = 0;
	const failed = await updateAttachmentExtractStatus(
		db as unknown as D1Database,
		"att_2",
		"failed",
	);
	assert.equal(failed.updated, true);
	const failedWrite = db.writes.find((write) => write.sql.startsWith("UPDATE attachments SET"));
	assert.ok(failedWrite, "expected an UPDATE attachments statement");
	assert.doesNotMatch(failedWrite.sql, /text_extracted_at/);
	// Never touches the emails table.
	assert.equal(
		db.writes.some((write) => /UPDATE emails/i.test(write.sql)),
		false,
	);
	resetTableCache();
});

test("hydrate additive guard: attachment-only hydrate never touches body content", async () => {
	resetTableCache();
	const db = new RecordingD1({ emails: V34_EMAILS_PRAGMA, attachments: V34_ATTACHMENTS_PRAGMA });

	const result = await hydrateEmailContent(db as unknown as D1Database, "em_1", {
		attachment_names: "Invoice_INV-0042.pdf Price_Sheet.pdf",
		attachment_search_text: "invoice inv 0042 amount due on receipt",
	});

	assert.equal(result.updated, true);
	const update = db.writes.find((write) => write.sql.startsWith("UPDATE emails SET"));
	assert.ok(update, "expected an UPDATE emails statement");
	assert.match(update.sql, /attachment_names = \?/);
	assert.match(update.sql, /attachment_search_text = \?/);
	assert.doesNotMatch(update.sql, /text_content\s*=/);
	assert.doesNotMatch(update.sql, /html_content\s*=/);
	resetTableCache();
});

test("import split: metadata-only attachments are counted + named but get no rows", async () => {
	resetTableCache();
	const db = new RecordingD1({ emails: V34_EMAILS_PRAGMA, attachments: V34_ATTACHMENTS_PRAGMA });
	const r2Puts: string[] = [];
	const env = {
		D1: db,
		ATTACHMENTS: {
			async put(key: string) {
				r2Puts.push(key);
			},
		},
	} as unknown as CloudflareBindings;

	const result = await importEmailRecord(
		env,
		{
			from: "billing@supply.example",
			to: ["owner@business.example"],
			subject: "Invoice",
			text: "see attached",
			html: null,
			date: Date.now(),
			domain: "business.example",
			mailbox: "owner",
			direction: "inbound",
			mailbox_state: "inbox",
			is_read: false,
			has_attachments: false,
			attachment_count: 0,
			attachments_meta: [
				{ filename: "Price_Sheet.pdf", mime_type: "application/pdf", size: 1000 },
				{ filename: "Delivery_Note.pdf" },
			],
		},
		{
			attachments: [
				{
					filename: "Invoice_INV-0042.pdf",
					mimeType: "application/pdf",
					content: new Uint8Array([1, 2, 3]),
				},
			],
		},
	);

	assert.equal(result.imported, true);

	// One stored attachment → one R2 object + one attachments row (extract_status pending).
	assert.equal(r2Puts.length, 1);
	const attachmentInserts = db.writes.filter((write) =>
		write.sql.startsWith("INSERT INTO attachments"),
	);
	assert.equal(attachmentInserts.length, 1);
	assert.match(attachmentInserts[0].sql, /extract_status/);
	assert.ok(attachmentInserts[0].params.includes("pending"));

	// Email row counts ALL attachments (1 stored + 2 metadata-only).
	const emailInsert = db.writes.find((write) => write.sql.startsWith("INSERT INTO emails"));
	assert.ok(emailInsert, "expected an INSERT INTO emails statement");
	const emailColumns = (emailInsert.sql.match(/INSERT INTO emails \(([^)]+)\)/) ?? [])[1]
		.split(",")
		.map((column) => column.trim());
	assert.equal(emailInsert.params[emailColumns.indexOf("has_attachments")], true);
	assert.equal(emailInsert.params[emailColumns.indexOf("attachment_count")], 3);

	// Phase 6 (AI-only cutover): no heuristic stamp at ingest. Without a
	// matching USER sender rule the row inserts with category NULL — the
	// Codex sidecar classifies it via the classify-queue afterwards.
	assert.equal(emailInsert.params[emailColumns.indexOf("category")], null);

	// attachment_names rewritten with the COMBINED list (stored + metadata-only).
	const namesUpdate = db.writes
		.filter(
			(write) =>
				write.sql.startsWith("UPDATE emails SET attachment_names = ?") &&
				typeof write.params[0] === "string",
		)
		.at(-1);
	assert.ok(namesUpdate, "expected explicit attachment_names UPDATE");
	assert.equal(namesUpdate.params[0], "Invoice_INV-0042.pdf Price_Sheet.pdf Delivery_Note.pdf");
	resetTableCache();
});

// Phase 6 (AI-only cutover): the sender-rule short-circuit is the only
// classification applied at ingest. A rule with confidence >= 0.7 stamps
// instantly; low-confidence rules do NOT. Rules are global (no domain scope).
test("Phase 6: getUserRuleClassification short-circuits confident rules", async () => {
	const makeRuleDb = (rule: Record<string, unknown> | null) =>
		({
			prepare(sql: string) {
				const statement = {
					bind() {
						return statement;
					},
					async first() {
						// Only the exact-match sender_rules lookup returns the rule;
						// the wildcard probe (and anything else) returns nothing.
						return /FROM sender_rules WHERE from_pattern = \?/.test(sql) ? rule : null;
					},
					async all() {
						return { results: [] };
					},
				};
				return statement;
			},
		}) as unknown as D1Database;

	const baseRule = {
		id: "sr-1",
		domain: "sensors.example",
		from_pattern: "no-reply@sensors.example",
		category: "home_alerts",
		confidence: 1,
		created_at: 1,
		updated_at: 1,
	};

	const homeAlerts = JSON.stringify([{ domain: "sensors.example", label: "Customer A — Sensors" }]);
	const userHit = await getUserRuleClassification(
		makeRuleDb(baseRule),
		"no-reply@sensors.example",
		homeAlerts,
	);
	assert.ok(userHit, "expected a user rule to short-circuit");
	assert.equal(userHit.category, "home_alerts");
	assert.equal(userHit.rule_id, "sr-1");
	// sub_category resolved the same way the retired pipeline did (Phase 4
	// sender heuristics over the rule's category, labels from HOME_ALERTS_JSON).
	assert.equal(userHit.sub_category, "Customer A — Sensors");

	// Low-confidence user rules don't stamp either.
	const lowConfidence = await getUserRuleClassification(
		makeRuleDb({ ...baseRule, confidence: 0.5 }),
		"no-reply@sensors.example",
	);
	assert.equal(lowConfidence, null);

	// No rule at all → category stays NULL for the Codex sidecar.
	const miss = await getUserRuleClassification(makeRuleDb(null), "someone@example.com");
	assert.equal(miss, null);
});

/**
 * Open an in-memory SQLite with FTS5 under either test runner: bun:sqlite
 * when running via `bun test`, node:sqlite under `bun run test` (tsx/node).
 * NOTE: this validates the mark-aware snippet logic, not D1 planner
 * compatibility — the correlated-subquery shape is verified against remote
 * D1 separately (local engines accept shapes D1 rejects).
 */
function openSnippetTestDb(): {
	exec: (sql: string) => void;
	get: (sql: string, params: unknown[]) => Record<string, unknown>;
	all: (sql: string, params: unknown[]) => Record<string, unknown>[];
	close: () => void;
} {
	const req = createRequire(import.meta.url);
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = req("bun:sqlite");
		const db = new Database(":memory:");
		return {
			exec: (sql: string) => db.run(sql),
			get: (sql: string, params: unknown[]) =>
				db.query(sql).get(...(params as never[])) as Record<string, unknown>,
			all: (sql: string, params: unknown[]) =>
				db.query(sql).all(...(params as never[])) as Record<string, unknown>[],
			close: () => db.close(),
		};
	}
	const { DatabaseSync } = req("node:sqlite");
	const db = new DatabaseSync(":memory:");
	return {
		exec: (sql: string) => db.exec(sql),
		get: (sql: string, params: unknown[]) =>
			db.prepare(sql).get(...(params as never[])) as Record<string, unknown>,
		all: (sql: string, params: unknown[]) =>
			db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
		close: () => db.close(),
	};
}

test("snippet subqueries surface attachment-only matches with a source discriminator", () => {
	const db = openSnippetTestDb();
	db.exec(`CREATE TABLE emails (
		id TEXT PRIMARY KEY, subject TEXT, text_content TEXT, from_address TEXT,
		from_name TEXT, to_address TEXT, to_addresses_json TEXT, cc_addresses_json TEXT,
		bcc_addresses_json TEXT, reply_to_addresses_json TEXT, attachment_names TEXT,
		attachment_search_text TEXT
	)`);
	db.exec(`CREATE VIRTUAL TABLE emails_fts USING fts5(
		subject, text_content, from_address, from_name, to_address, to_addresses_json,
		cc_addresses_json, bcc_addresses_json, reply_to_addresses_json, attachment_names,
		attachment_search_text, content='emails', content_rowid='rowid'
	)`);
	db.exec(`INSERT INTO emails (id, subject, text_content, from_address, attachment_names, attachment_search_text)
		VALUES ('em1', 'Quarterly invoice', 'See the attached invoice for details',
		'bob@example.com', 'Invoice_2024_Q4.pdf', 'equipment warranty terms and renewal')`);
	db.exec(`INSERT INTO emails_fts (rowid, subject, text_content, from_address, from_name, to_address,
		to_addresses_json, cc_addresses_json, bcc_addresses_json, reply_to_addresses_json,
		attachment_names, attachment_search_text)
		SELECT rowid, COALESCE(subject,''), COALESCE(text_content,''), COALESCE(from_address,''),
		'', '', '', '', '', '', COALESCE(attachment_names,''), COALESCE(attachment_search_text,'')
		FROM emails`);

	const sql = `SELECT e.id,
		${buildMatchSnippetSubquery("e.rowid")} AS snippet,
		${buildMatchSnippetSourceSubquery("e.rowid")} AS snippet_source
		FROM emails_fts INNER JOIN emails e ON e.rowid = emails_fts.rowid
		WHERE emails_fts MATCH ?`;

	// Match only in extracted attachment text → marked attachment snippet + discriminator.
	const attachmentHit = db.get(sql, ["warranty*", "warranty*", "warranty*"]);
	assert.match(String(attachmentHit.snippet), /<mark>warranty<\/mark>/);
	assert.equal(attachmentHit.snippet_source, "attachment");

	// Match in the body → marked body snippet, NO attachment discriminator.
	const bodyHit = db.get(sql, ["invoice*", "invoice*", "invoice*"]);
	assert.match(String(bodyHit.snippet), /attached <mark>invoice<\/mark>/);
	assert.equal(bodyHit.snippet_source, null);
	db.close();
});

/**
 * Regression: the SMTP lane built MIME with a bare btoa(), which throws on any
 * code point above U+00FF — a single em-dash in a subject returned a 500 while
 * the other provider lane sent the same content fine.
 */
function decodeEncodedWords(value: string): string {
	return Buffer.concat(
		value
			.split("\r\n ")
			.map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, ""), "base64")),
	).toString("utf8");
}

test("smtp MIME encodes non-ASCII subjects, display names, and bodies", () => {
	const subject = "Monitor — sensor offline (—40°C)";
	const text = "Job tripped — see the dashboard. Café… ✅";
	const message = buildMimeMessage(
		{
			from: "Éxample Sender <owner@work.example>",
			to: ["ops@work.example"],
			subject,
			text,
		},
		"<abc123@work.example>",
	);

	const separator = message.indexOf("\r\n\r\n");
	const headerBlock = message.slice(0, separator);
	const body = message.slice(separator + 4);

	// Headers must be ASCII on the wire — raw UTF-8 arrives as mojibake even
	// where it doesn't crash the encoder.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-range assertion
	assert.ok(/^[\x00-\x7f]*$/.test(headerBlock), "headers must be ASCII-only");

	const headerLines = headerBlock.split("\r\n");
	const subjectLine = headerLines.find((line) => line.startsWith("Subject: "));
	assert.match(String(subjectLine), /^Subject: =\?UTF-8\?B\?/);
	assert.equal(decodeEncodedWords(String(subjectLine).slice("Subject: ".length)), subject);

	// Display name is encoded; the addr-spec stays bare and parseable.
	const fromLine = headerLines.find((line) => line.startsWith("From: "));
	assert.match(String(fromLine), /^From: =\?UTF-8\?B\?\S+\?= <owner@work\.example>$/);

	// Body round-trips through UTF-8 base64.
	assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), text);
});

test("smtp MIME leaves ASCII headers unencoded and wraps base64 at 76 chars", () => {
	const message = buildMimeMessage(
		{
			from: "owner@work.example",
			to: ["ops@work.example"],
			subject: "Plain ASCII subject",
			text: "x".repeat(5000),
			headers: { "In-Reply-To": "<prior@work.example>\r\nBcc: attacker@evil.example" },
		},
		"<abc123@work.example>",
	);

	// ASCII subjects stay human-readable — no gratuitous encoded-words.
	assert.ok(message.includes("Subject: Plain ASCII subject\r\n"));

	// Header values are single-line, so a CRLF in a custom header can't smuggle
	// in a Bcc.
	assert.ok(!/^Bcc:/m.test(message), "custom header must not inject a new header");

	// RFC 2045 caps base64 lines at 76 chars; SMTP hard-caps any line at 998.
	const separator = message.indexOf("\r\n\r\n");
	const bodyLines = message.slice(separator + 4).split("\r\n");
	assert.ok(bodyLines.length > 1, "long body must be wrapped across lines");
	for (const line of bodyLines) {
		assert.ok(line.length <= 76, `base64 line too long: ${line.length}`);
	}
	assert.equal(Buffer.from(bodyLines.join(""), "base64").toString("utf8"), "x".repeat(5000));
});

/**
 * Regression: GET /api/emails takes the thread-collapsed path, whose where
 * clause only knew about domain/mailbox_state/category/attachments/read/dates.
 * from, to, direction and mailbox were parsed, documented, and then silently
 * dropped — so `?direction=outbound&from=owner@business.example` returned inbound
 * marketing mail.
 */
function openThreadFilterDb() {
	const db = openSnippetTestDb();
	db.exec(`CREATE TABLE threads (
		id TEXT PRIMARY KEY, domain TEXT, latest_email_id TEXT, latest_message_at INTEGER
	)`);
	db.exec(`CREATE TABLE emails (
		id TEXT PRIMARY KEY, thread_id TEXT, from_address TEXT, to_address TEXT,
		direction TEXT, mailbox TEXT, mailbox_state TEXT, sent_at INTEGER, received_at INTEGER
	)`);
	// t1: owner sent, Bob replied. t2: inbound marketing only (the noise that
	// used to crowd out the filtered result).
	db.exec(`INSERT INTO threads VALUES
		('t1', 'business.example', 'e2', 200),
		('t2', 'business.example', 'e3', 300)`);
	db.exec(`INSERT INTO emails VALUES
		('e1', 't1', 'owner@business.example', 'bob@example.com', 'outbound', 'owner', 'sent', 100, 100),
		('e2', 't1', 'bob@example.com', 'owner@business.example', 'inbound', 'owner', 'inbox', NULL, 200),
		('e3', 't2', 'marketing@spam.example', 'owner@business.example', 'inbound', 'owner', 'inbox', NULL, 300)`);
	return db;
}

function listThreadCollapsedIds(
	db: ReturnType<typeof openSnippetTestDb>,
	filters: Parameters<typeof buildThreadCollapsedWhereClause>[0],
): string[] {
	const { where, params } = buildThreadCollapsedWhereClause(filters, ["business.example"]);
	const { joinClause, params: joinParams } = buildThreadConversationJoinClause(filters);
	// Same bind order as getThreadCollapsedEmails: join params precede where params.
	const rows = db.all(
		`SELECT e.id FROM threads t ${joinClause} ${where} ORDER BY t.latest_message_at DESC`,
		[...joinParams, ...params],
	);
	return rows.map((row) => String(row.id));
}

test("thread-collapsed list applies from/to/direction/mailbox filters", () => {
	const db = openThreadFilterDb();
	const base = { limit: 50, offset: 0 };

	// Unfiltered: one row per thread, represented by its latest message.
	assert.deepEqual(listThreadCollapsedIds(db, base), ["e3", "e2"]);

	// The reported repro: outbound + from must not surface inbound marketing,
	// and must represent the thread with the message that actually matched.
	assert.deepEqual(
		listThreadCollapsedIds(db, {
			...base,
			direction: "outbound",
			from: "owner@business.example",
		}),
		["e1"],
	);

	assert.deepEqual(listThreadCollapsedIds(db, { ...base, direction: "inbound" }), ["e3", "e2"]);
	assert.deepEqual(listThreadCollapsedIds(db, { ...base, to: "bob@example.com" }), ["e1"]);
	assert.deepEqual(listThreadCollapsedIds(db, { ...base, from: "nobody@example.com" }), []);
	assert.deepEqual(listThreadCollapsedIds(db, { ...base, mailbox: "owner" }), ["e3", "e2"]);

	// The per-message filters must hold together on ONE message. t1 has an
	// outbound message and a message from Bob, but no outbound message from
	// Bob — independent EXISTS clauses would wrongly match here.
	assert.deepEqual(
		listThreadCollapsedIds(db, { ...base, direction: "outbound", from: "bob@example.com" }),
		[],
	);

	// mailbox_state still narrows to the newest member in that state.
	assert.deepEqual(listThreadCollapsedIds(db, { ...base, mailbox_state: "sent" }), ["e1"]);
	db.close();
});
