import { onCleanup, onMount } from "solid-js";

// Frames are left out: a browser's PDF viewer inside one keeps Tab in its own controls and then
// hands it to the browser, and Escape no longer reaches the page (web-r1-01/02/03).
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not(iframe)';

/**
 * Keyboard focus for a modal dialog (shortcut help, file preview, Delete forever): focus moves in
 * on open (to `initial`, else the first control), Tab and Shift+Tab stay inside, Esc closes, and
 * focus returns to whatever had it before. While it is open no key reaches the mail shortcuts
 * behind it (e, #, j, z, [). A list row drawn again meanwhile or just after (a refresh changed it)
 * is found by its id, so focus returns to the same control in it, never to <body> (web-r2-02).
 */
export function useDialogFocus(
	dialog: () => HTMLElement | undefined,
	options: { onClose: () => void; initial?: () => HTMLElement | undefined },
): void {
	let opener: HTMLElement | null = null;
	/** The opener's list row (data-id) and its label, to find it again if the row is redrawn. */
	let openerRow: string | null = null;
	let openerLabel = "";

	/** The opener, or the same control in its row drawn again, or that row's first control. */
	const returnTarget = (): HTMLElement | null => {
		if (opener?.isConnected) return opener;
		if (!openerRow) return null;
		const row = [...document.querySelectorAll<HTMLElement>("[data-id]")].find(
			(el) => el.dataset.id === openerRow,
		);
		const controls = row ? [...row.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
		return controls.find((el) => el.textContent?.trim() === openerLabel) ?? controls[0] ?? null;
	};

	const onKey = (e: KeyboardEvent) => {
		const el = dialog();
		if (!el) return;
		e.stopPropagation();
		if (e.key === "Escape") {
			e.preventDefault();
			options.onClose();
			return;
		}
		if (e.key !== "Tab") return;
		const stops = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
			(node) => node.offsetParent !== null || node === document.activeElement,
		);
		if (stops.length === 0) {
			e.preventDefault();
			return;
		}
		// Every Tab is moved here, not left to the browser: WebKit tabs only to fields by default, and
		// would leave the dialog from a button (web-r1-03).
		e.preventDefault();
		const at = stops.indexOf(document.activeElement as HTMLElement);
		const next =
			at < 0
				? e.shiftKey
					? stops.length - 1
					: 0
				: (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
		stops[next].focus();
	};

	// A click into a frame inside the dialog (the PDF viewer) takes the keyboard out of the page:
	// bring focus back to the dialog so Tab stays inside and Escape still closes it.
	const onWindowBlur = () =>
		setTimeout(() => {
			const el = dialog();
			const active = document.activeElement;
			if (!el || !(active instanceof HTMLIFrameElement) || !el.contains(active)) return;
			(options.initial?.() ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
		}, 0);

	onMount(() => {
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		openerRow = opener?.closest<HTMLElement>("[data-id]")?.dataset.id ?? null;
		openerLabel = opener?.textContent?.trim() ?? "";
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", onWindowBlur);
		requestAnimationFrame(() => {
			const el = dialog();
			const target = options.initial?.() ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
			target?.focus();
		});
	});
	onCleanup(() => {
		window.removeEventListener("keydown", onKey, true);
		window.removeEventListener("blur", onWindowBlur);
		queueMicrotask(() => {
			returnFocus();
			if (openerRow) followRow();
		});
	});

	/** Focus goes back; true when something took it. */
	const returnFocus = (): boolean => {
		const back = returnTarget();
		if (!back) return false;
		back.focus();
		if (document.activeElement === back) return true;
		// A control that can't take focus (not drawn): the nearest control around it on screen does.
		for (let el = back.parentElement; el; el = el.parentElement) {
			const near = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
				(node) => node.offsetParent !== null,
			);
			if (near) {
				near.focus();
				return true;
			}
		}
		return false;
	};

	/**
	 * The list may draw the row again just after the dialog closes (its answer landing then), and the
	 * row taking focus away with it left it on <body>. Until the person presses a key or the pointer
	 * (at most 3 s), focus found on <body> after a change goes back to the row.
	 */
	const followRow = () => {
		const observer = new MutationObserver(() => {
			const at = document.activeElement;
			if (!at || at === document.body) returnFocus();
		});
		const stop = () => {
			observer.disconnect();
			clearTimeout(timer);
			window.removeEventListener("keydown", stop, true);
			window.removeEventListener("pointerdown", stop, true);
		};
		const timer = setTimeout(stop, 3000);
		observer.observe(document.body, { childList: true, subtree: true });
		window.addEventListener("keydown", stop, true);
		window.addEventListener("pointerdown", stop, true);
	};
}
