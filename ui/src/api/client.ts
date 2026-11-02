/**
 * API client. Who is calling is Cloudflare Access's answer: the Pages proxy forwards the Access
 * JWT to the Worker (ticket 09). The browser holds no MailClaw token.
 */

import { createSignal } from "solid-js";
import { leaveForAccessLogout } from "../lib/account";
import { reloadIfEdgeLoginNeeded } from "../lib/edge-login";
import {
	accessHeld,
	currentIdentity,
	identityGeneration,
	identityLost,
	onAccessHeld,
} from "../lib/identity";

const IDENTITY_CHANGED = "Signed in as someone else in another tab. Reload this tab.";
const ACCESS_HELD = "Signed out. Sign in again to use your mailbox.";

/**
 * True when the identity this request was made for is no longer this tab's: its answer belongs to
 * someone who isn't signed in here any more and must not reach the UI (re-review 2026-10-22 C).
 */
function answeredForAnotherIdentity(startedAs: string | null): boolean {
	return identityLost() || (startedAs !== null && currentIdentity() !== startedAs);
}

/** The hold started (or the identity changed) after this request went out: refuse its answer. */
function staleAnswer(startedGen: number): ApiHttpError | null {
	if (identityGeneration() === startedGen) return null;
	return accessHeld()
		? new ApiHttpError(401, ACCESS_HELD, { error: { code: "ACCESS_HELD", message: ACCESS_HELD } })
		: new ApiHttpError(409, IDENTITY_CHANGED);
}

/**
 * A body read after the hold started (or the identity changed) is refused too, not only the
 * headers: a slow body must not reach the UI (review R2d). Streams fail at the first chunk read
 * under a newer generation.
 */
function fencedBody(res: Response, startedGen: number): Response {
	if (!res.body) return res;
	const body = res.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const stale = staleAnswer(startedGen);
				if (stale) controller.error(stale);
				else controller.enqueue(chunk);
			},
			flush(controller) {
				const stale = staleAnswer(startedGen);
				if (stale) controller.error(stale);
			},
		}),
	);
	return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** The assistant chat stream in flight, aborted when the hold starts. */
let activeChat: AbortController | null = null;
onAccessHeld(() => activeChat?.abort());

const BASE = "/api";

/**
 * The server said ACCOUNT_DELETED (401 with an app bearer, 403 through Access; API.md): App.tsx shows
 * "This account is being deleted." instead of the app, and from then on no call goes out (no timer,
 * foreground or retry asks again).
 */
const [accountDeleted, setAccountDeleted] = createSignal(false);
export { accountDeleted };
const deletedError = () =>
	new ApiHttpError(403, "This account is being deleted.", {
		error: { code: "ACCOUNT_DELETED", message: "This account is being deleted." },
	});

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
	if (accountDeleted()) throw deletedError();
	// Another tab signed in as someone else, or signed out: the browser's Access cookie no longer
	// belongs to the person this tab shows, so nothing this tab does may reach the server.
	if (identityLost()) throw new ApiHttpError(409, IDENTITY_CHANGED);
	// Held after a 401 (lib/identity.ts holdAccess): only the identity check may go out.
	if (accessHeld() && path !== "/auth/me") {
		throw new ApiHttpError(401, ACCESS_HELD, { error: { code: "ACCESS_HELD", message: ACCESS_HELD } });
	}
	const startedAs = currentIdentity();
	const startedGen = identityGeneration();
	const headers: Record<string, string> = {
		...((opts.headers as Record<string, string>) || {}),
	};
	if (opts.body && typeof opts.body === "string") headers["Content-Type"] = "application/json";
	const method = (opts.method ?? "GET").toUpperCase();
	const isGet = method === "GET";
	// GETs default to no-store for freshness; a caller may pass an explicit
	// cache mode instead.
	const defaultNoStore = isGet && opts.cache === undefined;
	if (
		defaultNoStore &&
		!Object.keys(headers).some((key) => key.toLowerCase() === "cache-control")
	) {
		headers["Cache-Control"] = "no-store";
	}

	const requestInit: RequestInit = {
		...opts,
		headers,
		credentials: "same-origin",
	};
	if (defaultNoStore) requestInit.cache = "no-store";

	let res: Response;
	try {
		res = await fetch(`${BASE}${path}`, requestInit);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		void reloadIfEdgeLoginNeeded();
		throw new ApiNetworkError(error);
	}

	// Answered for an identity this tab no longer has (including errors: a SIGNED_OUT or 429 from
	// A's era must not sign B out): nothing of it reaches the caller.
	if (answeredForAnotherIdentity(startedAs)) throw new ApiHttpError(409, IDENTITY_CHANGED);
	// Sent before the hold started (a 401 elsewhere): who answered it is no longer known.
	const stale = res.ok ? staleAnswer(startedGen) : null;
	if (stale) throw stale;

	if (res.status === 429) {
		const retry = res.headers.get("Retry-After");
		throw new ApiHttpError(
			429,
			`Rate limited${retry ? `. Retry after ${retry}s` : ""}`,
			{ error: { code: "RATE_LIMITED" }, retry_after: Number(retry) || null },
			res.headers.get("X-Request-Id"),
		);
	}

	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
		// "Sign out everywhere" ran (here or on another device): sign in to Access again.
		if (answeredForAnotherIdentity(startedAs)) throw new ApiHttpError(409, IDENTITY_CHANGED);
		if (body?.error?.code === "ACCOUNT_DELETED") {
			setAccountDeleted(true);
			throw deletedError();
		}
		if (res.status === 401 && body?.error?.code === "SIGNED_OUT") void leaveForAccessLogout();
		throw new ApiHttpError(
			res.status,
			body?.error?.message || res.statusText,
			body,
			res.headers.get("X-Request-Id"),
		);
	}

	// Attachment downloads return raw bytes
	if (res.headers.get("content-type")?.startsWith("application/json")) {
		const json = await res.json();
		if (answeredForAnotherIdentity(startedAs)) throw new ApiHttpError(409, IDENTITY_CHANGED);
		const staleAfterBody = staleAnswer(startedGen);
		if (staleAfterBody) throw staleAfterBody;
		return json.data as T;
	}
	if (answeredForAnotherIdentity(startedAs)) throw new ApiHttpError(409, IDENTITY_CHANGED);
	return fencedBody(res, startedGen) as unknown as T;
}

/**
 * The request never got a response: offline, a dropped connection, or (behind Cloudflare Access)
 * a login redirect fetch can't follow. Browsers word it differently ("Failed to fetch", "Load
 * failed", Workbox's "no-response"), so callers check the type, not the message.
 */
export class ApiNetworkError extends Error {
	constructor(public cause: unknown) {
		super(cause instanceof Error ? cause.message : "Network request failed");
		this.name = "ApiNetworkError";
	}
}

export class ApiHttpError extends Error {
	constructor(
		public status: number,
		message: string,
		public body?: unknown,
		public requestId?: string | null,
	) {
		super(message);
		this.name = "ApiHttpError";
	}
}

function normalizeMailboxCounts(
	counts?: Partial<Record<MailboxState, number>>,
	fallback?: Partial<Record<MailboxState, number>>,
): PlatformMeta["mailbox_state_counts"] {
	return {
		inbox: counts?.inbox ?? fallback?.inbox ?? 0,
		sent: counts?.sent ?? fallback?.sent ?? 0,
		archived: counts?.archived ?? fallback?.archived ?? 0,
		trash: counts?.trash ?? fallback?.trash ?? 0,
		draft: counts?.draft ?? fallback?.draft ?? 0,
	};
}

type LegacyDraftMutationResponse = {
	id?: string;
	message?: string;
};

async function normalizeDraftMutationResponse(
	payload: DraftMutationResponse | LegacyDraftMutationResponse,
	fallbackId?: string,
): Promise<DraftMutationResponse> {
	if ("draft" in payload && payload.draft) {
		return payload;
	}

	const draftId = ("id" in payload ? payload.id : undefined) ?? fallbackId;
	if (!draftId) {
		throw new Error("Draft response did not include a draft id");
	}

	const draft = await request<Email>(`/emails/${encodeURIComponent(draftId)}`);
	return {
		draft,
		saved_at: draft.received_at,
	};
}

function isEnabledOverride(value: string | null): boolean {
	if (!value) return false;
	return /^(1|true|yes|on)$/i.test(value.trim());
}

function getComposeFeatureOverrides() {
	if (typeof window === "undefined") return {};
	const params = new URLSearchParams(window.location.search);
	return {
		...(params.has("compose_rte")
			? { compose_rte_enabled: isEnabledOverride(params.get("compose_rte")) }
			: {}),
	};
}

export function normalizePlatformMeta(meta: PlatformMeta): PlatformMeta {
	return {
		...meta,
		mailbox_state_counts: normalizeMailboxCounts(meta.mailbox_state_counts),
		conversation_mailbox_state_counts: normalizeMailboxCounts(
			meta.conversation_mailbox_state_counts,
			meta.mailbox_state_counts,
		),
		category_counts: meta.category_counts ?? {},
		conversation_category_counts: meta.conversation_category_counts ?? meta.category_counts ?? {},
		unread_count: meta.unread_count ?? 0,
		conversation_unread_count: meta.conversation_unread_count ?? meta.unread_count ?? 0,
		conversation_count:
			meta.conversation_count ??
			Object.values(
				normalizeMailboxCounts(meta.conversation_mailbox_state_counts, meta.mailbox_state_counts),
			).reduce((sum, value) => sum + value, 0),
		features: {
			...DEFAULT_COMPOSE_FEATURE_FLAGS,
			...meta.features,
			...getComposeFeatureOverrides(),
		},
	};
}

// --- Account ---

export interface AccountMe {
	principal: "user" | "api" | null;
	user?: { email: string; name: string | null; is_admin: boolean };
	session?: { id: string; kind: string; borrowed: boolean; expires_at: number };
}

/** The signed-in person (ticket 09). Signing out is Cloudflare Access's (lib/account.ts). */
export const account = {
	me: () => request<AccountMe>("/auth/me"),
	/** The one-time link's screen: sets the password the native app signs in with. */
	setPassword: (token: string, password: string) =>
		request<{ email: string }>("/auth/set-password", {
			method: "POST",
			body: JSON.stringify({ token, password }),
		}),
	/** /app-password: the password the native app signs in with, for the person signed in here. */
	setAppPassword: (password: string) =>
		request<{ emails: string[] }>("/auth/password", {
			method: "POST",
			body: JSON.stringify({ password }),
		}),
	/**
	 * Ends every app session and every browser's Access sign-in, then signs out here. Throws (and
	 * stays) if the server didn't confirm, so nobody believes it worked when it didn't.
	 */
	signOutEverywhere: async () => {
		await request<{ revoked: number }>("/auth/logout-all", { method: "POST" });
		await leaveForAccessLogout();
	},
	signOut: () => leaveForAccessLogout(),
};

// --- Endpoints ---

import type {
	ActionNote,
	AgentMessage,
	BatchAction,
	BlockedSender,
	ContactSuggestion,
	ConversationDetailResponse,
	ConversationFilters,
	ConversationListResponse,
	DraftMutationResponse,
	DraftRequest,
	Email,
	EmailCategory,
	MailboxState,
	PlatformMeta,
	SendEmailRequest,
	SendEmailResponse,
} from "../types";

const DEFAULT_COMPOSE_FEATURE_FLAGS = {
	compose_rte_enabled: false,
};

export interface AgentFeedbackRequest {
	category?: EmailCategory | null;
	comment?: string;
}

export interface AgentFeedbackResponse {
	rule_id: string;
	agent_message?: string;
	feedback_id?: string;
	follow_up_question?: string;
}

function toSearchParams(filters: object): URLSearchParams {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) {
		if (value !== undefined && value !== null && value !== "") {
			params.set(key, String(value));
		}
	}
	return params;
}

export const api = {
	/** Raw request helper — for ad-hoc API calls. */
	request: <T>(path: string, opts?: RequestInit) => request<T>(path, opts),

	meta: () => request<PlatformMeta>("/meta").then(normalizePlatformMeta),

	emails: {
		get: (id: string) => request<Email>(`/emails/${encodeURIComponent(id)}`),
		unsubscribe: (id: string) =>
			request<{
				outcome: "unsubscribed" | "link";
				method: "one_click" | "mailto" | "link";
				url?: string;
			}>(`/emails/${encodeURIComponent(id)}/unsubscribe`, { method: "POST" }),

		delete: (id: string) => request<{ message: string }>(`/emails/${encodeURIComponent(id)}`, { method: "DELETE" }),

		update: (
			id: string,
			body: {
				mailbox_state?: string;
				is_read?: boolean;
				category?: string | null;
				interest_level?: string | null;
				interest_comment?: string | null;
			},
		) =>
			request<{ message: string }>(`/emails/${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: JSON.stringify(body),
			}),

		batchAction: (ids: string[], action: BatchAction, threadIds?: string[]) =>
			request<{ updated: number }>("/emails/actions", {
				method: "POST",
				body: JSON.stringify({
					ids,
					action,
					...(threadIds && threadIds.length > 0 ? { thread_ids: threadIds } : {}),
				}),
			}),

		send: (body: SendEmailRequest) =>
			request<SendEmailResponse>("/emails/send", {
				method: "POST",
				body: JSON.stringify(body),
			}),

		suggestRecipients: (query: string, limit = 8, opts?: RequestInit) => {
			const params = new URLSearchParams({ q: query, limit: String(limit) });
			return request<{ contacts: ContactSuggestion[] }>(
				`/emails/contacts?${params.toString()}`,
				opts,
			);
		},

		attachmentUrl: (emailId: string, attachmentId: string) =>
			`${BASE}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
	},

	conversations: {
		list: (filters: ConversationFilters = {}, opts?: RequestInit) => {
			const params = toSearchParams(filters);
			const qs = params.toString();
			return request<ConversationListResponse>(`/conversations${qs ? `?${qs}` : ""}`, opts);
		},

		get: (
			id: string,
			options?: {
				emailId?: string | null;
				load?: "anchor" | "full";
			},
			opts?: RequestInit,
		) => {
			const params = new URLSearchParams();
			if (options?.emailId) params.set("email_id", options.emailId);
			if (options?.load) params.set("load", options.load);
			const qs = params.toString();
			return request<ConversationDetailResponse>(`/conversations/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, opts);
		},
	},

	drafts: {
		create: async (body: DraftRequest) =>
			normalizeDraftMutationResponse(
				await request<DraftMutationResponse | LegacyDraftMutationResponse>("/emails/drafts", {
					method: "POST",
					body: JSON.stringify(body),
				}),
			),

		update: async (id: string, body: Partial<DraftRequest>) =>
			normalizeDraftMutationResponse(
				await request<DraftMutationResponse | LegacyDraftMutationResponse>(`/emails/drafts/${encodeURIComponent(id)}`, {
					method: "PATCH",
					body: JSON.stringify(body),
				}),
				id,
			),

		send: (id: string) =>
			request<SendEmailResponse>(`/emails/drafts/${encodeURIComponent(id)}/send`, {
				method: "POST",
			}),
	},

	// "Needs you" strip on Personal (v55).
	notes: {
		list: () => request<{ notes: ActionNote[] }>("/notes"),
		done: (emailId: string) =>
			request<{ email_id: string; done: boolean }>(`/notes/${encodeURIComponent(emailId)}/done`, {
				method: "POST",
			}),
		/** Undo of Done: PUT sets the note again and re-opens it (src/routes/notes.ts). */
		reopen: (note: ActionNote) =>
			request<{ email_id: string; note: string; due: string | null }>(
				`/notes/${encodeURIComponent(note.email_id)}`,
				{ method: "PUT", body: JSON.stringify({ note: note.note, due: note.due }) },
			),
	},

	senders: {
		blocked: () => request<{ blocked: BlockedSender[] }>("/senders/blocked"),

		block: (body: { pattern_type: "address" | "domain"; pattern: string; note?: string }) =>
			request<{ blocked: BlockedSender; swept_count: number }>("/senders/block", {
				method: "POST",
				body: JSON.stringify(body),
			}),

		unblock: (id: number) =>
			request<{ message: string }>(`/senders/block/${id}`, { method: "DELETE" }),
	},

	agent: {
		chat: (message: string, context?: { emailId?: string; conversationId?: string }) => {
			// The same guards as request(): never while held or after an identity change, and a
			// stream running when the hold starts is aborted (review R2c).
			if (identityLost()) return Promise.reject(new ApiHttpError(409, IDENTITY_CHANGED));
			if (accessHeld()) {
				return Promise.reject(
					new ApiHttpError(401, ACCESS_HELD, { error: { code: "ACCESS_HELD", message: ACCESS_HELD } }),
				);
			}
			const startedGen = identityGeneration();
			activeChat?.abort();
			const controller = new AbortController();
			activeChat = controller;
			return fetch(`${BASE}/agent/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				signal: controller.signal,
				body: JSON.stringify({
					message,
					...(context?.emailId ? { email_id: context.emailId } : {}),
					...(context?.conversationId ? { conversation_id: context.conversationId } : {}),
				}),
			}).then((res) => {
				const stale = staleAnswer(startedGen);
				if (stale) {
					controller.abort();
					throw stale;
				}
				return fencedBody(res, startedGen);
			});
		},
		messages: (limit = 50) =>
			request<{ messages: AgentMessage[] }>(`/agent/messages?limit=${limit}`),
		clearMessages: () => request<{ success: boolean }>("/agent/messages", { method: "DELETE" }),
		feedback: (emailId: string, body: AgentFeedbackRequest) =>
			request<AgentFeedbackResponse>("/agent/feedback", {
				method: "POST",
				body: JSON.stringify({ email_id: emailId, ...body }),
			}),
	},
};
