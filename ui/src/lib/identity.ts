/**
 * Whose mail this tab may cache and request (ticket 09; review 2026-10-22 finding 1).
 *
 * Boot sets it once per page load from /api/auth/me (lib/account.ts claimLocalMail). The device's
 * owner marker in localStorage is shared by every tab; whenever it stops naming this tab's
 * identity (another tab signed in as someone else, or signed out), this tab LOSES its identity for
 * good: cache reads find nothing, cache writes are dropped, API calls are refused, and the app
 * reloads (App.tsx). The marker is re-read on every check, so a tab never acts on a stale identity
 * even before the `storage` event reaches it.
 */
export const OWNER_KEY = "mailclaw-account";
/** sessionStorage page-cache keys: PAGE_CACHE_PREFIX + identityTag + ":" + filters (lib/cache.ts). */
export const PAGE_CACHE_PREFIX = "mailclaw:conversation-page:";
/** localStorage: where builds before Grip 7 kept the last AI sorting answer. Removed at every claim. */
export const OLD_CONSENT_KEY = "mc-ai-consent";

/**
 * Why a tab lost its identity:
 * - "signed-out-here"       this tab is signing out (lib/account.ts): nothing to do, it is leaving
 * - "signed-out-elsewhere"  another tab is signing out: leave for Access logout too, never reclaim
 * - "other-identity"        another tab signed in as someone else: reload as them
 */
export type LossReason = "signed-out-here" | "signed-out-elsewhere" | "other-identity";

/**
 * Signing out tells every other open tab (BroadcastChannel; the owner marker's removal reaches
 * them through the storage event as a fallback). They wipe their mail and go to Access logout
 * too. Nothing persists: a tab opened later boots normally, and Access decides whether a session
 * is still there (manager 2026-10-22).
 */
const CHANNEL = "mailclaw-identity";

let identity: string | null = null;
let lost = false;
let generation = 0;
const lostListeners = new Set<(reason: LossReason) => void>();

function readOwner(): string | null | undefined {
	try {
		return localStorage.getItem(OWNER_KEY);
	} catch {
		return undefined; // no storage: nothing shared to coordinate with
	}
}

/** This tab's identity, or null before boot claimed one or after it was lost. */
export function currentIdentity(): string | null {
	if (lost || identity === null) return null;
	const owner = readOwner();
	if (owner !== undefined && owner !== identity) {
		loseIdentity(owner === null ? "signed-out-elsewhere" : "other-identity");
		return null;
	}
	return identity;
}

/** True once this tab's identity was replaced or signed out (never before boot). */
export function identityLost(): boolean {
	currentIdentity();
	return lost;
}

/** Bumps on every change; work started under one generation must not write under another. */
export function identityGeneration(): number {
	return generation;
}

export function isCurrentGeneration(started: number): boolean {
	return started === generation && currentIdentity() !== null;
}

/** Called by claimLocalMail after the owner marker names `next`. */
export function setIdentity(next: string): void {
	if (next === identity && !lost) return;
	identity = next;
	lost = false;
	generation++;
}

export function loseIdentity(reason: LossReason): void {
	if (lost || identity === null) return;
	lost = true;
	generation++;
	for (const listener of lostListeners) {
		try {
			listener(reason);
		} catch {
			// One listener failing must not stop the others from dropping their caches.
		}
	}
}

export function onIdentityLost(listener: (reason: LossReason) => void): () => void {
	lostListeners.add(listener);
	return () => lostListeners.delete(listener);
}

/**
 * The identity's namespace for database names and cache keys: the full identity string,
 * base64url-encoded. Injective, so two identities never share a namespace (a short hash did:
 * re-review 2026-10-22 B).
 */
export function identityTag(value: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let channel: BroadcastChannel | null = null;

/** Tell the other open tabs this browser is signing out. */
export function broadcastSigningOut(): void {
	channel?.postMessage({ type: "signing-out" });
}

if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key === OWNER_KEY || event.key === null) currentIdentity();
	});
	try {
		channel = new BroadcastChannel(CHANNEL);
		channel.addEventListener("message", (event) => {
			if ((event.data as { type?: string } | null)?.type === "signing-out") {
				loseIdentity("signed-out-elsewhere");
			}
		});
	} catch {
		channel = null; // no BroadcastChannel: the storage event carries it
	}
}

/**
 * Mailbox access on hold (review R2/R2b): the server answered 401 while a compose window held
 * text, so the app stays mounted for that text, but until /api/auth/me confirms this tab's own
 * identity again nothing else may reach the server (api/client.ts refuses it): the browser may
 * by then be signed in as someone else, whose mail must not paint or cache under this identity,
 * and whose account must not receive this tab's draft.
 */
let held = false;
const heldListeners = new Set<() => void>();

/**
 * Entering the hold bumps the identity generation, the same fence an identity change uses: every
 * answer already in flight (deduplicated ones included) is refused when it lands (review R2c).
 */
export function holdAccess(): void {
	if (held) return;
	held = true;
	generation++;
	for (const listener of heldListeners) {
		try {
			listener();
		} catch {
			// One listener failing must not stop the others.
		}
	}
}

/** Called when the hold starts (an active chat stream aborts). */
export function onAccessHeld(listener: () => void): () => void {
	heldListeners.add(listener);
	return () => heldListeners.delete(listener);
}

export function releaseAccess(): void {
	held = false;
}

export function accessHeld(): boolean {
	return held;
}
