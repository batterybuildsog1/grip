import { type IDBPDatabase, openDB } from "idb";
import {
	currentIdentity,
	identityGeneration,
	identityTag,
	isCurrentGeneration,
	onIdentityLost,
} from "./identity";
import type {
	EmailCategory,
	EmailDirection,
	InterestLevel,
	MailboxState,
	SendAttachment,
	ThreadParticipant,
} from "../types";

export interface ConversationSummaryRecord {
	id: string;
	latest_email_id: string | null;
	display_email_id: string | null;
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
	snippet: string | null;
	/** 'attachment' when the search snippet matched only attachment filename/text. */
	snippet_source?: "attachment" | null;
	category: EmailCategory | null;
	interest_level: InterestLevel | null;
	interest_comment: string | null;
	thread_id: string;
	thread_count: number;
	thread_unread_count: number;
	thread_participants: ThreadParticipant[];
	thread_has_attachments: boolean;
	thread_is_muted: boolean;
	thread_is_starred: boolean;
	/** The display message's file names, up to 3 (newer Workers; older rows and caches carry none). */
	display_attachment_names?: string[];
	/** Sent and draft rows: the server's name for `to_address` (`display_to_name`); none = show it. */
	to_name?: string | null;
}

interface LegacyEmailSummaryRecord {
	id: string;
	thread_id: string | null;
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
	snippet: string | null;
	category: EmailCategory | null;
	interest_level: InterestLevel | null;
	interest_comment: string | null;
	thread_count: number;
	thread_unread_count: number;
	thread_participants: ThreadParticipant[];
	thread_has_attachments: boolean;
	thread_is_muted: boolean;
	thread_is_starred: boolean;
}

interface MailClawDB {
	email_summaries: {
		key: string;
		value: LegacyEmailSummaryRecord;
		indexes: {
			received_at: number;
			mailbox_state: MailboxState;
			"mailbox_state,received_at": [MailboxState, number];
			thread_id: string;
		};
	};
	conversation_summaries: {
		key: string;
		value: ConversationSummaryRecord;
		indexes: {
			latest_message_at: number;
			mailbox_state: MailboxState;
			"mailbox_state,latest_message_at": [MailboxState, number];
			thread_id: string;
			latest_email_id: string;
		};
	};
	// Kept so the schema stays exactly version 4 (an open older tab, or a rolled-back UI, opens it
	// as is; review F7). Nothing writes them any more: written-never-read details, a queue nothing
	// replayed, a write-only draft copy. Their old rows are cleared on open.
	email_details: { key: string; value: unknown };
	sync_queue: { key: number; value: unknown; indexes: { created_at: number } };
	draft_snapshots: { key: string; value: unknown; indexes: { timestamp: number } };
}

const RETIRED_STORES = ["email_details", "sync_queue", "draft_snapshots"] as const;

interface ComposeDB {
	compose_drafts: {
		key: string;
		value: LocalComposeDraft;
	};
}

/**
 * One open compose window, kept on this device on every edit, before (and whether or not) the
 * server save succeeds, in the signed-in identity's own drafts database (never another's).
 * Restored on the next load, so a reload, a crash or an ended Cloudflare Access session loses
 * nothing: not the text, not new attachments (up to
 * MAX_LOCAL_ATTACHMENT_BYTES; larger sets keep everything but the files). Closed (Close,
 * Cancel) it stays, marked `closedAt`, for New, Reply or its Drafts row to bring back
 * (takeClosedComposeDraft). Deleted when it is sent or discarded.
 */
export interface LocalComposeDraft {
	/** The compose window id; a restored window reuses it. */
	id: string;
	draftId: string | null;
	draftRevision: number;
	/** conversationId: the thread its inline reply shows under (absent in records before S5). */
	replyTo: {
		emailId: string;
		mode: "reply" | "reply-all" | "forward";
		conversationId?: string | null;
	} | null;
	minimized: boolean;
	fields: {
		from: string;
		to: string;
		cc: string;
		bcc: string;
		subject: string;
		/** The typed text; with `quote` absent (older records) the whole message. */
		text: string;
		/** Retired with the formatting editor; written as null, kept for older UIs. */
		html: string | null;
		editorStateJson: string | null;
		inReplyTo: string | null;
		references: string | null;
		/** The quoted original or forwarded message under the typed text ("Quoted text"). */
		quote?: string | null;
	};
	/** Send was pressed and its 5-second Undo was running: a reload means it never went out. */
	sendPendingAt?: number | null;
	attachments: SendAttachment[];
	/** The files were over the local cap and are not kept here (the server copy may have them). */
	attachmentsOmitted: boolean;
	/** Last local edit. */
	updatedAt: number;
	/** Last successful server save of this content; null = the server has never seen it. */
	serverSavedAt: number | null;
	/** Closed with words in it: not reopened on load, waiting to be brought back. */
	closedAt?: number | null;
}

export const MAX_LOCAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * One database per identity (`mailclaw:<tag>`, lib/identity.ts), so one person's cached mail is
 * never where another reads, and a late write from a previous identity lands only in its own
 * database. Without a current identity there is no database: reads find nothing, writes are
 * dropped. "clawmail" is the pre-2026-10-22 database shared by everyone; it is deleted on claim.
 */
const DB_PREFIX = "mailclaw:";
const LEGACY_DB = "clawmail";
let opened: { tag: string; promise: Promise<IDBPDatabase<MailClawDB>> } | null = null;
let conversationSeedPromise: Promise<void> | null = null;

function latestMessageAt(summary: ConversationSummaryRecord): number {
	return summary.received_at || summary.sent_at || 0;
}

function normalizeConversationSummary(
	summary: ConversationSummaryRecord,
): ConversationSummaryRecord {
	const threadId = summary.thread_id || summary.id;
	return {
		...summary,
		id: summary.id || threadId,
		thread_id: threadId,
		latest_email_id: summary.latest_email_id ?? null,
		display_email_id: summary.display_email_id ?? summary.latest_email_id ?? null,
		mailbox: summary.mailbox || summary.mailbox_state,
		received_at: latestMessageAt(summary),
		sent_at: summary.sent_at ?? null,
		read_at: summary.thread_unread_count > 0 ? null : (summary.read_at ?? latestMessageAt(summary)),
		thread_count: Math.max(summary.thread_count ?? 0, 1),
		thread_unread_count: Math.max(summary.thread_unread_count ?? 0, 0),
		thread_participants: summary.thread_participants ?? [],
	};
}

function conversationFromLegacySummary(
	summary: LegacyEmailSummaryRecord,
): ConversationSummaryRecord {
	const threadId = summary.thread_id || summary.id;
	const latestAt = summary.received_at || summary.sent_at || 0;
	return normalizeConversationSummary({
		id: threadId,
		latest_email_id: summary.id,
		display_email_id: summary.id,
		from_address: summary.from_address,
		from_name: summary.from_name,
		to_address: summary.to_address,
		to_addresses: summary.to_addresses ?? [],
		cc_addresses: summary.cc_addresses ?? [],
		bcc_addresses: summary.bcc_addresses ?? [],
		reply_to_addresses: summary.reply_to_addresses ?? [],
		domain: summary.domain,
		mailbox: summary.mailbox,
		direction: summary.direction,
		mailbox_state: summary.mailbox_state,
		subject: summary.subject,
		received_at: latestAt,
		sent_at: summary.sent_at ?? null,
		read_at: summary.thread_unread_count > 0 ? null : (summary.read_at ?? latestAt),
		has_attachments: summary.thread_has_attachments ?? summary.has_attachments,
		attachment_count: summary.attachment_count ?? 0,
		snippet: summary.snippet,
		category: summary.category ?? null,
		interest_level: summary.interest_level ?? null,
		interest_comment: summary.interest_comment ?? null,
		thread_id: threadId,
		thread_count: summary.thread_count ?? 1,
		thread_unread_count: summary.thread_unread_count ?? (summary.read_at == null ? 1 : 0),
		thread_participants: summary.thread_participants ?? [],
		thread_has_attachments: summary.thread_has_attachments ?? summary.has_attachments,
		thread_is_muted: summary.thread_is_muted ?? false,
		thread_is_starred: summary.thread_is_starred ?? false,
	});
}

async function ensureConversationSummariesSeeded(): Promise<void> {
	if (conversationSeedPromise) return conversationSeedPromise;
	conversationSeedPromise = (async () => {
		const db = await getDB();
		if (!db) return;
		const existingCount = await db.count("conversation_summaries");
		if (existingCount > 0) return;

		const legacy = await db.getAll("email_summaries");
		if (legacy.length === 0) return;

		const merged = new Map<string, ConversationSummaryRecord>();
		for (const summary of legacy) {
			const candidate = conversationFromLegacySummary(summary);
			const key = candidate.thread_id || candidate.id;
			const current = merged.get(key);
			if (!current || latestMessageAt(candidate) >= latestMessageAt(current)) {
				merged.set(key, candidate);
			}
		}

		if (merged.size === 0) return;

		const tx = db.transaction("conversation_summaries", "readwrite");
		for (const summary of merged.values()) {
			await tx.store.put(summary);
		}
		await tx.done;
	})().finally(() => {
		conversationSeedPromise = null;
	});

	return conversationSeedPromise;
}

/** Close this tab's connection (identity lost, or another tab deleting the database). */
export function closeDatabase(): void {
	const current = opened;
	opened = null;
	current?.promise.then((db) => db.close()).catch(() => {});
}

onIdentityLost(closeDatabase);

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, 3000); // blocked by a tab that never closes: give up waiting
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		try {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = done;
			request.onerror = done;
		} catch {
			done();
		}
	});
}

/**
 * Delete every mail and drafts database on this device except `keep`'s (null: all of them).
 * Drafts go with their identity: a claim by someone else, or a sign-out (after its unsaved-text
 * warning), leaves no other identity's drafts readable on this browser.
 */
export async function deleteMailDatabases(keep: string | null): Promise<void> {
	const keepNames = keep
		? [`${DB_PREFIX}${identityTag(keep)}`, `${COMPOSE_DB_PREFIX}${identityTag(keep)}`]
		: [];
	let names = [LEGACY_DB, LEGACY_COMPOSE_DB];
	try {
		const listed = await indexedDB.databases();
		names = names.concat(
			listed
				.map((entry) => entry.name ?? "")
				.filter((n) => n.startsWith(DB_PREFIX) || n.startsWith(COMPOSE_DB_PREFIX)),
		);
	} catch {
		// databases() unsupported: only the current identity's names and the legacy ones are known.
		const identity = currentIdentity();
		if (identity && !keep) names.push(`${COMPOSE_DB_PREFIX}${identityTag(identity)}`);
	}
	if (!keep || keep !== currentIdentity()) closeComposeDatabase();
	await Promise.all(
		[...new Set(names)].filter((name) => !keepNames.includes(name)).map(deleteDatabase),
	);
}

function getDB(): Promise<IDBPDatabase<MailClawDB> | null> {
	const identity = currentIdentity();
	if (!identity) return Promise.resolve(null);
	const tag = identityTag(identity);
	if (opened?.tag !== tag) {
		closeDatabase();
		const promise = openDB<MailClawDB>(`${DB_PREFIX}${tag}`, 4, {
			upgrade(db, oldVersion, _newVersion, transaction) {
				if (oldVersion < 1) {
					// email_summaries
					const summaries = db.createObjectStore("email_summaries", {
						keyPath: "id",
					});
					summaries.createIndex("received_at", "received_at");
					summaries.createIndex("mailbox_state", "mailbox_state");
					summaries.createIndex("mailbox_state,received_at", ["mailbox_state", "received_at"]);

					// email_details
					db.createObjectStore("email_details", { keyPath: "id" });

					// sync_queue
					const queue = db.createObjectStore("sync_queue", {
						keyPath: "id",
						autoIncrement: true,
					});
					queue.createIndex("created_at", "created_at");
				}

				if (oldVersion < 2) {
					const summaries = transaction.objectStore("email_summaries");
					summaries.createIndex("thread_id", "thread_id");
				}

				if (oldVersion < 3) {
					const conversations = db.createObjectStore("conversation_summaries", {
						keyPath: "id",
					});
					conversations.createIndex("latest_message_at", "received_at");
					conversations.createIndex("mailbox_state", "mailbox_state");
					conversations.createIndex("mailbox_state,latest_message_at", [
						"mailbox_state",
						"received_at",
					]);
					conversations.createIndex("thread_id", "thread_id");
					conversations.createIndex("latest_email_id", "latest_email_id");
				}

				if (oldVersion < 4) {
					if (!db.objectStoreNames.contains("draft_snapshots")) {
						const store = db.createObjectStore("draft_snapshots", { keyPath: "id" });
						store.createIndex("timestamp", "timestamp");
					}
				}
			},
			// Another tab wants this database deleted (it signed in as someone else, or out), or a
			// newer version open: never hold either up.
			blocking() {
				if (opened?.promise === promise) closeDatabase();
			},
		}).then(async (db) => {
			// Retired stores: drop what an older UI left in them (no schema change).
			const tx = db.transaction([...RETIRED_STORES], "readwrite");
			await Promise.all([...RETIRED_STORES.map((name) => tx.objectStore(name).clear()), tx.done]);
			return db;
		});
		opened = { tag, promise };
	}
	return opened.promise;
}

// ── Conversation Summaries ──

/**
 * The device's rows for a browse list, newest first: one mailbox state, or none for All mail. What
 * the server's browse leaves out is left out here too, before the offset and limit count it: Trash
 * outside Trash, Spam outside Trash (routes/conversations.ts). A failed or slow All mail drew Trash
 * and Spam from here (P1-4 review). A row carries the state of the last list, search or action that
 * saw it, so this is the device's best knowledge, never another view's rows.
 */
export async function getCachedConversationSummaries(
	mailboxState?: MailboxState,
	limit = 50,
	offset = 0,
): Promise<ConversationSummaryRecord[]> {
	await ensureConversationSummariesSeeded();
	const db = await getDB();
	if (!db) return [];
	const listed = (row: ConversationSummaryRecord) =>
		mailboxState === "trash" || (row.mailbox_state !== "trash" && row.category !== "spam");

	const tx = db.transaction("conversation_summaries", "readonly");
	let cursor = mailboxState
		? await tx.store
				.index("mailbox_state,latest_message_at")
				.openCursor(
					IDBKeyRange.bound([mailboxState, 0], [mailboxState, Number.MAX_SAFE_INTEGER]),
					"prev",
				)
		: await tx.store.index("latest_message_at").openCursor(null, "prev");
	const results: ConversationSummaryRecord[] = [];
	let skipped = 0;
	while (cursor && results.length < limit) {
		if (listed(cursor.value)) {
			if (skipped < offset) skipped++;
			else results.push(cursor.value);
		}
		cursor = await cursor.continue();
	}
	return results;
}

/** Conversations that no longer exist (Delete forever): their device rows go. */
export async function deleteConversationSummaries(ids: string[]): Promise<void> {
	await ensureConversationSummariesSeeded();
	const db = await getDB();
	if (!db) return;
	const tx = db.transaction("conversation_summaries", "readwrite");
	await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/** One conversation's last-known row on this device (a thread that can't load still shows it). */
export async function getCachedConversationSummary(
	id: string,
): Promise<ConversationSummaryRecord | undefined> {
	await ensureConversationSummariesSeeded();
	const db = await getDB();
	return db ? db.get("conversation_summaries", id) : undefined;
}

export async function putConversationSummaries(
	summaries: ConversationSummaryRecord[],
): Promise<void> {
	const db = await getDB();
	if (!db) return;
	const tx = db.transaction("conversation_summaries", "readwrite");
	for (const s of summaries) {
		await tx.store.put(normalizeConversationSummary(s));
	}
	await tx.done;
}

// ── Summary Partial Update ──

export async function updateConversationSummary(
	id: string,
	updates: Partial<ConversationSummaryRecord>,
): Promise<void> {
	await ensureConversationSummariesSeeded();
	const db = await getDB();
	if (!db) return;
	const tx = db.transaction("conversation_summaries", "readwrite");
	const existing = await tx.store.get(id);
	if (existing) {
		await tx.store.put(normalizeConversationSummary({ ...existing, ...updates }));
	}
	await tx.done;
}

// ── Thread-level Summary Update ──

export async function updateConversationSummariesByThreadId(
	threadId: string,
	updates: Partial<ConversationSummaryRecord>,
): Promise<void> {
	await ensureConversationSummariesSeeded();
	const db = await getDB();
	if (!db) return;
	const tx = db.transaction("conversation_summaries", "readwrite");
	const index = tx.store.index("thread_id");
	let cursor = await index.openCursor(threadId);
	while (cursor) {
		await cursor.update(normalizeConversationSummary({ ...cursor.value, ...updates }));
		cursor = await cursor.continue();
	}
	await tx.done;
}

/** Evict cached summaries older than the given age (default 30 days). */
export async function evictStaleSummaries(maxAgeMs = 30 * 86_400_000): Promise<number> {
	await ensureConversationSummariesSeeded();
	const db = await getDB();
	if (!db) return 0;
	const tx = db.transaction(["conversation_summaries", "email_summaries"], "readwrite");
	const conversationIndex = tx.objectStore("conversation_summaries").index("latest_message_at");
	const emailIndex = tx.objectStore("email_summaries").index("received_at");
	const cutoff = Date.now() - maxAgeMs;
	let deleted = 0;

	let cursor = await conversationIndex.openCursor(IDBKeyRange.upperBound(cutoff));
	while (cursor) {
		await cursor.delete();
		deleted++;
		cursor = await cursor.continue();
	}

	let legacyCursor = await emailIndex.openCursor(IDBKeyRange.upperBound(cutoff));
	while (legacyCursor) {
		await legacyCursor.delete();
		deleted++;
		legacyCursor = await legacyCursor.continue();
	}

	await tx.done;
	return deleted;
}

/** Clear all IndexedDB stores and service worker API caches. */
export async function clearAllCaches(): Promise<void> {
	// Every mail database on the device, not just this identity's.
	closeDatabase();
	await deleteMailDatabases(null);

	// Clear service worker API caches
	const cacheNames = await caches.keys();
	await Promise.all(
		cacheNames.filter((name) => name.startsWith("api-")).map((name) => caches.delete(name)),
	);
}

// ── Compose drafts kept on this device, per identity ──

/**
 * Drafts live in their own database per identity, `mailclaw-compose:<tag>` (lib/identity.ts),
 * so the cache database never needs a version bump (review F7) and one person's drafts are
 * never where another reads. Without a current identity there is none: reads find nothing and
 * writes fail (the window then says it is not kept). Work started under one identity generation
 * never reads or writes under another: a stale answer is refused (StaleIdentity), a late write
 * is not made. "mailclaw-compose" is the identity-less name an unreleased build used.
 */
const COMPOSE_DB_PREFIX = "mailclaw-compose:";
const LEGACY_COMPOSE_DB = "mailclaw-compose";
let composeOpened: { tag: string; promise: Promise<IDBPDatabase<ComposeDB>> } | null = null;

export class StaleIdentity extends Error {
	constructor() {
		super("The signed-in identity changed; this local draft operation was dropped");
	}
}

function closeComposeDatabase(): void {
	const current = composeOpened;
	composeOpened = null;
	current?.promise.then((db) => db.close()).catch(() => {});
}

onIdentityLost(closeComposeDatabase);

/** This identity's drafts database, and the generation it was opened under. */
function getComposeDB(): { db: Promise<IDBPDatabase<ComposeDB>>; started: number } | null {
	const identity = currentIdentity();
	if (!identity) return null;
	const started = identityGeneration();
	const tag = identityTag(identity);
	if (composeOpened?.tag !== tag) {
		closeComposeDatabase();
		const promise = openDB<ComposeDB>(`${COMPOSE_DB_PREFIX}${tag}`, 1, {
			upgrade(db) {
				db.createObjectStore("compose_drafts", { keyPath: "id" });
			},
			blocking() {
				if (composeOpened?.promise === promise) closeComposeDatabase();
			},
		});
		promise.catch(() => {
			if (composeOpened?.promise === promise) composeOpened = null;
		});
		composeOpened = { tag, promise };
	}
	return { db: composeOpened.promise, started };
}

/** Rejects when the draft could not be stored (no identity, quota, storage denied): say so. */
export async function putLocalComposeDraft(draft: LocalComposeDraft): Promise<void> {
	const open = getComposeDB();
	if (!open) throw new StaleIdentity();
	const db = await open.db;
	if (!isCurrentGeneration(open.started)) throw new StaleIdentity();
	await db.put("compose_drafts", draft);
}

export async function getLocalComposeDraft(id: string): Promise<LocalComposeDraft | undefined> {
	const open = getComposeDB();
	if (!open) return undefined;
	const draft = await (await open.db).get("compose_drafts", id);
	if (!isCurrentGeneration(open.started)) throw new StaleIdentity();
	return draft;
}

export async function listLocalComposeDrafts(): Promise<LocalComposeDraft[]> {
	const open = getComposeDB();
	if (!open) return [];
	const all = await (await open.db).getAll("compose_drafts");
	if (!isCurrentGeneration(open.started)) throw new StaleIdentity();
	return all.sort((a, b) => a.updatedAt - b.updatedAt);
}

/**
 * The most recently closed draft `match` accepts, made window `windowId`'s in one transaction:
 * of two windows or tabs asking at once, one gets it. Undefined: none.
 */
export async function takeClosedComposeDraft(
	windowId: string,
	match: (draft: LocalComposeDraft) => boolean,
): Promise<LocalComposeDraft | undefined> {
	const open = getComposeDB();
	if (!open) return undefined;
	const db = await open.db;
	if (!isCurrentGeneration(open.started)) throw new StaleIdentity();
	const tx = db.transaction("compose_drafts", "readwrite");
	const closed = (await tx.store.getAll())
		.filter((draft) => draft.closedAt && match(draft))
		.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0];
	const taken = closed && { ...closed, id: windowId, closedAt: null };
	if (closed && taken) await Promise.all([tx.store.delete(closed.id), tx.store.put(taken)]);
	await tx.done;
	return taken;
}

export async function deleteLocalComposeDraft(id: string): Promise<void> {
	const open = getComposeDB();
	if (!open) return;
	const db = await open.db;
	if (!isCurrentGeneration(open.started)) return;
	await db.delete("compose_drafts", id);
}

// ── Which tab owns an open compose window ──

/**
 * An open window belongs to one live tab (web-r3-01): that tab holds a Web Lock named for the
 * window while it is open. The browser lets the lock go when the tab closes, reloads or crashes,
 * so the same tab's reload (or any tab's, once the owner is gone) restores the window, while a
 * second tab opened meanwhile leaves it alone. Without Web Locks every tab restores, as before.
 */
const composeLockPrefix = (tag: string) => `mailclaw-compose-window:${tag}:`;

/** Take window `id` for this tab: the release, or null when another tab has it open. */
export function holdComposeWindow(id: string): Promise<(() => void) | null> {
	const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
	const tag = currentIdentityTag();
	if (!locks || !tag) return Promise.resolve(() => {});
	return new Promise((resolve) => {
		let release = () => {};
		const held = new Promise<void>((done) => {
			release = done;
		});
		locks
			.request(`${composeLockPrefix(tag)}${id}`, { ifAvailable: true }, (lock) => {
				if (!lock) {
					resolve(null);
					return;
				}
				resolve(release);
				return held;
			})
			.catch(() => resolve(() => {}));
	});
}

/** The ids of compose windows another tab has open now (before this tab restores any). */
export async function composeWindowsOpenElsewhere(): Promise<Set<string>> {
	const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
	const tag = currentIdentityTag();
	if (!locks?.query || !tag) return new Set();
	const prefix = composeLockPrefix(tag);
	const { held = [] } = await locks.query().catch(() => ({ held: [] as LockInfo[] }));
	return new Set(
		held
			.map((lock) => lock.name ?? "")
			.filter((name) => name.startsWith(prefix))
			.map((name) => name.slice(prefix.length)),
	);
}

/** The current identity's tag, for messages between tabs that must stay within one identity. */
export function currentIdentityTag(): string | null {
	const identity = currentIdentity();
	return identity ? identityTag(identity) : null;
}

/**
 * Open compose windows register a flush here: it writes the window's current state to
 * compose_drafts at once (skipping the edit debounce) and resolves true only when this device
 * now holds a complete copy (text and files). Call before anything that reloads the page, and
 * do not reload when it resolves false: the open window is then the only copy.
 */
const localComposeFlushers = new Map<string, () => Promise<boolean>>();

export function registerLocalComposeFlush(id: string, flush: () => Promise<boolean>): () => void {
	localComposeFlushers.set(id, flush);
	return () => localComposeFlushers.delete(id);
}

/** True when every open compose window is fully kept on this device. */
export async function flushLocalComposeDrafts(): Promise<boolean> {
	const results = await Promise.all(
		[...localComposeFlushers.values()].map((flush) => flush().catch(() => false)),
	);
	return results.every(Boolean);
}
