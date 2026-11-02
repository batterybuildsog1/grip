/**
 * Where a reply is written: under its thread (r2 build spec, S5 "InlineComposer under the
 * thread"). The thread view places <InlineComposerSlot> after its last message; Compose.tsx
 * draws the reply into it while the thread is open. The draft itself lives in Compose.tsx, so
 * leaving the thread only moves the reply to the dock.
 */
import { type Component, createSignal, onCleanup } from "solid-js";
import type { ComposeReplyTarget } from "../../store/app";

interface Slot {
	el: HTMLDivElement;
	readonly conversationId: string | null;
	emailIds: () => readonly string[];
}

const [slots, setSlots] = createSignal<readonly Slot[]>([]);
/** Compose windows drawn inline right now: window id -> the slot element they are in. */
const [occupants, setOccupants] = createSignal<ReadonlyMap<string, HTMLElement>>(new Map());

/**
 * The open conversation that has loaded and draws no slot (a lone newsletter in the newsletter
 * reader): its reply is a window (lead's call, 2026-10-26). Set by ThreadView only once the thread
 * is known, so a reply whose thread is still loading waits in the dock instead of flashing a window.
 */
const [windowThread, setWindowThread] = createSignal<string | null>(null);
export const replyWindowThread = windowThread;
export const setReplyWindowThread = (conversationId: string | null) =>
	setWindowThread(conversationId);

const holds = (slot: Slot, target: ComposeReplyTarget) =>
	(Boolean(target.conversationId) && slot.conversationId === target.conversationId) ||
	slot.emailIds().includes(target.emailId);

/** The open thread's slot for this reply, or null when its thread isn't on screen. */
export function inlineSlotFor(target: ComposeReplyTarget | null | undefined): HTMLElement | null {
	if (!target) return null;
	return slots().find((slot) => holds(slot, target))?.el ?? null;
}

/** Compose.tsx says which slot a window is drawn in (null: it isn't inline). */
export function setInlineOccupant(windowId: string, el: HTMLElement | null) {
	setOccupants((previous) => {
		if ((previous.get(windowId) ?? null) === el) return previous;
		const next = new Map(previous);
		if (el) next.set(windowId, el);
		else next.delete(windowId);
		return next;
	});
}

/** True while a reply is written under this thread: hide its Reply · Reply all · Forward row. */
export function inlineComposerOpenFor(
	conversationId: string | null,
	emailIds: readonly string[],
): boolean {
	const slot = slots().find(
		(entry) =>
			(Boolean(conversationId) && entry.conversationId === conversationId) ||
			entry.emailIds().some((id) => emailIds.includes(id)),
	);
	if (!slot) return false;
	return [...occupants().values()].includes(slot.el);
}

const InlineComposerSlot: Component<{
	conversationId: string | null;
	/** Every message id in the timeline, a folded earlier conversation's included. */
	emailIds: readonly string[];
}> = (props) => {
	let slot: Slot | undefined;
	onCleanup(() => {
		const mine = slot;
		if (mine) setSlots((previous) => previous.filter((entry) => entry !== mine));
	});
	return (
		<div
			data-inline-composer-slot
			ref={(el) => {
				slot = {
					el,
					get conversationId() {
						return props.conversationId;
					},
					emailIds: () => props.emailIds,
				};
				const mine = slot;
				setSlots((previous) => [...previous, mine]);
			}}
		/>
	);
};

export default InlineComposerSlot;
