/**
 * The reply under the thread (r2 build spec, S5; option B without the three panes):
 * To chips and "Reply all adds ...", From, the message, Quoted text, then Send · Attach ·
 * Draft saved · Discard. Nothing lies over the From row (WP-05). Compose.tsx draws it into the
 * thread's InlineComposerSlot.
 */
import { type Component, Show } from "solid-js";
import { useApp } from "../../store/app";
import {
	AttachButton,
	AttachmentList,
	BodyField,
	DiscardButton,
	FromRow,
	fileDrop,
	Notices,
	QuotedText,
	RecipientRows,
	SaveState,
	SendButton,
	SubjectRow,
} from "./ComposeFields";
import type { ComposeDraft } from "./draft-engine";

const InlineComposer: Component<{ draft: ComposeDraft }> = (props) => {
	const [, actions] = useApp();
	const d = () => props.draft;
	const drop = fileDrop(props.draft);
	const placeholder = () => {
		if (d().mode() === "forward") return "Add a note";
		if (d().mode() === "reply-all") return "Reply to all";
		const first = d().chips()[0];
		return first ? `Reply to ${first.name}` : "Reply";
	};
	return (
		<section
			ref={(el) => {
				d().refs.root = el;
			}}
			data-testid="compose-root"
			data-compose-window-id={d().windowId}
			data-compose-placement="inline"
			aria-label={d().title()}
			class="mc-compose mt-4 rounded-box border border-control bg-sheet text-[14px] text-text"
			classList={{ "outline outline-2 outline-accent": drop.over() }}
			// In front (its Send the filled one) by pointer or by Tab.
			onMouseDown={() => actions.focusCompose(d().windowId)}
			onFocusIn={() => actions.focusCompose(d().windowId)}
			{...drop.handlers}
		>
			<RecipientRows draft={props.draft} />
			<FromRow draft={props.draft} />
			<Show when={d().mode() === "forward"}>
				<SubjectRow draft={props.draft} />
			</Show>
			<BodyField draft={props.draft} class="min-h-[150px] resize-y" placeholder={placeholder()} />
			<QuotedText draft={props.draft} />
			<AttachmentList draft={props.draft} />
			<Notices draft={props.draft} />
			<div class="flex flex-wrap items-center gap-2.5 border-t border-rule px-3 py-2.5">
				<SendButton draft={props.draft} />
				<AttachButton draft={props.draft} />
				<SaveState draft={props.draft} />
				<span class="flex-1" />
				<DiscardButton draft={props.draft} />
			</div>
		</section>
	);
};

export default InlineComposer;
