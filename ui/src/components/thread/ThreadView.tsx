import "./thread.css";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
	untrack,
} from "solid-js";
import { ApiHttpError, ApiNetworkError } from "../../api/client";
import {
	detailAskedAt,
	detailNumber,
	draftLetGo,
	forgetConversationDetail,
	getConversationDetailCached,
	markThreadRead,
	threadLetGo,
} from "../../lib/cache";
import { type ConversationSummaryRecord, getCachedConversationSummary } from "../../lib/db";
import { useDialogFocus } from "../../lib/dialog";
import { endsComposition, notAShortcut } from "../../lib/shortcuts";
import { earlierConversation } from "../../lib/thread-link";
import {
	type ListedConversation,
	listedConversations,
	listedHasMore,
	nextAfter,
	openListed,
	type TriageAction,
	type TriageTarget,
	useTriage,
} from "../../lib/triage";
import { useApp, viewIdOf, viewTitle } from "../../store/app";
import { columnFits, isMobile } from "../../store/responsive";
import type {
	ConversationDetailResponse,
	ConversationSummary,
	Email,
	MailboxState,
} from "../../types";
import {
	firstLine,
	isBulk,
	People,
	shortDate,
	type TimelineItem,
	timelinePlan,
} from "../../utils/thread-text";
import InlineComposerSlot, {
	inlineComposerOpenFor,
	setReplyWindowThread,
} from "../compose/InlineComposerSlot";
import Menu, { MenuAction } from "../Menu";
import NewsletterReader from "../NewsletterReader";
import DeleteForever from "../triage/DeleteForever";
import MessageBox, { canShowOriginal, originalShown, toggleOriginal } from "./MessageBox";
import MessageStack from "./MessageStack";

interface ThreadViewProps {
	conversationId: string;
	emailId?: string | null;
	onClose: () => void;
}

const itemKey = (item: TimelineItem) =>
	item.kind === "stack" ? `stack:${item.key}` : `message:${item.email.id}`;

/**
 * The thread's answer holds its drafts too (the apps read them; the newest is the thread's latest).
 * A draft is never a message here (ux-w-p0-1): it is its composer, or one item marked Draft, drawn
 * only from an answer asked after a window last let go of it (lib/cache: noteDraftLetGo).
 */
const isDraft = (email: Email) => email.mailbox_state === "draft";
const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
	a.size === b.size && [...a].every((id) => b.has(id));

const whenIdle = (task: () => void) => {
	const idle = (
		window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
	).requestIdleCallback;
	if (idle) idle(task, { timeout: 250 });
	else setTimeout(task, 32);
};

/**
 * The thread (round-2 S2, L3): a centred 760 reading column whose bar (‹ Personal, Archive, Mark
 * unread, Trash in red and apart, More, Reply) shares its edges with the subject and the messages.
 * Every message is a bordered box; a split-off earlier conversation folds into one stack at the top;
 * more than four messages show the first, a stack of the middle and the last three, the latest open.
 * Each action is said once (design-taste X4, thread direction A): Reply is the one filled control and
 * Reply all and Forward are in More, so nothing repeats under the messages. Phone: Back alone at the
 * top, and Archive · Reply · More at the bottom, More a sheet (WM4). Offline and not downloaded, it
 * keeps what it knows.
 */
const ThreadView: Component<ThreadViewProps> = (props) => {
	const [state, actions] = useApp();
	const [conversation, setConversation] = createSignal<ConversationSummary | null>(null);
	/** This thread's messages, oldest first; its drafts are apart (`drafts`). */
	const [own, setOwn] = createSignal<Email[]>([]);
	const [drafts, setDrafts] = createSignal<Email[]>([]);
	/** The number (lib/cache: detailNumber) of the answer `drafts` came from. */
	const [draftsAsked, setDraftsAsked] = createSignal(0);
	/** The number of the answer `own` came from: an answer asked earlier never replaces it (D24),
	 *  unless `own` holds only part of the thread and that answer holds all of it (build 13 review). */
	const [ownAsked, setOwnAsked] = createSignal(0);
	const [ownPartial, setOwnPartial] = createSignal(false);
	const partial = (detail: ConversationDetailResponse) => (detail.remaining_email_count ?? 0) > 0;
	const takesOwn = (detail: ConversationDetailResponse) =>
		detailNumber(detail) >= ownAsked() || (ownPartial() && !partial(detail));
	const [earlier, setEarlier] = createSignal<Email[]>([]);
	const [focusId, setFocusId] = createSignal<string | null>(null);
	const [loadingRest, setLoadingRest] = createSignal(false);
	const [failure, setFailure] = createSignal<"offline" | "error" | null>(null);
	const [lastKnown, setLastKnown] = createSignal<ConversationSummaryRecord | null>(null);
	const [openStacks, setOpenStacks] = createSignal<ReadonlySet<string>>(new Set());
	const [toggled, setToggled] = createSignal<ReadonlyMap<string, boolean>>(new Map());
	const [markedUnread, setMarkedUnread] = createSignal(false);
	let generation = 0;
	let scrolledFor: string | null = null;
	onCleanup(() => {
		generation++;
	});

	const sorted = (emails: Email[]) => [...emails].sort((a, b) => a.received_at - b.received_at);

	/** The fresh answer, keeping the object of every email that did not change. */
	const keepUnchanged = (current: Email[], fresh: Email[]) => {
		const held = new Map(current.map((e) => [e.id, e]));
		return sorted(fresh).map((e) => {
			const old = held.get(e.id);
			return old && JSON.stringify(old) === JSON.stringify(e) ? old : e;
		});
	};
	/** This answer's drafts, unless the ones known came from an answer asked later (D18). */
	const takeDrafts = (detail: ConversationDetailResponse) => {
		const asked = detailNumber(detail);
		if (asked < draftsAsked()) return;
		setDraftsAsked(asked);
		setDrafts(keepUnchanged(drafts(), detail.emails.filter(isDraft)));
	};

	const show = (detail: ConversationDetailResponse) => {
		if (takesOwn(detail)) {
			setOwnAsked(Math.max(ownAsked(), detailNumber(detail)));
			setOwnPartial(partial(detail));
			setConversation(detail.conversation);
			setOwn(sorted(detail.emails.filter((e) => !isDraft(e))));
		}
		takeDrafts(detail);
		setFailure(null);
	};

	const load = async (id: string, anchor: string | null) => {
		const gen = ++generation;
		setFailure(null);
		let first: ConversationDetailResponse;
		try {
			first = await getConversationDetailCached(id, { emailId: anchor, load: "anchor" });
		} catch (error) {
			if (gen !== generation) return;
			// A dead link (deleted, another account's, a typo) goes back to the list and says so;
			// anything else stays here with what this device last knew.
			if (error instanceof ApiHttpError && (error.status === 404 || error.status === 403)) {
				queueMicrotask(() => {
					actions.selectConversation(null);
					actions.showToast("That conversation is no longer available", "error");
				});
				return;
			}
			setFailure(error instanceof ApiNetworkError ? "offline" : "error");
			const known = await getCachedConversationSummary(id).catch(() => undefined);
			if (gen === generation) setLastKnown(known ?? null);
			return;
		}
		if (gen !== generation) return;
		show(first);
		const resolved = first.conversation.id;
		// A draft is never the anchor (the server's default is the newest message, often a draft).
		const anchorId =
			[first.anchor_email_id, first.emails.at(-1)?.id].find(
				(candidate) => candidate && !first.emails.some((e) => e.id === candidate && isDraft(e)),
			) ?? null;
		setFocusId(anchorId);
		if (resolved !== id || (anchorId && anchorId !== anchor)) {
			queueMicrotask(() => actions.selectConversation(resolved, anchorId));
		}
		// The list marks a row it showed unread; this covers a row that drifted from the server. Both
		// go through markThreadRead: one POST per unread seen (m2-03, R3 F2).
		if (
			first.conversation.unread_count > 0 ||
			first.emails.some((e) => e.direction === "inbound" && !e.read_at)
		) {
			whenIdle(() => void markThreadRead(resolved, detailAskedAt(first)).catch(() => {}));
		}

		let full = first;
		const remaining =
			first.remaining_email_count ?? first.conversation.message_count - first.emails.length;
		if (remaining > 0) {
			setLoadingRest(true);
			try {
				full = await getConversationDetailCached(id, { emailId: anchor, load: "full" });
				if (gen !== generation) return;
				show(full);
			} catch {
				if (gen === generation)
					actions.showToast("Some messages in this thread could not be loaded", "info");
				return;
			} finally {
				if (gen === generation) setLoadingRest(false);
			}
		}
		if (gen !== generation) return;
		const before = await earlierConversation(full, state.meta?.allowed_senders ?? []);
		if (gen === generation) setEarlier(before.filter((e) => !isDraft(e)));
	};

	// One load per conversation; a new message id from the URL (the canonical anchor) is not a reload.
	createEffect(
		on(
			() => props.conversationId,
			(id) => {
				setConversation(null);
				setOwn([]);
				setDrafts([]);
				setDraftsAsked(0);
				setOwnAsked(0);
				setOwnPartial(false);
				setEarlier([]);
				setOpenStacks(new Set<string>());
				setToggled(new Map<string, boolean>());
				setMarkedUnread(false);
				setLastKnown(null);
				scrolledFor = null;
				void load(
					id,
					untrack(() => props.emailId ?? null),
				);
			},
		),
	);

	const retry = () => void load(props.conversationId, props.emailId ?? null);
	const retryWhenOnline = () => {
		if (failure() === "offline") retry();
	};
	onMount(() => window.addEventListener("online", retryWhenOnline));
	onCleanup(() => window.removeEventListener("online", retryWhenOnline));

	const people = createMemo(
		() =>
			new People(
				[...earlier(), ...own()],
				state.meta?.allowed_senders ?? [],
				conversation()?.participants ?? [],
			),
	);
	const latest = () => own().at(-1) ?? null;
	const plan = createMemo(() => timelinePlan(own(), earlier(), openStacks()));
	const items = createMemo(() => new Map(plan().map((item) => [itemKey(item), item])));
	const keys = createMemo(() => plan().map(itemKey));
	// A lone bulk message: the conversation has one message, not just one loaded so far (a long
	// thread paints its anchor first; it must not flash as a newsletter and send its reply to the dock).
	const singleBulk = () =>
		own().length === 1 &&
		(conversation()?.message_count ?? 1) <= 1 &&
		earlier().length === 0 &&
		isBulk(own()[0], conversation()?.category);
	const newsletter = () => (singleBulk() ? own()[0] : null);
	// The newsletter reader has no reply slot: once it is on screen, a reply to it is a window.
	createEffect(() => setReplyWindowThread(newsletter() ? props.conversationId : null));
	onCleanup(() => setReplyWindowThread(null));

	// A message opened from search or a note (not the latest) is open too, its stack unfolded.
	createEffect(() => {
		const focus = focusId();
		if (!focus || focus === latest()?.id) return;
		for (const item of untrack(plan)) {
			if (item.kind === "stack" && item.emails.some((e) => e.id === focus)) {
				setOpenStacks((open) => new Set([...open, item.key]));
			}
		}
	});
	const isOpen = (email: Email) =>
		toggled().get(email.id) ??
		(email.id === latest()?.id || (email.id === focusId() && !!focusId()));
	const toggle = (email: Email) => setToggled((map) => new Map(map).set(email.id, !isOpen(email)));
	const unfold = (stack: string) => setOpenStacks((open) => new Set([...open, stack]));

	// Once the whole thread is in: bring the focused message on screen if it is below the fold.
	createEffect(() => {
		const target = focusId() ?? latest()?.id;
		if (loadingRest() || !target || scrolledFor === props.conversationId || own().length < 2)
			return;
		scrolledFor = props.conversationId;
		requestAnimationFrame(() => {
			const el = document.querySelector<HTMLElement>(
				`[data-testid="message-box"][data-email-id="${CSS.escape(target)}"]`,
			);
			if (el && el.getBoundingClientRect().top > window.innerHeight - 160)
				el.scrollIntoView({ block: "start" });
		});
	});

	// Back in the foreground (and on the 2-minute tick) the open conversation is asked again:
	// another tab or device may have archived or trashed it (d1-04: it still offered Archive), and
	// its messages may have changed or grown (R3 F6). A message that did not change keeps its
	// object, so its box is not drawn again; what the person opened or collapsed stays so, a new
	// reply comes in open, and the message at the top of the screen stays where it was (R2-1, R2-2).
	const messageBox = (id: string) =>
		document.querySelector<HTMLElement>(
			`[data-testid="message-box"][data-email-id="${CSS.escape(id)}"]`,
		);
	/** The first message on screen, the element scrolling it, and its top on screen. */
	const readingPlace = () => {
		const boxes = [
			...document.querySelectorAll<HTMLElement>(
				'[data-testid="thread-view"] [data-testid="message-box"]',
			),
		];
		let scroller = boxes[0]?.parentElement ?? null;
		while (
			scroller &&
			!(
				scroller.scrollHeight > scroller.clientHeight &&
				/auto|scroll/.test(getComputedStyle(scroller).overflowY)
			)
		) {
			scroller = scroller.parentElement;
		}
		const target = scroller ?? document.scrollingElement;
		const screenTop = scroller ? scroller.getBoundingClientRect().top : 0;
		const first = boxes.find((el) => el.getBoundingClientRect().bottom > screenTop);
		const id = first?.dataset.emailId;
		if (!first || !id || !target) return null;
		return { id, top: first.getBoundingClientRect().top, scroller: target };
	};
	const applyFresh = (detail: ConversationDetailResponse) => {
		if (detail.conversation.id !== conversation()?.id) return;
		takeDrafts(detail);
		if (!takesOwn(detail)) return;
		setOwnAsked(Math.max(ownAsked(), detailNumber(detail)));
		setOwnPartial(partial(detail));
		setConversation(detail.conversation);
		const current = own();
		const next = keepUnchanged(
			current,
			detail.emails.filter((e) => !isDraft(e)),
		);
		if (next.length === current.length && next.every((e, i) => e === current[i])) return;
		// What is open stays open: the latest stops being the latest when a reply arrives.
		setToggled((map) => {
			const pinned = new Map(map);
			for (const e of current) if (!pinned.has(e.id)) pinned.set(e.id, isOpen(e));
			return pinned;
		});
		const place = readingPlace();
		setOwn(next);
		const el = place && messageBox(place.id);
		if (place && el) place.scroller.scrollTop += el.getBoundingClientRect().top - place.top;
	};
	/** This conversation asked again (a new read) and applied. Still loading (or not downloaded):
	 *  the load in flight, or Try again, answers, unless it was asked too early (D20). */
	const askAgain = async (evenWhileLoading = false) => {
		if (!conversation() || (loadingRest() && !evenWhileLoading)) return;
		const id = props.conversationId;
		// A draft is never the anchor: one sent or discarded since would make the thread a 404.
		const anchor =
			props.emailId && !drafts().some((d) => d.id === props.emailId) ? props.emailId : null;
		const gen = generation;
		forgetConversationDetail(id);
		const whole = loadingRest() || own().length + drafts().length > 1;
		const detail = await getConversationDetailCached(id, {
			emailId: anchor,
			load: whole ? "full" : "anchor",
		});
		if (gen !== generation) return;
		const more = !whole && (detail.remaining_email_count ?? 0) > 0;
		const fresh = more
			? await getConversationDetailCached(id, { emailId: anchor, load: "full" })
			: detail;
		if (gen === generation) applyFresh(fresh);
	};
	createEffect(
		on(
			() => state.freshnessVersion,
			() => void askAgain().catch(() => {}),
			{ defer: true },
		),
	);

	/* ── Drafts (ux-w-p0-1): a draft is its composer while a window holds it, else one Draft item. ── */

	const heldDrafts = createMemo<ReadonlySet<string>>(
		() => new Set(state.composeWindows.flatMap((w) => (w.draftId ? [w.draftId] : []))),
		new Set<string>(),
		{ equals: sameIds },
	);
	// What is known of a draft from an answer asked before a window let go of it (sent, discarded,
	// closed) is not drawn (D07, D08, D17), and this thread is asked again, loading or not, as it is
	// when a reply here let go of a draft the answer may not hold (D09, D18, D20). The let-go is
	// noted by the store as it happens (D21), so a thread opened later asks too. A number per let-go:
	// another one while an ask is on its way asks once more (D22). No answer (offline): not drawn.
	const behind = createMemo(() => {
		const asked = draftsAsked();
		if (!conversation()) return 0;
		const held = heldDrafts();
		const last = Math.max(
			threadLetGo(props.conversationId),
			...drafts()
				.filter((d) => !held.has(d.id))
				.map((d) => draftLetGo(d.id)),
		);
		return last >= asked ? last : 0;
	});
	createEffect(
		on(behind, (last) => {
			if (last > 0) void askAgain(true).catch(() => {});
		}),
	);
	const draftItems = () =>
		drafts().filter((d) => !heldDrafts().has(d.id) && draftLetGo(d.id) < draftsAsked());
	/** A Draft item opens its composer with the saved words: under the thread, as a reply. */
	const openDraft = (draft: Email) => {
		const answered =
			own().find((e) => e.message_id && e.message_id === draft.in_reply_to) ?? replyTarget();
		const mode = !draft.in_reply_to
			? "forward"
			: draft.cc_addresses.length > 0
				? "reply-all"
				: "reply";
		actions.editDraft(
			draft.id,
			answered ? { emailId: answered.id, mode, conversationId: props.conversationId } : null,
		);
	};

	/* ── Actions: the server first; a failure says so and changes nothing here (no offline queue). ── */

	const isTrashed = () =>
		(state.activeMailbox === "trash" && !state.searchQuery) ||
		conversation()?.mailbox_state === "trash";
	const isArchived = () => !isTrashed() && conversation()?.mailbox_state === "archived";
	const conversationKey = () => conversation()?.id ?? props.conversationId;

	// Triage from the thread bar (S7, lib/triage.ts): server first, one toast with Undo and z.
	const triage = useTriage();
	const [confirmingDelete, setConfirmingDelete] = createSignal(false);
	createEffect(
		on(
			() => props.conversationId,
			() => setConfirmingDelete(false),
			{ defer: true },
		),
	);
	const target = (): TriageTarget => ({
		id: conversationKey(),
		subject: conversation()?.subject ?? latest()?.subject ?? null,
		unread: markedUnread(),
	});
	/** The conversation that takes this one's place in the list opens (the rail's next hop). */
	const advance = (next: ReturnType<typeof nextAfter>) => {
		if (!next) props.onClose();
		else if (!openListed(next.id)) actions.selectConversation(next.id, next.emailId);
	};

	/** Where this conversation sits in the list ("4 of 25"), shown only with the column hidden. */
	const position = createMemo(() => {
		const rows = listedConversations();
		const index = rows.findIndex((row) => row.id === props.conversationId);
		return index < 0 ? null : { index, count: rows.length, more: listedHasMore() };
	});
	const showPosition = () =>
		!(state.sidebarShown && columnFits()) && !isMobile() && position() !== null;
	const hop = (by: number) => {
		const at = position();
		const row = at ? listedConversations()[at.index + by] : undefined;
		if (row && !openListed(row.id)) actions.selectConversation(row.id, row.emailId);
	};

	/** Archive or Trash (Restore inside Trash) leaves the list: the next conversation opens at once;
	 *  refused, this one opens again and the toast says what didn't happen. */
	const move = (action: "archive" | "trash" | "restore", undoAs?: TriageAction) => {
		const id = props.conversationId;
		const anchor = props.emailId ?? undefined;
		const next = nextAfter(id);
		void triage.run(action, [target()], {
			leaves: true,
			undoAs,
			shown: () => {
				advance(next);
				return () => actions.selectConversation(id, anchor);
			},
			refreshed: () => actions.refresh(),
		});
	};

	const showMailbox = (id: string, mailbox: MailboxState) => {
		if (props.conversationId === id)
			setConversation((c) => (c ? { ...c, mailbox_state: mailbox } : c));
	};
	/** Archived (d1-04): Move to Inbox, and its Undo puts it back in Archive. From the Archive view it
	 *  leaves the list (the next conversation opens, as Archive does); anywhere else it stays open. */
	const moveToInbox = () => {
		if (state.activeMailbox === "archived" && !state.searchQuery) {
			move("restore", "archive");
			return;
		}
		const id = props.conversationId;
		void triage.run("restore", [target()], {
			undoAs: "archive",
			shown: () => {
				showMailbox(id, "inbox");
				return () => showMailbox(id, "archived");
			},
			undone: () => showMailbox(id, "archived"),
			refreshed: () => actions.refresh(),
		});
	};

	const toggleRead = () => {
		const id = props.conversationId;
		const wasUnread = markedUnread();
		const showAgain = () => {
			if (props.conversationId === id) setMarkedUnread(wasUnread);
		};
		void triage.run(wasUnread ? "mark_read" : "mark_unread", [target()], {
			shown: () => {
				setMarkedUnread(!wasUnread);
				return showAgain;
			},
			undone: showAgain,
			refreshed: () => actions.refresh(),
		});
	};

	/** Inside Trash only, after the confirm (S7): no Undo. */
	const deleteForever = async () => {
		const next = nextAfter(props.conversationId);
		const done = await triage.deleteForever([target()], { refreshed: () => actions.refresh() });
		setConfirmingDelete(false);
		if (done) advance(next);
	};

	/** Reply goes to the latest message not from me, else the latest. */
	const replyTarget = () => {
		const list = own();
		return [...list].reverse().find((e) => !people().isMe(e.from_address)) ?? list.at(-1) ?? null;
	};
	const compose = (mode: "reply" | "reply-all" | "forward") => {
		const target = mode === "forward" ? latest() : replyTarget();
		if (target)
			actions.openCompose({ emailId: target.id, mode, conversationId: props.conversationId });
	};
	// S5: the reply is written under the thread; the end-of-thread row comes back after.
	const timelineIds = createMemo(() => [...earlier(), ...own()].map((e) => e.id));
	const composingHere = () => inlineComposerOpenFor(props.conversationId, timelineIds());

	const handleKey = (event: KeyboardEvent) => {
		if (notAShortcut(event)) return;
		// Escape closes one thing per press: an IME's Escape is the composition's (R3 F3), a held key
		// repeats (F5), and one a composer (or a dialog) already took is not the thread's (d1-22).
		if (
			event.key === "Escape" &&
			(endsComposition(event) ||
				event.repeat ||
				event.defaultPrevented ||
				(event.target as Element | null)?.closest?.("[data-compose-window-id]"))
		)
			return;
		const run: Record<string, () => void> = {
			Escape: props.onClose,
			u: props.onClose,
			// Triage (S7): e does nothing in Trash or on an archived conversation; # in Trash asks
			// before Delete forever; z (Undo) is the toast's.
			e: () => {
				if (!isTrashed() && !isArchived()) move("archive");
			},
			"#": () => (isTrashed() ? setConfirmingDelete(true) : move("trash")),
			U: () => {
				if (!markedUnread()) toggleRead();
			},
			r: () => compose("reply"),
			a: () => compose("reply-all"),
			A: () => compose("reply-all"),
			f: () => compose("forward"),
		};
		const action = run[event.key];
		if (!action) return;
		event.preventDefault();
		action();
	};
	onMount(() => document.addEventListener("keydown", handleKey));
	onCleanup(() => document.removeEventListener("keydown", handleKey));

	const backLabel = () => {
		if (state.searchQuery.trim()) return "Results";
		if (state.levelView === "money") return "Money";
		if (state.levelView?.startsWith("person:")) return state.levelView.slice("person:".length);
		if (state.activeCategory === "personal" || state.activeCategory === "notifications")
			return viewTitle(viewIdOf(state));
		const views: Record<string, string> = {
			all: "All mail",
			inbox: "Inbox",
			sent: "Sent",
			draft: "Drafts",
			archived: "Archive",
			trash: "Trash",
		};
		return views[state.activeMailbox] ?? "Back";
	};

	const subject = () =>
		conversation()?.subject || lastKnown()?.subject || latest()?.subject || "(no subject)";
	const readLabel = () => (markedUnread() ? "Mark read" : "Mark unread");

	const phone = () => isMobile();
	/** A composer on this screen is in front (New message, or this thread's reply): its Send is filled. */
	const composerInFront = () => {
		const w = state.composeWindows.find((c) => c.id === state.focusedComposeWindowId);
		return Boolean(
			w && !w.minimized && (!w.replyTo || w.replyTo.conversationId === props.conversationId),
		);
	};
	// One filled button per screen (L3, X3): Reply, or Archive on a lone newsletter (no Reply there);
	// either steps down to a word while a composer is in front. Everything else is a word in ink.
	const filled = (on: boolean) =>
		on && !composingHere() && !composerInFront() ? "mc-primary" : "mc-word";
	const replyClass = () => `${filled(true)} shrink-0`;
	const archiveClass = () => `${filled(singleBulk() && !isTrashed())} shrink-0`;
	const [moreOpen, setMoreOpen] = createSignal(false);
	createEffect(
		on(
			() => props.conversationId,
			() => setMoreOpen(false),
			{ defer: true },
		),
	);
	let moreButton: HTMLButtonElement | undefined;
	/** Close More, then act. */
	const fromMore = (act: () => void) => () => {
		setMoreOpen(false);
		act();
	};
	/** The phone's More offers the latest message's original HTML (its body has no link for it). */
	const originalTarget = () => {
		const email = latest();
		return email && canShowOriginal(email, conversation()?.category ?? null) ? email : null;
	};
	const archiveLabel = () => (isTrashed() ? "Restore" : isArchived() ? "Move to Inbox" : "Archive");
	const archive = () =>
		isTrashed() ? move("restore") : isArchived() ? moveToInbox() : move("archive");
	const trash = () => (isTrashed() ? setConfirmingDelete(true) : move("trash"));
	/**
	 * Phone: what follows this conversation in the list (the rail's one hop). Nothing is said when
	 * it isn't in the list (a link, a notification) or when the list's next page hasn't loaded.
	 */
	const following = (): { next: ListedConversation | null } | null => {
		const at = position();
		if (!at) return null;
		const next = listedConversations()[at.index + 1] ?? null;
		return next || !at.more ? { next } : null;
	};

	return (
		<div data-testid="thread-view" class="mc-thread min-h-full bg-sheet text-text text-[14px]">
			<div
				data-testid="reading-column"
				class="w-full"
				classList={{ "mx-auto max-w-[824px] px-8 pb-24": !phone(), "pb-24": phone() }}
			>
				<div
					data-testid="thread-bar"
					class="sticky top-0 z-10 flex shrink-0 items-center bg-sheet"
					classList={{
						"h-[60px] gap-1 mb-5 border-0 border-b border-solid border-rule": !phone(),
						"min-h-14 px-2 py-2": phone(),
					}}
				>
					<button
						type="button"
						data-testid="thread-back"
						aria-keyshortcuts="u"
						class="-ml-1.5 inline-flex min-w-0 items-center rounded-control py-1.5 pl-0.5 pr-3 hover:bg-raised"
						classList={{ "text-[17px]": phone() }}
						style={{ "font-weight": phone() ? undefined : "var(--mc-strong-weight)" }}
						title="Back to the list (u)"
						onClick={() => props.onClose()}
					>
						<span class="mc-chevron" aria-hidden="true" />
						<span class="truncate">{backLabel()}</span>
					</button>
					<Show when={showPosition() && position()}>
						{(at) => (
							<>
								<span
									data-testid="thread-position"
									class="ml-2.5 mr-0.5 whitespace-nowrap text-[13px] text-muted"
								>
									{at().index + 1} of {at().count}
									{at().more ? "+" : ""}
								</span>
								<button
									type="button"
									class="mc-quiet"
									disabled={at().index <= 0}
									onClick={() => hop(-1)}
								>
									Prev
								</button>
								<button
									type="button"
									class="mc-quiet"
									disabled={at().index >= at().count - 1}
									onClick={() => hop(1)}
								>
									Next
								</button>
							</>
						)}
					</Show>
					<span class="flex-1" />
					<Show when={conversation() && !phone()}>
						{/* Archive · Mark unread · Trash (red, set apart) · More · Reply. Inside Trash: Restore ·
						    Mark unread · Delete forever, behind the confirm. */}
						<button
							type="button"
							class={archiveClass()}
							title={isTrashed() ? undefined : isArchived() ? "Move to Inbox" : "Archive (e)"}
							onClick={archive}
						>
							{archiveLabel()}
						</button>
						<button
							type="button"
							class="mc-word shrink-0"
							title="Mark unread (Shift U)"
							onClick={() => toggleRead()}
						>
							{readLabel()}
						</button>
						<span class="w-3.5 shrink-0" aria-hidden="true" />
						<button
							type="button"
							class="mc-word shrink-0 !text-neg"
							title={isTrashed() ? undefined : "Trash (#)"}
							onClick={trash}
						>
							{isTrashed() ? "Delete forever" : "Trash"}
						</button>
						<span class="w-3.5 shrink-0" aria-hidden="true" />
						<div class="relative shrink-0">
							<button
								ref={moreButton}
								type="button"
								data-testid="thread-more"
								aria-haspopup="menu"
								aria-expanded={moreOpen()}
								class="mc-word"
								onClick={() => setMoreOpen(!moreOpen())}
							>
								More
							</button>
							<Show when={moreOpen()}>
								<Menu
									label="More"
									class="right-0 top-[40px]"
									anchor={() => moreButton}
									onClose={() => setMoreOpen(false)}
									sections={[]}
								>
									<Show when={!singleBulk()}>
										<MenuAction label="Reply all" onClick={fromMore(() => compose("reply-all"))} />
									</Show>
									<MenuAction label="Forward" onClick={fromMore(() => compose("forward"))} />
								</Menu>
							</Show>
						</div>
						<Show when={!singleBulk()}>
							<button
								type="button"
								data-testid="thread-reply"
								class={replyClass()}
								title="Reply (r)"
								onClick={() => compose("reply")}
							>
								Reply
							</button>
						</Show>
					</Show>
					<Show when={confirmingDelete()}>
						<DeleteForever
							targets={[target()]}
							onCancel={() => setConfirmingDelete(false)}
							onConfirm={deleteForever}
						/>
					</Show>
				</div>

				{/* S3: a lone bulk message is read in the newsletter reader (its HTML across the column). */}
				<Show when={newsletter()}>
					{(only) => <NewsletterReader email={only()} subject={subject()} />}
				</Show>
				<Show when={!newsletter()}>
					<div classList={{ "px-3 pt-4": phone() }}>
						<div data-testid="thread-head" class="px-2 md:px-0 mb-3.5 md:mb-[18px]">
							<h1
								data-testid="thread-subject"
								class="mc-title text-[24px] md:text-[26px] leading-tight [overflow-wrap:anywhere]"
							>
								{subject()}
							</h1>
						</div>

						<Switch>
							<Match when={failure() && own().length === 0 && drafts().length === 0}>
								<NotDownloaded kind={failure() ?? "offline"} known={lastKnown()} onRetry={retry} />
							</Match>
							{/* The newest message is often the draft, the anchor the server sends first: the
							    rest is on its way. A thread holding only a draft shows its Draft item. */}
							<Match when={own().length === 0 && (drafts().length === 0 || loadingRest())}>
								<div class="flex flex-col gap-2" aria-busy="true">
									<div class="h-11 rounded-box bg-raised" />
									<div class="h-11 rounded-box bg-raised" />
									<div class="h-56 rounded-box bg-raised" />
								</div>
							</Match>
							<Match when={own().length > 0 || drafts().length > 0}>
								<div data-testid="thread-timeline" class="flex flex-col gap-2">
									<For each={keys()}>
										{(key) => {
											const item = () => items().get(key);
											const stack = () => {
												const current = item();
												return current?.kind === "stack" ? current : null;
											};
											const email = () => {
												const current = item();
												return current?.kind === "message" ? current.email : null;
											};
											return (
												<Switch>
													<Match when={stack()}>
														{(s) => (
															<MessageStack
																stack={s().key}
																emails={s().emails}
																people={people()}
																onOpen={() => unfold(s().key)}
															/>
														)}
													</Match>
													<Match when={email()}>
														{(e) => (
															<MessageBox
																email={e()}
																people={people()}
																category={conversation()?.category ?? null}
																open={isOpen(e())}
																onToggle={() => toggle(e())}
															/>
														)}
													</Match>
												</Switch>
											);
										}}
									</For>
									<For each={draftItems()}>
										{(draft) => <DraftItem draft={draft} onOpen={() => openDraft(draft)} />}
									</For>
								</div>
								<Show when={loadingRest()}>
									<p class="mt-3 text-muted text-[0.9em]">Loading the rest of this conversation…</p>
								</Show>
								<div classList={{ "mt-4.5": composingHere() }}>
									<InlineComposerSlot
										conversationId={props.conversationId}
										emailIds={timelineIds()}
									/>
								</div>
							</Match>
						</Switch>
					</div>
				</Show>
				{/* Phone (WM4): Archive · Reply · More under the thumb; More is a sheet. */}
				<Show when={phone() && conversation()}>
					<div
						data-testid="thread-actions"
						class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 items-center border-0 border-t border-solid border-rule bg-sheet px-3 pt-2.5"
						style={{ "padding-bottom": "calc(10px + env(safe-area-inset-bottom, 0px))" }}
					>
						<Show when={!singleBulk() || isTrashed()} fallback={<span />}>
							<button
								type="button"
								class="mc-word justify-self-start text-[17px]"
								onClick={archive}
							>
								{archiveLabel()}
							</button>
						</Show>
						<Show
							when={!singleBulk()}
							fallback={
								<Show when={!isTrashed()} fallback={<span />}>
									<button
										type="button"
										class={`${archiveClass()} h-11 justify-self-center !px-7 text-[17px]`}
										onClick={archive}
									>
										{archiveLabel()}
									</button>
								</Show>
							}
						>
							<button
								type="button"
								data-testid="thread-reply"
								class={`${replyClass()} h-11 justify-self-center !px-9 text-[17px]`}
								onClick={() => compose("reply")}
							>
								Reply
							</button>
						</Show>
						<button
							type="button"
							data-testid="thread-more"
							aria-haspopup="dialog"
							class="mc-word justify-self-end text-[17px]"
							onClick={() => setMoreOpen(true)}
						>
							More
						</button>
					</div>
				</Show>
				<Show when={phone() && moreOpen()}>
					<ActionSheet onClose={() => setMoreOpen(false)}>
						<div class="overflow-hidden rounded-box bg-sheet">
							<Show when={!singleBulk()}>
								<button type="button" onClick={fromMore(() => compose("reply-all"))}>
									Reply all
								</button>
							</Show>
							<button type="button" onClick={fromMore(() => compose("forward"))}>
								Forward
							</button>
							<button type="button" onClick={fromMore(toggleRead)}>
								{readLabel()}
							</button>
							<Show when={originalTarget()}>
								{(email) => (
									<button type="button" onClick={fromMore(() => toggleOriginal(email().id))}>
										{originalShown(email().id) ? "Show as text" : "Show original"}
									</button>
								)}
							</Show>
						</div>
						<div class="overflow-hidden rounded-box bg-sheet">
							<button type="button" class="!text-neg" onClick={fromMore(trash)}>
								{isTrashed() ? "Delete forever" : "Trash"}
							</button>
						</div>
						<div class="overflow-hidden rounded-box bg-sheet">
							<button
								type="button"
								class="!text-center font-semibold"
								onClick={() => setMoreOpen(false)}
							>
								Cancel
							</button>
						</div>
					</ActionSheet>
				</Show>
				{/* Phone: the rail's one hop, named, under the last message (L3's iPhone form). */}
				<Show when={phone() && own().length > 0 && following()}>
					{(after) => (
						<NextInView
							view={backLabel()}
							next={after().next}
							inset={Boolean(newsletter())}
							onOpen={(row) => {
								if (!openListed(row.id)) actions.selectConversation(row.id, row.emailId);
							}}
						/>
					)}
				</Show>
			</div>
		</div>
	);
};

/**
 * A saved draft no window holds (Cancel or Close kept it, another device wrote it): one line in
 * a closed message's shape, "Draft" in the list row's mark (text-neg) where the sender would be,
 * then its first line. Never a message: it opens the composer with the saved words.
 */
const DraftItem: Component<{ draft: Email; onOpen: () => void }> = (props) => (
	<button
		type="button"
		data-testid="thread-draft"
		data-email-id={props.draft.id}
		class="w-full grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,170px)_minmax(0,1fr)] gap-x-3.5 gap-y-0.5 items-baseline px-3.5 md:px-4 py-2.75 text-left border border-solid border-border rounded-box bg-sheet hover:border-control"
		onClick={() => props.onOpen()}
	>
		<span data-testid="thread-draft-mark" class="font-semibold text-neg">
			Draft
		</span>
		<span class="truncate text-muted">{firstLine(props.draft)}</span>
	</button>
);

/** The phone's sheet of actions from the bottom (More): groups of words, Cancel last. */
const ActionSheet: Component<{ onClose: () => void; children: JSX.Element }> = (props) => {
	let root: HTMLDivElement | undefined;
	useDialogFocus(() => root, { onClose: props.onClose });
	return (
		<div class="fixed inset-0 z-[60]">
			<button
				type="button"
				tabindex="-1"
				aria-label="Close"
				class="absolute inset-0 h-full w-full bg-scrim"
				onClick={() => props.onClose()}
			/>
			<div
				ref={root}
				role="dialog"
				aria-modal="true"
				aria-label="More"
				data-testid="thread-more-sheet"
				class="mc-action-sheet absolute inset-x-0 bottom-0 grid gap-2 px-2.5 pt-2.5"
				style={{ "padding-bottom": "calc(10px + env(safe-area-inset-bottom, 0px))" }}
			>
				{props.children}
			</div>
		</div>
	);
};

/**
 * "Next in Personal": the next conversation in the list, or the end of it. A well, not a bordered
 * card: as the message cards' twin it read as one more message (build 6). Its tone
 * is the accent tint, the icon's flap in Light (build 7: it follows the theme); pressed, 12% of the accent over it.
 */
const NextInView: Component<{
	view: string;
	next: ListedConversation | null;
	inset: boolean;
	onOpen: (row: ListedConversation) => void;
}> = (props) => (
	<div class="px-3" classList={{ "pt-2": props.inset }}>
		<Show
			when={props.next}
			fallback={
				<p data-testid="thread-next" class="mb-1.5 mt-[22px] text-center text-[14.5px] text-muted">
					Last conversation in {props.view}.
				</p>
			}
		>
			{(row) => (
				<button
					type="button"
					data-testid="thread-next"
					aria-label={`Next in ${props.view}: ${row().name ?? ""}, ${row().subject ?? ""}`}
					class="mb-1.5 mt-[30px] grid min-h-16 w-full gap-y-px rounded-box bg-accent-soft px-4 pb-[13px] pt-3 text-left active:bg-[color-mix(in_srgb,var(--mc-accent)_12%,var(--mc-accent-soft))]"
					onClick={() => props.onOpen(row())}
				>
					<span class="text-[13.5px]" style={{ "font-weight": "var(--mc-strong-weight)" }}>
						Next in {props.view}
					</span>
					<span
						class="truncate text-[16.5px]"
						style={{ "font-weight": row().unread ? "var(--mc-strong-weight)" : undefined }}
					>
						{row().name}
					</span>
					<span class="truncate text-[15px] text-muted">{row().subject}</span>
				</button>
			)}
		</Show>
	</div>
);

/** NI-12: offline (or refused) and not on this device: what the list last knew, and a way to retry. */
const NotDownloaded: Component<{
	kind: "offline" | "error";
	known: ConversationSummaryRecord | null;
	onRetry: () => void;
}> = (props) => (
	<div data-testid="thread-offline" class="flex flex-col gap-3">
		<Show when={props.known}>
			{(known) => (
				<article class="border border-border rounded-box bg-sheet px-4 md:px-5 py-3.5">
					<div class="flex items-baseline gap-3">
						<span class="font-semibold min-w-0 truncate">
							{known().from_name || known().from_address}
						</span>
						<time class="ml-auto shrink-0 text-muted text-[0.88em]">
							{shortDate(known().received_at)}
						</time>
					</div>
					<Show when={known().snippet}>
						<p class="mt-1.5 text-muted [overflow-wrap:anywhere]">{known().snippet}</p>
					</Show>
				</article>
			)}
		</Show>
		<p class="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3.5 py-2.5 rounded-box bg-warn-soft font-medium">
			<span>
				{props.kind === "offline"
					? "Not downloaded"
					: "Couldn't load: the server returned an error"}
			</span>
			<span class="text-faint" aria-hidden="true">
				·
			</span>
			<button
				type="button"
				class="font-medium text-accent hover:underline"
				onClick={() => props.onRetry()}
			>
				Try again
			</button>
		</p>
	</div>
);

export default ThreadView;
