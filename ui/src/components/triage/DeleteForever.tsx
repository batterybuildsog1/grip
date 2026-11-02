import { type Component, createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useDialogFocus } from "../../lib/dialog";
import { quotedSubject, type TriageTarget } from "../../lib/triage";

/**
 * The confirm before Delete forever (S7, WP-04): offered only inside Trash, names what it deletes,
 * Cancel has the focus. While it is open nothing behind it hears the keyboard (e, #, z, Esc).
 */
const DeleteForever: Component<{
	targets: TriageTarget[];
	onCancel: () => void;
	onConfirm: () => Promise<unknown>;
}> = (props) => {
	const [busy, setBusy] = createSignal(false);
	let cancelButton: HTMLButtonElement | undefined;
	let dialog: HTMLDivElement | undefined;

	const title = () =>
		props.targets.length === 1
			? `Delete ${quotedSubject(props.targets[0].subject)} forever?`
			: `Delete ${props.targets.length} conversations forever?`;
	const names = () =>
		props.targets.length > 1
			? `${props.targets
					.slice(0, 3)
					.map((t) => quotedSubject(t.subject))
					.join(", ")}${props.targets.length > 3 ? ` and ${props.targets.length - 3} more` : ""}.`
			: "";

	const cancel = () => {
		if (!busy()) props.onCancel();
	};
	const confirm = async () => {
		if (busy()) return;
		setBusy(true);
		try {
			await props.onConfirm();
		} finally {
			setBusy(false);
		}
	};

	useDialogFocus(() => dialog, { onClose: cancel, initial: () => cancelButton });

	return (
		<Portal>
			<div class="fixed inset-0 z-[110] bg-scrim" aria-hidden="true" />
			<div
				ref={dialog}
				role="alertdialog"
				aria-modal="true"
				aria-label="Delete forever"
				class="fixed left-1/2 top-1/2 z-[111] w-[min(440px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-sheet bg-sheet px-[22px] pb-[22px] pt-[18px] text-text shadow-float"
			>
				<h2 class="mc-title mb-1.5 text-[16px] leading-snug [overflow-wrap:anywhere]">{title()}</h2>
				<Show when={names()}>
					<p class="mb-1 text-[14px] [overflow-wrap:anywhere]">{names()}</p>
				</Show>
				<p class="text-[14px] text-muted">This can't be undone.</p>
				<div class="mt-[18px] flex justify-end gap-2">
					<button ref={cancelButton} type="button" class="mc-soft" onClick={cancel}>
						Cancel
					</button>
					<button
						type="button"
						class="rounded-control bg-neg px-3.5 py-[7px] text-neg-on disabled:opacity-60"
						style={{ "font-weight": "var(--mc-strong-weight)" }}
						disabled={busy()}
						onClick={() => void confirm()}
					>
						{busy() ? "Deleting…" : "Delete forever"}
					</button>
				</div>
			</div>
		</Portal>
	);
};

export default DeleteForever;
