/**
 * The compose surfaces that aren't under a thread (r2 build spec, S5):
 *   ComposeWindow   New message (or a draft opened from Drafts): 560x600 at the bottom right
 *   ComposeSheet    a phone: the whole screen, Cancel · title · Send, Attach above the keyboard
 *   ComposeDockChip a minimized window, or a reply whose thread isn't open: Open · Close
 * The draft (ComposeDraft, compose/draft-engine.ts) lives in Compose.tsx, not here.
 */
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { useApp } from "../store/app";
import {
	AttachButton,
	AttachmentList,
	BodyField,
	DiscardButton,
	FromRow,
	fileDrop,
	LINK,
	Notices,
	QUIET,
	QuotedText,
	RecipientRows,
	SaveState,
	SendButton,
	SubjectRow,
} from "./compose/ComposeFields";
import type { ComposeDraft } from "./compose/draft-engine";

type Props = { draft: ComposeDraft };

const ComposeWindow: Component<Props> = (props) => {
	const [, actions] = useApp();
	const d = () => props.draft;
	const drop = fileDrop(props.draft);
	return (
		<section
			ref={(el) => {
				d().refs.root = el;
			}}
			data-testid="compose-root"
			data-compose-window-id={d().windowId}
			data-compose-placement="window"
			role="dialog"
			aria-label={d().title()}
			class="mc-compose pointer-events-auto flex h-[600px] max-h-[calc(100vh-60px)] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-t-sheet border border-b-0 border-border bg-sheet text-[14px] text-text shadow-[var(--mc-shadow)]"
			classList={{ "outline outline-2 outline-accent": drop.over() }}
			onMouseDown={() => actions.focusCompose(d().windowId)}
			onFocusIn={() => actions.focusCompose(d().windowId)}
			{...drop.handlers}
		>
			<div class="flex shrink-0 items-center border-b border-rule py-2 pl-4 pr-2">
				<b data-testid="compose-title" class="min-w-0 truncate font-semibold">
					{d().subject().trim() || d().title()}
				</b>
				<span class="flex-1" />
				<button
					type="button"
					data-testid="compose-minimize"
					class={QUIET}
					onClick={() => void d().minimize()}
				>
					Minimize
				</button>
				<button
					type="button"
					data-testid="compose-close"
					class={QUIET}
					onClick={() => void d().close()}
				>
					Close
				</button>
			</div>
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<RecipientRows draft={props.draft} />
				<FromRow draft={props.draft} />
				<SubjectRow draft={props.draft} />
				<BodyField draft={props.draft} class="min-h-[12rem] flex-1 resize-none" />
				<QuotedText draft={props.draft} />
				<AttachmentList draft={props.draft} />
			</div>
			<Notices draft={props.draft} />
			<div class="flex shrink-0 flex-wrap items-center gap-2.5 border-t border-rule px-3 py-2.5">
				<SendButton draft={props.draft} />
				<AttachButton draft={props.draft} />
				<SaveState draft={props.draft} />
				<span class="flex-1" />
				<DiscardButton draft={props.draft} />
			</div>
		</section>
	);
};

/** A phone: the whole screen above the keyboard (iOS Safari keeps the layout viewport). */
export const ComposeSheet: Component<Props> = (props) => {
	const d = () => props.draft;
	const [viewport, setViewport] = createSignal<{ top: number; height: number } | null>(null);
	onMount(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const update = () => setViewport({ top: vv.offsetTop, height: vv.height });
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		onCleanup(() => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		});
	});
	const placeholder = () => (d().mode() && d().mode() !== "forward" ? "Write your reply" : "");
	return (
		<section
			ref={(el) => {
				d().refs.root = el;
			}}
			data-testid="compose-root"
			data-compose-window-id={d().windowId}
			data-compose-placement="sheet"
			role="dialog"
			aria-label={d().title()}
			class="mc-compose pointer-events-auto fixed inset-x-0 bottom-0 top-0 z-[90] flex flex-col bg-sheet text-[16px] text-text"
			style={
				viewport()
					? { top: `${viewport()?.top}px`, height: `${viewport()?.height}px`, bottom: "auto" }
					: undefined
			}
		>
			<div
				data-testid="compose-sheet-bar"
				class="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-control px-4 pb-2.5 pt-[calc(0.5rem+env(safe-area-inset-top,0px))]"
			>
				<button
					type="button"
					data-testid="compose-cancel"
					class="justify-self-start py-1 text-[17px] text-accent"
					onClick={() => void d().close()}
				>
					Cancel
				</button>
				<b data-testid="compose-title" class="text-[17px] font-semibold">
					{d().title()}
				</b>
				<SendButton
					draft={props.draft}
					class="justify-self-end rounded-full bg-primary px-4 py-1.5 text-[15px] text-primary-on disabled:opacity-40"
				/>
			</div>
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<RecipientRows draft={props.draft} phone />
				<FromRow draft={props.draft} phone />
				<Show when={!d().mode() || d().mode() === "forward"}>
					<SubjectRow draft={props.draft} phone />
				</Show>
				<BodyField
					draft={props.draft}
					phone
					class="min-h-[90px] flex-1 resize-none"
					placeholder={placeholder()}
				/>
				<QuotedText draft={props.draft} phone />
				<AttachmentList draft={props.draft} phone />
			</div>
			<Notices draft={props.draft} phone />
			<div class="flex shrink-0 items-center gap-3 border-t border-control px-4 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom,0px))]">
				<AttachButton draft={props.draft} class={`${LINK} py-1 text-[16px]`} />
				<SaveState draft={props.draft} phone />
				<span class="flex-1" />
				<DiscardButton draft={props.draft} class="py-1 text-[16px] font-medium text-neg" />
			</div>
		</section>
	);
};

/** A window out of the way: minimized, or a reply waiting while its thread is closed. */
export const ComposeDockChip: Component<Props> = (props) => {
	const [, actions] = useApp();
	const d = () => props.draft;
	const open = () => {
		const target = d().replyTo();
		if (target?.conversationId) actions.selectConversation(target.conversationId, target.emailId);
		if (d().isMinimized()) actions.restoreCompose(d().windowId);
		actions.focusCompose(d().windowId);
		d().requestBodyFocus(300);
	};
	const status = () => (d().error() ? "Not sent" : d().saveLabel());
	return (
		<div
			data-testid="compose-minimized"
			data-compose-window-id={d().windowId}
			class="mc-compose pointer-events-auto w-[280px] max-w-full rounded-t-sheet border border-b-0 border-border bg-sheet text-[14px] text-text shadow-[var(--mc-shadow)] max-md:w-full"
		>
			<div class="flex items-center gap-1 py-2 pl-3 pr-1.5">
				<button type="button" class="min-w-0 flex-1 text-left" onClick={open}>
					<span class="block truncate font-semibold">{d().title()}</span>
					<span class="block truncate text-[12.5px] text-muted">
						{d().summary()}
						<Show when={status()}>
							<span classList={{ "text-neg": Boolean(d().error()) }}> · {status()}</span>
						</Show>
					</span>
				</button>
				<button type="button" data-testid="compose-restore" class={QUIET} onClick={open}>
					Open
				</button>
				<button
					type="button"
					data-testid="compose-close-minimized"
					class={QUIET}
					onClick={() => void d().close()}
				>
					Close
				</button>
			</div>
		</div>
	);
};

export default ComposeWindow;
