import { createSignal, onCleanup } from "solid-js";

const MOBILE_BREAKPOINT = 768;
/** Below this the desktop list rows take the rail's two lines (who and when, subject; WD1). */
const NARROW_BREAKPOINT = 1000;
/** Below this the column folds into the views menu, as on the phone (WD1). */
const COMPACT_BREAKPOINT = 900;

/**
 * The phone layout (one region) below 768px; the tablet band (768-999) keeps the desktop shell
 * with two-line rows, and below 900 without the column. matchMedia fires once per crossing, not on
 * every pixel of a resize: no debounce, no lag during a window drag.
 */
const mobileMQ = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
const narrowMQ = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
const compactMQ = window.matchMedia(`(max-width: ${COMPACT_BREAKPOINT - 1}px)`);

const [isMobile, setIsMobile] = createSignal(mobileMQ.matches);
const [isNarrow, setIsNarrow] = createSignal(narrowMQ.matches);
const [isCompact, setIsCompact] = createSignal(compactMQ.matches);

/** The column (views or the rail) has room: desktop at 900 px and up. */
const columnFits = () => !isCompact();

let listenerAttached = false;

export function initResponsive() {
	if (listenerAttached) return;
	listenerAttached = true;

	const onMobileChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
	const onNarrowChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
	const onCompactChange = (e: MediaQueryListEvent) => setIsCompact(e.matches);
	mobileMQ.addEventListener("change", onMobileChange);
	narrowMQ.addEventListener("change", onNarrowChange);
	compactMQ.addEventListener("change", onCompactChange);

	onCleanup(() => {
		mobileMQ.removeEventListener("change", onMobileChange);
		narrowMQ.removeEventListener("change", onNarrowChange);
		compactMQ.removeEventListener("change", onCompactChange);
		listenerAttached = false;
	});
}

export { columnFits, isCompact, isMobile, isNarrow };
