import { type Component, For } from "solid-js";
import { Portal } from "solid-js/web";
import { useDialogFocus } from "../lib/dialog";
import { keysWords } from "./mileage/format";
import { shownCompanies } from "./mileage/store";

interface ShortcutHelpProps {
	onClose: () => void;
	/** Mileage's keys instead of the mail's (CLEAN-SPEC: the hints moved here from the screen). */
	mileage?: boolean;
}

/** 1 2 3 name the latest report's first three companies, the ones they file to. */
const mileageKeys = (): [string, string][] => [
	["y", "Yes, file the agent's guess"],
	["s", "Skip this question"],
	["1 2 3", keysWords(shownCompanies())],
	["Enter", "File it"],
	["j / k", "Next / previous trip"],
	["u or Esc", "Back to the month"],
	["⌫", "Delete the trip (5 seconds to undo)"],
	["/", "Search trips"],
	["[", "Show or hide the sidebar"],
	["?", "This list"],
];

const KEYS: [string, string][] = [
	["j / k", "Next / previous conversation (the rail follows while reading)"],
	["o or Enter", "Open: the list folds into the rail"],
	["u or Esc", "Back to the list"],
	["e", "Archive (in a thread: the next conversation opens)"],
	["#", "Trash (in Trash: Delete forever, after a confirm)"],
	["Shift U", "Mark unread"],
	["r / Shift A / f", "Reply / Reply all / Forward"],
	["c", "New message"],
	["/ or ⌘K", "Search"],
	["x", "Select"],
	["[", "Show or hide the sidebar"],
	["z", "Undo"],
	["?", "This list"],
];

/** The keyboard (design r2 `ShortcutHelp`, L3): opened by "?" or "Shortcuts" in the column. */
const ShortcutHelp: Component<ShortcutHelpProps> = (props) => {
	let dialog: HTMLDivElement | undefined;
	let close: HTMLButtonElement | undefined;
	useDialogFocus(() => dialog, { onClose: () => props.onClose(), initial: () => close });

	return (
		<Portal>
			<div class="fixed inset-0 z-50 bg-scrim" aria-hidden="true" onClick={() => props.onClose()} />
			<div
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-label="Keyboard shortcuts"
				class="fixed left-1/2 top-1/2 z-50 max-h-[calc(100%-48px)] w-[min(560px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-sheet bg-sheet px-[22px] pb-[22px] pt-[18px] text-text shadow-float"
			>
				<div class="mb-3.5 flex items-center gap-2.5">
					<h2 class="mc-title text-[16px]">Keyboard</h2>
					<span class="flex-1" />
					<button ref={close} type="button" class="mc-quiet" onClick={() => props.onClose()}>
						Close
					</button>
				</div>
				<dl class="m-0 grid grid-cols-[140px_1fr] gap-x-3.5 gap-y-[9px]">
					<For each={props.mileage ? mileageKeys() : KEYS}>
						{([key, what]) => (
							<>
								<dt class="text-right">
									<kbd>{key}</kbd>
								</dt>
								<dd class="m-0">{what}</dd>
							</>
						)}
					</For>
				</dl>
			</div>
		</Portal>
	);
};

export default ShortcutHelp;
