/**
 * The pieces every compose surface draws (InlineComposer, ComposeWindow, the phone sheet), all
 * reading one ComposeDraft. Words, type, spacing and borders only: no icons, no formatting toolbar
 * (r2 build spec, sections 1 and 4 "S5").
 */
import { type Component, createSignal, For, type JSX, Show } from "solid-js";
import { useApp } from "../../store/app";
import type { ContactSuggestion } from "../../types";
import { parseSenderName } from "../../utils/sender";
import { formatComposeSavedAt } from "./compose-draft";
import {
	type ComposeDraft,
	formatAttachmentSize,
	getAttachmentByteLength,
	type RecipientField,
} from "./draft-engine";

type Props = { draft: ComposeDraft; phone?: boolean };

const ROW = "relative flex items-center gap-3 border-b border-rule px-4";
const LABEL = "w-[52px] shrink-0 text-muted";
// 16px on a phone so Safari doesn't zoom on focus (m3-09).
const FIELD =
	"min-w-0 flex-1 bg-transparent py-1 text-[16px] text-text outline-none placeholder:text-faint md:text-[14px]";
export const LINK = "font-medium text-accent hover:underline";
export const QUIET =
	"rounded-control px-2 py-1.5 text-muted transition-colors hover:bg-raised hover:text-text disabled:opacity-40";

const rowHeight = (phone?: boolean) => (phone ? "min-h-[48px] py-2" : "min-h-[46px] py-2");

/** Files dragged onto a surface are attached; `over` outlines it while they hover. */
export function fileDrop(draft: ComposeDraft) {
	const [over, setOver] = createSignal(false);
	let depth = 0;
	const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
	return {
		over,
		handlers: {
			onDragEnter: (e: DragEvent) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				depth += 1;
				setOver(true);
			},
			onDragOver: (e: DragEvent) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
			},
			onDragLeave: (e: DragEvent) => {
				if (!hasFiles(e)) return;
				depth = Math.max(0, depth - 1);
				if (depth === 0) setOver(false);
			},
			onDrop: (e: DragEvent) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				depth = 0;
				setOver(false);
				const files = Array.from(e.dataTransfer?.files ?? []);
				if (files.length > 0) void draft.ingestFiles(files);
			},
		},
	};
}

/** One recipient: the name, then the address (WD-06: who it goes to is never hidden). */
const Chip: Component<{ name: string; address: string; phone?: boolean }> = (props) => (
	<span
		data-testid="compose-chip"
		class="inline-flex max-w-full items-baseline gap-1.5 rounded-full bg-raised px-2.5 py-0.5 text-text"
		classList={{ "text-[15px]": props.phone, "text-[13.5px]": !props.phone }}
	>
		<b class="truncate font-medium">{props.name}</b>
		<span class="truncate text-muted">{props.address}</span>
	</span>
);

const Suggestions: Component<Props & { field: RecipientField }> = (props) => {
	const d = () => props.draft;
	return (
		<Show
			when={
				d().activeRecipientField() === props.field &&
				d().showRecipientSuggestions() &&
				d().recipientSuggestions().length > 0
			}
		>
			<div
				data-testid="recipient-suggestions"
				class="absolute left-[4.5rem] right-4 top-full z-20 mt-1 overflow-hidden rounded-box border border-border bg-sheet shadow-[var(--mc-shadow)]"
			>
				<For each={d().recipientSuggestions()}>
					{(suggestion: ContactSuggestion, idx) => {
						const label = suggestion.name?.trim() || parseSenderName(suggestion.address);
						return (
							<button
								type="button"
								class="flex w-full flex-col px-3 py-2 text-left"
								classList={{ "bg-raised": idx() === d().activeRecipientSuggestion() }}
								onMouseEnter={() => d().setActiveRecipientSuggestion(idx())}
								onMouseDown={(e) => {
									e.preventDefault();
									d().applyRecipientSuggestion(props.field, suggestion);
								}}
							>
								<span class="truncate font-medium text-text">{label}</span>
								<Show when={label.toLowerCase() !== suggestion.address.toLowerCase()}>
									<span class="truncate text-[12.5px] text-muted">{suggestion.address}</span>
								</Show>
							</button>
						);
					}}
				</For>
			</div>
		</Show>
	);
};

const AddressField: Component<Props & { field: RecipientField; label: string }> = (props) => {
	const d = () => props.draft;
	const value = () =>
		props.field === "to" ? d().to() : props.field === "cc" ? d().cc() : d().bcc();
	return (
		<div class={`${ROW} ${rowHeight(props.phone)}`}>
			<label for={d().fieldId(props.field)} class={LABEL}>
				{props.label}
			</label>
			<input
				id={d().fieldId(props.field)}
				ref={(el) => {
					d().refs[props.field] = el;
				}}
				data-testid={`compose-${props.field}`}
				type="text"
				// Addresses (m1-06): no iOS capitalizing/autocorrect, the @ keyboard.
				inputmode="email"
				autocapitalize="off"
				autocorrect="off"
				spellcheck={false}
				class={FIELD}
				placeholder={props.field === "to" ? "Name or address" : ""}
				value={value()}
				onInput={d().handleRecipientInput(props.field)}
				onKeyDown={d().handleRecipientKeyDown(props.field)}
				onFocus={(e) =>
					d().loadRecipientSuggestions(
						props.field,
						e.currentTarget.value,
						e.currentTarget.selectionStart ?? e.currentTarget.value.length,
					)
				}
				onBlur={() => d().handleRecipientBlur()}
			/>
			<Show when={props.field === "to" && !d().showCcBcc()}>
				<button
					type="button"
					class={`${QUIET} shrink-0 text-[13px]`}
					onClick={() => d().toggleCcBcc()}
				>
					Cc Bcc
				</button>
			</Show>
			<Suggestions draft={props.draft} phone={props.phone} field={props.field} />
		</div>
	);
};

/** To (and Cc/Bcc): chips for a reply, fields for new mail, a forward, or after "Edit". */
export const RecipientRows: Component<Props> = (props) => {
	const d = () => props.draft;
	const replyAllLabel = () => {
		const adds = d().replyAllAdds();
		if (props.phone) return `Reply all (${adds.length + d().chips().length})`;
		return `Reply all adds ${adds.map((address) => d().nameFor(address)).join(", ")}`;
	};
	return (
		<Show
			when={d().showChips()}
			fallback={
				<>
					<AddressField draft={props.draft} phone={props.phone} field="to" label="To" />
					<Show when={d().showCcBcc()}>
						<AddressField draft={props.draft} phone={props.phone} field="cc" label="Cc" />
						<AddressField draft={props.draft} phone={props.phone} field="bcc" label="Bcc" />
					</Show>
				</>
			}
		>
			<div class={`${ROW} ${rowHeight(props.phone)}`}>
				<span class={`${LABEL} self-start pt-1`}>To</span>
				<div
					data-testid="compose-to-chips"
					class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5"
				>
					<For each={d().chips()}>
						{(chip) => <Chip name={chip.name} address={chip.address} phone={props.phone} />}
					</For>
					<Show when={d().replyAllAdds().length > 0}>
						<button
							type="button"
							data-testid="compose-reply-all"
							class={`${LINK} text-left`}
							onClick={() => d().switchToReplyAll()}
						>
							{replyAllLabel()}
						</button>
					</Show>
				</div>
				<button
					type="button"
					data-testid="compose-edit-recipients"
					class={`${QUIET} shrink-0 self-start text-[13px]`}
					onClick={() => d().editRecipients()}
				>
					Edit
				</button>
			</div>
		</Show>
	);
};

/** From: every sender (a native select, so phones get their own picker), default the account. */
export const FromRow: Component<Props> = (props) => {
	const d = () => props.draft;
	return (
		<div class={`${ROW} ${rowHeight(props.phone)}`}>
			<label for={d().fieldId("from")} class={LABEL}>
				From
			</label>
			<span class="relative inline-flex min-w-0 items-center">
				<select
					id={d().fieldId("from")}
					data-testid="compose-from"
					class="min-w-0 max-w-full cursor-pointer appearance-none truncate bg-transparent py-1 pr-5 text-[16px] font-medium text-text outline-none md:text-[14px]"
					value={d().from()}
					onChange={(e) => d().setFrom(e.currentTarget.value)}
				>
					{/* selected per option: a value set before the options render shows the first
					    option while the draft holds another (sends From what isn't shown) */}
					<For each={d().fromOptions()}>
						{(address) => (
							<option value={address} selected={address === d().from()}>
								{address}
							</option>
						)}
					</For>
				</select>
				<span class="mc-caret pointer-events-none absolute right-1" aria-hidden="true" />
			</span>
		</div>
	);
};

export const SubjectRow: Component<Props> = (props) => {
	const d = () => props.draft;
	return (
		<div class={`${ROW} ${rowHeight(props.phone)}`}>
			<label for={d().fieldId("subject")} class={LABEL}>
				Subject
			</label>
			<input
				id={d().fieldId("subject")}
				data-testid="compose-subject"
				type="text"
				class={`${FIELD} font-medium`}
				value={d().subject()}
				onInput={(e) => d().setSubject(e.currentTarget.value)}
			/>
		</div>
	);
};

/** The message. Plain text; a pasted image (a screenshot) is attached like a dropped file. */
export const BodyField: Component<Props & { class?: string; placeholder?: string }> = (props) => {
	const d = () => props.draft;
	return (
		<textarea
			ref={(el) => {
				d().refs.body = el;
			}}
			data-testid="compose-textarea"
			aria-label="Message"
			// No focus ring: the caret shows focus, and the ring spilled over the composer's edge. What
			// the reader writes is set like what they read: the reading face (Literata).
			class={`block w-full bg-transparent px-4 py-3.5 font-read leading-[1.55] text-text outline-none focus-visible:outline-none placeholder:text-faint ${
				props.phone ? "text-[17px]" : "text-[16px] md:text-[15px]"
			} ${props.class ?? ""}`}
			placeholder={props.placeholder ?? ""}
			value={d().bodyText()}
			onInput={(e) => d().setBodyText(e.currentTarget.value)}
			onPaste={(e) => {
				const files = Array.from(e.clipboardData?.files ?? []);
				if (files.length === 0) return;
				e.preventDefault();
				void d().ingestFiles(files);
			}}
		/>
	);
};

/**
 * "Quoted text": the original (or the forwarded message) under the reply, sent with it. Hidden
 * until asked for; editable, and left out once cleared.
 */
export const QuotedText: Component<Props> = (props) => {
	const d = () => props.draft;
	const label = () => (d().mode() === "forward" ? "Forwarded message" : "Quoted text");
	return (
		<Show when={d().quote() !== null}>
			<div class="px-4 pb-2.5">
				<button
					type="button"
					data-testid="compose-quoted-toggle"
					aria-expanded={d().quoteShown()}
					class={
						props.phone
							? "rounded-full bg-raised px-3 py-1 text-[14px] text-muted"
							: `${LINK} text-[13px]`
					}
					onClick={() => d().toggleQuote()}
				>
					{d().quoteShown() ? `Hide ${label().toLowerCase()}` : label()}
				</button>
				<textarea
					data-testid="compose-quote"
					aria-label={label()}
					// The class, not the hidden attribute: UnoCSS's `block` would override [hidden].
					class={`mt-2 ${d().quoteShown() ? "block" : "hidden"} min-h-[9rem] w-full resize-y rounded-control border-l-2 border-rule bg-raised px-3 py-2 font-read text-[16px] leading-[1.5] text-muted outline-none md:text-[13.5px]`}
					value={d().quote() ?? ""}
					onInput={(e) => d().setQuote(e.currentTarget.value)}
				/>
			</div>
		</Show>
	);
};

/** Attached files: full name, size, Remove; and the states of a forward's original files. */
export const AttachmentList: Component<Props> = (props) => {
	const d = () => props.draft;
	const locked = () =>
		d().attachmentLoadState() === "loading" || d().attachmentLoadState() === "failed";
	return (
		<>
			<Show when={d().attachmentLoadState() === "loading"}>
				<output
					data-testid="compose-attachments-loading"
					class="mx-4 mb-3 block rounded-control bg-raised px-3 py-2 text-[13px] text-muted"
					aria-live="polite"
				>
					Preparing {d().expectedAttachmentCount()}{" "}
					{d().expectedAttachmentCount() === 1 ? "attachment" : "attachments"}…
				</output>
			</Show>
			<Show when={d().attachmentLoadState() === "failed"}>
				<div
					data-testid="compose-attachments-failed"
					class="mx-4 mb-3 flex items-baseline gap-3 rounded-control bg-warn-soft px-3 py-2 text-[13px] text-text"
					role="alert"
				>
					<span class="flex-1">Attachments were not added. This message cannot be sent yet.</span>
					<button type="button" class={LINK} onClick={() => void d().retryAttachmentHydration()}>
						Try again
					</button>
				</div>
			</Show>
			<Show when={d().attachments().length > 0}>
				<ul class="flex flex-wrap gap-2 px-4 pb-3">
					<For each={d().attachments()}>
						{(att, idx) => (
							<li class="flex min-w-0 max-w-[380px] items-baseline gap-2 rounded-box border border-border px-3 py-1.5 text-[13px]">
								<span class="min-w-0 break-words font-medium text-text [overflow-wrap:anywhere]">
									{att.filename}
								</span>
								<span class="shrink-0 text-muted">
									{formatAttachmentSize(getAttachmentByteLength(att))}
								</span>
								<button
									type="button"
									class="shrink-0 text-muted hover:text-neg disabled:opacity-40"
									disabled={locked()}
									onClick={() => d().removeAttachment(idx())}
									aria-label={`Remove ${att.filename}`}
								>
									Remove
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>
		</>
	);
};

const Notice: Component<{ tone: "warn" | "neg"; testid?: string; children: JSX.Element }> = (
	props,
) => (
	<div
		data-testid={props.testid}
		role="alert"
		class="mx-3 my-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-box px-3 py-2 text-[13px] text-text"
		classList={{
			"bg-warn-soft": props.tone === "warn",
			"border border-neg": props.tone === "neg",
		}}
	>
		{props.children}
	</div>
);

/** What can't wait: not sent, not saved, a newer draft, open in another tab, sending not set up. */
export const Notices: Component<Props> = (props) => {
	const d = () => props.draft;
	return (
		<>
			<Show when={!d().sendConfigured()}>
				<Notice tone="warn">
					<span>
						Sending isn't set up for this server (EMAIL_PROVIDERS_JSON or SMTP_ACCOUNTS_JSON).
					</span>
				</Notice>
			</Show>
			<Show when={d().crossTabWarning()}>
				<Notice tone="warn">
					<span class="flex-1">This draft is open in another tab. Changes may conflict.</span>
					<button type="button" class={LINK} onClick={() => d().dismissCrossTabWarning()}>
						Dismiss
					</button>
				</Notice>
			</Show>
			<Show when={d().error()}>
				<Notice tone="neg" testid="compose-error">
					<span class="flex-1">{d().error()}</span>
					<Show when={d().sendState() === "failed"}>
						<button type="button" class={LINK} onClick={() => void d().send()}>
							Send again
						</button>
					</Show>
					<Show when={d().sendState() === "unknown"}>
						<button type="button" class={LINK} onClick={() => d().clearUnknownSend()}>
							I checked Sent, send again
						</button>
					</Show>
					<button
						type="button"
						class="text-muted hover:text-text"
						onClick={() => d().dismissError()}
					>
						Dismiss
					</button>
				</Notice>
			</Show>
			<Show when={d().draftConflict()}>
				{(conflict) => (
					<Notice tone="warn" testid="compose-conflict">
						<span class="w-full font-semibold">A newer version of this draft was saved</span>
						<span class="w-full">
							Your edits are still here. The other version was saved
							<Show when={formatComposeSavedAt(conflict().latestSavedAt)}>
								{(time) => <> at {time()}</>}
							</Show>
							.
						</span>
						<button type="button" class={LINK} onClick={() => void d().reloadLatestDraft()}>
							Load the newer version
						</button>
						<button
							type="button"
							class={LINK}
							onClick={() => void d().overwriteDraftWithLocalChanges()}
						>
							Keep my edits
						</button>
					</Notice>
				)}
			</Show>
		</>
	);
};

/**
 * Send. One filled button per screen (L3): the composer in front (the focused window) has the filled
 * Send; any other open composer's Send steps down, so a reply under the thread and a New message
 * window never both shout.
 */
export const SendButton: Component<Props & { class?: string }> = (props) => {
	const [state] = useApp();
	const d = () => props.draft;
	const inFront = () =>
		!state.focusedComposeWindowId || state.focusedComposeWindowId === d().windowId;
	const why = () => {
		if (!d().sendConfigured()) return "Sending isn't set up";
		if (!d().to().trim()) return "Add someone in To";
		if (!d().from()) return "Choose a From address";
		if (d().attachmentLoadState() === "loading") return "Preparing attachments…";
		if (d().attachmentLoadState() === "failed") return "Try the attachments again first";
		if (d().sendState() === "unknown") return "Check Sent before sending again";
		return "Send (⌘ Enter)";
	};
	return (
		<button
			type="button"
			data-testid="compose-send"
			data-filled={inFront() ? "true" : "false"}
			class={props.class ?? (inFront() ? "mc-primary" : "mc-soft")}
			disabled={!d().canSend()}
			title={why()}
			onClick={() => void d().send()}
		>
			{d().sendState() === "preparing" ? "Sending…" : "Send"}
		</button>
	);
};

/** Attach: a word, over the hidden file input. */
export const AttachButton: Component<Props & { class?: string }> = (props) => {
	const d = () => props.draft;
	const locked = () =>
		d().attachmentLoadState() === "loading" || d().attachmentLoadState() === "failed";
	return (
		<label
			for={d().fieldId("attachments")}
			data-testid="compose-attach"
			class={`relative cursor-pointer overflow-hidden ${props.class ?? QUIET}`}
			classList={{ "pointer-events-none opacity-50": locked() }}
			role="button"
			tabIndex={0}
			aria-disabled={locked()}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					d().refs.file?.click();
				}
			}}
		>
			Attach
			<input
				id={d().fieldId("attachments")}
				ref={(el) => {
					d().refs.file = el;
				}}
				type="file"
				multiple
				disabled={locked()}
				tabIndex={-1}
				aria-hidden="true"
				class="absolute inset-0 cursor-pointer opacity-0"
				onChange={async (e) => {
					const input = e.currentTarget;
					if (!input.files) return;
					await d().ingestFiles(input.files);
					input.value = "";
				}}
			/>
		</label>
	);
};

/** "Draft saved" and, when this device can't keep the window, why a reload would lose it. */
export const SaveState: Component<Props> = (props) => {
	const d = () => props.draft;
	return (
		<>
			<Show when={d().localWarning()}>
				<span
					data-testid="compose-local-warning"
					role="alert"
					class="text-[12.5px] font-medium text-neg"
				>
					{d().localWarning()}
				</span>
			</Show>
			<Show when={d().saveLabel()}>
				<span
					data-testid="compose-save-state"
					class="text-[12.5px]"
					classList={{ "text-neg": d().saveFailed(), "text-muted": !d().saveFailed() }}
				>
					{d().saveLabel()}
				</span>
			</Show>
		</>
	);
};

export const DiscardButton: Component<Props & { class?: string }> = (props) => (
	<button
		type="button"
		data-testid="compose-discard"
		class={props.class ?? "rounded-control px-2 py-1.5 font-medium text-neg hover:bg-raised"}
		onClick={() => void props.draft.discard()}
	>
		Discard
	</button>
);
