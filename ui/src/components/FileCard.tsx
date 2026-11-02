import { type Component, createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../api/client";
import type { Email, EmailAttachment } from "../types";
import { fileMeta, missingFileCount, previewKind, realFiles } from "../utils/files";
import PdfPreview from "./PdfPreview";

interface FileCardProps {
	attachment: EmailAttachment;
	emailId: string;
	onPreview: (card: HTMLElement) => void;
}

const CARD =
	"grid w-full items-center gap-x-2.5 rounded-box border border-border bg-sheet px-3 py-2 text-left text-text no-underline min-h-[52px] hover:border-control sm:w-auto sm:max-w-[380px]";

/**
 * One file: the whole name, wrapping (WD-08, WP-13), "PDF · 57 KB" under it, and a thumbnail when
 * the browser can draw one (images; PDFs get one when the server can render a first page). A PDF
 * or an image opens the preview; anything else downloads.
 */
export const FileCard: Component<FileCardProps> = (props) => {
	const att = props.attachment;
	const name = att.filename || "Attachment";
	const url = api.emails.attachmentUrl(props.emailId, att.id);
	const kind = previewKind(att);
	const body = (): JSX.Element => (
		<>
			<Show when={kind === "image"}>
				<img
					data-file-thumb
					src={url}
					alt=""
					width="46"
					height="60"
					loading="lazy"
					class="mc-paper row-span-2 h-[60px] w-[46px] border border-solid border-rule object-cover"
					style={{ "border-radius": "calc(var(--mc-radius-control) / 2)" }}
				/>
			</Show>
			<span
				data-testid="file-name"
				class="min-w-0 text-[0.92em] font-medium leading-[1.3] [overflow-wrap:anywhere]"
			>
				{name}
			</span>
			<span data-testid="file-meta" class="text-[0.82em] text-muted">
				{fileMeta(att)}
			</span>
		</>
	);
	const columns = kind === "image" ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]";
	return (
		<Show
			when={kind}
			fallback={
				<a
					data-testid="file-card"
					class={`${CARD} ${columns}`}
					href={url}
					download={name}
					aria-label={`Download ${name}`}
				>
					{body()}
				</a>
			}
		>
			<button
				type="button"
				data-testid="file-card"
				class={`${CARD} ${columns}`}
				aria-label={`Preview ${name}`}
				onClick={(ev) => props.onPreview(ev.currentTarget)}
			>
				{body()}
			</button>
		</Show>
	);
};

/**
 * A message's files, and an honest line when an older import stored none of them. Owns the
 * preview; closing it returns focus to the card that opened it.
 */
export const FileList: Component<{ email: Email }> = (props) => {
	const [open, setOpen] = createSignal<{ attachment: EmailAttachment; card: HTMLElement } | null>(
		null,
	);
	const close = () => {
		const card = open()?.card;
		setOpen(null);
		queueMicrotask(() => card?.focus());
	};
	const missing = () => missingFileCount(props.email);
	return (
		<>
			<Show when={realFiles(props.email).length > 0}>
				<div class="mt-3.5 flex flex-wrap gap-2">
					<For each={realFiles(props.email)}>
						{(attachment) => (
							<FileCard
								attachment={attachment}
								emailId={props.email.id}
								onPreview={(card) => setOpen({ attachment, card })}
							/>
						)}
					</For>
				</div>
			</Show>
			<Show when={missing() > 0}>
				<p data-testid="files-missing" class="mt-3.5 text-[13px] text-muted">
					{missing() === 1
						? "1 attachment wasn't stored when this message was imported."
						: `${missing()} attachments weren't stored when this message was imported.`}
				</p>
			</Show>
			<Show when={open()} keyed>
				{(preview) => (
					<PdfPreview attachment={preview.attachment} emailId={props.email.id} onClose={close} />
				)}
			</Show>
		</>
	);
};
