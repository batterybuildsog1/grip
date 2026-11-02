import { flushLocalComposeDrafts } from "./db";

/**
 * Cloudflare Access fronts the web app. When its session ends, every same-origin request
 * 302s to the Access login on another origin, and fetch() reports that only as "Failed to fetch",
 * so Retry can never succeed. A page load is the one request the browser lets follow that
 * redirect: reload once to land on the login page, which sends the user back here afterwards.
 * While a compose window is open or other text is typed, nothing reloads on its own: the app is
 * told instead (SIGNED_OUT_EVENT / RELOAD_BLOCKED_EVENT). Compose windows are written to this
 * device first, so the user's "Sign in" / "Reload" (reloadKeepingDrafts) brings them back.
 */
const LAST_RELOAD_KEY = "mailclaw-edge-login-reload";
export const SIGNED_OUT_EVENT = "mailclaw:signed-out";
export const RELOAD_BLOCKED_EVENT = "mailclaw:reload-blocked";
/** A reload was refused: an open compose window is not kept on this device (storage failed). */
export const DRAFT_NOT_KEPT_EVENT = "mailclaw:draft-not-kept";
let lastSignedOutNotice = 0;

export function hasUnsavedText(): boolean {
	if (document.querySelector("[data-compose-window-id]")) return true;
	return Array.from(document.querySelectorAll("textarea")).some((el) => el.value.trim() !== "");
}

export async function reloadIfEdgeLoginNeeded(): Promise<void> {
	let res: Response;
	try {
		res = await fetch("/api/health", {
			redirect: "manual",
			cache: "no-store",
			credentials: "same-origin",
		});
	} catch {
		return; // offline, not signed out
	}
	if (res.type !== "opaqueredirect") return;
	if (hasUnsavedText()) {
		await flushLocalComposeDrafts();
		if (Date.now() - lastSignedOutNotice < 60_000) return;
		lastSignedOutNotice = Date.now();
		window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
		return;
	}
	const last = Number(sessionStorage.getItem(LAST_RELOAD_KEY) ?? 0);
	if (Date.now() - last < 60_000) return;
	sessionStorage.setItem(LAST_RELOAD_KEY, String(Date.now()));
	window.location.reload();
}

/**
 * Reload after writing every open compose window to this device (they reopen after the load).
 * If any window could not be kept (storage full or blocked, files over the cap and unsaved),
 * nothing reloads: DRAFT_NOT_KEPT_EVENT tells the user, and the open window stays the copy.
 */
export async function reloadKeepingDrafts(): Promise<boolean> {
	if (!(await flushLocalComposeDrafts())) {
		window.dispatchEvent(new Event(DRAFT_NOT_KEPT_EVENT));
		return false;
	}
	window.location.reload();
	return true;
}

/**
 * The Retry of a view that failed to load. Reloads, unless a compose window is open or text is
 * typed: then the drafts are written to this device and RELOAD_BLOCKED_EVENT lets the user choose.
 */
export async function reloadUnlessUnsaved(): Promise<void> {
	if (hasUnsavedText()) {
		await flushLocalComposeDrafts();
		window.dispatchEvent(new Event(RELOAD_BLOCKED_EVENT));
		return;
	}
	window.location.reload();
}
