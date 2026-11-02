import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
	ApiHttpError,
	ApiNetworkError,
	account,
	accountDeleted,
	api,
	normalizePlatformMeta,
} from "./api/client";
import Layout from "./components/Layout";
import {
	ACCESS_LOGOUT_URL,
	claimLocalMail,
	forgetDeletedAccount,
	leaveForAccessLogout,
	SIGN_OUT_HELD_EVENT,
} from "./lib/account";
import { readConsent } from "./lib/ai-consent";
import {
	composeWindowsOpenElsewhere,
	flushLocalComposeDrafts,
	listLocalComposeDrafts,
} from "./lib/db";
import {
	DRAFT_NOT_KEPT_EVENT,
	hasUnsavedText,
	RELOAD_BLOCKED_EVENT,
	reloadKeepingDrafts,
	SIGNED_OUT_EVENT,
} from "./lib/edge-login";
import {
	accessHeld,
	currentIdentity,
	holdAccess,
	loseIdentity,
	onIdentityLost,
	releaseAccess,
} from "./lib/identity";
import {
	type ActiveView,
	AppContext,
	createAppStore,
	type LevelView,
	type MileageNav,
	NO_MILEAGE,
} from "./store/app";
import type { EmailCategory, PlatformMeta } from "./types";
import { CATEGORY_ORDER } from "./utils/category";

const BOOT_FAILURE_MESSAGE = "Grip couldn't open your inbox. Try again in a moment.";
// Offline, the service worker still opens the cached shell, so its first API calls fail. Show this
// instead of the browser's wording ("Failed to fetch", "Load failed", Workbox's "no-response").
const NETWORK_DOWN_MESSAGE = "You're offline. Grip opens by itself once you're back online.";

function countsChanged(current: Record<string, number>, next: Record<string, number>): boolean {
	const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
	for (const key of keys) {
		if ((current[key] ?? 0) !== (next[key] ?? 0)) {
			return true;
		}
	}
	return false;
}

function metaAffectsMailboxState(previous: PlatformMeta, next: PlatformMeta): boolean {
	return (
		getUnreadCount(previous) !== getUnreadCount(next) ||
		countsChanged(getMailboxStateCounts(previous), getMailboxStateCounts(next)) ||
		countsChanged(getCategoryCounts(previous), getCategoryCounts(next))
	);
}

function getUnreadCount(meta: PlatformMeta): number {
	return meta.conversation_unread_count ?? meta.unread_count;
}

function getMailboxStateCounts(meta: PlatformMeta): Record<string, number> {
	return meta.conversation_mailbox_state_counts ?? meta.mailbox_state_counts;
}

function getCategoryCounts(meta: PlatformMeta): Record<string, number> {
	return meta.conversation_category_counts ?? meta.category_counts;
}

interface UrlView {
	mailbox: ActiveView;
	category: EmailCategory | null;
	levelView: LevelView | null;
	/** The account in view (its domain). */
	domain: string | null;
	searchQuery: string;
	selectedConversationId: string | null;
	selectedEmailId: string | null;
	composeDraftId: string | null;
	/** Mileage's month, open trip and rail queue (only with ?view=mileage). */
	mileage: MileageNav;
}

/**
 * What the list shows (Mileage: which month). A change is a history entry, so Back steps through
 * views, months and searches.
 */
const viewKey = (
	v: Omit<UrlView, "selectedConversationId" | "selectedEmailId" | "composeDraftId">,
) => [v.mailbox, v.category, v.levelView, v.domain, v.mileage.month, v.mileage.page].join("|");

/** ?view=mileage&month=YYYY-MM&page=settings&trip=<id>&queue=needs|spot|company:<id>|search */
function parseMileage(params: URLSearchParams, levelView: LevelView | null): MileageNav {
	if (levelView !== "mileage") return NO_MILEAGE;
	const month = params.get("month")?.trim() ?? "";
	const trip = params.get("trip")?.trim() || null;
	return {
		month: /^\d{4}-\d{2}$/.test(month) ? month : null,
		page: params.get("page")?.trim() || null,
		trip,
		queue: trip ? params.get("queue")?.trim() || "needs" : null,
	};
}

const VALID_MAILBOXES: ReadonlySet<ActiveView> = new Set<ActiveView>([
	"all",
	"inbox",
	"sent",
	"archived",
	"trash",
	"draft",
]);

const VALID_CATEGORIES: ReadonlySet<EmailCategory> = new Set(CATEGORY_ORDER);

function parseMailbox(raw: string | null): ActiveView {
	if (!raw) return "inbox";
	// Accept the plural "drafts" as an alias for the canonical "draft" mailbox
	// so hand-typed/external ?mailbox=drafts URLs don't silently fall to inbox.
	if (raw === "drafts") return "draft";
	return VALID_MAILBOXES.has(raw as ActiveView) ? (raw as ActiveView) : "inbox";
}

function parseCategory(raw: string | null): EmailCategory | null {
	if (!raw) return null;
	return VALID_CATEGORIES.has(raw as EmailCategory) ? (raw as EmailCategory) : null;
}

// ?view=money, ?view=mileage, ?view=settings or ?view=person:Robin (inbox levels).
function parseLevelView(raw: string | null): LevelView | null {
	if (raw === "money" || raw === "mileage" || raw === "settings") return raw;
	if (raw?.startsWith("person:") && raw.length > "person:".length) return raw as LevelView;
	return null;
}

const App: Component = () => {
	const store = createAppStore();
	const [state, actions] = store;
	const [authed, setAuthed] = createSignal(false);
	const [checking, setChecking] = createSignal(true);
	const [bootError, setBootError] = createSignal<string | null>(null);
	// Signed in to Access as someone MailClaw has no account for: offer to sign out of Access.
	const [bootSignOut, setBootSignOut] = createSignal(false);
	const [waitingForNetwork, setWaitingForNetwork] = createSignal(false);
	/** auth/me answered 429: the boot waits for Retry-After, then asks again. */
	const [rateLimited, setRateLimited] = createSignal(false);
	const [initialUrlHandled, setInitialUrlHandled] = createSignal(false);

	// The tab title carries the app's one count: Personal unread (design r2 §4 S1).
	createEffect(() => {
		const count = state.meta?.conversation_category_unread_counts?.personal ?? 0;
		document.title = count > 0 ? `(${count}) Personal - Grip` : "Grip";
	});

	const readViewFromUrl = (): UrlView => {
		const params = new URLSearchParams(window.location.search);
		const conversationId = params.get("conversation")?.trim() || null;
		const emailId = params.get("email")?.trim() || null;
		// Legacy ?review=1 links (the review queue was deleted in 6a) land on
		// All Mail unless the URL names a mailbox explicitly — never on the
		// Personal cold-boot default below.
		const legacyReview = params.has("review");
		// Blank URL = cold boot with no navigation state → default to Personal
		// category. Explicit URL params always win (e.g. ?mailbox=inbox).
		const hasAnyViewParam =
			params.has("mailbox") ||
			params.has("category") ||
			params.has("view") ||
			params.has("domain") ||
			legacyReview ||
			params.has("q") ||
			!!conversationId ||
			!!emailId;
		if (!hasAnyViewParam) {
			return {
				mailbox: "all",
				category: "personal",
				levelView: null,
				domain: null,
				searchQuery: "",
				selectedConversationId: null,
				selectedEmailId: null,
				composeDraftId: params.get("compose")?.trim() || null,
				mileage: NO_MILEAGE,
			};
		}
		const levelView = parseLevelView(params.get("view"));
		return {
			mailbox: legacyReview && !params.has("mailbox") ? "all" : parseMailbox(params.get("mailbox")),
			category: parseCategory(params.get("category")),
			levelView,
			domain: params.get("domain")?.trim() || null,
			searchQuery: params.get("q") ?? "",
			selectedConversationId: conversationId ?? emailId,
			selectedEmailId: emailId,
			composeDraftId: params.get("compose")?.trim() || null,
			mileage: parseMileage(params, levelView),
		};
	};

	const buildCurrentViewUrl = (view: UrlView): URL => {
		const url = new URL(window.location.href);
		const set = (key: string, value: string | null | undefined) => {
			if (value) url.searchParams.set(key, value);
			else url.searchParams.delete(key);
		};
		// Inbox is written too: a bare "/" is the cold-boot default (Personal), so a reload on
		// Inbox used to land on Personal (m2-01, 2026-10-23).
		set("mailbox", view.mailbox);
		set("category", view.category);
		set("view", view.levelView);
		set("domain", view.domain);
		// Legacy params (the review queue; unread-only, To Self and sort, cut in design r2):
		// scrubbed on the first URL write.
		// ?layout= picked round 2's F1/F2 desktop layouts (both cut for L3, 2026-10-26).
		for (const gone of ["review", "unread", "self", "sort", "layout"])
			url.searchParams.delete(gone);
		set("q", view.searchQuery?.trim() || null);
		set("conversation", view.selectedConversationId);
		set("email", view.selectedEmailId);
		set("compose", view.composeDraftId);
		set("month", view.mileage.month);
		set("page", view.mileage.page);
		set("trip", view.mileage.trip);
		set("queue", view.mileage.trip ? view.mileage.queue : null);
		return url;
	};

	const readComposeDraftIdFromUrl = () => readViewFromUrl().composeDraftId;

	// Which compose draft (if any) should be in the URL. The store keeps a
	// top-level focusedComposeDraftId in sync with the focused window's
	// draftId — we just read that primitive so reactivity propagates without
	// needing to track nested composeWindows[i] mutations through createMemo
	// (which we verified doesn't propagate reliably through Solid's
	// createStore proxy).
	const focusedComposeDraftId = (): string | null => state.focusedComposeDraftId;

	const applyMeta = (meta: Awaited<ReturnType<typeof api.meta>>, refreshInbox = false) => {
		const previousMeta = state.meta;
		const normalizedMeta = normalizePlatformMeta(meta);
		actions.setMeta(normalizedMeta);
		if (refreshInbox && (!previousMeta || metaAffectsMailboxState(previousMeta, normalizedMeta))) {
			actions.refresh();
		}
	};

	const fetchMeta = async ({
		foreground = false,
		refreshInbox = false,
		forceInboxRefresh = false,
	}: {
		foreground?: boolean;
		refreshInbox?: boolean;
		forceInboxRefresh?: boolean;
	} = {}) => {
		try {
			if (foreground) {
				actions.setLoading(true);
			}
			const meta = await api.meta();
			applyMeta(meta, refreshInbox);
			if (forceInboxRefresh) {
				actions.refresh();
			}
			actions.setError(null);
			return true;
		} catch (e: unknown) {
			if (e instanceof ApiHttpError && e.status === 401) {
				// Signed out (e.g. "sign out everywhere"). With a compose window open or text typed the
				// app stays mounted (review R2): unmounting would drop the only copy when saves and the
				// device both failed. The person copies the text and leaves through the existing
				// confirmation; a later refresh that is answered again (same identity) resumes here.
				if (hasUnsavedText() || accessHeld()) {
					const code = (e.body as { error?: { code?: string } } | undefined)?.error?.code;
					// Nothing but /api/auth/me goes out until it names this tab's identity again.
					holdAccess();
					// SIGNED_OUT already raised the held sign-out notice (api/client.ts).
					if (code !== "SIGNED_OUT") window.dispatchEvent(new Event(SIGN_OUT_HELD_EVENT));
					return false;
				}
				setAuthed(false);
				actions.setError(null);
				return false;
			}
			if (e instanceof ApiNetworkError) {
				actions.setError(NETWORK_DOWN_MESSAGE);
				setWaitingForNetwork(true);
				return false;
			}
			// The server answered with an error: mail doesn't need the counts, so it loads anyway and
			// the timer asks again (d1-21: "Failed to connect" over the whole app, no mail).
			// Said once, while there are no counts at all; a later failure keeps the last counts.
			const message = e instanceof Error ? e.message : "Failed to load";
			if (!state.meta) actions.showToast(`Couldn't load counts: ${message}`, "info");
			return false;
		}
	};

	const fetchInitialMeta = async (): Promise<boolean> => fetchMeta({ foreground: false });

	// Fresh counts and mail by request, no live connection (the /api/events heartbeat stream, which
	// sent one meta and then only heartbeats, was cut 2026-10-22). Refresh when the app comes back
	// to the foreground, and every REFRESH_MS while it is visible (list and counts), like the
	// native app. A refresh that fails because Cloudflare Access ended the
	// session reloads to its login (api/client.ts request() -> reloadIfEdgeLoginNeeded).
	const REFRESH_MS = 120_000;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Held after a 401 with text open: ask only /api/auth/me. The same identity (email and session
	 * kind, as claimed at boot) -> mailbox access resumes in place. Someone else -> this tab loses
	 * its identity (the existing path: text stays visible to copy, nothing is written for them).
	 */
	let recheckingHeld = false;
	const recheckHeldIdentity = async () => {
		if (recheckingHeld) return;
		recheckingHeld = true;
		try {
			const me = await account.me();
			if (me.principal !== "user" || !me.user) return;
			const now = `${me.user.email} ${me.session?.kind ?? ""}`;
			if (now === currentIdentity()) {
				// Counts first: only when the server really answers again does the list reload.
				releaseAccess();
				if (await fetchMeta()) actions.refresh();
			} else {
				loseIdentity("other-identity");
			}
		} catch {
			// Still signed out, or offline: stay held and ask again on the next tick.
		} finally {
			recheckingHeld = false;
		}
	};

	const startRefreshTimer = () => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			if (document.hidden || !authed()) return;
			if (accessHeld()) {
				void recheckHeldIdentity();
				return;
			}
			// The list too, not only when counts move: a reply in a conversation that is already
			// unread changes no count (review F6).
			actions.refresh();
			void fetchMeta();
		}, REFRESH_MS);
	};

	const stopRefreshTimer = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = null;
	};

	// Web push sign-up is cut (design r2 §1: notifications are native, Mac and iPhone). Devices
	// already subscribed keep getting pushes (sw.ts) until the native path ships and the server's
	// push route goes, in the order CLAUDE.md gives for destructive changes.

	// Finish login: render the shell immediately, then hydrate meta in the
	// background. EmailList owns its own data fetch (page cache first, then the
	// network), so mailbox rows never wait behind counts, feature flags, or a
	// combined boot payload. The /api/_boot seed that used to hold first paint
	// for up to 400 ms (and doubled meta + list work per load) is gone.
	const finishLogin = async () => {
		const initialView = readViewFromUrl();
		if (!initialUrlHandled()) {
			actions.setViewFromUrl(initialView);
			setInitialUrlHandled(true);
		}
		setAuthed(true);
		setChecking(false); // unblock the shell — render NOW, meta arrives later

		actions.setLoading(false);
		const metaPromise = fetchInitialMeta()
			.then((loaded) => {
				if (authed()) startRefreshTimer();
				return loaded;
			})
			.catch((error) => {
				console.warn("Initial meta load failed:", error);
				return false;
			});
		// Reopen every compose window kept on this device (lib/db.ts compose_drafts: open windows,
		// with their text and new attachments, even ones the server never saved; closed ones wait
		// for New or Reply; one open in another tab stays that tab's), then the ?compose=<draft id>
		// deep link unless a reopened window already holds that draft.
		const composeIdFromUrl = readComposeDraftIdFromUrl();
		void Promise.all([
			listLocalComposeDrafts().catch((error) => {
				console.warn("Local compose drafts could not be read:", error);
				return [];
			}),
			composeWindowsOpenElsewhere().catch(() => new Set<string>()),
		]).then(([local, elsewhere]) => {
			actions.restoreComposeWindows(
				local
					.filter((draft) => !draft.closedAt && !elsewhere.has(draft.id))
					.map((draft) => ({
						id: draft.id,
						draftId: draft.draftId,
						replyTo: draft.replyTo,
						minimized: draft.minimized,
					})),
			);
			if (composeIdFromUrl) actions.editDraft(composeIdFromUrl);
		});

		void metaPromise;
		return true;
	};

	// A 429 on /api/auth/me is a rate limit, not a failure (d1-20: "MailClaw couldn't open" over
	// the whole app): the app waits, shut, and asks again after Retry-After (1-60 s). Nothing opens
	// before auth/me names the person, not even this tab's own cache: Access may have signed
	// someone else in since (R3 review F1: A's mail and draft showed to B, B's rows went into A's
	// database).
	let rateLimitTimer: ReturnType<typeof setTimeout> | undefined;
	const waitOutRateLimit = (error: ApiHttpError) => {
		const seconds = (error.body as { retry_after?: number | null } | undefined)?.retry_after;
		const ms = Math.min(Math.max(seconds || 5, 1), 60) * 1000;
		clearTimeout(rateLimitTimer);
		rateLimitTimer = setTimeout(() => void boot(true), ms);
	};

	// Who is signed in comes from Cloudflare Access (the Pages proxy forwards its JWT; ticket 09).
	// A quiet retry (after a start without a connection) keeps the current card on screen.
	const boot = async (quiet = false) => {
		if (!quiet) {
			setChecking(true);
			setBootError(null);
			setBootSignOut(false);
		}
		let waiting = false;
		try {
			const me = await account.me();
			if (me.principal !== "user" || !me.user) {
				setBootError(BOOT_FAILURE_MESSAGE);
				return;
			}
			setRateLimited(false);
			const identity = `${me.user.email} ${me.session?.kind ?? ""}`;
			// Before anything paints from the device cache: another person's mail goes first.
			await claimLocalMail(identity);
			// AI sorting's switch (Settings): read once in the background so Settings opens with it in
			// place. Nothing waits for it (on by default, no consent screen).
			void readConsent();
			if (await finishLogin()) return;
			setBootError(BOOT_FAILURE_MESSAGE);
		} catch (error: unknown) {
			if (error instanceof ApiNetworkError) {
				setBootError(NETWORK_DOWN_MESSAGE);
				setWaitingForNetwork(true);
				return;
			}
			const code =
				error instanceof ApiHttpError
					? (error.body as { error?: { code?: string } } | undefined)?.error?.code
					: undefined;
			if (code === "NO_ACCOUNT" || code === "NOT_A_PERSON") {
				setBootError(
					`${(error as Error).message}. Ask your administrator for access, or sign out and sign in as someone else.`,
				);
				setBootSignOut(true);
				return;
			}
			if (error instanceof ApiHttpError && error.status === 429) {
				waitOutRateLimit(error);
				setRateLimited(true);
				waiting = true; // the waiting card stays until the retry answers
				return;
			}
			setBootError(error instanceof Error ? error.message : BOOT_FAILURE_MESSAGE);
		} finally {
			if (!waiting) setChecking(false);
		}
	};

	boot();

	// After a start that couldn't reach the server, try again by itself: when the browser says the
	// connection is back, when the app returns to the foreground, and every 10 s (a captive or
	// flaky network never fires "online").
	const retryAfterNetworkFailure = () => {
		if (!waitingForNetwork() || document.hidden) return;
		setWaitingForNetwork(false);
		if (!authed()) {
			void boot(true);
			return;
		}
		void fetchInitialMeta().then((loaded) => {
			if (loaded && authed()) startRefreshTimer();
		});
	};
	window.addEventListener("online", retryAfterNetworkFailure);
	document.addEventListener("visibilitychange", retryAfterNetworkFailure);
	const networkRetryTimer = setInterval(retryAfterNetworkFailure, 10_000);

	// The account is being deleted (any call answered ACCOUNT_DELETED; api/client.ts): one sentence
	// replaces the app, nothing asks the server again, and this identity's data leaves the device.
	createEffect(() => {
		if (!accountDeleted()) return;
		stopRefreshTimer();
		clearInterval(networkRetryTimer);
		clearTimeout(rateLimitTimer);
		void forgetDeletedAccount();
	});

	// Suppresses the URL-write effect while we're applying URL-derived state
	// (initial hydration + popstate). Without this guard, popstate would
	// re-write the URL and potentially push new entries, corrupting history.
	let isHydratingFromUrl = false;
	const hydrateStateFromUrl = () => {
		isHydratingFromUrl = true;
		actions.setViewFromUrl(readViewFromUrl());
		queueMicrotask(() => {
			isHydratingFromUrl = false;
		});
	};

	createEffect(() => {
		if (!authed() || initialUrlHandled()) return;
		hydrateStateFromUrl();
		setInitialUrlHandled(true);
	});

	// pushState when the user opens an email over the list, switches view or starts/ends a search
	// (d1-02/m2-10: Back left MailClaw); replaceState for sort, refining a search, siblings, closing.
	// Compared with the URL on screen, not a remembered selection: during boot the selection reads
	// null for a moment, and a cold ?email= link then pushed a second entry (m2-05).
	createEffect(() => {
		if (!authed() || !initialUrlHandled()) return;
		const view: UrlView = {
			mailbox: state.activeMailbox,
			category: state.activeCategory,
			levelView: state.levelView,
			domain: state.activeDomain,
			searchQuery: state.searchQuery,
			selectedConversationId: state.selectedConversationId,
			selectedEmailId: state.selectedEmailId,
			// Compose follows focus: whichever compose window is currently front
			// and has a saved draft id is represented in the URL. Local-only
			// windows (pre-first-save, no draft id yet) stay out of the URL.
			composeDraftId: focusedComposeDraftId(),
			mileage: {
				month: state.mileage.month,
				page: state.mileage.page,
				trip: state.mileage.trip,
				queue: state.mileage.queue,
			},
		};
		if (isHydratingFromUrl) return;
		const shown = readViewFromUrl();
		const shownQuery = shown.searchQuery.trim();
		const nextQuery = view.searchQuery.trim();
		const openedFresh =
			shown.selectedConversationId === null && view.selectedConversationId !== null;
		// A trip opened over the report: Back (and "u") return to it.
		const tripOpened = shown.mileage.trip === null && view.mileage.trip !== null;
		const newView = viewKey(view) !== viewKey(shown) || (shownQuery === "") !== (nextQuery === "");
		const url = buildCurrentViewUrl(view);
		if (url.href === window.location.href) return;
		if (openedFresh) {
			window.history.pushState({ mc: "email-open" }, "", url);
		} else if (tripOpened && !newView) {
			window.history.pushState({ mc: "trip-open" }, "", url);
		} else if (newView) {
			window.history.pushState({ mc: "view" }, "", url);
		} else {
			window.history.replaceState(window.history.state ?? {}, "", url);
		}
	});

	// Refresh data when app returns to foreground (critical for PWA on mobile): with no live
	// connection, a foreground is what pulls new mail and counts between timer ticks. Quick app
	// switches are one refresh (m2-12: five foregrounds in 2.5 s sent five /api/meta).
	const FOREGROUND_COALESCE_MS = 10_000;
	let lastForegroundRefresh = 0;
	const handleVisibility = () => {
		if (!document.hidden && authed()) {
			if (accessHeld()) {
				void recheckHeldIdentity();
				return;
			}
			if (Date.now() - lastForegroundRefresh < FOREGROUND_COALESCE_MS) return;
			lastForegroundRefresh = Date.now();
			actions.refresh();
			void fetchMeta();
		}
	};
	document.addEventListener("visibilitychange", handleVisibility);

	const handleServiceWorkerMessage = (event: MessageEvent) => {
		const data = event.data as { type?: string } | null;
		if (data?.type !== "mailclaw:new-mail") return;
		if (!authed()) return;
		actions.refresh();
		void fetchMeta();
	};
	navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);

	// Cloudflare Access session ended while a compose window is open (or text is typed): nothing
	// reloads on its own. Open compose windows are already written to this device and reopen after
	// the sign-in page sends the user back.
	// The notices only promise what is true: they check that every open draft is kept first.
	const notKeptMessage =
		"A draft couldn't be kept on this device (storage full or blocked). Copy it before you reload.";
	const handleSignedOut = async () => {
		const kept = await flushLocalComposeDrafts();
		actions.showToast(
			kept ? "Signed out. Your drafts are kept on this device." : `Signed out. ${notKeptMessage}`,
			"error",
			() => void reloadKeepingDrafts(),
			"Sign in",
		);
	};
	window.addEventListener(SIGNED_OUT_EVENT, handleSignedOut);
	const handleReloadBlocked = async () => {
		const kept = await flushLocalComposeDrafts();
		actions.showToast(
			kept
				? "Grip needs a reload. Your drafts are kept on this device."
				: `Grip needs a reload. ${notKeptMessage}`,
			"error",
			() => void reloadKeepingDrafts(),
			"Reload",
		);
	};
	window.addEventListener(RELOAD_BLOCKED_EVENT, handleReloadBlocked);
	const handleDraftNotKept = () => actions.showToast(`Not reloaded. ${notKeptMessage}`, "error");
	window.addEventListener(DRAFT_NOT_KEPT_EVENT, handleDraftNotKept);
	// Signing out deletes this device's mail and drafts: with text open, ask first.
	let lastSignOutHeldNotice = 0;
	const handleSignOutHeld = () => {
		// Each refresh while signed out asks again: one notice a minute is enough.
		if (Date.now() - lastSignOutHeldNotice < 60_000) return;
		lastSignOutHeldNotice = Date.now();
		actions.showToast(
			"You're signed out, or signing out. Your text is still open here: copy it, then sign out. Signing out deletes the drafts kept on this device.",
			"error",
			() => {
				lastSignOutHeldNotice = 0;
				void leaveForAccessLogout({ force: true });
			},
			"Sign out",
		);
	};
	window.addEventListener(SIGN_OUT_HELD_EVENT, handleSignOutHeld);

	// This tab's identity is gone (lib/identity.ts): its caches are already dropped and its requests
	// refused. Signing out here: the sign-out itself navigates, so do nothing. Signed out in another
	// tab: follow it to Access logout (a reload would reclaim the still-valid Access session).
	// Someone else signed in elsewhere: reload as them. Typed text is never thrown away.
	const stopIdentityWatch = onIdentityLost((reason) => {
		stopRefreshTimer();
		if (reason === "signed-out-here") return;
		if (hasUnsavedText()) {
			actions.showToast(
				reason === "signed-out-elsewhere"
					? "Signed out in another tab. Copy what you typed, then reload."
					: "Signed in as someone else in another tab. Copy what you typed, then reload.",
				"error",
			);
			return;
		}
		if (reason === "signed-out-elsewhere") window.location.assign(ACCESS_LOGOUT_URL);
		else window.location.reload();
	});

	const handlePopState = () => {
		if (!authed()) return;
		hydrateStateFromUrl();
		const composeIdFromUrl = readComposeDraftIdFromUrl();
		// editDraft brings an open window holding that draft to the front, or opens one.
		if (composeIdFromUrl) actions.editDraft(composeIdFromUrl);
	};
	window.addEventListener("popstate", handlePopState);

	onCleanup(() => {
		stopRefreshTimer();
		window.removeEventListener("online", retryAfterNetworkFailure);
		document.removeEventListener("visibilitychange", retryAfterNetworkFailure);
		clearInterval(networkRetryTimer);
		clearTimeout(rateLimitTimer);
		document.removeEventListener("visibilitychange", handleVisibility);
		navigator.serviceWorker?.removeEventListener("message", handleServiceWorkerMessage);
		window.removeEventListener(SIGNED_OUT_EVENT, handleSignedOut);
		window.removeEventListener(RELOAD_BLOCKED_EVENT, handleReloadBlocked);
		window.removeEventListener(DRAFT_NOT_KEPT_EVENT, handleDraftNotKept);
		window.removeEventListener(SIGN_OUT_HELD_EVENT, handleSignOutHeld);
		window.removeEventListener("popstate", handlePopState);
		stopIdentityWatch();
	});

	return (
		<AppContext.Provider value={store}>
			<Show
				when={!accountDeleted()}
				fallback={
					<main class="flex h-full items-center justify-center p-6">
						<p data-testid="account-deleted" class="mc-title text-center text-[17px]">
							This account is being deleted.
						</p>
					</main>
				}
			>
				{/* Initial session check */}
				<Show
					when={!checking()}
					fallback={
						<output
							class="h-full flex flex-col items-center justify-center gap-2 text-muted"
							aria-busy="true"
						>
							Opening…
							{/* auth/me answered 429: the boot waits out Retry-After, shut (d1-20, R3 F1). */}
							<Show when={rateLimited()}>
								<span class="text-[13px]">The server is busy. Grip will open in a moment.</span>
							</Show>
						</output>
					}
				>
					<Show
						when={authed()}
						fallback={
							<div class="h-full flex items-center justify-center p-4">
								<div class="w-full max-w-sm bg-sheet rounded-sheet p-8 text-center">
									<h1 class="mc-title text-[17px] mb-2">Grip couldn't open</h1>
									<p class="text-muted leading-relaxed mb-5">{bootError() || BOOT_FAILURE_MESSAGE}</p>
									<button
										type="button"
										class="mc-primary w-full"
										onClick={() => {
											void boot();
										}}
									>
										Retry
									</button>
									<Show when={bootSignOut()}>
										<a href={ACCESS_LOGOUT_URL} class="block mt-3 text-accent underline">
											Sign out
										</a>
									</Show>
								</div>
							</div>
						}
					>
						<Layout />
					</Show>
				</Show>
			</Show>
		</AppContext.Provider>
	);
};

export default App;
