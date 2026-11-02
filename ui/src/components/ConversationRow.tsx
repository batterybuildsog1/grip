import { type Component, For, Show } from "solid-js";
import type { ConversationSummaryRecord } from "../lib/db";
import { fullTime, markedRuns, newText, rowTime } from "../utils/row-format";
import { parseSenderName, personName } from "../utils/sender";

interface ConversationRowProps {
	email: ConversationSummaryRecord;
	index: number;
	/** Phone: three lines (who and when, subject, new text); desktop: one line. */
	phone: boolean;
	/** The tablet band (WD1): the phone's form without the new text, so two lines, with hover actions. */
	twoLine?: boolean;
	selected: boolean;
	/** Some row is selected: every row shows its checkbox. */
	selecting: boolean;
	/** The keyboard cursor (shown only once a key moved it). */
	cursor: boolean;
	/** In Trash, Restore takes Archive's place and Delete forever Trash's. */
	inTrash: boolean;
	onOpen: () => void;
	onToggleSelect: () => void;
	onArchive: () => void;
	onToggleRead: () => void;
	onTrash: () => void;
	onRestore: () => void;
	/** In Trash (S7): asks, then deletes the conversation's Trash messages. */
	onDeleteForever: () => void;
	onHoverIntent?: () => void;
	/** Search results: where the conversation lives ("Personal", "Sent", "All mail"; r2 S4). */
	where?: string;
	/** A search's results: the found file's name stays on the row (WD6). */
	searching?: boolean;
}

export function isUnread(email: ConversationSummaryRecord): boolean {
	return email.thread_count > 1 ? email.thread_unread_count > 0 : !email.read_at;
}

/**
 * Who a row names: the sender, or for mail sent from here "To <name>", the name the server found
 * (`display_to_name`, the same on every client), else the whole address.
 */
export function rowName(email: ConversationSummaryRecord): string {
	if (email.direction === "outbound") {
		const name = email.to_name?.trim();
		const to = email.to_address || email.to_addresses[0] || "";
		return `To ${name ? personName(name) : to || "(no recipient)"}`;
	}
	return parseSenderName(email.from_address, email.from_name);
}

const CHIP =
	"whitespace-nowrap rounded-control border border-solid border-border px-2 py-px text-[12px] text-muted";

/** "QUARTERLY_REPORT FINAL DR…) (1).pdf": the start and the extension both stay readable. */
export const midTrunc = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max - 10).trimEnd()}…${text.slice(-9)}`;

export const rowAt = (email: ConversationSummaryRecord) => email.received_at || email.sent_at || 0;
export const rowSubject = (email: ConversationSummaryRecord) =>
	email.subject?.trim() || "(no subject)";

/**
 * One conversation (design r2 §4 S1, L3). Desktop, one line: unread dot, who (and the count), subject
 * — new text, files, when. On hover Archive · Read/Unread · Trash (red, apart) replace the time
 * and a checkbox replaces the dot. The row opens from a real button under its text; the checkbox is
 * a real control. No avatars, stars, category pills or icons. Unread is the dot and the name at the
 * strong weight only; the subject stays regular (design-taste X2). The inbox says "2 files"; search
 * keeps the file's name, which is what was found (WD6).
 */
const ConversationRow: Component<ConversationRowProps> = (props) => {
	const unread = () => isUnread(props.email);
	const subject = () => rowSubject(props.email);
	const runs = () => markedRuns(newText(props.email.snippet));
	/** The display message's file names when the Worker sends them; else only the count is known. */
	const names = () =>
		(props.email.display_attachment_names ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
	const files = () =>
		Math.max(
			names().length,
			props.email.has_attachments ? Math.max(1, props.email.attachment_count || 0) : 0,
		);
	/** The conversation's other files: its count less the one named (at least the other names). */
	const moreFiles = () => Math.max(files() - 1, names().length - 1, 0);
	const filesLabel = () => (files() === 1 ? "1 file" : `${files()} files`);
	const time = () => rowTime(rowAt(props.email));
	const label = () =>
		`${rowName(props.email)}, ${subject()}${unread() ? ", unread" : ""}, ${time()}`;

	const act = (fn: () => void) => (e: MouseEvent) => {
		e.stopPropagation();
		fn();
	};
	const actClass =
		"rounded-control px-[9px] py-1 text-[13px] text-muted hover:bg-sheet hover:text-text";

	const snippet = () => (
		<>
			<Show when={props.email.snippet_source === "attachment"}>
				<span class="italic">in attachment: </span>
			</Show>
			<For each={runs()}>
				{(run) => (run.marked ? <mark class="rounded-sm px-px">{run.text}</mark> : run.text)}
			</For>
		</>
	);

	const mark = () => (
		<>
			{/* A button, not an <input>: keys typed after a click in an input are not shortcuts, so
			    e, # and x went dead until focus moved (S7 review). */}
			<button
				type="button"
				role="checkbox"
				aria-checked={props.selected}
				aria-label={`Select ${rowName(props.email)}: ${subject()}`}
				class="mc-check h-4 w-4 shrink-0 cursor-pointer border-[1.5px] border-solid border-control bg-sheet"
				style={{ "border-radius": "calc(var(--mc-radius-control) / 2)" }}
				onClick={(e) => {
					e.stopPropagation();
					props.onToggleSelect();
				}}
			/>
			<span
				data-part="dot"
				class="h-2 w-2 shrink-0 rounded-full"
				classList={{ "bg-accent": unread() }}
				role={unread() ? "img" : undefined}
				aria-label={unread() ? "Unread" : undefined}
				aria-hidden={unread() ? undefined : "true"}
			/>
		</>
	);

	const acts = () => (
		<span
			data-part="acts"
			data-testid="row-actions"
			class="mc-acts absolute inset-y-0 right-2 z-2 items-center gap-0.5 bg-raised pl-4"
		>
			<button
				type="button"
				class={actClass}
				onClick={act(props.inTrash ? props.onRestore : props.onArchive)}
			>
				{props.inTrash ? "Restore" : "Archive"}
			</button>
			<button type="button" class={actClass} onClick={act(props.onToggleRead)}>
				{unread() ? "Read" : "Unread"}
			</button>
			<button
				type="button"
				class={`${actClass} ml-2.5 !text-neg`}
				onClick={act(props.inTrash ? props.onDeleteForever : props.onTrash)}
			>
				{props.inTrash ? "Delete forever" : "Trash"}
			</button>
		</span>
	);

	const draftMark = () => (
		<Show when={props.email.mailbox_state === "draft"}>
			<span class="mr-1.5 shrink-0 text-neg">Draft</span>
		</Show>
	);
	const count = () => (
		<Show when={props.email.thread_count > 1}>
			<span class="ml-1.5 shrink-0 text-[0.86em] font-normal text-faint">
				{props.email.thread_count}
			</span>
		</Show>
	);

	return (
		<li
			class="mc-row relative"
			data-testid="conversation-row"
			data-email-row
			data-email-id={props.email.id}
			data-id={props.email.id}
			data-thread-id={props.email.thread_id}
			data-index={props.index}
			data-direction={props.email.direction}
			data-unread={unread() ? "true" : "false"}
			data-selected={props.selected ? "true" : "false"}
			data-cursor={props.cursor ? "true" : "false"}
		>
			<Show
				when={!props.phone && !props.twoLine}
				fallback={
					// biome-ignore lint/a11y/useKeyWithClickEvents: the open button inside is the keyboard path.
					// biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut for the whole row.
					<div
						data-testid="email-row"
						class="mc-face relative flex cursor-pointer gap-2.5 bg-sheet"
						classList={{
							"py-[11px] pl-2.5 pr-5": !props.twoLine,
							"py-2 pl-2 pr-3 rounded-control": props.twoLine,
						}}
						onMouseEnter={() => props.onHoverIntent?.()}
						onClick={() => props.onOpen()}
					>
						<button
							type="button"
							class="mc-open absolute inset-0 z-0"
							aria-label={label()}
							onClick={(e) => {
								e.stopPropagation();
								props.onOpen();
							}}
						/>
						<span
							class="relative z-1 flex w-4 shrink-0 justify-center"
							classList={{ "mt-[7px]": !props.twoLine, "mt-[6px]": props.twoLine }}
						>
							{mark()}
						</span>
						<div class="relative z-1 min-w-0 flex-1">
							<div class="flex min-w-0 items-baseline gap-1.5">
								{draftMark()}
								<span
									data-part="from"
									class="min-w-0 truncate"
									classList={{ "text-[16.5px]": !props.twoLine }}
									style={{ "font-weight": unread() ? "var(--mc-strong-weight)" : undefined }}
								>
									{rowName(props.email)}
								</span>
								{count()}
								<Show when={props.where}>
									<span data-testid="row-where" class="ml-auto shrink-0 text-[12px] text-faint">
										{props.where}
									</span>
								</Show>
								<span
									data-part="time"
									data-testid="row-time"
									class="shrink-0 whitespace-nowrap"
									classList={{
										"ml-auto": !props.where,
										"text-[14.5px]": !props.twoLine,
										"text-[13px]": props.twoLine,
										"text-text": unread(),
										"text-muted": !unread(),
									}}
									title={fullTime(rowAt(props.email))}
								>
									{time()}
								</span>
							</div>
							<div
								data-part="subject"
								class="min-w-0 truncate"
								classList={{ "text-[15.5px]": !props.twoLine }}
							>
								{subject()}
							</div>
							<Show when={!props.twoLine && (files() > 0 || runs().length > 0)}>
								{/* One line (direction A): "2 files · " then the new text, or the file names alone. */}
								<div data-part="snippet" class="min-w-0 truncate text-[15px] text-muted">
									<Show
										when={runs().length > 0}
										fallback={names().length > 0 ? names().join(", ") : filesLabel()}
									>
										<Show when={files() > 0}>{`${filesLabel()} · `}</Show>
										{snippet()}
									</Show>
								</div>
							</Show>
						</div>
						<Show when={props.twoLine}>{acts()}</Show>
					</div>
				}
			>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: the open button inside is the keyboard path. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut for the whole row. */}
				<div
					data-testid="email-row"
					class="mc-face relative grid h-11 cursor-pointer grid-cols-[20px_196px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-control pl-2 pr-3"
					onMouseEnter={() => props.onHoverIntent?.()}
					onClick={() => props.onOpen()}
				>
					<button
						type="button"
						class="mc-open absolute inset-0 z-0 rounded-[inherit]"
						aria-label={label()}
						onClick={(e) => {
							e.stopPropagation();
							props.onOpen();
						}}
					/>
					<span class="relative z-1 grid place-items-center">{mark()}</span>
					<span
						data-part="from"
						class="relative z-1 flex min-w-0 items-baseline overflow-hidden whitespace-nowrap"
						style={{ "font-weight": unread() ? "var(--mc-strong-weight)" : undefined }}
					>
						{draftMark()}
						<span class="truncate">{rowName(props.email)}</span>
						{count()}
					</span>
					<span class="relative z-1 flex min-w-0 overflow-hidden whitespace-nowrap">
						<span data-part="subject" class="min-w-0 max-w-[72%] flex-[0_1_auto] truncate">
							{subject()}
						</span>
						<Show when={runs().length > 0}>
							<span
								data-part="snippet"
								class="mc-snip min-w-[60px] flex-[1_1_0] truncate text-muted"
							>
								{snippet()}
							</span>
						</Show>
					</span>
					<span
						data-part="side"
						class="relative z-1 flex min-w-[76px] items-center justify-end gap-2"
					>
						<Show when={files() > 0}>
							<Show
								when={props.searching && names().length > 0}
								fallback={
									<span data-testid="row-files" class="whitespace-nowrap text-[13px] text-muted">
										{filesLabel()}
									</span>
								}
							>
								<span
									data-testid="row-files"
									class={`${CHIP} max-w-[240px] truncate`}
									title={names()[0]}
								>
									{midTrunc(names()[0], 30)}
								</span>
								<Show when={moreFiles() > 0}>
									<span data-testid="row-files-more" class={CHIP}>
										+{moreFiles()}
									</span>
								</Show>
							</Show>
						</Show>
						<Show when={props.where}>
							<span data-testid="row-where" class="min-w-[56px] text-right text-[12px] text-faint">
								{props.where}
							</span>
						</Show>
						<span
							data-part="time"
							data-testid="row-time"
							class="min-w-[62px] whitespace-nowrap text-right text-[13px]"
							classList={{ "text-text": unread(), "text-muted": !unread() }}
							title={fullTime(rowAt(props.email))}
						>
							{time()}
						</span>
					</span>
					{acts()}
				</div>
			</Show>
		</li>
	);
};

export default ConversationRow;
