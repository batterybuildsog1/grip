import { createSignal } from "solid-js";
import { ApiHttpError, api } from "../api/client";
import { useApp } from "../store/app";
import { batchActionCached, forgetConversations } from "./cache";

/**
 * Triage (S7, design/r2-build-spec.md): Archive, Trash, Restore and Read/Unread on whole
 * conversations, from a row, the bulk bar, the thread bar or the keyboard. Each goes to the server
 * first (POST /api/emails/actions; no offline queue, CLAUDE.md), then one toast says what happened,
 * with Undo (or z) for 6 s. A failure puts the screen back and says what did not happen. Delete
 * forever exists only inside Trash, behind a confirm (components/triage/DeleteForever.tsx).
 */
export type TriageAction = "archive" | "trash" | "restore" | "mark_read" | "mark_unread";

/** One conversation as the list or the thread shows it. */
export interface TriageTarget {
	/** The conversation (thread) id: what POST /api/emails/actions takes as thread_ids. */
	id: string;
	subject: string | null;
	unread: boolean;
}

export interface RunOptions {
	/** The action takes these conversations out of the list on screen: hidden now, back on failure. */
	leaves?: boolean;
	/** Change the screen now; return what puts it back if the server refuses. */
	shown?: () => (() => void) | undefined;
	/** After an Undo the server confirmed: show the state from before the action again. */
	undone?: () => void;
	/** After the server answered, either way, and after an Undo: bring the screen in line with it. */
	refreshed?: () => void;
	/** What Undo runs, when it isn't the action's usual opposite: a restore from Archive goes back
	 *  to Archive, not to Trash (d1-04). */
	undoAs?: TriageAction;
}

const UNDO: Record<TriageAction, TriageAction> = {
	archive: "restore",
	trash: "restore",
	restore: "trash",
	mark_read: "mark_unread",
	mark_unread: "mark_read",
};

/** “Subject”, cut at 40 characters. */
export function quotedSubject(subject: string | null): string {
	const text = subject?.trim() || "(no subject)";
	return `“${text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text}”`;
}

const what = (targets: TriageTarget[]) =>
	targets.length === 1 ? quotedSubject(targets[0].subject) : `${targets.length} conversations`;

function doneText(action: TriageAction, targets: TriageTarget[]): string {
	const it = what(targets);
	switch (action) {
		case "archive":
			return `Archived ${it}`;
		case "trash":
			return `Moved ${it} to Trash`;
		case "restore":
			return `Restored ${it}`;
		case "mark_read":
			return `Marked ${it} read`;
		case "mark_unread":
			return `Marked ${it} unread`;
	}
}

function attemptText(action: TriageAction, targets: TriageTarget[]): string {
	const it = what(targets);
	switch (action) {
		case "archive":
			return `archive ${it}`;
		case "trash":
			return `move ${it} to Trash`;
		case "restore":
			return `restore ${it}`;
		case "mark_read":
			return `mark ${it} read`;
		case "mark_unread":
			return `mark ${it} unread`;
	}
}

/** A refusal changed nothing; a lost connection leaves the outcome unknown, and nothing retries. */
const failedText = (doing: string, error: unknown) =>
	error instanceof ApiHttpError
		? `Couldn't ${doing}. Nothing changed.`
		: `Couldn't ${doing}: you're offline. It's shown as it was; check again once you're online.`;

/** Undo of Mark read re-marks only what was unread before; of Mark unread, only what was read. */
const changed = (action: TriageAction, targets: TriageTarget[]) =>
	action === "mark_read"
		? targets.filter((t) => t.unread)
		: action === "mark_unread"
			? targets.filter((t) => !t.unread)
			: targets;

// ── Conversations leaving the list ──
// Hidden from the moment an action starts. A refusal shows them again; otherwise the server's next
// list decides (settleLeaving), so the screen never keeps a guess the server contradicts.
const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
const running = new Set<string>();
export const leavingIds = leaving;

const hide = (ids: string[]) => setLeaving((prev) => new Set([...prev, ...ids]));
const unhide = (ids: string[]) =>
	setLeaving((prev) => {
		if (!ids.some((id) => prev.has(id))) return prev;
		const next = new Set(prev);
		for (const id of ids) next.delete(id);
		return next;
	});

/** A fresh list arrived from the server: it replaces every guess but those still running. */
export function settleLeaving(): void {
	setLeaving((prev) =>
		prev.size === 0 ? prev : new Set([...prev].filter((id) => running.has(id))),
	);
}

// ── The list as the thread sees it: what Archive advances to, the "4 of 25" position ──
export interface ListedConversation {
	id: string;
	emailId: string | null;
	/** As the row names it (the phone's "Next in Personal" card). */
	name?: string;
	subject?: string;
	unread?: boolean;
}
const [listed, setListed] = createSignal<readonly ListedConversation[]>([]);
/** The list's conversations in order (ConversationList keeps it current). */
export const listedConversations = listed;
/** More rows wait on the server (the position reads "4 of 50+"). */
const [listedMore, setListedMore] = createSignal(false);
export const listedHasMore = listedMore;

/** The list on screen keeps this current (ConversationList). */
export function setListedConversations(rows: readonly ListedConversation[], more = false): void {
	setListed(rows);
	setListedMore(more);
}

/**
 * Opening a listed conversation from outside the list (the thread bar's Prev/Next, Archive's next):
 * the list's own open, so the row reads as read at once. Set by ConversationList.
 */
let opener: ((id: string) => boolean) | null = null;
export function setListedOpener(open: ((id: string) => boolean) | null): void {
	opener = open;
}
/** False when no list is on screen to open it from (the caller selects it directly). */
export function openListed(id: string): boolean {
	return opener?.(id) ?? false;
}

/**
 * Once `id` leaves (with the `leaving` rows): the nearest conversation below it in the list that
 * stays, else the nearest above, else none.
 */
export function nextAfter(id: string, leaving?: ReadonlySet<string>): ListedConversation | null {
	const rows = listed();
	const index = rows.findIndex((row) => row.id === id);
	if (index < 0) return null;
	const stays = (row: ListedConversation) => row.id !== id && !leaving?.has(row.id);
	return rows.slice(index + 1).find(stays) ?? rows.slice(0, index).reverse().find(stays) ?? null;
}

/** One triage toast at a time: a new action's toast replaces the last one's. */
let lastToast: string | null = null;

export function useTriage() {
	const [, app] = useApp();

	const say = (message: string, type: "success" | "error", undo?: () => void) => {
		if (lastToast) app.dismissToast(lastToast);
		lastToast = app.showToast(message, type, undo);
	};

	const undo = async (action: TriageAction, targets: TriageTarget[], options: RunOptions) => {
		const ids = targets.map((t) => t.id);
		try {
			await batchActionCached([], action, ids);
		} catch (error) {
			say(failedText("undo", error), "error");
			options.refreshed?.();
			return;
		}
		unhide(ids);
		options.undone?.();
		options.refreshed?.();
	};

	/** Resolves true once the server confirmed. */
	const run = async (
		action: TriageAction,
		targets: TriageTarget[],
		options: RunOptions = {},
	): Promise<boolean> => {
		if (targets.length === 0) return false;
		const ids = targets.map((t) => t.id);
		for (const id of ids) running.add(id);
		if (options.leaves) hide(ids);
		const putBack = options.shown?.();
		try {
			await batchActionCached([], action, ids);
		} catch (error) {
			for (const id of ids) running.delete(id);
			if (options.leaves) unhide(ids);
			putBack?.();
			say(failedText(attemptText(action, targets), error), "error");
			options.refreshed?.();
			return false;
		}
		for (const id of ids) running.delete(id);
		const back = changed(action, targets);
		say(
			doneText(action, targets),
			"success",
			back.length > 0 ? () => void undo(options.undoAs ?? UNDO[action], back, options) : undefined,
		);
		options.refreshed?.();
		return true;
	};

	/**
	 * Deletes every message of these conversations that is in Trash, nothing outside it. Asked for
	 * only from inside Trash, after the confirm. No Undo: the server keeps nothing to restore.
	 */
	const deleteForever = async (
		targets: TriageTarget[],
		options: Pick<RunOptions, "refreshed"> = {},
	): Promise<boolean> => {
		if (targets.length === 0) return false;
		let deleted = 0;
		// Conversations whose Trash is gone: the device forgets them (a cache failure is not the delete's).
		const gone: string[] = [];
		const forget = () => forgetConversations(gone).catch(() => undefined);
		try {
			for (const target of targets) {
				const detail = await api.conversations.get(target.id, { load: "full" });
				for (const message of detail.emails.filter((e) => e.mailbox_state === "trash")) {
					await api.emails.delete(message.id);
					deleted += 1;
				}
				gone.push(target.id);
			}
		} catch (error) {
			await forget();
			const doing = `delete ${what(targets)} forever`;
			say(
				deleted > 0
					? `Deleted ${deleted} message${deleted === 1 ? "" : "s"}, then couldn't ${doing}. Check Trash.`
					: failedText(doing, error),
				"error",
			);
			options.refreshed?.();
			return false;
		}
		hide(targets.map((t) => t.id));
		await forget();
		say(`Deleted ${what(targets)} forever`, "success");
		options.refreshed?.();
		return true;
	};

	return { run, deleteForever };
}
