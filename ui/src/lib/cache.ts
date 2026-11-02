import { ApiHttpError, ApiNetworkError, api } from "../api/client";
import type {
	BatchAction,
	ConversationDetailResponse,
	ConversationSearchInfo,
	EmailCategory,
	EmailDirection,
	EmailFilters,
	MailboxState,
	PaginatedResponse,
	ThreadParticipant,
} from "../types";
import {
	type ConversationSummaryRecord,
	getCachedConversationSummaries,
	putConversationSummaries,
	updateConversationSummariesByThreadId,
	updateConversationSummary,
} from "./db";
import {
	currentIdentity,
	identityGeneration,
	identityTag,
	isCurrentGeneration,
	onAccessHeld,
	onIdentityLost,
	PAGE_CACHE_PREFIX,
} from "./identity";

export interface ConversationSummaryApiRecord {
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
	participants: ThreadParticipant[];
	is_muted: boolean;
	is_starred: boolean;
	category: EmailCategory | null;
	latest_email_id: string | null;
	display_email_id: string | null;
	display_mailbox_state: MailboxState | null;
	display_direction: EmailDirection | null;
	display_from_address: string | null;
	display_from_name: string | null;
	display_to_address: string | null;
	/** The server's name for display_to_address on a sent or draft row (absent before the deploy). */
	display_to_name?: string | null;
	display_to_addresses: string[];
	display_cc_addresses: string[];
	display_bcc_addresses: string[];
	display_received_at: number | null;
	display_sent_at: number | null;
	display_snippet: string | null;
	display_snippet_source?: "attachment" | null;
	/** Up to 3 file names of the display message (newer Workers; absent before the deploy). */
	display_attachment_names?: string[];
}

interface ConversationListResponse {
	conversations: ConversationSummaryApiRecord[];
	total: number;
	limit: number;
	offset: number;
	next_cursor?: string | null;
	has_more?: boolean;
	search?: ConversationSearchInfo;
}

interface CachedPage<T> {
	data: T;
	expiresAt: number;
}

// Every key below starts with the identity's tag (lib/identity.ts): one person's pages and
// details are never found under another's, and nothing is cached without an identity.
const CONVERSATION_PAGE_CACHE_PREFIX = PAGE_CACHE_PREFIX;
const CONVERSATION_PAGE_CACHE_TTL_MS = 5 * 60_000;
const MAX_CONVERSATION_PAGE_CACHE_ENTRIES = 16;
const conversationPageCache = new Map<
	string,
	CachedPage<PaginatedResponse<ConversationSummaryRecord>>
>();

const CONVERSATION_DETAIL_CACHE_TTL_MS = 5 * 60_000;
const MAX_CONVERSATION_DETAIL_CACHE_ENTRIES = 20;
const conversationDetailCache = new Map<string, CachedPage<ConversationDetailResponse>>();
const conversationDetailRequests = new Map<string, Promise<ConversationDetailResponse>>();

/**
 * Work started for an identity this tab no longer has rejects with this: no caller, including a
 * deduplicated subscriber, ever receives that identity's mail (re-review 2026-10-22 C).
 */
function staleIdentity(): ApiHttpError {
	return new ApiHttpError(409, "Signed in as someone else in another tab. Reload this tab.");
}

/** The current identity's tag, or null (no caching at all). */
function scope(): string | null {
	const identity = currentIdentity();
	return identity ? identityTag(identity) : null;
}

// In-flight requests may finish; their writes are fenced by generation (fetchConversationsFromNetwork).
onIdentityLost(() => {
	conversationPageCache.clear();
	conversationDetailCache.clear();
	conversationDetailRequests.clear();
});

function primaryParticipant(participants: ThreadParticipant[], domain: string): ThreadParticipant {
	return (
		participants[0] ?? {
			name: null,
			address: domain || "unknown",
		}
	);
}

function deriveDirection(mailboxState: MailboxState): EmailDirection {
	return mailboxState === "sent" ? "outbound" : "inbound";
}

export function toConversationSummaryRecord(
	conversation: ConversationSummaryApiRecord,
): ConversationSummaryRecord {
	const participant = primaryParticipant(conversation.participants, conversation.domain);
	const direction = conversation.display_direction ?? deriveDirection(conversation.mailbox_state);
	const rowMailboxState = conversation.display_mailbox_state ?? conversation.mailbox_state;
	const displayAt =
		conversation.display_sent_at ??
		conversation.display_received_at ??
		conversation.latest_message_at;
	const fromAddress = conversation.display_from_address ?? participant.address;
	const toAddress = conversation.display_to_address ?? participant.address;
	const toAddresses =
		conversation.display_to_addresses?.length > 0
			? conversation.display_to_addresses
			: conversation.participants.map((entry) => entry.address);
	return {
		id: conversation.id,
		latest_email_id: conversation.latest_email_id,
		display_email_id: conversation.display_email_id ?? conversation.latest_email_id,
		from_address: fromAddress,
		from_name: conversation.display_from_name ?? participant.name,
		to_address: toAddress,
		to_addresses: toAddresses,
		cc_addresses: conversation.display_cc_addresses ?? [],
		bcc_addresses: conversation.display_bcc_addresses ?? [],
		reply_to_addresses: [],
		domain: conversation.domain,
		mailbox: rowMailboxState,
		direction,
		mailbox_state: rowMailboxState,
		subject: conversation.subject,
		received_at: displayAt,
		sent_at: direction === "outbound" ? displayAt : null,
		read_at: conversation.unread_count > 0 ? null : displayAt,
		has_attachments: conversation.has_attachments,
		attachment_count: conversation.attachment_count,
		snippet: conversation.display_snippet ?? conversation.snippet,
		snippet_source: conversation.display_snippet
			? (conversation.display_snippet_source ?? null)
			: null,
		category: conversation.category,
		interest_level: null,
		interest_comment: null,
		thread_id: conversation.id,
		thread_count: conversation.message_count,
		thread_unread_count: conversation.unread_count,
		thread_participants: conversation.participants,
		thread_has_attachments: conversation.has_attachments,
		thread_is_muted: conversation.is_muted,
		thread_is_starred: conversation.is_starred,
		display_attachment_names: conversation.display_attachment_names,
		to_name: conversation.display_to_name ?? null,
	};
}

// ── Helpers ──

export function isOnline(): boolean {
	return navigator.onLine;
}

// ── Request deduplication ──

const inFlightRequests = new Map<string, Promise<PaginatedResponse<ConversationSummaryRecord>>>();
const inFlightControllers = new Map<string, AbortController>();

export function filtersKey(filters: EmailFilters): string {
	return JSON.stringify(filters, Object.keys(filters).sort());
}

function responseCacheKey(filters: EmailFilters): string | null {
	const tag = scope();
	if (!tag) return null;
	return `${tag}:${filtersKey({
		...filters,
		limit: filters.limit ?? 50,
		offset: filters.offset ?? 0,
	})}`;
}

function shouldUseConversationPageCache(filters: EmailFilters): boolean {
	return (
		!filters.q?.trim() &&
		!filters.cursor &&
		(filters.offset ?? 0) === 0 &&
		(filters.sort === undefined || filters.sort === "latest_desc")
	);
}

function pruneConversationPageCache(): void {
	while (conversationPageCache.size > MAX_CONVERSATION_PAGE_CACHE_ENTRIES) {
		const firstKey = conversationPageCache.keys().next().value;
		if (!firstKey) return;
		conversationPageCache.delete(firstKey);
		try {
			sessionStorage.removeItem(`${CONVERSATION_PAGE_CACHE_PREFIX}${firstKey}`);
		} catch {
			// Ignore storage failures.
		}
	}
}

function getCachedConversationPage(
	filters: EmailFilters,
): PaginatedResponse<ConversationSummaryRecord> | null {
	if (!shouldUseConversationPageCache(filters)) return null;
	const key = responseCacheKey(filters);
	if (!key) return null;
	const now = Date.now();
	const memory = conversationPageCache.get(key);
	if (memory && memory.expiresAt > now) {
		conversationPageCache.delete(key);
		conversationPageCache.set(key, memory);
		return memory.data;
	}
	if (memory) conversationPageCache.delete(key);

	try {
		const raw = sessionStorage.getItem(`${CONVERSATION_PAGE_CACHE_PREFIX}${key}`);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CachedPage<PaginatedResponse<ConversationSummaryRecord>>;
		if (!parsed?.data || parsed.expiresAt <= now) {
			sessionStorage.removeItem(`${CONVERSATION_PAGE_CACHE_PREFIX}${key}`);
			return null;
		}
		conversationPageCache.set(key, parsed);
		pruneConversationPageCache();
		return parsed.data;
	} catch {
		return null;
	}
}

/**
 * Synchronous read of the in-memory conversation page cache (no await), for the
 * optimistic paint-on-switch path. Returns null when the page isn't cached or
 * the filter shape isn't page-cacheable.
 */
export function peekConversationPage(
	filters: EmailFilters,
): PaginatedResponse<ConversationSummaryRecord> | null {
	return getCachedConversationPage(filters);
}

function putConversationPageCache(
	filters: EmailFilters,
	data: PaginatedResponse<ConversationSummaryRecord>,
): void {
	if (!shouldUseConversationPageCache(filters)) return;
	const key = responseCacheKey(filters);
	if (!key) return;
	const entry = {
		data,
		expiresAt: Date.now() + CONVERSATION_PAGE_CACHE_TTL_MS,
	};
	conversationPageCache.delete(key);
	conversationPageCache.set(key, entry);
	pruneConversationPageCache();
	try {
		sessionStorage.setItem(`${CONVERSATION_PAGE_CACHE_PREFIX}${key}`, JSON.stringify(entry));
	} catch {
		// Session storage is best-effort; memory cache still helps this tab.
	}
}

function updateConversationPageCacheRows(
	ids: string[],
	threadIds: string[] | undefined,
	updates: Partial<ConversationSummaryRecord>,
): void {
	const idSet = new Set(ids);
	const threadIdSet = new Set(threadIds ?? []);
	if (idSet.size === 0 && threadIdSet.size === 0) return;

	for (const [key, entry] of conversationPageCache) {
		const nextEntry = {
			...entry,
			data: {
				...entry.data,
				emails: entry.data.emails.map((email) =>
					idSet.has(email.id) || threadIdSet.has(email.thread_id)
						? { ...email, ...updates }
						: email,
				),
			},
		};
		conversationPageCache.set(key, nextEntry);
		try {
			sessionStorage.setItem(`${CONVERSATION_PAGE_CACHE_PREFIX}${key}`, JSON.stringify(nextEntry));
		} catch {
			// Ignore storage failures.
		}
	}
}

function clearConversationPageCache(): void {
	conversationPageCache.clear();
	try {
		const keys: string[] = [];
		for (let index = 0; index < sessionStorage.length; index += 1) {
			const key = sessionStorage.key(index);
			if (key?.startsWith(CONVERSATION_PAGE_CACHE_PREFIX)) keys.push(key);
		}
		for (const key of keys) sessionStorage.removeItem(key);
	} catch {
		// Ignore storage failures.
	}
}

/** In-flight list requests are shared only within one identity. */
/**
 * Keyed by identity generation too: after a hold or identity change a new request never joins one
 * started under the old generation (its answer is refused when it lands; review R2d).
 */
function inFlightKey(filterKey: string): string {
	return `${identityGeneration()}|${scope() ?? "-"}|${filterKey}`;
}

// The hold started: list requests from before it are retired (aborted, so the list shows no
// error for them; their answers would be refused anyway) and never joined again (review R2d).
onAccessHeld(() => {
	for (const controller of inFlightControllers.values()) controller.abort();
	inFlightControllers.clear();
	inFlightRequests.clear();
	conversationDetailRequests.clear();
});

export function cancelPendingRequests(exceptFilterKey?: string): void {
	const exceptKey = exceptFilterKey === undefined ? undefined : inFlightKey(exceptFilterKey);
	// Abort every in-flight conversation fetch EXCEPT the one we're about to
	// (re)issue — so a rapid A→B→A that returns to an already-in-flight A reuses
	// the live request instead of aborting it and re-issuing under a new
	// generation the stale-guard would then discard (the blank-inbox race).
	for (const [key, controller] of [...inFlightControllers]) {
		if (exceptKey && key === exceptKey) continue;
		controller.abort();
		inFlightControllers.delete(key);
		inFlightRequests.delete(key);
	}
}

function shouldBypassCache(filters: EmailFilters): boolean {
	return (
		Boolean(filters.q?.trim()) ||
		Boolean(filters.cursor) ||
		filters.category !== undefined ||
		Boolean(filters.for_person) ||
		Boolean(filters.domain) ||
		filters.is_read === false ||
		Boolean(filters.cursor) ||
		(filters.offset ?? 0) > 0 ||
		// IndexedDB summary cache is keyed only by mailbox_state; it can't
		// represent custom sort orders, so non-default sorts must skip it and
		// render straight from the live API response.
		(filters.sort !== undefined && filters.sort !== "latest_desc")
	);
}

function fetchConversationsFromNetwork(
	filters: EmailFilters,
	onUpdate?: (data: PaginatedResponse<ConversationSummaryRecord>) => void,
): Promise<PaginatedResponse<ConversationSummaryRecord>> {
	const key = inFlightKey(filtersKey(filters));
	const pending = inFlightRequests.get(key);

	if (pending) {
		if (onUpdate) {
			pending.then(onUpdate).catch(() => {});
		}
		return pending;
	}

	const controller = new AbortController();
	const started = identityGeneration();
	const askedAt = Date.now();
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(filters)) {
		if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
	}

	const request = api
		.request<ConversationListResponse>(
			`/conversations${params.size > 0 ? `?${params.toString()}` : ""}`,
			{ signal: controller.signal },
		)
		.then(async (fresh) => {
			const response: PaginatedResponse<ConversationSummaryRecord> = {
				emails: keepReadMarks(fresh.conversations.map(toConversationSummaryRecord), askedAt),
				total: fresh.total,
				limit: fresh.limit,
				offset: fresh.offset,
				next_cursor: fresh.next_cursor ?? null,
				has_more: fresh.has_more,
				search: fresh.search,
			};
			// Answered for an identity this tab no longer has: cache nothing, deliver nothing.
			if (!isCurrentGeneration(started)) throw staleIdentity();
			await putConversationSummaries(response.emails);
			if (!isCurrentGeneration(started)) throw staleIdentity();
			putConversationPageCache(filters, response);
			onUpdate?.(response);
			return response;
		})
		.finally(() => {
			inFlightRequests.delete(key);
			const current = inFlightControllers.get(key);
			if (current === controller) {
				inFlightControllers.delete(key);
			}
		});

	inFlightRequests.set(key, request);
	inFlightControllers.set(key, controller);
	return request;
}

// ── Read state a list answer may predate ──

// Read or unread this tab asked for, and when the server confirmed it (null while on its way). A
// list asked before then answers with the old state and painted the row back (review, 2026-10-30: a
// refresh in flight while a row was opened showed it unread again though the server had it read).
// Such an answer gets this tab's state back before it reaches a cache or the screen. Marks confirmed
// over ten minutes ago are dropped: the server's answers carry them by then.
type ReadMark = { unread: boolean; confirmedAt: number | null };
const readMarks = new Map<string, ReadMark>();
const readMarkKey = (id: string) => `${identityGeneration()}|${id}`;

/** What a row holds once read or unread (the server's `mark_read` / `mark_unread`). */
function readState(unread: boolean): Partial<ConversationSummaryRecord> {
	return unread
		? { read_at: null, thread_unread_count: 1 }
		: { read_at: Date.now(), thread_unread_count: 0 };
}

function keepReadMarks(
	rows: ConversationSummaryRecord[],
	askedAt: number,
): ConversationSummaryRecord[] {
	const now = Date.now();
	for (const [key, mark] of readMarks) {
		if (mark.confirmedAt !== null && now - mark.confirmedAt > 600_000) readMarks.delete(key);
	}
	if (readMarks.size === 0) return rows;
	return rows.map((row) => {
		const mark = readMarks.get(readMarkKey(row.thread_id)) ?? readMarks.get(readMarkKey(row.id));
		if (!mark || (mark.confirmedAt !== null && mark.confirmedAt <= askedAt)) return row;
		return { ...row, ...readState(mark.unread) };
	});
}

// ── Cached conversation list ──

export async function getConversationRowsCached(
	filters: EmailFilters = {},
	onUpdate?: (data: PaginatedResponse<ConversationSummaryRecord>) => void,
	onError?: (error: unknown) => void,
): Promise<PaginatedResponse<ConversationSummaryRecord>> {
	const limit = filters.limit ?? 50;
	const offset = filters.offset ?? 0;
	const started = identityGeneration();
	const bypassCache = shouldBypassCache(filters);
	const cachedPage = getCachedConversationPage(filters);

	if (isOnline()) {
		if (cachedPage) {
			// Surface a failed revalidation here too: the cached page may itself be
			// a promoted IDB fallback (see below), and a failure means "couldn't load
			// new messages" over stale rows — onError (gen-guarded, aborts ignored in
			// the caller) lets the UI show the retry banner instead of going silent.
			fetchConversationsFromNetwork(filters, onUpdate).catch((e) => onError?.(e));
			return cachedPage;
		}

		if (bypassCache) {
			return fetchConversationsFromNetwork(filters, onUpdate);
		}

		const cached = await getCachedConversationSummaries(filters.mailbox_state, limit, offset);
		if (!isCurrentGeneration(started)) throw staleIdentity();

		// The cache doesn't store the true total count, so we estimate:
		// if we got a full page of results, assume there are more (offset + limit + 1
		// keeps hasNext() true); otherwise use offset + actual count.
		// The real total arrives via onUpdate once the API responds.
		const estimatedTotal = cached.length >= limit ? offset + limit + 1 : offset + cached.length;

		const cachedResponse: PaginatedResponse<ConversationSummaryRecord> = {
			emails: cached,
			total: estimatedTotal,
			limit,
			offset,
		};
		putConversationPageCache(filters, cachedResponse);

		// Surface a failed background revalidation (we returned possibly-stale or
		// empty IDB data) so the caller can show a non-destructive "couldn't load"
		// banner instead of silently leaving the wrong/old rows on screen.
		fetchConversationsFromNetwork(filters, onUpdate).catch((e) => onError?.(e));

		return cachedResponse;
	}

	// Offline. A page this view already showed is kept, marked offline (d1-15: nothing said so).
	const offline = new ApiNetworkError(new Error("offline"));
	if (cachedPage) {
		onError?.(offline);
		return cachedPage;
	}

	// A search or filtered view has no answer on this device: say so, never "0 results"
	// (WD-12/WP-11, 2026-10-23). Nor a mailbox view: the device's rows carry one mailbox state per
	// conversation, from whichever view listed it last, so offline Sent listed inbound mail (d1-15).
	if (bypassCache || filters.mailbox_state) throw offline;

	const cached = await getCachedConversationSummaries(filters.mailbox_state, limit, offset);
	if (!isCurrentGeneration(started)) throw staleIdentity();

	const estimatedTotal = cached.length >= limit ? offset + limit + 1 : offset + cached.length;

	if (cached.length > 0) onError?.(offline);
	return {
		emails: cached,
		total: estimatedTotal,
		limit,
		offset,
	};
}

function conversationDetailKey(
	id: string,
	options?: {
		emailId?: string | null;
		load?: "anchor" | "full";
	},
): string {
	return JSON.stringify({
		identity: scope(),
		id,
		emailId: options?.emailId ?? null,
		load: options?.load === "full" ? "full" : "anchor",
	});
}

function putConversationDetailCache(key: string, data: ConversationDetailResponse): void {
	conversationDetailCache.delete(key);
	conversationDetailCache.set(key, {
		data,
		expiresAt: Date.now() + CONVERSATION_DETAIL_CACHE_TTL_MS,
	});
	while (conversationDetailCache.size > MAX_CONVERSATION_DETAIL_CACHE_ENTRIES) {
		const firstKey = conversationDetailCache.keys().next().value;
		if (!firstKey) return;
		conversationDetailCache.delete(firstKey);
	}
}

function getConversationDetailCache(key: string): ConversationDetailResponse | null {
	const cached = conversationDetailCache.get(key);
	if (!cached) return null;
	if (cached.expiresAt <= Date.now()) {
		conversationDetailCache.delete(key);
		return null;
	}
	conversationDetailCache.delete(key);
	conversationDetailCache.set(key, cached);
	return cached.data;
}

function detailContainsEmail(
	detail: ConversationDetailResponse,
	emailId: string | null | undefined,
): boolean {
	if (!emailId) return true;
	if (detail.anchor_email_id === emailId) return true;
	if (detail.conversation.display_email_id === emailId) return true;
	if (detail.conversation.latest_email_id === emailId) return true;
	return detail.emails.some((entry) => entry.id === emailId);
}

/** When each detail was asked of the server: what it says was true no earlier than that. */
const detailAsked = new WeakMap<ConversationDetailResponse, number>();
export const detailAskedAt = (detail: ConversationDetailResponse) => detailAsked.get(detail);

function withConversationDetailAnchor(
	detail: ConversationDetailResponse,
	emailId: string | null | undefined,
): ConversationDetailResponse {
	if (!emailId || detail.anchor_email_id === emailId) return detail;
	if (!detailContainsEmail(detail, emailId)) return detail;
	const anchored = { ...detail, anchor_email_id: emailId };
	const asked = detailAsked.get(detail);
	if (asked !== undefined) detailAsked.set(anchored, asked);
	return anchored;
}

export async function getConversationDetailCached(
	id: string,
	options?: {
		emailId?: string | null;
		load?: "anchor" | "full";
	},
	opts?: RequestInit,
): Promise<ConversationDetailResponse> {
	const key = conversationDetailKey(id, options);
	const fullKey = conversationDetailKey(id, { ...options, load: "full" });
	const broadFullKey = conversationDetailKey(id, { load: "full" });
	const requestedEmailId = options?.emailId?.trim() || null;

	const cached = getConversationDetailCache(key);
	if (cached) return cached;
	if (options?.load === "full" && key !== broadFullKey) {
		const cachedBroadFull = getConversationDetailCache(broadFullKey);
		if (cachedBroadFull && detailContainsEmail(cachedBroadFull, requestedEmailId)) {
			return withConversationDetailAnchor(cachedBroadFull, requestedEmailId);
		}
	}
	if (options?.load !== "full") {
		const cachedFull = getConversationDetailCache(fullKey);
		if (cachedFull && detailContainsEmail(cachedFull, requestedEmailId)) {
			return withConversationDetailAnchor(cachedFull, requestedEmailId);
		}
		const cachedBroadFull = getConversationDetailCache(broadFullKey);
		if (cachedBroadFull && detailContainsEmail(cachedBroadFull, requestedEmailId)) {
			return withConversationDetailAnchor(cachedBroadFull, requestedEmailId);
		}
	}

	const started = identityGeneration();
	const requestKey = `${started}|${key}`; // never join a request from an older generation
	const pending = conversationDetailRequests.get(requestKey);
	if (pending) return pending;
	// The whole thread already on its way (a hover prefetch) answers this one too (m2-13: an open
	// loaded the thread three times: the prefetch, the anchor, then the full thread again).
	const wholeThread = conversationDetailRequests.get(`${started}|${broadFullKey}`);
	if (wholeThread) {
		return wholeThread.then((detail) =>
			detailContainsEmail(detail, requestedEmailId)
				? withConversationDetailAnchor(detail, requestedEmailId)
				: getConversationDetailCached(id, options, opts),
		);
	}

	const askedAt = Date.now();
	const request = api.conversations
		.get(id, options, opts)
		.then((detail) => {
			if (!isCurrentGeneration(started)) throw staleIdentity();
			detailAsked.set(detail, askedAt);
			putConversationDetailCache(key, detail);
			if (options?.load === "full") {
				putConversationDetailCache(fullKey, detail);
				putConversationDetailCache(broadFullKey, detail);
			}
			return detail;
		})
		.finally(() => {
			conversationDetailRequests.delete(requestKey);
		});
	conversationDetailRequests.set(requestKey, request);
	return request;
}

/** Forget this conversation's cached detail: another tab or device may have changed it. */
export function forgetConversationDetail(id: string): void {
	for (const key of [...conversationDetailCache.keys()]) {
		if ((JSON.parse(key) as { id?: string }).id === id) conversationDetailCache.delete(key);
	}
}

export function prefetchConversationDetail(
	id: string,
	options?: {
		emailId?: string | null;
		load?: "anchor" | "full";
	},
): void {
	void getConversationDetailCached(id, options).catch(() => {});
}

// ── Batch action ──

// One mark_read per unread the app saw: tapping an unread row asks, and so does the thread view
// once its messages load (m2-03: two identical POSTs). A mark in flight answers both. Unread in
// data asked before the last mark landed is that mark's (the server had not written it yet);
// unread seen after it (another client, new mail) is marked again (R3 F2: a 15 s memo hid it).
const markReadInFlight = new Map<string, Promise<void>>();
const markReadLanded = new Map<string, number>();
const markReadKey = (threadId: string) => `${identityGeneration()}|${threadId}`;

/** `seenAt`: when the data that showed the thread unread was asked for (detailAskedAt). */
export function markThreadRead(threadId: string, seenAt?: number): Promise<void> {
	const key = markReadKey(threadId);
	const pending = markReadInFlight.get(key);
	if (pending) return pending;
	if (seenAt !== undefined && seenAt < (markReadLanded.get(key) ?? 0)) return Promise.resolve();
	const request = batchActionCached([], "mark_read", [threadId])
		.then(() => {
			markReadLanded.set(key, Date.now());
		})
		.finally(() => markReadInFlight.delete(key));
	markReadInFlight.set(key, request);
	return request;
}

/**
 * Run a mailbox action on the server, then bring the caches in line. There is no offline
 * queue: when the request fails (offline, 4xx, 5xx) this rejects with the caches untouched,
 * and the caller reverts whatever it showed optimistically and tells the user.
 */
export async function batchActionCached(
	ids: string[],
	action: BatchAction,
	threadIds?: string[],
): Promise<void> {
	const started = identityGeneration();
	const marked =
		action === "mark_read" || action === "mark_unread" ? [...ids, ...(threadIds ?? [])] : [];
	for (const id of marked) {
		readMarks.set(readMarkKey(id), { unread: action === "mark_unread", confirmedAt: null });
	}
	try {
		await api.emails.batchAction(ids, action, threadIds);
	} catch (error) {
		for (const id of marked) readMarks.delete(readMarkKey(id));
		throw error;
	}
	const confirmedAt = Date.now();
	for (const id of marked) {
		const mark = readMarks.get(readMarkKey(id));
		if (mark) mark.confirmedAt = confirmedAt;
	}
	// Signed out or someone else signed in meanwhile: their caches are not this action's to touch.
	if (!isCurrentGeneration(started)) return;

	// Determine optimistic updates based on action
	const updates: Partial<ConversationSummaryRecord> = {};
	switch (action) {
		case "archive":
			updates.mailbox_state = "archived";
			break;
		case "trash":
			updates.mailbox_state = "trash";
			break;
		case "restore":
			updates.mailbox_state = "inbox";
			break;
		case "mark_read":
		case "mark_unread":
			Object.assign(updates, readState(action === "mark_unread"));
			break;
		case "set_personal":
			updates.category = "personal";
			break;
		case "set_notifications":
			updates.category = "notifications";
			break;
		case "set_billing":
			updates.category = "billing";
			break;
		case "set_agents":
			updates.category = "agents";
			break;
		case "set_newsletters":
			updates.category = "newsletters";
			break;
		case "set_marketing":
			updates.category = "marketing";
			break;
		case "set_spam":
			updates.category = "spam";
			break;
		case "clear_category":
			updates.category = null;
			break;
	}

	await Promise.all(ids.map((id) => updateConversationSummary(id, updates)));

	if (threadIds && threadIds.length > 0) {
		await Promise.all(
			threadIds.map((threadId) => updateConversationSummariesByThreadId(threadId, updates)),
		);
	}

	if (action === "mark_read" || action === "mark_unread") {
		updateConversationPageCacheRows(ids, threadIds, updates);
	} else {
		clearConversationPageCache();
	}
	conversationDetailCache.clear();
}
