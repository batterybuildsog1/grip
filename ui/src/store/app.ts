import { createContext, useContext } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type Appearance, applyAppearance, saveAppearance, storedAppearance } from "../lib/theme";
import type { EmailCategory, MailboxState, PlatformMeta } from "../types";

export type ActiveView = MailboxState | "all";

/**
 * Inbox levels (2026-10-14): "money" is billing
 * mail to act on, grouped by vendor; "person:<name>" is a forwarded-in person's mail
 * (FORWARDED_FOR_JSON), which no category view shows. "mileage" is the views' last entry: Mileage V3
 * "Answer first" (components/mileage/MileageView.tsx).
 */
export type LevelView = "money" | "mileage" | "settings" | `person:${string}`;

/**
 * Mileage's place in the URL (?view=mileage&month=2026-10&page=settings&trip=t013&queue=needs): the
 * month on screen (null: the server's current month), a page in the sheet ("settings"), the trip open
 * in the sheet, and the queue its rail holds: "needs" (Needs you), "spot" (the agent's trips, least
 * sure first), "company:<id>" (a company's trips) or "search" (the month's trips matching the search).
 */
export interface MileageNav {
	month: string | null;
	page: string | null;
	trip: string | null;
	queue: string | null;
}
export const NO_MILEAGE: MileageNav = { month: null, page: null, trip: null, queue: null };

/** A thread or a trip is open: the column holds the rail, the sheet one column (L3 reading). */
export function isReading(s: {
	selectedConversationId: string | null;
	levelView: LevelView | null;
	mileage: MileageNav;
}): boolean {
	return (
		Boolean(s.selectedConversationId) || (s.levelView === "mileage" && Boolean(s.mileage.trip))
	);
}

export function levelViewPerson(view: LevelView | null): string | null {
	return view?.startsWith("person:") ? view.slice("person:".length) : null;
}

/**
 * The views (design r2 §4 S6: Personal, Money, the forwarded-in people, then All mail, Sent,
 * Drafts, Trash; L3 adds Mileage last; design-taste X9 adds Notifications under the people, WD2 Settings off the column's
 * foot). Archive, Spam, Inbox and the other category views are cut; old links to them still open.
 */
export type ViewId =
	| "personal"
	| "money"
	| `person:${string}`
	| "notifications"
	| "settings"
	| "all"
	| "sent"
	| "draft"
	| "trash"
	| "mileage";

/** Which sidebar view the state shows, or null for a view the sidebar no longer lists. */
export function viewIdOf(s: {
	activeMailbox: ActiveView;
	activeCategory: EmailCategory | null;
	levelView: LevelView | null;
}): ViewId | null {
	if (s.levelView) return s.levelView;
	if (s.activeCategory === "personal") return "personal";
	if (s.activeCategory === "notifications") return "notifications";
	if (s.activeCategory) return null;
	if (s.activeMailbox === "all") return "all";
	if (s.activeMailbox === "sent" || s.activeMailbox === "draft" || s.activeMailbox === "trash") {
		return s.activeMailbox;
	}
	return null;
}

export function viewTitle(view: ViewId | null): string {
	if (!view) return "Mail";
	if (view.startsWith("person:")) return view.slice("person:".length);
	const titles: Record<string, string> = {
		personal: "Personal",
		money: "Money",
		notifications: "Notifications",
		settings: "Settings",
		all: "All mail",
		sent: "Sent",
		draft: "Drafts",
		trash: "Trash",
		mileage: "Mileage",
	};
	return titles[view] ?? "Mail";
}

/** The list's title, including views only an old link still opens (Inbox, Archive, a category). */
export function titleOf(s: {
	activeMailbox: ActiveView;
	activeCategory: EmailCategory | null;
	levelView: LevelView | null;
}): string {
	const view = viewIdOf(s);
	if (view) return viewTitle(view);
	if (s.activeCategory) {
		const c = s.activeCategory.replace(/_/g, " ");
		return c.charAt(0).toUpperCase() + c.slice(1);
	}
	return s.activeMailbox === "archived"
		? "Archive"
		: s.activeMailbox === "inbox"
			? "Inbox"
			: "Mail";
}

export interface Toast {
	id: string;
	message: string;
	type: "success" | "error" | "info";
	undoAction?: () => void;
	/** Label of the undoAction button (default "Undo"). */
	actionLabel?: string;
	dismissedAt?: number;
}

export interface ComposeReplyTarget {
	emailId: string;
	mode: "reply" | "reply-all" | "forward";
	/** The thread the reply shows under (InlineComposerSlot); optional for older kept windows. */
	conversationId?: string | null;
}

export interface ComposeWindowState {
	id: string;
	draftId: string | null;
	replyTo: ComposeReplyTarget | null;
	minimized: boolean;
	closeRequestKey: number;
	createdAt: number;
}

/** A compose window kept on this device (src/lib/db.ts compose_drafts), reopened on load. */
export interface RestoredComposeWindow {
	id: string;
	minimized: boolean;
	draftId: string | null;
	replyTo: ComposeReplyTarget | null;
}

export interface AppState {
	meta: PlatformMeta | null;
	loading: boolean;
	error: string | null;
	freshnessVersion: number;
	activeMailbox: ActiveView;
	activeCategory: EmailCategory | null;
	/**
	 * The account in view (the account menu): its domain, or null for All accounts. Narrows
	 * whatever view is open and never changes it (WD-02); new mail is From this account (WD-03).
	 */
	activeDomain: string | null;
	selectedConversationId: string | null;
	selectedEmailId: string | null;
	composeWindows: ComposeWindowState[];
	focusedComposeWindowId: string | null;
	/**
	 * Mirror of the focused compose window's server draft id (null before its first save), kept
	 * in sync by compose window actions. Top-level primitive so URL-sync code can subscribe
	 * without tracking nested composeWindows[i] mutations through createMemo — Solid's
	 * createStore proxy didn't propagate those reliably.
	 */
	focusedComposeDraftId: string | null;
	searchQuery: string;
	/** Search runs over All Mail; "view" narrows it to the open view (WD-09). Reset per query. */
	searchScope: "all" | "view";
	/** Phone: the search field is open at the bottom of the screen (r2 S4), before or during a search. */
	searchOpen: boolean;
	toasts: Toast[];
	/** Money, Mileage or a person's view; null for mailbox/category views. */
	levelView: LevelView | null;
	/** Mileage's month, open trip and rail queue (in the URL). */
	mileage: MileageNav;
	/** "Search trips": filters the month's trips on this device (names, addresses, purpose). */
	mileageSearch: string;
	/**
	 * The left column (L3): the views while browsing, the rail while reading. "Sidebar" and `[`
	 * hide it in either state; hidden, the list title becomes the view menu and the thread bar says
	 * "4 of 25 · Prev · Next".
	 */
	sidebarShown: boolean;
	/**
	 * Light (default) or Dark, per device (lib/theme.ts); the one theme is Grip. Mail frames resolve
	 * a sender's dark CSS for it, not the system's.
	 */
	appearance: Appearance;
}

const defaultState: AppState = {
	meta: null,
	loading: true,
	error: null,
	freshnessVersion: 0,
	activeMailbox: "all",
	activeCategory: "personal",
	activeDomain: null,
	selectedConversationId: null,
	selectedEmailId: null,
	composeWindows: [],
	focusedComposeWindowId: null,
	focusedComposeDraftId: null,
	searchQuery: "",
	searchScope: "all",
	searchOpen: false,
	toasts: [],
	levelView: null,
	mileage: NO_MILEAGE,
	mileageSearch: "",
	sidebarShown: true,
	appearance: "light",
};

type AppStore = [
	AppState,
	{
		setMeta: (m: PlatformMeta) => void;
		setLoading: (v: boolean) => void;
		setError: (e: string | null) => void;
		setActiveMailbox: (m: ActiveView) => void;
		setActiveCategory: (c: EmailCategory | null) => void;
		setActiveDomain: (d: string | null) => void;
		setLevelView: (v: LevelView) => void;
		setView: (v: ViewId) => void;
		setViewFromUrl: (view: {
			mailbox: ActiveView;
			category: EmailCategory | null;
			levelView: LevelView | null;
			domain: string | null;
			searchQuery: string;
			selectedConversationId: string | null;
			selectedEmailId: string | null;
			mileage: MileageNav;
		}) => void;
		/** Opens a trip in the sheet (null closes it), its rail holding `queue`. */
		openTrip: (id: string | null, queue?: string | null) => void;
		setMileageMonth: (month: string | null) => void;
		/** A page in the sheet ("settings"), or null for the report. */
		setMileagePage: (page: string | null) => void;
		setMileageSearch: (q: string) => void;
		toggleSidebar: () => void;
		setAppearance: (appearance: Appearance) => void;
		selectConversation: (conversationId: string | null, emailId?: string | null) => void;
		selectEmail: (id: string | null) => void;
		adjustUnreadCount: (delta: number, category?: string | null) => void;
		openCompose: (replyTo?: ComposeReplyTarget | null) => void;
		editDraft: (draftId: string) => void;
		restoreComposeWindows: (windows: RestoredComposeWindow[]) => void;
		setComposeWindowDraftId: (windowId: string, id: string | null) => void;
		/** Reply all, or a reply brought back after Cancel: what the window answers, and how. */
		setComposeReplyTo: (windowId: string, replyTo: ComposeReplyTarget) => void;
		requestComposeClose: (windowId: string) => void;
		closeCompose: (windowId: string) => void;
		minimizeCompose: (windowId: string) => void;
		restoreCompose: (windowId: string) => void;
		focusCompose: (windowId: string) => void;
		setSearch: (q: string) => void;
		setSearchScope: (scope: "all" | "view") => void;
		setSearchOpen: (open: boolean) => void;
		refresh: () => void;
		/** Returns the toast's id (for dismissToast). */
		showToast: (
			message: string,
			type: Toast["type"],
			undoAction?: () => void,
			actionLabel?: string,
		) => string;
		dismissToast: (id: string) => void;
		/** z: undo the newest toast that offers Undo. False when none does. */
		undoLatest: () => boolean;
	},
];

const AppContext = createContext<AppStore>();

let composeWindowCounter = 0;

function createComposeWindowId(): string {
	composeWindowCounter += 1;
	return `compose-window-${Date.now()}-${composeWindowCounter}`;
}

export function createAppStore() {
	const [state, setState] = createStore<AppState>({
		...defaultState,
		appearance: storedAppearance(),
	});
	// Another tab changed the appearance: follow it here too, without writing it back.
	window.addEventListener("storage", (e) => {
		if (e.key !== "mc-appearance") return;
		const appearance = storedAppearance();
		applyAppearance(appearance);
		setState({ appearance });
	});

	// Keeps the top-level focusedComposeDraftId mirror in sync with whichever
	// window is currently focused. Called at the end of every produce that
	// touches focus or draftId.
	const refreshFocusedComposeDraftId = (s: AppState) => {
		const focused = s.focusedComposeWindowId
			? s.composeWindows.find((w) => w.id === s.focusedComposeWindowId)
			: null;
		s.focusedComposeDraftId = focused?.draftId ?? null;
	};

	const syncFocusedComposeWindow = (s: AppState) => {
		const focusedExists = s.focusedComposeWindowId
			? s.composeWindows.some((window) => window.id === s.focusedComposeWindowId)
			: false;
		if (!focusedExists) {
			const lastActive = [...s.composeWindows].reverse().find((window) => !window.minimized);
			s.focusedComposeWindowId =
				lastActive?.id ?? s.composeWindows[s.composeWindows.length - 1]?.id ?? null;
		}
		refreshFocusedComposeDraftId(s);
	};

	// Focus only: the focused window is drawn on top (Compose.tsx z-index). Moving it within
	// composeWindows re-inserted its DOM node on mousedown, so the click that followed (its own
	// Minimize, Close or Send) never fired on a window that wasn't already in front.
	const bringComposeWindowToFront = (s: AppState, windowId: string) => {
		if (!s.composeWindows.some((window) => window.id === windowId)) return;
		s.focusedComposeWindowId = windowId;
		refreshFocusedComposeDraftId(s);
	};

	const actions = {
		setMeta: (m: PlatformMeta) => setState({ meta: m, loading: false, error: null }),
		setLoading: (v: boolean) => setState({ loading: v }),
		setError: (e: string | null) => setState({ error: e, loading: false }),
		// Choosing a view leaves search: the view replaces the results (r2 S4).
		setActiveMailbox: (m: ActiveView) =>
			setState(
				produce((s) => {
					s.searchQuery = "";
					s.searchOpen = false;
					s.activeMailbox = m;
					s.activeCategory = null;
					s.levelView = null;
					s.searchQuery = "";
					s.selectedConversationId = null;
					s.selectedEmailId = null;
					s.mileage = NO_MILEAGE;
					s.mileageSearch = "";
				}),
			),
		setActiveCategory: (c: EmailCategory | null) =>
			setState(
				produce((s) => {
					s.searchQuery = "";
					s.searchOpen = false;
					s.activeCategory = c;
					s.levelView = null;
					s.activeMailbox = "all";
					s.searchQuery = "";
					s.selectedConversationId = null;
					s.selectedEmailId = null;
					s.mileage = NO_MILEAGE;
					s.mileageSearch = "";
				}),
			),
		// A domain narrows whatever view is open (WD-02, 2026-10-23: choosing a domain from
		// Personal used to drop Personal and Needs you); the view setters keep it.
		setActiveDomain: (d: string | null) =>
			setState(
				produce((s) => {
					s.activeDomain = d;
					s.selectedConversationId = null;
					s.selectedEmailId = null;
				}),
			),
		setLevelView: (v: LevelView) =>
			setState(
				produce((s) => {
					s.searchQuery = "";
					s.searchOpen = false;
					s.levelView = v;
					s.activeMailbox = "all";
					s.activeCategory = null;
					s.searchQuery = "";
					s.selectedConversationId = null;
					s.selectedEmailId = null;
					s.mileage = NO_MILEAGE;
					s.mileageSearch = "";
				}),
			),
		/** A sidebar or view-menu choice: leaves any search, keeps the account (WD-02). */
		setView: (v: ViewId) => {
			if (v === "personal" || v === "notifications") actions.setActiveCategory(v);
			else if (v === "money" || v === "mileage" || v === "settings" || v.startsWith("person:"))
				actions.setLevelView(v as LevelView);
			else actions.setActiveMailbox(v as ActiveView);
		},
		setViewFromUrl: (view: {
			mailbox: ActiveView;
			category: EmailCategory | null;
			levelView: LevelView | null;
			domain: string | null;
			searchQuery: string;
			selectedConversationId: string | null;
			selectedEmailId: string | null;
			mileage: MileageNav;
		}) =>
			setState(
				produce((s) => {
					s.activeMailbox = view.mailbox;
					s.activeCategory = view.category;
					s.levelView = view.levelView;
					s.activeDomain = view.domain;
					s.searchQuery = view.searchQuery;
					s.selectedConversationId = view.selectedConversationId;
					s.selectedEmailId = view.selectedEmailId;
					s.mileage = view.levelView === "mileage" ? view.mileage : NO_MILEAGE;
				}),
			),
		openTrip: (id: string | null, queue?: string | null) =>
			setState("mileage", (m) => ({
				...m,
				trip: id,
				queue: id ? (queue ?? m.queue ?? "needs") : null,
			})),
		setMileageMonth: (month: string | null) =>
			setState("mileage", { month, page: null, trip: null, queue: null }),
		setMileagePage: (page: string | null) => setState("mileage", { page, trip: null, queue: null }),
		setMileageSearch: (q: string) => setState({ mileageSearch: q }),
		toggleSidebar: () =>
			setState(
				produce((s) => {
					s.sidebarShown = !s.sidebarShown;
				}),
			),
		// Applies at once (attributes on <html>): nothing re-mounts, so drafts, threads and scroll stay.
		setAppearance: (appearance: Appearance) => {
			saveAppearance(appearance);
			setState({ appearance });
		},
		selectConversation: (conversationId: string | null, emailId?: string | null) =>
			setState(
				produce((s) => {
					const nextConversationId = conversationId?.trim() ? conversationId : null;
					const nextEmailId = emailId?.trim() ? emailId : null;
					const previousConversationId = s.selectedConversationId;

					s.selectedConversationId = nextConversationId;
					if (!nextConversationId) {
						s.selectedEmailId = null;
						return;
					}

					if (emailId !== undefined) {
						s.selectedEmailId = nextEmailId;
						return;
					}

					if (previousConversationId !== nextConversationId) {
						s.selectedEmailId = null;
					}
				}),
			),
		selectEmail: (id: string | null) =>
			actions.selectConversation(id?.trim() ? id : null, id?.trim() ? id : null),
		adjustUnreadCount: (delta: number, category?: string | null) =>
			setState(
				produce((s) => {
					if (s.meta) {
						s.meta.unread_count = Math.max(0, s.meta.unread_count + delta);
						s.meta.conversation_unread_count = Math.max(
							0,
							(s.meta.conversation_unread_count ?? 0) + delta,
						);
						// The sidebar's Personal count moves with the row, before the next refresh.
						const counts = s.meta.conversation_category_unread_counts;
						if (category && counts && counts[category] !== undefined) {
							counts[category] = Math.max(0, counts[category] + delta);
						}
					}
				}),
			),
		requestComposeClose: (windowId: string) =>
			setState(
				produce((s) => {
					const window = s.composeWindows.find((entry) => entry.id === windowId);
					if (!window) return;
					window.closeRequestKey += 1;
				}),
			),
		closeCompose: (windowId: string) =>
			setState(
				produce((s) => {
					const idx = s.composeWindows.findIndex((window) => window.id === windowId);
					if (idx === -1) return;
					s.composeWindows.splice(idx, 1);
					syncFocusedComposeWindow(s);
				}),
			),
		minimizeCompose: (windowId: string) =>
			setState(
				produce((s) => {
					const window = s.composeWindows.find((entry) => entry.id === windowId);
					if (!window) return;
					window.minimized = true;
					if (s.focusedComposeWindowId === windowId) {
						const nextActive = [...s.composeWindows]
							.reverse()
							.find((entry) => entry.id !== windowId && !entry.minimized);
						s.focusedComposeWindowId = nextActive?.id ?? windowId;
					}
					refreshFocusedComposeDraftId(s);
				}),
			),
		restoreCompose: (windowId: string) =>
			setState(
				produce((s) => {
					const window = s.composeWindows.find((entry) => entry.id === windowId);
					if (!window) return;
					window.minimized = false;
					bringComposeWindowToFront(s, windowId);
				}),
			),
		focusCompose: (windowId: string) =>
			setState(
				produce((s) => {
					bringComposeWindowToFront(s, windowId);
				}),
			),
		// Submitting always shows the results, even the same query over a thread opened from them
		// (WP-09); a new query starts over All Mail.
		setSearch: (q: string) =>
			setState(
				produce((s) => {
					if (s.searchQuery !== q) {
						s.searchQuery = q;
						s.searchScope = "all";
					}
					s.selectedConversationId = null;
					s.selectedEmailId = null;
				}),
			),
		setSearchScope: (scope: "all" | "view") => setState({ searchScope: scope }),
		setSearchOpen: (open: boolean) => setState({ searchOpen: open }),
		refresh: () =>
			setState(
				produce((s) => {
					s.freshnessVersion += 1;
				}),
			),
		openCompose: (replyTo?: ComposeReplyTarget | null) =>
			setState(
				produce((s) => {
					// One reply per thread (it is written under the thread): Reply again brings it back.
					const existing = replyTo
						? s.composeWindows.find(
								(window) =>
									window.replyTo &&
									((replyTo.conversationId &&
										window.replyTo.conversationId === replyTo.conversationId) ||
										window.replyTo.emailId === replyTo.emailId),
							)
						: undefined;
					if (existing) {
						existing.minimized = false;
						bringComposeWindowToFront(s, existing.id);
						return;
					}
					const windowId = createComposeWindowId();
					s.composeWindows.push({
						id: windowId,
						draftId: null,
						replyTo: replyTo ?? null,
						minimized: false,
						closeRequestKey: 0,
						createdAt: Date.now(),
					});
					s.focusedComposeWindowId = windowId;
					refreshFocusedComposeDraftId(s);
				}),
			),
		editDraft: (draftId: string) =>
			setState(
				produce((s) => {
					const existing = s.composeWindows.find((window) => window.draftId === draftId);
					if (existing) {
						existing.minimized = false;
						bringComposeWindowToFront(s, existing.id);
						return;
					}
					const windowId = createComposeWindowId();
					s.composeWindows.push({
						id: windowId,
						draftId,
						replyTo: null,
						minimized: false,
						closeRequestKey: 0,
						createdAt: Date.now(),
					});
					s.focusedComposeWindowId = windowId;
					refreshFocusedComposeDraftId(s);
				}),
			),
		restoreComposeWindows: (windows: RestoredComposeWindow[]) =>
			setState(
				produce((s) => {
					for (const restored of windows) {
						if (s.composeWindows.some((w) => w.id === restored.id)) continue;
						if (restored.draftId && s.composeWindows.some((w) => w.draftId === restored.draftId)) {
							continue;
						}
						s.composeWindows.push({
							id: restored.id,
							draftId: restored.draftId,
							replyTo: restored.replyTo,
							minimized: restored.minimized,
							closeRequestKey: 0,
							createdAt: Date.now(),
						});
					}
					syncFocusedComposeWindow(s);
				}),
			),
		setComposeWindowDraftId: (windowId: string, id: string | null) =>
			setState(
				produce((s) => {
					const window = s.composeWindows.find((entry) => entry.id === windowId);
					if (!window) return;
					window.draftId = id;
					refreshFocusedComposeDraftId(s);
				}),
			),
		setComposeReplyTo: (windowId: string, replyTo: ComposeReplyTarget) =>
			setState(
				produce((s) => {
					const window = s.composeWindows.find((entry) => entry.id === windowId);
					if (window?.replyTo) window.replyTo = { ...replyTo };
				}),
			),
		showToast: (
			message: string,
			type: Toast["type"],
			undoAction?: () => void,
			actionLabel?: string,
		) => {
			const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const toast: Toast = { id, message, type, undoAction, actionLabel };
			setState(
				produce((s) => {
					s.toasts.push(toast);
				}),
			);
			// 6 s (S7): long enough to reach Undo or press z. Errors stay until dismissed.
			if (type !== "error") {
				setTimeout(() => {
					actions.dismissToast(id);
				}, 6000);
			}
			return id;
		},
		dismissToast: (id: string) => {
			setState(
				produce((s) => {
					const idx = s.toasts.findIndex((t) => t.id === id);
					if (idx !== -1) s.toasts.splice(idx, 1);
				}),
			);
		},
		undoLatest: () => {
			const toast = [...state.toasts].reverse().find((t) => t.undoAction);
			if (!toast?.undoAction) return false;
			toast.undoAction();
			actions.dismissToast(toast.id);
			return true;
		},
	};

	return [state, actions] as AppStore;
}

export { AppContext };
export function useApp() {
	const ctx = useContext(AppContext);
	if (!ctx) throw new Error("useApp must be used within AppContext.Provider");
	return ctx;
}
