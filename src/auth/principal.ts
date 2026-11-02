/**
 * Who is calling (ticket 09). The auth middleware resolves exactly one principal per request:
 *
 * - `api`   API_TOKEN (or API_TOKEN_PREVIOUS during a rotation): agents, the CLI, integrations.
 *           Sees everything and may use operator routes.
 * - `user`  a person. On the web, from the Cloudflare Access JWT the Pages proxy forwards
 *           (session kind `access`, src/auth/access-jwt.ts); in the native app, from the bearer
 *           its password sign-in returned (kind `app`). What they read comes from their grants;
 *           operator routes need is_admin.
 */
import type { Context } from "hono";
import type { AppVariables } from "@/types";

type AppContext = Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>;

export type GrantKind = "all" | "address" | "for_person";

export interface Grant {
	kind: GrantKind;
	value: string;
}

export interface SessionUser {
	id: string;
	email: string;
	name: string | null;
	is_admin: boolean;
	owner_key: string | null;
	grants: Grant[];
	session: {
		/** sessions.id, or `access:<user id>` on the web (no row). */
		id: string;
		kind: string;
		borrowed: boolean;
		expires_at: number;
		last_seen_at: number;
		/** When the credential was issued (ms): sessions.created_at, or the JWT's iat. */
		issued_at: number;
	};
}

export type Principal = { kind: "api" } | { kind: "user"; user: SessionUser };

export const SESSION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days (the native app's session)
export const PASSWORD_LINK_MS = 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 10;

/**
 * The owner key of the whole mailbox ("all", the old web workspace's name). The owner's users rows
 * hold it, so agent memory, compose sessions, push subscriptions and the send-key namespace stay
 * with the owner; inbound-mail push notifications go to it.
 */
export const FULL_MAILBOX_OWNER = "all";

/** Null before the auth middleware ran (public routes). */
export function getPrincipal(c: AppContext): Principal | null {
	return c.get("principal") ?? null;
}

export function getUser(c: AppContext): SessionUser | null {
	const principal = getPrincipal(c);
	return principal?.kind === "user" ? principal.user : null;
}

/** Operator routes (admin, import, memory map, sorter queue, users): API_TOKEN or an admin. */
export function isPrivileged(c: AppContext): boolean {
	const principal = getPrincipal(c);
	if (principal?.kind === "api") return true;
	return principal?.kind === "user" && principal.user.is_admin;
}

/**
 * The for_person values a restricted user may read, or null when the caller is not restricted
 * (API token, or a user with an `all` grant). An empty array means no access, which is also the
 * answer when no principal was resolved.
 */
export function restrictedPersons(c: AppContext): string[] | null {
	const principal = getPrincipal(c);
	if (principal?.kind === "api") return null;
	const user = principal?.kind === "user" ? principal.user : null;
	if (!user) return [];
	if (user.grants.some((grant) => grant.kind === "all")) return null;
	return user.grants.filter((grant) => grant.kind === "for_person").map((grant) => grant.value);
}

/** Key that agent memory/history, compose sessions and push subscriptions are stored under. */
export function ownerKey(c: AppContext): string {
	const user = getUser(c);
	return user ? (user.owner_key ?? `user:${user.id}`) : "default";
}

/**
 * Send-key namespace. A user with an owner_key ('all' for the mailbox owner) keeps the old web workspace's
 * namespace (stored as kind 'workspace'), so a key the web used before the cutover can never
 * send again.
 */
export function sendKeyScope(c: AppContext): { kind: "workspace" | "api" | "user"; id: string } {
	const user = getUser(c);
	if (!user) return { kind: "api", id: "" };
	return user.owner_key ? { kind: "workspace", id: user.owner_key } : { kind: "user", id: user.id };
}

// --- Tokens and passwords -------------------------------------------------------------------

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** An opaque 32-byte token; only its SHA-256 is stored. */
export function newToken(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Workers caps PBKDF2 at 100k iterations.
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256,
	);
	return new Uint8Array(bits);
}

/** "pbkdf2_sha256$<iterations>$<salt>$<hash>" with a per-user random salt. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Constant-time check. A missing hash still costs one derivation, so timing reveals nothing. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
	const parts = stored?.split("$") ?? [];
	const valid = parts.length === 4 && parts[0] === "pbkdf2_sha256";
	const iterations = valid ? Number(parts[1]) : PBKDF2_ITERATIONS;
	const salt = valid ? fromBase64Url(parts[2]) : new Uint8Array(16);
	const expected = valid ? fromBase64Url(parts[3]) : new Uint8Array(32);
	const actual = await pbkdf2(password, salt, iterations);
	return (
		valid && actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected)
	);
}
