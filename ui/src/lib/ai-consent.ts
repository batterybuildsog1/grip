/**
 * AI sorting on the web: the owner's On/Off switch in Settings and the phone's Account sheet. It is on
 * unless the owner turns it off (owner decision, 2026-10-30: on by default, no consent screen), so nothing
 * asks and nothing waits for it: boot reads it in the background (App.tsx). The server is the truth: the
 * switch shows its last answer, read again as the switch appears, and moves only on a PUT's 200 body.
 * Failure list: docs/release-1.0/failure-modes-consent-web.md.
 */
import { createSignal } from "solid-js";
import { ApiHttpError, ApiNetworkError, api } from "../api/client";
import { currentIdentity } from "./identity";

export const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL || "/privacy";
export const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL || "/support";

export type ConsentState = "undecided" | "allowed" | "declined";
export interface Consent {
	state: ConsentState;
	version: number;
	can_decide: boolean;
}

/** What decide() returns after a 409: the state was read again. */
export const STALE = "stale";

const [consent, setConsent] = createSignal<Consent | null>(null);
/** The last read failed (503, offline, a Worker without the route). */
const [readFailed, setReadFailed] = createSignal(false);
export { consent, readFailed };

function parse(raw: unknown): Consent | null {
	const c = raw as Partial<Consent> | null;
	if (!c || !["undecided", "allowed", "declined"].includes(c.state as string)) return null;
	if (typeof c.version !== "number") return null;
	return { state: c.state as ConsentState, version: c.version, can_decide: c.can_decide === true };
}

/** A server answer for `identity` (the one that asked, still this tab's). */
function apply(identity: string | null, raw: unknown): void {
	const c = parse(raw);
	if (!c) throw new Error("unreadable AI sorting answer");
	if (!identity || currentIdentity() !== identity) return;
	setConsent(c);
	setReadFailed(false);
}

let reading: Promise<void> | null = null;

/** GET the state. A failure is said in Settings, with Try again. */
export function readConsent(): Promise<void> {
	if (reading) return reading;
	const identity = currentIdentity();
	reading = api
		.request<Consent>("/account/ai-consent")
		.then((c) => apply(identity, c))
		.catch(() => {
			setReadFailed(true);
		})
		.finally(() => {
			reading = null;
		});
	return reading;
}

/** Why a save failed, in a few words. */
function reason(error: unknown): string {
	if (error instanceof ApiNetworkError) return "You're offline.";
	if (error instanceof ApiHttpError) {
		const code = (error.body as { error?: { code?: string } } | undefined)?.error?.code;
		if (code === "AI_CONSENT_OWNER_ONLY") return "Only the mailbox owner can change this.";
		if (error.status === 429) return "The server is busy.";
	}
	return "Something went wrong on the server.";
}

/**
 * On / Off: PUT at the version of the server's last answer (the build holds no version of its own),
 * then show the server's own answer. Resolves to null when acknowledged, STALE after a 409 (read
 * again), or why it wasn't saved.
 */
export async function decide(allow: boolean): Promise<string | null> {
	const identity = currentIdentity();
	const known = consent();
	if (!known) return reason(null);
	try {
		const answer = await api.request<Consent>("/account/ai-consent", {
			method: "PUT",
			body: JSON.stringify({ allow, version: known.version }),
		});
		apply(identity, answer);
		return null;
	} catch (error) {
		const code =
			error instanceof ApiHttpError
				? (error.body as { error?: { code?: string } } | undefined)?.error?.code
				: undefined;
		if (code === "AI_CONSENT_STALE") {
			await readConsent();
			return STALE;
		}
		return reason(error);
	}
}
