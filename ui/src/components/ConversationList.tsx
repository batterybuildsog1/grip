import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import { ApiHttpError, ApiNetworkError } from "../api/client";
import {
	cancelPendingRequests,
	filtersKey,
	getConversationRowsCached,
	isOnline,
	markThreadRead,
	peekConversationPage,
	prefetchConversationDetail,
} from "../lib/cache";
import type { ConversationSummaryRecord } from "../lib/db";
import { activatesControl, notAShortcut } from "../lib/shortcuts";
import {
	leavingIds,
	nextAfter,
	setListedConversations,
	setListedOpener,
	settleLeaving,
	type TriageTarget,
	useTriage,
} from "../lib/triage";
import { levelViewPerson, titleOf, useApp, type ViewId, viewIdOf } from "../store/app";
import { columnFits, isMobile, isNarrow } from "../store/responsive";
import type { BatchAction, ConversationSearchInfo, EmailFilters } from "../types";
import { searchWhere, viewNarrowsSearch } from "../utils/search";
import ConversationRow, { isUnread, rowName, rowSubject } from "./ConversationRow";
import NeedsYouLine from "./NeedsYouLine";
import Rail from "./Rail";
import SearchHeader, { type SearchScope, type SearchStatus } from "./SearchHeader";
import { setAccountSheetOpen } from "./Settings";
import { railSlot, useViewMenuItems } from "./Sidebar";
import { accountsOf } from "./TopBar";
import DeleteForever from "./triage/DeleteForever";
import ViewTitle from "./ViewTitle";

/**
 * The list (design r2 §4 S1, L3): the view's title (a view menu when the column is hidden), Needs
 * you on Personal, one line per conversation, and every state of §5: skeletons while loading (no
 * fake counts), an offline line only when what is shown may be stale, an error that never reads as
 * an empty view, and plain empty views ("No drafts.", "Trash is empty."). While a thread is open the
 * list stays mounted (invisible) and draws itself into the column as the rail.
 *
 * Data: the first page paints from the device cache, then the network answer replaces it; a
 * timed refresh merges in place and keeps the row on top where it was. Mailbox actions run on
 * the server and put the screen back when they fail (no offline queue).
 */

const PAGE = 50;

/**
 * Money view: one group per vendor so one vendor's many notices are one block.
 * Vendor = the vendor-side sender's display name, else its domain. Groups keep newest-first order.
 */
function vendorOf(email: ConversationSummaryRecord): string {
	const other =
		email.direction === "outbound"
			? email.thread_participants.find((p) => !p.address.endsWith(`@${email.domain}`))
			: { name: email.from_name, address: email.from_address };
	const address = other?.address ?? email.from_address;
	return other?.name?.trim() || address.slice(address.lastIndexOf("@") + 1) || address;
}

function groupByVendor(list: ConversationSummaryRecord[]): ConversationSummaryRecord[] {
	const groups = new Map<string, ConversationSummaryRecord[]>();
	for (const email of list) {
		const vendor = vendorOf(email).toLowerCase();
		const group = groups.get(vendor);
		if (group) group.push(email);
		else groups.set(vendor, [email]);
	}
	return [...groups.values()].flat();
}

/** Keep unchanged rows as the same objects, so a refresh doesn't redraw them. */
function mergeRows(
	existing: ConversationSummaryRecord[],
	fresh: ConversationSummaryRecord[],
): ConversationSummaryRecord[] {
	if (existing.length === 0) return fresh;
	const byId = new Map(existing.map((e) => [e.id, e]));
	return fresh.map((next) => {
		const prev = byId.get(next.id);
		return prev &&
			prev.read_at === next.read_at &&
			prev.thread_unread_count === next.thread_unread_count &&
			prev.mailbox_state === next.mailbox_state &&
			prev.snippet === next.snippet &&
			prev.subject === next.subject &&
			prev.thread_count === next.thread_count &&
			prev.received_at === next.received_at
			? prev
			: next;
	});
}

const appendRows = (existing: ConversationSummaryRecord[], fresh: ConversationSummaryRecord[]) => {
	const ids = new Set(existing.map((e) => e.id));
	return [...existing, ...fresh.filter((e) => !ids.has(e.id))];
};

const ConversationList: Component = () => {
	const [state, actions] = useApp();
	const viewItems = useViewMenuItems();
	const [loaded, setLoaded] = createSignal<ConversationSummaryRecord[]>([]);
	const emails = createMemo(() => {
		// Rows the thread bar's triage (S7, lib/triage.ts) is taking out of the list stay hidden
		// until the server's next list settles them.
		const leaving = leavingIds();
		const rows = leaving.size > 0 ? loaded().filter((e) => !leaving.has(e.id)) : loaded();
		return state.levelView === "money" && !state.searchQuery ? groupByVendor(rows) : rows;
	});
	// What an open thread advances to after Archive or Trash (S7's nextAfter), and its "4 of 25":
	// conversations, so a row that is only its draft is passed (ux-w-p1-2, P1-3).
	createEffect(() =>
		setListedConversations(
			emails()
				.filter((e) => !draftOnly(e))
				.map((e) => ({
					id: e.id,
					emailId: e.display_email_id ?? e.latest_email_id ?? e.id,
					name: rowName(e),
					subject: rowSubject(e),
					unread: isUnread(e),
				})),
			hasMore(),
		),
	);
	const triage = useTriage();
	/** Delete forever (Trash only, S7): the conversations waiting on the confirm. */
	const [confirmingDelete, setConfirmingDelete] = createSignal<ConversationSummaryRecord[] | null>(
		null,
	);
	const [total, setTotal] = createSignal(0);
	const [hasMore, setHasMore] = createSignal(false);
	const [loading, setLoading] = createSignal(true);
	// From opening a view until the server answers it, rows painted from the device may be stale:
	// the list says it is loading (dimmed, aria-busy) (WD-11: a slow switch showed old rows, no sign).
	const [awaitingNetwork, setAwaitingNetwork] = createSignal(false);
	type LoadError = { offline: boolean; message: string | null };
	const [loadError, setLoadError] = createSignal<LoadError | null>(null);
	const loadErrorOf = (e: unknown): LoadError => ({
		offline: e instanceof ApiNetworkError || !navigator.onLine,
		message:
			e instanceof ApiHttpError && e.status >= 400 && e.status < 500 && e.status !== 409
				? e.message
				: null,
	});
	const [searchInfo, setSearchInfo] = createSignal<ConversationSearchInfo | null>(null);
	const [loadingMore, setLoadingMore] = createSignal(false);
	const [offset, setOffset] = createSignal(0);
	const [nextCursor, setNextCursor] = createSignal<string | null>(null);
	const [selected, setSelected] = createSignal<Set<string>>(new Set());
	const [fetchGen, setFetchGen] = createSignal(0);
	// The keyboard cursor: where j/k/Enter act. Drawn only once a key has moved it.
	const [cursor, setCursor] = createSignal(-1);
	const [keyed, setKeyed] = createSignal(false);
	const [newCount, setNewCount] = createSignal(0);
	let scrollRef: HTMLDivElement | undefined;
	let isLoadingMore = false;

	const view = () => viewIdOf(state);
	const phone = () => isMobile();
	/** The tablet band (768-999): the rail's two-line rows, not the five-column line (WD1). */
	const twoLine = () => !phone() && isNarrow();
	const inTrash = () => state.activeMailbox === "trash" && !state.searchQuery;
	/**
	 * A row that is only its draft, as in the apps (AppModel+Compose openDraft): any draft row in
	 * Drafts, and anywhere a draft that is its whole conversation (a new message). Any other draft
	 * row is its conversation, whose reply that draft is (ux-w-p1-2).
	 */
	const draftOnly = (e: ConversationSummaryRecord) =>
		e.mailbox_state === "draft" &&
		(e.thread_count <= 1 || (state.activeMailbox === "draft" && !state.searchQuery));
	/** A thread is open: the list is the rail (desktop), j/k hop its rows. */
	const reading = () => Boolean(state.selectedConversationId);
	/** No column (hidden, below 900 px, a phone): the title is the views menu and carries the count. */
	const titleIsMenu = () => !state.sidebarShown || phone() || !columnFits();

	// ── Scroll: keep the row on top through a refresh; keep the spot through a thread ──

	type Anchor = { id: string; top: number };
	const captureAnchor = (): Anchor | null => {
		const box = scrollRef;
		if (!box) return null;
		const top = box.getBoundingClientRect().top;
		const row = [...box.querySelectorAll<HTMLElement>("[data-testid=conversation-row]")].find(
			(el) => el.getBoundingClientRect().bottom > top + 1,
		);
		return row?.dataset.id
			? { id: row.dataset.id, top: row.getBoundingClientRect().top - top }
			: null;
	};
	const restoreAnchor = (anchor: Anchor | null) => {
		if (!anchor) return;
		requestAnimationFrame(() => {
			const box = scrollRef;
			const row = box?.querySelector<HTMLElement>(
				`[data-testid=conversation-row][data-id="${CSS.escape(anchor.id)}"]`,
			);
			if (!box || !row) return;
			box.scrollTop +=
				row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.top;
		});
	};

	// A phone turned to landscape is the desktop layout (768 px and up), whose rows are shorter: the
	// same scrollTop shows other rows (m2-08). Note the row on top as scrolling goes; after the layout
	// swaps, put that row back on top (main 54ec19d did this for the old lists).
	let topRow: Anchor | null = null;
	let noting = false;
	const noteTopRow = () => {
		if (noting) return;
		noting = true;
		requestAnimationFrame(() => {
			noting = false;
			topRow = captureAnchor();
		});
	};
	// Its top edge goes to the list's top: a row half scrolled off in one layout would be wholly off
	// in the other, whose rows are a different height.
	createEffect(
		on(phone, () => restoreAnchor(topRow && { id: topRow.id, top: Math.max(0, topRow.top) }), {
			defer: true,
		}),
	);

	// The hidden list can lose its place while a thread is open (d1-01: Chrome moved it with no
	// script involved), so keep the position from the moment it opened and put it back on Back.
	let topAtOpen: number | null = null;
	createEffect(
		on(
			() => Boolean(state.selectedConversationId),
			(open, wasOpen) => {
				if (open && !wasOpen) topAtOpen = scrollRef?.scrollTop ?? null;
				if (!open && wasOpen && topAtOpen !== null) {
					const top = topAtOpen;
					topAtOpen = null;
					requestAnimationFrame(() => {
						if (scrollRef) scrollRef.scrollTop = top;
					});
				}
			},
			{ defer: true },
		),
	);

	// ── Data ──

	const buildFilters = (over?: { cursor?: string | null; offset?: number }): EmailFilters => {
		const filters: EmailFilters = { limit: PAGE, offset: over?.offset ?? offset() };
		if (over?.cursor) filters.cursor = over.cursor;
		// A search sends the view's filters too: scope=all (the default) leaves them out and echoes them
		// as search.view_filters; scope=view applies them (the view's pill, r2 S4). An in: operator in
		// the query text still scopes it on the server.
		if (state.activeMailbox !== "all") {
			filters.mailbox_state = state.activeMailbox as EmailFilters["mailbox_state"];
		}
		if (state.searchQuery) filters.q = state.searchQuery;
		if (state.searchQuery && state.searchScope === "view") filters.scope = "view";
		if (state.activeCategory) filters.category = state.activeCategory;
		if (state.levelView === "money") {
			filters.category = "billing";
			filters.sub_category = "failed_payments,invoice_conversations";
		}
		const person = levelViewPerson(state.levelView);
		if (person) filters.for_person = person;
		if (state.activeDomain) filters.domain = state.activeDomain;
		return filters;
	};

	const isAbort = (e: unknown) =>
		(e instanceof DOMException || e instanceof Error) && e.name === "AbortError";
	const moreOf = (page: {
		emails: ConversationSummaryRecord[];
		offset: number;
		total: number;
		next_cursor?: string | null;
		has_more?: boolean;
	}) =>
		page.has_more !== undefined
			? page.has_more
			: Boolean(page.next_cursor) || page.offset + page.emails.length < page.total;

	const fetchRows = async (
		refresh = false,
		opts?: { append?: boolean; cursor?: string | null; filters?: EmailFilters },
	) => {
		// A refresh keeps the generation, so it can't orphan a first load still in flight.
		const gen = refresh ? fetchGen() : fetchGen() + 1;
		const append = opts?.append ?? false;
		const anchor = refresh && !append ? captureAnchor() : null;
		if (!refresh) setFetchGen(gen);
		setLoadError(null);
		// The network answered (or failed). Until then an empty page is only the device's, which
		// on a cold device is empty for every view: keep the skeletons, not "No conversations".
		let answered = false;
		let waiting = false;
		const settle = () => setLoading(false);
		const awaits = !refresh && !append;
		const heard = () => {
			if (awaits && fetchGen() === gen) setAwaitingNetwork(false);
		};
		if (awaits) setAwaitingNetwork(true);
		try {
			if (!append && !refresh && loaded().length === 0) setLoading(true);
			const filters = opts?.filters ?? buildFilters({ cursor: opts?.cursor });
			const cached = await getConversationRowsCached(
				filters,
				(fresh) => {
					answered = true;
					heard();
					if (fetchGen() !== gen) return;
					if (waiting) settle();
					setSearchInfo(fresh.search ?? null);
					setTotal(fresh.total);
					setHasMore(moreOf(fresh));
					setNextCursor(fresh.next_cursor ?? null);
					if (append) setLoaded((prev) => appendRows(prev, fresh.emails));
					else {
						setLoaded((prev) =>
							refresh && prev.length > 0 ? mergeRows(prev, fresh.emails) : fresh.emails,
						);
						// The server's list replaces every guess about rows leaving (S7).
						settleLeaving();
						restoreAnchor(anchor);
					}
				},
				(e) => {
					answered = true;
					heard();
					if (fetchGen() !== gen) return;
					if (waiting) settle();
					// The network failed after cached rows were shown: say so (aborts are switches).
					if (!isAbort(e)) setLoadError(loadErrorOf(e));
				},
			);
			// Offline the device's rows are all there is: no answer is coming.
			if (answered || !isOnline()) heard();
			if (fetchGen() !== gen) return;
			waiting = !answered && !append && !refresh && cached.emails.length === 0;
			if (append) setLoaded((prev) => appendRows(prev, cached.emails));
			else if (loaded().length === 0) setLoaded(cached.emails);
			if (cached.search || !append) setSearchInfo(cached.search ?? null);
			setTotal(cached.total);
			setHasMore(moreOf(cached));
			setNextCursor(cached.next_cursor ?? null);
			if (cached.emails.length > 0 || loaded().length > 0) setLoading(false);
		} catch (e) {
			heard();
			if (isAbort(e)) return;
			if (fetchGen() === gen) setLoadError(loadErrorOf(e));
		} finally {
			if (fetchGen() === gen) {
				if (!waiting) settle();
				isLoadingMore = false;
				setLoadingMore(false);
			}
		}
	};

	// A new view, account or search: start at the top, paint the cached page if there is one.
	createEffect(
		on(
			() =>
				[
					state.activeMailbox,
					state.activeCategory,
					state.levelView,
					state.activeDomain,
					state.searchQuery,
					state.searchScope,
				] as const,
			() => {
				setOffset(0);
				setNextCursor(null);
				setSelected(new Set<string>());
				setCursor(-1);
				setHasMore(false);
				setLoadError(null);
				setNewCount(0);
				isLoadingMore = false;
				if (scrollRef) scrollRef.scrollTop = 0;
				const filters = buildFilters({ offset: 0 });
				// The rows are the new view's from here on: its page from this tab, else none until
				// fetchRows paints the device's or the server answers (the skeleton meanwhile). Never the
				// last view's: a failed or slow switch listed All mail under "Sent" (UX walkthrough P1-4).
				const page = peekConversationPage(filters);
				const rows = page?.emails ?? [];
				setLoading(rows.length === 0);
				setLoaded(rows);
				setSearchInfo(page?.search ?? null);
				if (page && rows.length > 0) {
					setTotal(page.total);
					setHasMore(moreOf(page));
					setNextCursor(page.next_cursor ?? null);
				}
				cancelPendingRequests(filtersKey(filters));
				void fetchRows(false, { filters });
			},
		),
	);

	// The app's refresh (foreground, every 2 min): merge in place. Not during a search (a ranked
	// list reshuffling under the reader). New rows above a scrolled list are counted, not jumped to.
	createEffect(
		on(
			() => state.freshnessVersion,
			() => {
				if (state.searchQuery || document.hidden || loadingMore()) return;
				const topBefore = loaded()[0]?.id ?? null;
				void fetchRows(true).then(() => {
					const at = topBefore ? loaded().findIndex((e) => e.id === topBefore) : -1;
					if (at > 0 && (scrollRef?.scrollTop ?? 0) > 100) setNewCount((n) => n + at);
				});
			},
			{ defer: true },
		),
	);

	const loadMore = () => {
		if (loadingMore() || loading() || !hasMore()) return;
		isLoadingMore = true;
		setLoadingMore(true);
		const next = nextCursor();
		if (next) {
			void fetchRows(false, { append: true, cursor: next });
			return;
		}
		// Ranked search pages by offset.
		const at = offset() + PAGE;
		setOffset(at);
		void fetchRows(false, { append: true, filters: buildFilters({ offset: at }) });
	};
	const nearEnd = () => {
		const box = scrollRef;
		if (!box || isLoadingMore) return;
		if (box.scrollTop + box.clientHeight > box.scrollHeight - 800) loadMore();
	};
	// A first page shorter than the window never scrolls: ask for the next one now.
	createEffect(
		on(
			() => emails().length,
			() => requestAnimationFrame(nearEnd),
			{ defer: true },
		),
	);

	// Hover a row a moment: fetch its thread, so the click opens at once.
	const prefetched = new Set<string>();
	let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
	const prefetch = (id: string) => {
		if (prefetched.has(id)) return;
		clearTimeout(prefetchTimer);
		prefetchTimer = setTimeout(() => {
			prefetched.add(id);
			prefetchConversationDetail(id, { load: "full" });
		}, 120);
	};
	onCleanup(() => clearTimeout(prefetchTimer));

	// ── Actions: the server first; a failure puts the screen back and says so ──

	const failed =
		(what: string, putBack?: () => void) =>
		(error?: unknown): void => {
			putBack?.();
			actions.showToast(
				error instanceof ApiHttpError
					? `Couldn't ${what}. Nothing changed.`
					: `Couldn't ${what}: you're offline. It's shown as it was; check again once you're online.`,
				"error",
			);
			actions.refresh();
		};

	/** The rows and the unread counts before an optimistic change, to put back. */
	const snapshot = () => {
		const rows = loaded();
		const gen = fetchGen();
		const noted: [number, string | null][] = [];
		return {
			noteUnread: (delta: number, category: string | null) => {
				noted.push([delta, category]);
				actions.adjustUnreadCount(delta, category);
			},
			putBack: () => {
				if (fetchGen() === gen) setLoaded(rows);
				for (const [delta, category] of noted.splice(0))
					actions.adjustUnreadCount(-delta, category);
			},
		};
	};

	const threadOf = (e: ConversationSummaryRecord) => e.thread_id || e.id;

	// Row, bulk-bar and key actions run S7's one engine (lib/triage.ts): server first, one toast
	// with Undo and z, a failure that says so. The list's own change is `shown`: rows leave or flip
	// at once, and a refusal puts the rows (and the unread counts) back.
	const targetsOf = (rows: ConversationSummaryRecord[]): TriageTarget[] => {
		const seen = new Set<string>();
		return rows.flatMap((e) => {
			const id = threadOf(e);
			if (seen.has(id)) return [];
			seen.add(id);
			return [{ id, subject: e.subject, unread: isUnread(e) }];
		});
	};
	const refreshed = () => void fetchRows(true);

	/** Archive, Trash, or Restore inside Trash: the rows leave the list. */
	const leave = (
		rows: ConversationSummaryRecord[],
		action: "archive" | "trash" | "restore",
		refused?: () => void,
	) => {
		if (rows.length === 0) return;
		const gone = new Set(rows.map(threadOf));
		const open = state.selectedConversationId;
		const leavingRows = new Set(rows.map((e) => e.id));
		// The open conversation leaving moves the reader to the next that stays (S7).
		const next = open && leavingRows.has(open) ? nextAfter(open, leavingRows) : undefined;
		void triage.run(action, targetsOf(rows), {
			shown: () => {
				const before = snapshot();
				if (open && next !== undefined) {
					if (next) actions.selectConversation(next.id, next.emailId);
					else actions.selectConversation(null);
				}
				setLoaded((prev) => prev.filter((e) => !gone.has(threadOf(e))));
				if (action !== "restore") {
					for (const e of rows) if (isUnread(e)) before.noteUnread(-1, e.category);
				}
				return () => {
					before.putBack();
					refused?.();
				};
			},
			refreshed,
		});
	};

	/** Read state of these rows on screen (and the unread counts with it). */
	const showRead = (rows: ConversationSummaryRecord[], read: boolean) => {
		const before = snapshot();
		const ids = new Set(rows.map((e) => e.id));
		for (const e of rows) if (isUnread(e) === read) before.noteUnread(read ? -1 : 1, e.category);
		setLoaded((prev) =>
			prev.map((e) =>
				ids.has(e.id)
					? {
							...e,
							read_at: read ? Date.now() : null,
							thread_unread_count: read ? 0 : Math.max(e.thread_unread_count, 1),
						}
					: e,
			),
		);
		return before.putBack;
	};

	const markRows = (rows: ConversationSummaryRecord[], read: boolean, refused?: () => void) => {
		if (rows.length === 0) return;
		const current = rows.map((r) => loaded().find((e) => e.id === r.id) ?? r);
		void triage.run(read ? "mark_read" : "mark_unread", targetsOf(current), {
			shown: () => {
				const putBack = showRead(current, read);
				return () => {
					putBack();
					refused?.();
				};
			},
			refreshed,
		});
	};

	const moveOut = (email: ConversationSummaryRecord, action: "archive" | "trash") =>
		leave([email], action);
	const restore = (email: ConversationSummaryRecord) => {
		if (inTrash()) leave([email], "restore");
		else void triage.run("restore", targetsOf([email]), { refreshed });
	};
	const setRead = (email: ConversationSummaryRecord, read: boolean) => markRows([email], read);

	const runBulk = (action: BatchAction) => {
		const rows = selectedRows();
		if (rows.length === 0) return;
		const was = new Set(selected());
		setSelected(new Set<string>());
		// Refused: the rows come back still selected (S7).
		const reselect = () => setSelected(was);
		if (action === "mark_read" || action === "mark_unread")
			markRows(rows, action === "mark_read", reselect);
		else if (action === "archive" || action === "trash" || (action === "restore" && inTrash()))
			leave(rows, action, reselect);
		else if (action === "restore") void triage.run("restore", targetsOf(rows), { refreshed });
	};

	const selectedRows = () => loaded().filter((e) => selected().has(e.id));

	/**
	 * Delete forever (S7): only inside Trash, after the confirm that names it; no Undo. The confirm
	 * names only rows the device holds as Trash: there is no Undo, so a row that isn't is never offered.
	 */
	const askDeleteForever = (rows: ConversationSummaryRecord[]) => {
		const trashed = rows.filter((row) => row.mailbox_state === "trash");
		if (trashed.length > 0 && inTrash()) setConfirmingDelete(trashed);
	};
	const deleteForever = async () => {
		const rows = confirmingDelete() ?? [];
		const done = await triage.deleteForever(targetsOf(rows), { refreshed });
		setConfirmingDelete(null);
		if (done) setSelected(new Set<string>());
	};

	// Opening a row that reads as unread marks it read; a read row writes nothing (m2-03: every open
	// POSTed, even an already-read Sent thread). A row that drifted from the server is still covered:
	// the thread marks it once its messages show unread inbound mail. Both share one request
	// (markThreadRead, R3 F2).
	const markRead = (email: ConversationSummaryRecord) => {
		if (!isUnread(email)) return;
		const was = email.thread_unread_count;
		const gen = fetchGen();
		setLoaded((prev) =>
			prev.map((e) =>
				e.id === email.id ? { ...e, read_at: Date.now(), thread_unread_count: 0 } : e,
			),
		);
		actions.adjustUnreadCount(-1, email.category);
		markThreadRead(threadOf(email)).catch(
			failed("mark it read", () => {
				if (fetchGen() !== gen) return;
				setLoaded((prev) =>
					prev.map((e) =>
						e.id === email.id
							? { ...e, read_at: was > 0 ? null : e.read_at, thread_unread_count: was }
							: e,
					),
				);
				actions.adjustUnreadCount(1, email.category);
			}),
		);
	};

	/**
	 * A row opens its conversation (ux-w-p1-2). A row that is only its draft opens the draft's window
	 * instead, unless that draft is already open as a reply (waiting in the dock): it opens under its
	 * thread. Any other draft row brings its draft along as the thread's reply (under it; on a phone
	 * the reply sheet), so the person's message is on screen and Reply doesn't start a second draft.
	 * A hop (Archive's next, Prev/Next, j/k while reading) opens the conversation only, no composer.
	 */
	const open = (email: ConversationSummaryRecord, index: number, hop = false) => {
		setCursor(index);
		const shown = email.display_email_id ?? email.latest_email_id ?? email.id;
		const draft = !hop && email.mailbox_state === "draft";
		const replying = state.composeWindows.some(
			(w) => w.draftId === shown && Boolean(w.replyTo?.conversationId),
		);
		if (draft && draftOnly(email) && !replying) {
			actions.editDraft(shown);
			return;
		}
		// A draft is never the thread's anchor: once it is sent or discarded, a refresh anchored on it
		// would ask for a message that no longer exists (404) and the open thread would stop refreshing.
		actions.selectConversation(email.id, email.mailbox_state === "draft" ? null : shown);
		markRead(email);
		if (draft)
			actions.editDraft(
				shown,
				{ emailId: shown, mode: "reply", conversationId: email.id },
				{ joinThreadReply: true },
			);
	};

	// The thread bar's Prev/Next and Archive's next open through the list, so the row reads as read.
	setListedOpener((id) => {
		const list = emails();
		const index = list.findIndex((e) => e.id === id);
		if (index < 0) return false;
		open(list[index], index, true);
		return true;
	});
	onCleanup(() => setListedOpener(null));

	const toggleSelect = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	// ── Keys (the list's; the thread, compose and global keys live with them) ──

	const scrollToCursor = (index: number) =>
		requestAnimationFrame(() =>
			scrollRef
				?.querySelector(`[data-testid=conversation-row][data-index="${index}"]`)
				?.scrollIntoView({ block: "nearest" }),
		);

	const onKey = (e: KeyboardEvent) => {
		if (notAShortcut(e)) return;
		const list = emails();
		// Reading: the thread's own keys act on it (e, #, U, r, a, f, u, Esc); the list only hops the
		// rail (j/k open the next or previous conversation, L3).
		const hopping = reading();
		const current = hopping
			? list.findIndex((x) => x.id === state.selectedConversationId)
			: cursor();
		const row = current >= 0 ? list[current] : undefined;
		const step = (d: number) => {
			if (list.length === 0) return;
			let next = Math.max(0, Math.min(list.length - 1, current + d));
			if (hopping) {
				// The next conversation: a row that is only its draft is passed (ux-w-p1-2).
				while (list[next] && draftOnly(list[next])) next += d;
				if (list[next] && next !== current) open(list[next], next, true);
				if (next >= list.length - 3) loadMore();
				return;
			}
			setKeyed(true);
			setCursor(next);
			scrollToCursor(next);
		};
		if (hopping && !["j", "k", "ArrowDown", "ArrowUp"].includes(e.key)) return;
		switch (e.key) {
			case "j":
			case "ArrowDown":
				e.preventDefault();
				step(1);
				return;
			case "k":
			case "ArrowUp":
				e.preventDefault();
				step(-1);
				return;
			case "Enter":
			case "o":
				if (e.key === "Enter" && activatesControl(e)) return;
				e.preventDefault();
				if (row) open(row, current);
				return;
			case "x":
				if (!row) return;
				e.preventDefault();
				toggleSelect(row.id);
				return;
			case "e":
				e.preventDefault();
				if (selected().size > 0) runBulk("archive");
				else if (row) moveOut(row, "archive");
				return;
			case "#":
				e.preventDefault();
				// In Trash, # asks before Delete forever (S7).
				if (inTrash()) askDeleteForever(selected().size > 0 ? selectedRows() : row ? [row] : []);
				else if (selected().size > 0) runBulk("trash");
				else if (row) moveOut(row, "trash");
				return;
			case "U":
				if (!row) return;
				e.preventDefault();
				setRead(row, false);
				return;
			case "Escape":
				if (selected().size > 0) {
					e.preventDefault();
					setSelected(new Set<string>());
				}
				return;
		}
	};
	onMount(() => document.addEventListener("keydown", onKey));
	onCleanup(() => document.removeEventListener("keydown", onKey));

	// "You're offline" retries by itself when the connection or the app comes back (m2-11).
	const retryWhenBack = () => {
		if (loadError()?.offline && navigator.onLine && !document.hidden) void fetchRows();
	};
	onMount(() => {
		window.addEventListener("online", retryWhenBack);
		document.addEventListener("visibilitychange", retryWhenBack);
	});
	onCleanup(() => {
		window.removeEventListener("online", retryWhenBack);
		document.removeEventListener("visibilitychange", retryWhenBack);
	});

	// ── Pieces ──

	const title = () => titleOf(state);
	// Needs you: Personal only, never in search; it steps aside while rows are selected (r1 S7).
	const showNeedsYou = () => view() === "personal" && !state.searchQuery && selected().size === 0;
	const emptyText = () => {
		if (state.activeMailbox === "draft") return "No drafts.";
		if (state.activeMailbox === "trash") return "Trash is empty.";
		const person = levelViewPerson(state.levelView);
		if (person) return `No mail for ${person}.`;
		return "No conversations here.";
	};
	// ── Search (r2 S4): what ran, its state, the other pill's request, the account ──

	/** The server's account of this search (it trims the query), or null before it answered. */
	const searchInfoNow = () => {
		const info = searchInfo();
		const query = state.searchQuery.trim();
		return info && (info.query === query || info.corrected_from === query) ? info : null;
	};
	/** Offline, a refused query and a server failure each say so; none of them is "0 results". */
	const searchStatus = (): SearchStatus => {
		const error = loadError();
		if (error) return error.offline ? "offline" : error.message ? "rejected" : "error";
		return loading() ? "loading" : "answered";
	};
	const searchFiltersFor = (scope: SearchScope): EmailFilters => {
		const filters = buildFilters({ offset: 0 });
		if (scope === "view") filters.scope = "view";
		else delete filters.scope;
		return filters;
	};
	/** The view's pill: only when the open view narrows anything (not from All mail). */
	const searchViewLabel = () => (viewNarrowsSearch(searchFiltersFor("view")) ? title() : null);
	const otherSearchFilters = () =>
		searchViewLabel() ? searchFiltersFor(state.searchScope === "view" ? "all" : "view") : null;
	/** The account searched: its one address on that domain when there is one, else the domain. */
	const searchAccount = () => {
		const domain = state.activeDomain?.toLowerCase();
		if (!domain) return "all accounts";
		const mine = (state.meta?.allowed_senders ?? []).filter((address) =>
			address.toLowerCase().endsWith(`@${domain}`),
		);
		return mine.length === 1 ? mine[0] : domain;
	};
	const vendorHeader = (index: number) => {
		if (state.levelView !== "money" || state.searchQuery) return null;
		const list = emails();
		const vendor = vendorOf(list[index]);
		if (index > 0 && vendorOf(list[index - 1]).toLowerCase() === vendor.toLowerCase()) return null;
		const count = list.filter((e) => vendorOf(e).toLowerCase() === vendor.toLowerCase()).length;
		return `${vendor} · ${count}`;
	};

	/** The phone's account line under the title (WM2): it opens the Account sheet (WM3). */
	const accountLine = () => {
		const domain = state.activeDomain;
		if (!domain) return "All accounts";
		return accountsOf(state.meta).find((a) => a.value === domain)?.label ?? domain;
	};

	/** The rail's title: the view, or the search as typed. */
	const railTitle = () => (state.searchQuery ? `“${state.searchQuery.trim()}”` : title());

	return (
		<div
			ref={scrollRef}
			data-testid="conversation-list"
			class="h-full min-h-0 flex-1 overflow-y-auto overscroll-contain"
			classList={{ "px-5 pb-10": !phone(), "px-1 pb-6": phone() }}
			onScroll={() => {
				nearEnd();
				noteTopRow();
				if ((scrollRef?.scrollTop ?? 0) < 50 && newCount() > 0) setNewCount(0);
			}}
		>
			<Switch>
				<Match when={selected().size > 0}>
					<div
						data-testid="bulk-bar"
						class="sticky top-0 z-3 flex flex-wrap items-center gap-2 border-0 border-b border-solid border-rule bg-sheet px-2 pb-3 pt-4"
					>
						<b class="mr-1.5 whitespace-nowrap">{selected().size} selected</b>
						{/* S7: in Trash, Restore takes Archive's place and Delete forever Trash's. */}
						<button
							type="button"
							class="mc-soft"
							onClick={() => runBulk(inTrash() ? "restore" : "archive")}
						>
							{inTrash() ? "Restore" : "Archive"}
						</button>
						<button type="button" class="mc-soft" onClick={() => runBulk("mark_read")}>
							Mark read
						</button>
						<button type="button" class="mc-soft" onClick={() => runBulk("mark_unread")}>
							Mark unread
						</button>
						<span class="flex-1" />
						<Show
							when={inTrash()}
							fallback={
								<button type="button" class="mc-quiet !text-neg" onClick={() => runBulk("trash")}>
									Trash
								</button>
							}
						>
							<button
								type="button"
								class="mc-quiet !text-neg"
								onClick={() => askDeleteForever(selectedRows())}
							>
								Delete forever
							</button>
						</Show>
						<button type="button" class="mc-quiet" onClick={() => setSelected(new Set<string>())}>
							Clear
						</button>
					</div>
				</Match>
				<Match when={state.searchQuery}>
					{/* What ran and where (r2 S4): the query as typed, the scope pills with counts once
					    answered, one note; offline or a failure is never "0 results" (WD-11/12). */}
					<SearchHeader
						query={state.searchQuery}
						info={searchInfoNow()}
						status={searchStatus()}
						reason={loadError()?.message ?? null}
						scope={state.searchScope}
						viewLabel={searchViewLabel()}
						rows={emails().length}
						hasMore={hasMore()}
						otherFilters={otherSearchFilters()}
						account={searchAccount()}
						onScope={(scope) => actions.setSearchScope(scope)}
						onSearch={(query) => actions.setSearch(query)}
						onRetry={() => void fetchRows()}
						onClear={() => {
							actions.setSearch("");
							actions.setSearchOpen(false);
						}}
					/>
				</Match>
				<Match when={true}>
					<div
						data-testid="list-head"
						class="relative"
						classList={{
							"px-2 pb-3 pt-[22px] text-[22px]": !phone(),
							"px-3.5 pb-2.5 pt-7": phone(),
						}}
					>
						<ViewTitle title={title()} asMenu={titleIsMenu()} current={view()} large={phone()} />
						<Show when={phone()}>
							<button
								type="button"
								data-testid="account-switch"
								aria-haspopup="dialog"
								class="-ml-0.5 mt-0.5 flex w-fit items-center py-1 text-[17px] text-muted"
								onClick={() => setAccountSheetOpen(true)}
							>
								{accountLine()}
								<span class="mc-caret" aria-hidden="true" />
							</button>
						</Show>
					</div>
				</Match>
			</Switch>

			<Show when={showNeedsYou()}>
				<div class="mb-1" classList={{ "-mx-1": phone() }}>
					<NeedsYouLine />
				</div>
			</Show>

			<Show when={newCount() > 0 && !state.searchQuery}>
				<button
					type="button"
					class="mc-soft mx-auto my-2 block text-[13px]"
					onClick={() => {
						scrollRef?.scrollTo({ top: 0, behavior: "smooth" });
						setNewCount(0);
					}}
				>
					{newCount() === 1 ? "1 new conversation" : `${newCount()} new conversations`}
				</button>
			</Show>

			{/* Rows on screen, the network failed: they may be stale, so say so. */}
			<Show when={loadError() && emails().length > 0 && !state.searchQuery}>
				<p class="mx-2 my-2 flex flex-wrap items-baseline gap-2 rounded-box bg-warn-soft px-3.5 py-2.5">
					<span class="font-medium">
						{loadError()?.offline
							? "You're offline, so this may not be up to date."
							: "Couldn't load new messages."}
					</span>
					<button
						type="button"
						class="font-medium text-accent hover:underline"
						onClick={() => void fetchRows()}
					>
						Try again
					</button>
				</p>
			</Show>

			<Switch>
				{/* A new view or search with nothing of its own yet shows the skeleton, never the previous
				    list under its title (S4, P1-4). */}
				<Match when={loading()}>
					<ul class="list-none" aria-busy="true" aria-label="Loading">
						<For each={Array.from({ length: 12 }, (_, i) => i)}>
							{(i) => (
								<li
									data-testid="skeleton-row"
									class="grid items-center gap-x-3 pl-2 pr-3"
									classList={{
										"h-11 grid-cols-[20px_196px_minmax(0,1fr)_auto]": !phone(),
										"grid-cols-[16px_minmax(0,1fr)] gap-y-2 py-3.5": phone(),
									}}
								>
									<span />
									<span class="mc-skeleton" style={{ width: `${90 + ((i * 29) % 70)}px` }} />
									<span class="mc-skeleton" style={{ width: `${45 + ((i * 17) % 40)}%` }} />
									<Show when={!phone()}>
										<span class="mc-skeleton w-[52px]" />
									</Show>
								</li>
							)}
						</For>
					</ul>
				</Match>
				{/* A search's header says offline, refused, failed and no results itself. */}
				<Match when={emails().length === 0 && state.searchQuery}>{null}</Match>
				<Match when={emails().length === 0 && loadError()}>
					{/* A failed load is an error with a way forward, never an empty view (WD-11). */}
					<div class="px-4 py-14 text-center">
						<p class="font-medium">
							{loadError()?.offline
								? "You're offline, so this view couldn't load."
								: "Couldn't load this view."}
						</p>
						<Show when={!loadError()?.offline && loadError()?.message}>
							<p class="mt-1.5 text-muted">{loadError()?.message}</p>
						</Show>
						<button
							type="button"
							class="mt-4 font-medium text-accent hover:underline"
							onClick={() => void fetchRows()}
						>
							Try again
						</button>
					</div>
				</Match>
				<Match when={emails().length === 0}>
					<p class="px-4 py-14 text-center">{emptyText()}</p>
				</Match>
				<Match when={true}>
					<ul
						class="mc-rows list-none transition-opacity"
						classList={{ "opacity-60": awaitingNetwork() }}
						aria-busy={awaitingNetwork()}
						data-selecting={selected().size > 0 ? "true" : "false"}
						data-phone={phone() || twoLine() ? "true" : "false"}
					>
						<For each={emails()}>
							{(email, index) => (
								<>
									<Show when={vendorHeader(index())}>
										{(label) => (
											<li class="px-2.5 pb-1 pt-4 text-[12.5px] font-semibold text-muted">
												{label()}
											</li>
										)}
									</Show>
									<ConversationRow
										email={email}
										index={index()}
										phone={phone()}
										twoLine={twoLine()}
										selected={selected().has(email.id)}
										selecting={selected().size > 0}
										cursor={keyed() && cursor() === index()}
										inTrash={email.mailbox_state === "trash"}
										onOpen={() => open(email, index())}
										onToggleSelect={() => toggleSelect(email.id)}
										onArchive={() => moveOut(email, "archive")}
										onToggleRead={() => setRead(email, isUnread(email))}
										onTrash={() => moveOut(email, "trash")}
										onRestore={() => restore(email)}
										onDeleteForever={() => askDeleteForever([email])}
										onHoverIntent={() => prefetch(email.id)}
										where={state.searchQuery ? searchWhere(email) : undefined}
										searching={Boolean(state.searchQuery)}
									/>
								</>
							)}
						</For>
					</ul>
					<Show when={loadingMore()}>
						<p class="py-4 text-center text-[13px] text-muted">Loading more…</p>
					</Show>
					<Show when={!hasMore() && !loadingMore() && total() > PAGE && isOnline()}>
						<p class="py-6 text-center text-[13px] text-muted">That's everything here.</p>
					</Show>
				</Match>
			</Switch>
			<Show when={confirmingDelete()}>
				{(rows) => (
					<DeleteForever
						targets={targetsOf(rows())}
						onCancel={() => setConfirmingDelete(null)}
						onConfirm={deleteForever}
					/>
				)}
			</Show>
			{/* Reading (desktop): the list folds into the column as the rail. */}
			<Show when={reading() && !phone() && railSlot()}>
				{(slot) => (
					<Portal
						mount={slot()}
						ref={(el: HTMLDivElement) => {
							el.style.display = "contents";
						}}
					>
						<Rail
							rows={emails()}
							openId={state.selectedConversationId}
							title={railTitle()}
							views={viewItems()}
							currentView={state.searchQuery ? null : view()}
							onView={(v) => actions.setView(v as ViewId)}
							onOpen={(row, index) => open(row, index)}
							onNearEnd={loadMore}
						/>
					</Portal>
				)}
			</Show>
		</div>
	);
};

export default ConversationList;
