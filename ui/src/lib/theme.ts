/**
 * Appearance: Light (default) or Dark, the one setting of the one theme, Grip.
 * Per device, in localStorage, so it survives reload and sign-out (lib/account.ts
 * clears only the owner marker). index.html's inline script applies it before first paint; this
 * module applies a change at once, without a reload, so open drafts, threads and scroll stay.
 * A stored `mc-theme` (older builds' Theme setting) is never read, written or removed: a rollback
 * finds its own value (docs/design/failure-modes-grip-only.md GO02, GO04).
 */
export type Appearance = "light" | "dark";

export const APPEARANCES: { value: Appearance; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

const APPEARANCE_KEY = "mc-appearance";

/** --mc-frame per appearance, for the browser chrome (meta theme-color). Same as index.html's. */
const FRAME: Record<Appearance, string> = { light: "#dcd4c3", dark: "#080908" };

export function storedAppearance(): Appearance {
	try {
		return localStorage.getItem(APPEARANCE_KEY) === "dark" ? "dark" : "light";
	} catch {
		return "light";
	}
}

/** Sets <html data-mode>, .dark and the browser chrome colour. */
export function applyAppearance(appearance: Appearance): void {
	const root = document.documentElement;
	root.dataset.mode = appearance;
	root.classList.toggle("dark", appearance === "dark");
	for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
		meta.content = FRAME[appearance];
	}
}

export function saveAppearance(appearance: Appearance): void {
	try {
		localStorage.setItem(APPEARANCE_KEY, appearance);
	} catch {
		// Storage blocked: the choice lasts for this tab.
	}
	applyAppearance(appearance);
}
