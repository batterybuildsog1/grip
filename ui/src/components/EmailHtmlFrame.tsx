import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";

interface EmailHtmlFrameProps {
	/** From buildEmailFrame / buildEmailSrcdoc (carries the CSP and the size reporter). */
	srcdoc: string;
	title?: string;
	class?: string;
	initialHeight?: number;
	onHeightChange?: (height: number) => void;
	/** The document is drawn dark (the sender's own dark CSS, app in dark mode): no white canvas. */
	dark?: boolean;
	/** "Dim email": a light mail inside the dark app, toned down (NI-16). */
	dim?: boolean;
}

/** Shown until the frame's first size report; reports are trusted only within these bounds. */
const PLACEHOLDER_HEIGHT = 200;
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 200_000;

/**
 * A message's HTML in a frame that can't touch the app (round-2 spec S3). No allow-same-origin:
 * the document runs in an opaque origin, so it can't read the app's DOM, cookies or storage.
 * allow-scripts runs only the size reporter buildEmailFrame adds (its CSP pins scripts to that
 * script's nonce). Links open a new tab that leaves the sandbox; mailto:/tel: come to the app,
 * which opens the OS handler without unloading itself.
 *
 * A srcdoc document inherits the page's CSP: one without this nonce would block the reporter and
 * every frame would keep its placeholder height.
 *
 * Each document gets a new frame: a new srcdoc on a loaded frame navigates it, which adds an entry
 * to the tab's history, so after an Appearance switch (the document is rebuilt for the sender's
 * dark CSS) Back walked the frame instead of closing the thread.
 */
const EmailHtmlFrame: Component<EmailHtmlFrameProps> = (props) => {
	let frameEl!: HTMLIFrameElement;
	const [height, setHeight] = createSignal(
		Math.max(props.initialHeight ?? PLACEHOLDER_HEIGHT, MIN_HEIGHT),
	);

	const onMessage = (ev: MessageEvent) => {
		if (ev.source !== frameEl.contentWindow) return;
		const data = ev.data as { mc?: unknown; h?: unknown; href?: unknown } | null;
		if (!data || typeof data !== "object") return;
		if (data.mc === "frame-height" && typeof data.h === "number" && Number.isFinite(data.h)) {
			const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(data.h)));
			if (next === height()) return;
			setHeight(next);
			props.onHeightChange?.(next);
			return;
		}
		const href = typeof data.href === "string" ? data.href : "";
		if (data.mc === "frame-open" && /^(mailto|tel):/i.test(href)) window.location.href = href;
	};

	onMount(() => window.addEventListener("message", onMessage));
	onCleanup(() => window.removeEventListener("message", onMessage));

	return (
		<Show when={props.srcdoc} keyed>
			{(srcdoc) => (
				<iframe
					ref={frameEl}
					title={props.title ?? "Email content"}
					sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
					srcdoc={srcdoc}
					loading="lazy"
					class={`email-iframe ${props.class ?? ""}`}
					style={{
						height: `${height()}px`,
						"color-scheme": props.dark ? "dark" : "light",
						// The sender's own paper (white), unless their dark CSS is in use.
						background: props.dark ? "transparent" : "#ffffff",
						filter: props.dim ? "brightness(0.82) contrast(0.95)" : "none",
					}}
				/>
			)}
		</Show>
	);
};

export default EmailHtmlFrame;
