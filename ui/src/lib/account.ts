/**
 * The web signs in with Cloudflare Access (ticket 09): who is using this browser is whoever Access
 * says, so signing out is Access's logout. Mail cached on the device belongs to one identity
 * (lib/identity.ts): each identity has its own IndexedDB database and its own page-cache keys, a
 * claim by someone else deletes the others' databases, and every other open tab of a previous
 * identity loses it at once (review 2026-10-22 finding 1; ui/tests/e2e/identity-isolation.spec.ts).
 */
import { closeDatabase, deleteMailDatabases } from "./db";
import { hasUnsavedText } from "./edge-login";
import {
	broadcastSigningOut,
	currentIdentity,
	identityTag,
	loseIdentity,
	OLD_CONSENT_KEY,
	OWNER_KEY,
	PAGE_CACHE_PREFIX,
	setIdentity,
} from "./identity";

export const ACCESS_LOGOUT_URL = "/cdn-cgi/access/logout";
/**
 * A sign-out was held back: a compose window is open or text is typed, and signing out deletes
 * this device's mail and drafts (lib/db.ts). App.tsx asks first ("Sign out" = force).
 */
export const SIGN_OUT_HELD_EVENT = "mailclaw:sign-out-held";
/** This tab's cached list pages, except `keep`'s (null: all). */
function dropSessionPages(keep: string | null = null): void {
	const keepPrefix = keep ? `${PAGE_CACHE_PREFIX}${identityTag(keep)}:` : null;
	try {
		const keys: string[] = [];
		for (let i = 0; i < sessionStorage.length; i++) {
			const key = sessionStorage.key(i);
			if (key?.startsWith(PAGE_CACHE_PREFIX) && !(keepPrefix && key.startsWith(keepPrefix))) {
				keys.push(key);
			}
		}
		for (const key of keys) sessionStorage.removeItem(key);
	} catch {
		// No session storage: nothing cached there.
	}
}

// Another tab took the device (or signed out): this tab's pages go with its identity.
if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key === OWNER_KEY || event.key === null) {
			if (currentIdentity() === null) dropSessionPages();
		}
	});
}

/**
 * Sign-out: this tab drops its identity first (its own loss must not reload it), forgets the
 * owner and tells the other tabs (they wipe and go to Access logout), then deletes every mail
 * database and this tab's pages. Waits at most `maxWaitMs` for databases another tab keeps open.
 */
export async function clearLocalMail(maxWaitMs = 3000): Promise<void> {
	loseIdentity("signed-out-here");
	try {
		localStorage.removeItem(OWNER_KEY);
	} catch {
		// No storage: the broadcast alone tells the other tabs.
	}
	broadcastSigningOut();
	dropSessionPages();
	try {
		sessionStorage.clear();
	} catch {
		// Ignore.
	}
	closeDatabase();
	await Promise.race([
		deleteMailDatabases(null).catch(() => {}),
		new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
	]);
}

/**
 * Call before anything reads the local cache. `identity` is the user's email plus how they signed
 * in (session kind). Another identity's cache on this device, or left in this tab, is dropped.
 */
export async function claimLocalMail(identity: string): Promise<void> {
	let owner: string | null = null;
	try {
		owner = localStorage.getItem(OWNER_KEY);
		if (owner !== identity) localStorage.setItem(OWNER_KEY, identity);
		localStorage.removeItem(OLD_CONSENT_KEY);
	} catch {
		owner = null;
	}
	setIdentity(identity);
	// Pages this tab cached under anyone else (before a reload) go, whoever owns the device now.
	dropSessionPages(identity);
	// Other identities' databases (and the pre-2026-10-22 shared one): not awaited, a tab still
	// holding one closes it when it sees the new owner (lib/db.ts `blocking`).
	void deleteMailDatabases(identity).catch(() => {});
}

/**
 * The server said this tab's account is being deleted (api/client.ts accountDeleted): its mail
 * and drafts leave this device, as the apps wipe theirs (SPEC §3). Only an
 * identity this tab claimed: refused at sign-in, nothing was claimed, and the device may hold
 * someone else's drafts. Other tabs learn it from their own next call; nothing is broadcast.
 */
export async function forgetDeletedAccount(): Promise<void> {
	if (currentIdentity() === null) return;
	loseIdentity("signed-out-here");
	dropSessionPages();
	closeDatabase();
	await deleteMailDatabases(null).catch(() => {});
}

let leaving = false;

/**
 * Empty the device's mail and drafts, then sign out of Cloudflare Access on this browser. With a
 * compose window open or text typed, nothing is deleted until the person confirms (`force`).
 */
export async function leaveForAccessLogout(options: { force?: boolean } = {}): Promise<void> {
	if (leaving) return;
	if (!options.force && hasUnsavedText()) {
		window.dispatchEvent(new Event(SIGN_OUT_HELD_EVENT));
		return;
	}
	leaving = true;
	await clearLocalMail(1500);
	window.location.assign(ACCESS_LOGOUT_URL);
}
