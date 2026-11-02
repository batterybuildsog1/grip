import { type Component, createEffect, createMemo, For, Match, onCleanup, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import { useApp } from "../store/app";
import { isMobile } from "../store/responsive";
import ComposeWindow, { ComposeDockChip, ComposeSheet } from "./ComposeWindow";
import { type ComposePlacement, createComposeDraft } from "./compose/draft-engine";
import InlineComposer from "./compose/InlineComposer";
import { inlineSlotFor, replyWindowThread, setInlineOccupant } from "./compose/InlineComposerSlot";

/**
 * One compose window: its draft lives here for as long as the window exists, wherever it is
 * drawn. A reply goes under its thread while that thread is open (desktop), waits in the dock
 * while it isn't; New message is a window; a phone shows one window at a time, full screen.
 */
const ComposeHost: Component<{ windowId: string }> = (props) => {
	const [state] = useApp();
	const windowState = () => state.composeWindows.find((w) => w.id === props.windowId) ?? null;
	const isFocused = () => state.focusedComposeWindowId === props.windowId;
	const draft = createComposeDraft({
		windowId: props.windowId,
		isFocused,
		placement: () => placement(),
	});
	const slot = createMemo(() => (isMobile() ? null : inlineSlotFor(windowState()?.replyTo)));
	const placement = createMemo((): ComposePlacement => {
		const w = windowState();
		if (!w || draft.hidden()) return "none";
		if (isMobile()) return !w.minimized && isFocused() ? "sheet" : "dock";
		if (w.minimized) return "dock";
		if (w.replyTo) {
			if (slot()) return "inline";
			// Its thread is open, loaded, and draws no reply slot (a lone newsletter): a window, as New
			// message is. Not while the thread loads: that would flash a window before the slot.
			if (w.replyTo.conversationId && w.replyTo.conversationId === replyWindowThread())
				return "window";
			// Its thread was left, is loading, or isn't open after a reload: wait in the dock.
			if (w.replyTo.conversationId) return "dock";
		}
		return "window";
	});
	createEffect(() => setInlineOccupant(props.windowId, placement() === "inline" ? slot() : null));
	onCleanup(() => setInlineOccupant(props.windowId, null));

	return (
		<Switch>
			<Match when={placement() === "inline" && slot()} keyed>
				{(el) => (
					<Portal mount={el}>
						<InlineComposer draft={draft} />
					</Portal>
				)}
			</Match>
			<Match when={placement() === "window"}>
				<ComposeWindow draft={draft} />
			</Match>
			<Match when={placement() === "sheet"}>
				<ComposeSheet draft={draft} />
			</Match>
			<Match when={placement() === "dock"}>
				<ComposeDockChip draft={draft} />
			</Match>
		</Switch>
	);
};

/**
 * Every compose window, in opening order from the right: windows and dock chips share one row
 * at the bottom right, so none covers another (on a phone the chips stack along the bottom).
 */
const Compose: Component = () => {
	const [state] = useApp();
	return (
		<div class="pointer-events-none fixed bottom-0 right-6 z-[90] flex max-w-[calc(100vw-3rem)] flex-row-reverse items-end gap-4 max-md:left-0 max-md:right-0 max-md:max-w-none max-md:flex-col max-md:items-stretch max-md:gap-0">
			<For each={state.composeWindows}>{(w) => <ComposeHost windowId={w.id} />}</For>
		</div>
	);
};

export default Compose;
