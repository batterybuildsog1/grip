import { type Component, createSignal, Match, onCleanup, onMount, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../api/client";
import { useDialogFocus } from "../lib/dialog";
import type { EmailAttachment } from "../types";
import { fileSize, previewKind } from "../utils/files";

interface PdfPreviewProps {
	attachment: EmailAttachment;
	emailId: string;
	onClose: () => void;
}

/**
 * A file's preview with Download (round-2 spec S3: web dialog; the apps use Quick Look).
 *
 * A PDF is fetched and shown from a blob typed application/pdf, so the browser's PDF viewer opens
 * it whatever the server's Content-Disposition says, and bytes that aren't a PDF can't render as
 * anything else. Images load directly. While open, the dialog keeps the keyboard: Esc closes it,
 * and no mail shortcut (e, #, j) acts on the thread behind it.
 */
const PdfPreview: Component<PdfPreviewProps> = (props) => {
	const att = props.attachment;
	const name = att.filename || "Attachment";
	const kind = previewKind(att);
	const url = api.emails.attachmentUrl(props.emailId, att.id);
	const headingId = `file-preview-${att.id}`;
	const [blobUrl, setBlobUrl] = createSignal<string | null>(null);
	const [failed, setFailed] = createSignal(false);
	let dialogEl!: HTMLDivElement;
	let closeEl!: HTMLButtonElement;
	let made: string | null = null;
	let disposed = false;

	useDialogFocus(() => dialogEl, { onClose: () => props.onClose(), initial: () => closeEl });

	onMount(() => {
		if (kind !== "pdf") return;
		api
			.request<Response>(
				`/emails/${encodeURIComponent(props.emailId)}/attachments/${encodeURIComponent(att.id)}`,
			)
			.then((res) => res.arrayBuffer())
			.then((bytes) => {
				if (disposed) return;
				made = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
				setBlobUrl(made);
			})
			.catch(() => {
				if (!disposed) setFailed(true);
			});
	});

	onCleanup(() => {
		disposed = true;
		if (made) URL.revokeObjectURL(made);
	});

	const failure = () =>
		navigator.onLine
			? "Couldn't load the preview. Download opens the file."
			: "Couldn't load the preview: you're offline.";

	return (
		<Portal>
			<div class="fixed inset-0 z-50 bg-scrim" onClick={() => props.onClose()} />
			<div
				ref={dialogEl}
				role="dialog"
				aria-modal="true"
				aria-labelledby={headingId}
				data-testid="file-preview"
				class="fixed inset-0 z-50 flex flex-col bg-sheet text-text px-4 pt-4 pb-5 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[min(780px,calc(100%-32px))] sm:h-[calc(100%-48px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-sheet sm:px-[22px] sm:pt-[18px] sm:pb-[22px] sm:shadow-float"
			>
				<div class="mb-3.5 flex items-center gap-2.5">
					<h2 id={headingId} class="mc-title min-w-0 text-[16px] [overflow-wrap:anywhere]">
						{name}
					</h2>
					<span class="shrink-0 text-muted">{fileSize(att.size)}</span>
					<span class="flex-1" />
					<a href={url} download={name} class="mc-soft shrink-0 text-text no-underline">
						Download
					</a>
					<button
						ref={closeEl}
						type="button"
						class="mc-quiet shrink-0"
						onClick={() => props.onClose()}
					>
						Close
					</button>
				</div>
				<div class="min-h-0 flex-1 overflow-auto rounded-box bg-raised p-4">
					<Switch>
						<Match when={failed()}>
							<p role="status" class="text-text">
								{failure()}
							</p>
						</Match>
						<Match when={kind === "image"}>
							<img
								data-preview-image
								src={url}
								alt={`Preview of ${name}`}
								class="mc-paper mx-auto block max-w-full"
								onError={() => setFailed(true)}
							/>
						</Match>
						<Match when={blobUrl()}>
							{(src) => (
								<iframe
									src={src()}
									title={name}
									// Out of the tab order: the viewer would keep Tab and Escape (lib/dialog.ts).
									tabIndex={-1}
									class="mc-paper block h-full min-h-[60vh] w-full border-0"
								/>
							)}
						</Match>
						<Match when={kind === "pdf"}>
							<p role="status" class="text-muted">
								Loading preview…
							</p>
						</Match>
					</Switch>
				</div>
			</div>
		</Portal>
	);
};

export default PdfPreview;
