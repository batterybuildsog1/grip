/**
 * A keydown that is not a mail shortcut: typed into a field or a select (d1-07), or held with
 * Cmd/Ctrl/Alt, which are the browser's (find, reload) (d1-06). Shift stays a shortcut ("#", "A").
 */
export function notAShortcut(e: KeyboardEvent): boolean {
	if (e.metaKey || e.ctrlKey || e.altKey) return true;
	const el = e.target as HTMLElement;
	const tag = el.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Enter or Space on a button or link presses it; it is not "open the focused row" (d1-19). */
export function activatesControl(e: KeyboardEvent): boolean {
	return !!(e.target as HTMLElement).closest?.("button, a[href], [role=button], summary");
}

/**
 * Escape (or any key) while an IME is composing belongs to the composition: it cancels the
 * candidate text, not the compose window or the search (R3 F3). Safari reports keyCode 229.
 */
export function endsComposition(e: KeyboardEvent): boolean {
	return e.isComposing || e.keyCode === 229;
}
