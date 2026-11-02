import { type Component, For, onCleanup, onMount, Show } from "solid-js";
import { notAShortcut } from "../lib/shortcuts";
import { type Toast as ToastEntry, useApp } from "../store/app";
import { columnFits, isMobile } from "../store/responsive";
import { replyWindowThread } from "./compose/InlineComposerSlot";

/** An Undo the "z" key may press: the default label, not a Sign in / Reload action. */
const undoable = (toast: ToastEntry) => Boolean(toast.undoAction) && !toast.actionLabel;

/**
 * Toasts: what an action did, in words, with Undo and "z" for 6 s (S7: "Archived “Newsletter” · Undo ·
 * z"). Errors stay until dismissed.
 */
const Toast: Component = () => {
	const [state, actions] = useApp();
	/** A window floats at the bottom right: New message, or the reply to a lone newsletter (not a
	 *  reply under its thread, not a dock chip). */
	const windowFloats = () =>
		state.composeWindows.some(
			(w) =>
				!w.minimized &&
				(!w.replyTo ||
					(Boolean(w.replyTo.conversationId) && w.replyTo.conversationId === replyWindowThread())),
		);

	// z presses the newest Undo on screen, wherever the action came from.
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "z" || notAShortcut(e)) return;
		const toast = [...state.toasts].reverse().find(undoable);
		if (!toast) return;
		e.preventDefault();
		toast.undoAction?.();
		actions.dismissToast(toast.id);
	};
	onMount(() => document.addEventListener("keydown", onKey));
	onCleanup(() => document.removeEventListener("keydown", onKey));

	return (
		<Show when={state.toasts.length > 0}>
			{/* Desktop: centred over the sheet (S7, L3); while a New message window floats at the bottom
			    right (S5) the toasts sit at the sheet's bottom left so they never cover its Send or
			    Discard. Phone: across the bottom. */}
			<div
				class="fixed bottom-5 z-[100] flex max-w-[calc(100vw-2rem)] flex-col gap-2 md:bottom-6"
				classList={{
					"left-4 items-start": isMobile(),
					"-translate-x-1/2 items-center": !isMobile() && !windowFloats(),
					"items-start": !isMobile() && windowFloats(),
				}}
				style={
					isMobile()
						? // Above the phone's bottom bars (the list's search and New, the thread's actions).
							{ bottom: "calc(76px + env(safe-area-inset-bottom, 0px))" }
						: {
								left: windowFloats()
									? state.sidebarShown && columnFits()
										? "256px"
										: "24px"
									: state.sidebarShown && columnFits()
										? "calc(240px + (100% - 248px) / 2)"
										: "50%",
							}
				}
			>
				<For each={state.toasts}>
					{(toast) => (
						<div
							class="flex max-w-[36rem] items-center gap-3.5 rounded-box bg-toast py-2.5 pl-4 pr-3 text-[14px] leading-5 text-toast-on shadow-float animate-slide-up"
							role={toast.type === "error" ? "alert" : "status"}
						>
							<span class="min-w-0">{toast.message}</span>
							<Show when={toast.undoAction}>
								<button
									type="button"
									class="shrink-0 text-toast-on underline underline-offset-3"
									style={{ "font-weight": "var(--mc-strong-weight)" }}
									onClick={() => {
										toast.undoAction?.();
										actions.dismissToast(toast.id);
									}}
								>
									{toast.actionLabel ?? "Undo"}
								</button>
							</Show>
							<Show when={undoable(toast)}>
								<kbd
									class="shrink-0 !bg-transparent !text-toast-on opacity-80"
									style={{
										"border-color": "color-mix(in srgb, var(--mc-on-toast) 35%, transparent)",
									}}
								>
									z
								</kbd>
							</Show>
							<Show when={toast.type === "error"}>
								<button
									type="button"
									class="shrink-0 rounded-control px-1.5 py-0.5 text-toast-on opacity-80 hover:opacity-100"
									onClick={() => actions.dismissToast(toast.id)}
								>
									Dismiss
								</button>
							</Show>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
};

export default Toast;
