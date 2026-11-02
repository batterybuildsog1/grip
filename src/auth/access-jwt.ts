/**
 * Cloudflare Access application tokens (ticket 09, 2026-10-22). The web UI sits behind Access, so
 * every browser request already carries the person's identity as a JWT signed by the team. The
 * Pages proxy forwards it as `Cf-Access-Jwt-Assertion`; this module decides whether to believe it.
 *
 * Believed only when all hold: RS256, signed by a key in the team's JWKS, `iss` is the team,
 * `aud` holds this app's tag (ACCESS_AUD), unexpired, and it names exactly one of a person
 * (`email`) or a service token (`common_name`). Anything else is refused; nothing throws.
 * Failure modes: tests/access-login.test.ts.
 */

export interface AccessConfig {
	/** https://<team>.cloudflareaccess.com */
	teamDomain: string;
	/** The Access application's AUD tag. */
	aud: string;
}

export type AccessIdentity =
	| { kind: "person"; email: string; issuedAt: number; expiresAt: number }
	| { kind: "service"; commonName: string; issuedAt: number; expiresAt: number };

export type AccessVerdict = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

type Jwks = { keys?: unknown[] };

/** Both settings, or null: the Access path is then off and every JWT is refused. */
export function accessConfig(env: {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}): AccessConfig | null {
	const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "") ?? "";
	const aud = env.ACCESS_AUD?.trim() ?? "";
	if (!aud || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain)) return null;
	return { teamDomain, aud };
}

/** At the web origin: the JWT Access adds as a header, else its CF_Authorization cookie. */
export function accessJwt(request: Request): string | null {
	const header = request.headers.get("Cf-Access-Jwt-Assertion");
	if (header) return header;
	const match = (request.headers.get("Cookie") || "").match(
		/(?:^|;\s*)CF_Authorization=([A-Za-z0-9_.-]+)/,
	);
	return match ? match[1] : null;
}

const SIGNED_ATTACHMENT = /^\/api\/public\/attachments\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The only requests the web origin (ui/functions/_middleware.ts) serves without a verified Access
 * JWT, matching Access's two bypass apps exactly: the service worker script (browsers fetch it
 * without cookies) and a signed attachment link (mailed to recipients). Access matches its bypass
 * paths loosely (case, trailing slash, encoded traversal), so the origin is the boundary: an exact,
 * case-sensitive path, no query, and a token of base64url.base64url (no '%', '/' or '..').
 */
export function isPublicWithoutAccess(method: string, url: URL): boolean {
	if (url.search !== "") return false;
	if (url.pathname === "/sw.js") return method === "GET" || method === "HEAD";
	return method === "GET" && SIGNED_ATTACHMENT.test(url.pathname);
}

// The team's signing keys, per isolate (review 2026-10-22 finding 2):
// - A successful refresh REPLACES the team's key set, so a key Cloudflare removed is distrusted at
//   once. A refresh that yields no importable key is not a success and changes nothing.
// - A known key's set is refreshed once it is 10 minutes old, so a removal takes effect within
//   10 minutes (+ the 60 s throttle) even when no new kid shows up.
// - If refreshes keep failing, a set is trusted for at most 1 hour after its last success; then
//   every JWT is refused until Cloudflare's JWKS answers again (fail closed).
// - An unknown kid refetches at most once a minute (forged kids can't turn requests into
//   fetches), and concurrent requests share one fetch (single flight).
const REFETCH_MS = 60_000;
const REFRESH_AFTER_MS = 10 * 60_000;
const MAX_SET_AGE_MS = 60 * 60_000;
const keySets = new Map<string, { keys: Map<string, CryptoKey>; fetchedAt: number }>();
const lastFetch = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

export function resetJwksCacheForTests() {
	keySets.clear();
	lastFetch.clear();
	inflight.clear();
}

async function defaultFetchJwks(url: string): Promise<Jwks> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`JWKS ${res.status}`);
	return (await res.json()) as Jwks;
}

async function loadKeys(
	teamDomain: string,
	now: number,
	fetchJwks: (url: string) => Promise<Jwks>,
): Promise<void> {
	lastFetch.set(teamDomain, now);
	let jwks: Jwks;
	try {
		jwks = await fetchJwks(`${teamDomain}/cdn-cgi/access/certs`);
	} catch {
		return;
	}
	const next = new Map<string, CryptoKey>();
	for (const entry of Array.isArray(jwks?.keys) ? jwks.keys : []) {
		const jwk = entry as { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown };
		if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
		// RSA modulus of at least 2048 bits (342 base64url chars) and a base64url exponent.
		if (typeof jwk.n !== "string" || !/^[A-Za-z0-9_-]{342,}$/.test(jwk.n)) continue;
		if (typeof jwk.e !== "string" || !/^[A-Za-z0-9_-]{1,8}$/.test(jwk.e)) continue;
		try {
			const key = await crypto.subtle.importKey(
				"jwk",
				{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
			next.set(jwk.kid, key);
		} catch {
			// A key that doesn't import verifies nothing.
		}
	}
	if (next.size > 0) keySets.set(teamDomain, { keys: next, fetchedAt: now });
}

/** One refresh per team at a time, at most once a minute. */
async function refresh(
	teamDomain: string,
	now: number,
	fetchJwks: (url: string) => Promise<Jwks>,
): Promise<void> {
	const pending = inflight.get(teamDomain);
	if (pending) return pending;
	if (now - (lastFetch.get(teamDomain) ?? Number.NEGATIVE_INFINITY) < REFETCH_MS) return;
	const load = loadKeys(teamDomain, now, fetchJwks).finally(() => inflight.delete(teamDomain));
	inflight.set(teamDomain, load);
	return load;
}

async function keyFor(
	teamDomain: string,
	kid: string,
	now: number,
	fetchJwks: (url: string) => Promise<Jwks>,
): Promise<CryptoKey | null> {
	const set = keySets.get(teamDomain);
	if (!set || !set.keys.has(kid) || now - set.fetchedAt >= REFRESH_AFTER_MS) {
		await refresh(teamDomain, now, fetchJwks);
	}
	const current = keySets.get(teamDomain);
	if (!current || now - current.fetchedAt >= MAX_SET_AGE_MS) return null;
	return current.keys.get(kid) ?? null;
}

function base64UrlBytes(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlJson(value: string): Record<string, unknown> | null {
	const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}

const refuse = (reason: string): AccessVerdict => ({ ok: false, reason });
// Clock skew allowed for iat and nbf in the future (Cloudflare's clock vs the isolate's). exp has
// no grace: an expired token is refused at its exp.
const SKEW_MS = 60_000;

/** A JWT NumericDate as milliseconds, or null unless it is a finite, safe number of seconds. */
function numericDate(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const ms = value * 1000;
	return Number.isSafeInteger(Math.round(ms)) ? ms : null;
}

export async function verifyAccessJwt(
	token: string,
	config: AccessConfig,
	options: { now?: number; fetchJwks?: (url: string) => Promise<Jwks> } = {},
): Promise<AccessVerdict> {
	const now = options.now ?? Date.now();
	const parts = token.split(".");
	if (parts.length !== 3) return refuse("malformed");
	let header: Record<string, unknown> | null;
	let claims: Record<string, unknown> | null;
	let signature: Uint8Array;
	try {
		header = base64UrlJson(parts[0]);
		claims = base64UrlJson(parts[1]);
		signature = base64UrlBytes(parts[2]);
	} catch {
		return refuse("malformed");
	}
	if (!header || !claims) return refuse("malformed");
	if (header.alg !== "RS256" || typeof header.kid !== "string") return refuse("alg");

	const key = await keyFor(
		config.teamDomain,
		header.kid,
		now,
		options.fetchJwks ?? defaultFetchJwks,
	);
	if (!key) return refuse("unknown_key");
	let valid = false;
	try {
		valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			signature,
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		);
	} catch {
		valid = false;
	}
	if (!valid) return refuse("signature");

	if (claims.iss !== config.teamDomain) return refuse("iss");
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(config.aud)) return refuse("aud");
	const expiresAt = numericDate(claims.exp);
	const issuedAt = numericDate(claims.iat);
	if (expiresAt === null || expiresAt <= now) return refuse("expired");
	if (issuedAt === null || issuedAt > now + SKEW_MS || issuedAt >= expiresAt) return refuse("iat");
	if (claims.nbf !== undefined) {
		const notBefore = numericDate(claims.nbf);
		if (notBefore === null || notBefore > now + SKEW_MS) return refuse("nbf");
	}

	const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
	// Exact: the service mapping matches common_name byte for byte.
	const commonName = typeof claims.common_name === "string" ? claims.common_name : "";
	if (email && !commonName) {
		return {
			ok: true,
			identity: {
				kind: "person",
				email,
				issuedAt,
				expiresAt,
			},
		};
	}
	if (commonName && !email) {
		return {
			ok: true,
			identity: {
				kind: "service",
				commonName,
				issuedAt,
				expiresAt,
			},
		};
	}
	return refuse("identity");
}
