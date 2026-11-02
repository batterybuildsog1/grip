/**
 * Web identity from Cloudflare Access (ticket 09 deletion step, 2026-10-22). Written before
 * src/auth/access-jwt.ts and the middleware change, because production can't produce these cases:
 * only Cloudflare can sign a person's Access JWT, so forged, expired and wrong-audience tokens and
 * "a real person with no MailClaw account" are proven here with a key this test generates.
 * tests/e2e/accounts.e2e.sh proves the production wiring (real JWKS, real service token).
 *
 * Failure modes:
 *   J1  garbage (not three parts, bad base64, bad JSON) throws or is accepted   -> refused, no throw
 *   J2  alg confusion: none, HS256 keyed with the public key, RS512                -> refused
 *   J3  signed by a key that isn't the team's, under the team's kid               -> refused
 *   J4  payload edited after signing (email swapped)                              -> refused
 *   J5  unknown kid: refetches JWKS without limit (amplification), or never picks up a
 *       rotated key                                                               -> one refetch per minute;
 *                                                                                    rotated key accepted
 *   J6  expired, not yet valid (nbf), or no exp/iat                               -> refused
 *   J7  aud of another Access app (string or array)                               -> refused; array with ours ok
 *   J8  iss of another team                                                       -> refused
 *   J9  ACCESS_TEAM_DOMAIN / ACCESS_AUD unset turns verification off open         -> no config, every JWT refused
 *   J10 the service token (common_name, no email) passes as a person              -> kind service
 *   J11 a token with an email and a common_name is taken as a person              -> refused
 *   J12 the JWKS fetch fails or returns junk                                      -> refused, no throw
 *   J13 email case/space differences miss the users row                           -> normalized
 *   review 2026-10-22 (findings 2, 3, 6):
 *   J14 a key Cloudflare removed stays trusted after a refresh that dropped it   -> refused at once
 *   J15 a known key is never rechecked, so a silent removal never takes effect    -> refetched after 10 min
 *   J16 a JWKS outage keeps old keys forever, or a junk JWKS wipes good keys      -> trusted <= 1 h; junk ignored
 *   J17 Infinity/-Infinity NumericDates, iat in the future or after exp          -> refused (60 s skew)
 *   M13 a captured mapped-token JWT outlives removal of its mapping               -> 403 NOT_A_PERSON
 *   Middleware
 *   M1  a person Access lets in who has no users row reads mail                   -> 403 NO_ACCOUNT
 *   M2  the service token becomes a human session                                 -> 403 NOT_A_PERSON
 *   M3  a browser still holding a JWT from before "sign out everywhere"           -> 401 SIGNED_OUT
 *   M4  a person with a row gets someone else's grants, or a password session      -> own grants, kind access
 *   M5  a bearer and a JWT together: the JWT rescues a bad bearer                  -> 401
 *   M6  an old WORKSPACES_JSON token still authenticates                          -> 401
 *   M7  Access unconfigured on the Worker: the JWT header is trusted anyway       -> 401
 *   Service tokens mapped to a user (ACCESS_SERVICE_TOKENS_JSON: e.g. a browser-test token that
 *   opens a real user's mailbox)
 *   M8  a listed token isn't admitted, or gets other grants than its user's      -> that user, kind
 *                                                                                    access_service
 *   M9  an unlisted token (or a near-miss id) is admitted                        -> 403 NOT_A_PERSON
 *   M10 a listed token whose user doesn't exist is admitted                      -> 403 NO_ACCOUNT
 *   M11 a malformed mapping crashes, or admits a token                          -> 403 NOT_A_PERSON
 *   M12 the mapping admits a person's JWT by its email, or lets a token named in
 *       the JSON as a person through without a signature                         -> unaffected / 401
 *   Pages origin boundary (review 2026-10-22 finding 1: Access's two bypass apps match paths
 *   loosely, so the origin decides what may be reached without a verified Access JWT)
 *   B1  a case, trailing-slash or suffix variant of /sw.js is served without Access  -> only GET/HEAD /sw.js
 *   B2  a variant of the attachment route is (case, prefix only, trailing slash, extra segment,
 *       encoded slash or dot, traversal, query string)                             -> only GET
 *                                                                                    /api/public/attachments/<b64url>.<b64url>
 *   B3  a write to a public path (POST /api/public/..., POST /sw.js)                -> not public
 */
import "./setup-dom";

import assert from "node:assert/strict";
import test from "node:test";
import {
	type AccessConfig,
	accessConfig,
	isPublicWithoutAccess,
	resetJwksCacheForTests,
	verifyAccessJwt,
} from "../src/auth/access-jwt";
import { authMiddleware } from "../src/middleware/auth";

const TEAM = `https://${["fixture-access-team", "cloudflareaccess", "com"].join(".")}`;
const AUD = "fixture-access-audience";
const CONFIG: AccessConfig = { teamDomain: TEAM, aud: AUD };
const NOW = Date.parse("2026-10-22T18:00:00Z");
const NOW_S = Math.floor(NOW / 1000);

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array | string) =>
	Buffer.from(typeof bytes === "string" ? enc.encode(bytes) : bytes).toString("base64url");

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };
async function rsaKey(): Promise<KeyPair> {
	return (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as KeyPair;
}
async function jwk(pair: KeyPair, kid: string) {
	const key = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	return { kid, kty: "RSA", alg: "RS256", use: "sig", n: key.n, e: key.e };
}
async function sign(
	pair: KeyPair,
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
): Promise<string> {
	const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, enc.encode(input));
	return `${input}.${b64url(new Uint8Array(sig))}`;
}

const KID = "team-kid-1";
const person = (over: Record<string, unknown> = {}) => ({
	type: "app",
	aud: [AUD],
	email: "owner@example.com",
	sub: "REPLACE_WITH_DATABASE_ID",
	iss: TEAM,
	iat: NOW_S - 600,
	exp: NOW_S + 3600,
	identity_nonce: "nonce",
	...over,
});
const service = (over: Record<string, unknown> = {}) => ({
	type: "app",
	aud: AUD,
	sub: "",
	common_name: "ca82e5aa.access",
	iss: TEAM,
	iat: NOW_S - 600,
	exp: NOW_S + 3600,
	...over,
});

async function fixture() {
	resetJwksCacheForTests();
	const team = await rsaKey();
	const rogue = await rsaKey();
	let jwks = { keys: [await jwk(team, KID)] };
	let fetches = 0;
	let failing = false;
	const fetchJwks = async (url: string) => {
		fetches++;
		assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
		if (failing) throw new Error("network down");
		return jwks;
	};
	return {
		team,
		rogue,
		fetchJwks,
		fetches: () => fetches,
		setJwks: (next: typeof jwks) => {
			jwks = next;
		},
		fail: (value: boolean) => {
			failing = value;
		},
		verify: (token: string, now = NOW) => verifyAccessJwt(token, CONFIG, { now, fetchJwks }),
	};
}

test("J1 garbage tokens are refused without throwing", async () => {
	const f = await fixture();
	for (const token of ["", "a", "a.b", "a.b.c.d", "!!!.###.$$$", `${b64url("{")}.${b64url("{}")}.x`]) {
		const verdict = await f.verify(token);
		assert.equal(verdict.ok, false, token);
	}
});

test("J2 only RS256 is accepted (no alg confusion)", async () => {
	const f = await fixture();
	const body = b64url(JSON.stringify(person()));
	const none = `${b64url(JSON.stringify({ alg: "none", kid: KID }))}.${body}.`;
	assert.equal((await f.verify(none)).ok, false);
	const pub = enc.encode(JSON.stringify(await jwk(f.team, KID)));
	const hmacKey = await crypto.subtle.importKey("raw", pub, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const hsInput = `${b64url(JSON.stringify({ alg: "HS256", kid: KID }))}.${body}`;
	const hsSig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, enc.encode(hsInput)));
	assert.equal((await f.verify(`${hsInput}.${b64url(hsSig)}`)).ok, false);
	const rs512 = await sign(f.team, { alg: "RS512", kid: KID, typ: "JWT" }, person());
	assert.equal((await f.verify(rs512)).ok, false);
});

test("J3 a key that isn't the team's is refused even under the team's kid", async () => {
	const f = await fixture();
	const forged = await sign(f.rogue, { alg: "RS256", kid: KID }, person());
	assert.equal((await f.verify(forged)).ok, false);
});

test("J4 a payload edited after signing is refused", async () => {
	const f = await fixture();
	const real = await sign(f.team, { alg: "RS256", kid: KID }, service());
	const [h, , s] = real.split(".");
	const swapped = `${h}.${b64url(JSON.stringify(person()))}.${s}`;
	assert.equal((await f.verify(swapped)).ok, false);
	assert.equal((await f.verify(real)).ok, true);
});

test("J5 unknown kids refetch at most once a minute; a rotated key is picked up", async () => {
	const f = await fixture();
	const ok = await sign(f.team, { alg: "RS256", kid: KID }, person());
	assert.equal((await f.verify(ok)).ok, true);
	assert.equal(f.fetches(), 1);
	const unknown = await sign(f.rogue, { alg: "RS256", kid: "nope" }, person());
	for (let i = 0; i < 20; i++) assert.equal((await f.verify(unknown, NOW + i)).ok, false);
	assert.ok(f.fetches() <= 2, `fetches=${f.fetches()}`);
	// Cloudflare rotates: a new kid appears in the JWKS. After the window it's fetched and accepted.
	f.setJwks({ keys: [await jwk(f.team, KID), await jwk(f.rogue, "team-kid-2")] });
	const rotated = await sign(f.rogue, { alg: "RS256", kid: "team-kid-2" }, person());
	assert.equal((await f.verify(rotated, NOW + 61_000)).ok, true);
});

test("J6 expired, not-yet-valid, and tokens without exp or iat are refused", async () => {
	const f = await fixture();
	const s = (p: Record<string, unknown>) => sign(f.team, { alg: "RS256", kid: KID }, p);
	assert.equal((await f.verify(await s(person({ exp: NOW_S - 1 })))).ok, false);
	assert.equal((await f.verify(await s(person({ nbf: NOW_S + 600 })))).ok, false);
	const noExp = person();
	delete (noExp as Record<string, unknown>).exp;
	assert.equal((await f.verify(await s(noExp))).ok, false);
	const noIat = person();
	delete (noIat as Record<string, unknown>).iat;
	assert.equal((await f.verify(await s(noIat))).ok, false);
});

test("J7 another Access app's audience is refused; an array holding ours is fine", async () => {
	const f = await fixture();
	const s = (p: Record<string, unknown>) => sign(f.team, { alg: "RS256", kid: KID }, p);
	assert.equal((await f.verify(await s(person({ aud: "other-app" })))).ok, false);
	assert.equal((await f.verify(await s(person({ aud: ["other-app"] })))).ok, false);
	assert.equal((await f.verify(await s(person({ aud: [] })))).ok, false);
	assert.equal((await f.verify(await s(person({ aud: ["other-app", AUD] })))).ok, true);
	assert.equal((await f.verify(await s(person({ aud: AUD })))).ok, true);
});

test("J8 another team's issuer is refused", async () => {
	const f = await fixture();
	const t = await sign(f.team, { alg: "RS256", kid: KID }, person({ iss: TEAM.replace("fixture-access-team", "other-fixture-team") }));
	assert.equal((await f.verify(t)).ok, false);
});

test("J9 verification is off (closed) unless both settings are present", () => {
	assert.equal(accessConfig({} as CloudflareBindings), null);
	assert.equal(accessConfig({ ACCESS_AUD: AUD } as CloudflareBindings), null);
	assert.equal(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM } as CloudflareBindings), null);
	assert.deepEqual(
		accessConfig({ ACCESS_TEAM_DOMAIN: `${TEAM}/`, ACCESS_AUD: ` ${AUD} ` } as CloudflareBindings),
		CONFIG,
	);
	// A bare team name or http:// is a misconfiguration, not a different issuer to trust.
	assert.equal(
		accessConfig({ ACCESS_TEAM_DOMAIN: TEAM.replace("https:", "http:"), ACCESS_AUD: AUD } as CloudflareBindings),
		null,
	);
});

test("J10 the service token is a service, never a person", async () => {
	const f = await fixture();
	const verdict = await f.verify(await sign(f.team, { alg: "RS256", kid: KID }, service()));
	assert.equal(verdict.ok, true);
	assert.equal(verdict.ok && verdict.identity.kind, "service");
});

test("J11 a token carrying both an email and a common_name is refused", async () => {
	const f = await fixture();
	const t = await sign(f.team, { alg: "RS256", kid: KID }, person({ common_name: "x.access" }));
	assert.equal((await f.verify(t)).ok, false);
	const empty = await sign(f.team, { alg: "RS256", kid: KID }, person({ email: "" }));
	assert.equal((await f.verify(empty)).ok, false);
});

test("J12 a failed or junk JWKS fetch refuses without throwing", async () => {
	const f = await fixture();
	f.fail(true);
	const t = await sign(f.team, { alg: "RS256", kid: KID }, person());
	assert.equal((await f.verify(t)).ok, false);
	resetJwksCacheForTests();
	const junk = await verifyAccessJwt(t, CONFIG, {
		now: NOW,
		fetchJwks: async () => ({ keys: [{ kid: KID, kty: "RSA", n: "!!", e: "AQAB" }] }),
	});
	assert.equal(junk.ok, false);
});

test("J13 the person's email is normalized", async () => {
	const f = await fixture();
	const t = await sign(f.team, { alg: "RS256", kid: KID }, person({ email: " Owner@Example.com " }));
	const verdict = await f.verify(t);
	assert.equal(verdict.ok && verdict.identity.kind === "person" && verdict.identity.email, "owner@example.com");
});

// --- Middleware --------------------------------------------------------------------------------

type Row = Record<string, unknown>;
function fakeUsersDb(rows: Row[]) {
	return {
		prepare(sql: string) {
			let params: unknown[] = [];
			const statement = {
				bind(...values: unknown[]) {
					params = values;
					return statement;
				},
				async first() {
					if (/FROM users u\b/.test(sql) && /u\.email = \?/.test(sql)) {
						return rows.find((row) => row.email === params[0]) ?? null;
					}
					if (/FROM sessions s JOIN users/.test(sql)) return null; // no password sessions
					throw new Error(`unexpected query: ${sql}`);
				},
				async run() {
					return { meta: { changes: 0 } };
				},
			};
			return statement;
		},
	} as unknown as D1Database;
}

function context(env: CloudflareBindings, headers: Record<string, string>) {
	const values = new Map<string, unknown>();
	const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
	return {
		env,
		req: {
			header: (name: string) => lower[name.toLowerCase()] ?? undefined,
			path: "/api/meta",
			method: "GET",
		},
		executionCtx: { waitUntil() {} },
		set: (key: string, value: unknown) => values.set(key, value),
		get: (key: string) => values.get(key),
		json: (body: unknown, status: number) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
	};
}

async function run(env: CloudflareBindings, headers: Record<string, string>) {
	const c = context(env, headers);
	let nextCalled = false;
	const res = await authMiddleware(c as unknown as Parameters<typeof authMiddleware>[0], async () => {
		nextCalled = true;
	});
	const body = res ? ((await res.json()) as { error?: { code?: string } }) : null;
	return { c, nextCalled, status: res?.status ?? 200, code: body?.error?.code ?? null };
}

const OWNER_ROW: Row = {
	id: "u_owner",
	email: "owner@example.com",
	name: "Owner",
	is_admin: 1,
	owner_key: "all",
	grants: JSON.stringify([{ kind: "all", value: "" }]),
	signed_out_at: null,
};
const READER_ROW: Row = {
	id: "u_reader",
	email: "robin@example.org",
	name: "Robin",
	is_admin: 0,
	owner_key: null,
	grants: JSON.stringify([{ kind: "for_person", value: "Robin" }]),
	signed_out_at: null,
};

async function middlewareFixture(rows: Row[] = [OWNER_ROW, READER_ROW]) {
	const f = await fixture();
	// The middleware fetches the JWKS itself: point the global fetch at the fixture for this test.
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) =>
		new Response(JSON.stringify(await f.fetchJwks(String(input))), {
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
	const env = {
		API_TOKEN: "admin-token",
		ACCESS_TEAM_DOMAIN: TEAM,
		ACCESS_AUD: AUD,
		WORKSPACES_JSON: JSON.stringify([
			{ id: "all", name: "All", domains: ["example.com"], token: "legacy-workspace-token" },
		]),
		D1: fakeUsersDb(rows),
	} as unknown as CloudflareBindings;
	const jwt = (p: Record<string, unknown>) => sign(f.team, { alg: "RS256", kid: KID }, p);
	return { env, jwt, restore: () => (globalThis.fetch = realFetch) };
}

// Real clock here: the middleware verifies against Date.now().
const live = (over: Record<string, unknown> = {}) =>
	person({ iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 3600, ...over });

test("M1 a person Access lets in without a MailClaw account gets 403 NO_ACCOUNT", async () => {
	const m = await middlewareFixture();
	try {
		const r = await run(m.env, { "Cf-Access-Jwt-Assertion": await m.jwt(live({ email: "stranger@example.com" })) });
		assert.equal(r.nextCalled, false);
		assert.equal(r.status, 403);
		assert.equal(r.code, "NO_ACCOUNT");
	} finally {
		m.restore();
	}
});

test("M2 the service token never becomes a human session", async () => {
	const m = await middlewareFixture();
	try {
		const now = Math.floor(Date.now() / 1000);
		const r = await run(m.env, { "Cf-Access-Jwt-Assertion": await m.jwt(service({ iat: now - 60, exp: now + 3600 })) });
		assert.equal(r.nextCalled, false);
		assert.equal(r.status, 403);
		assert.equal(r.code, "NOT_A_PERSON");
	} finally {
		m.restore();
	}
});

test("M3 a JWT issued before 'sign out everywhere' is refused with SIGNED_OUT", async () => {
	const signedOut = Date.now() - 30_000;
	const m = await middlewareFixture([{ ...OWNER_ROW, signed_out_at: signedOut }]);
	try {
		const before = await run(m.env, { "Cf-Access-Jwt-Assertion": await m.jwt(live()) });
		assert.equal(before.status, 401);
		assert.equal(before.code, "SIGNED_OUT");
		const after = await run(m.env, {
			"Cf-Access-Jwt-Assertion": await m.jwt(live({ iat: Math.floor(Date.now() / 1000) })),
		});
		assert.equal(after.nextCalled, true);
	} finally {
		m.restore();
	}
});

test("M4 a person gets their own row's grants and an access session", async () => {
	const m = await middlewareFixture();
	try {
		const r = await run(m.env, { "Cf-Access-Jwt-Assertion": await m.jwt(live({ email: "robin@example.org" })) });
		assert.equal(r.nextCalled, true);
		const principal = r.c.get("principal") as { kind: string; user: { id: string; grants: unknown; session: { kind: string } } };
		assert.equal(principal.kind, "user");
		assert.equal(principal.user.id, "u_reader");
		assert.deepEqual(principal.user.grants, [{ kind: "for_person", value: "Robin" }]);
		assert.equal(principal.user.session.kind, "access");
		assert.equal(r.c.get("workspace"), undefined);
	} finally {
		m.restore();
	}
});

test("M5 a valid JWT does not rescue a bad bearer", async () => {
	const m = await middlewareFixture();
	try {
		const r = await run(m.env, {
			Authorization: "Bearer not-a-token-at-all-but-long-enough-000000",
			"Cf-Access-Jwt-Assertion": await m.jwt(live()),
		});
		assert.equal(r.nextCalled, false);
		assert.equal(r.status, 401);
	} finally {
		m.restore();
	}
});

test("M6 an old WORKSPACES_JSON token no longer authenticates; API_TOKEN still does", async () => {
	const m = await middlewareFixture();
	try {
		const legacy = await run(m.env, { Authorization: "Bearer legacy-workspace-token" });
		assert.equal(legacy.nextCalled, false);
		assert.equal(legacy.status, 401);
		const api = await run(m.env, { Authorization: "Bearer admin-token" });
		assert.equal(api.nextCalled, true);
		assert.deepEqual(api.c.get("principal"), { kind: "api" });
	} finally {
		m.restore();
	}
});

test("M7 with Access unconfigured the JWT header is not trusted", async () => {
	const m = await middlewareFixture();
	try {
		const env = { ...m.env, ACCESS_AUD: undefined } as unknown as CloudflareBindings;
		const r = await run(env, { "Cf-Access-Jwt-Assertion": await m.jwt(live()) });
		assert.equal(r.nextCalled, false);
		assert.equal(r.status, 401);
	} finally {
		m.restore();
	}
});

// --- Pages origin boundary ----------------------------------------------------------------------

const TOKEN = "eyJrIjoiYXR0In0.c2lnbmF0dXJlX2J5dGVz";
const pub = (method: string, raw: string) =>
	isPublicWithoutAccess(method, new URL(raw, "https://mail.example.com"));

test("B1 only GET/HEAD /sw.js itself is public", () => {
	assert.equal(pub("GET", "/sw.js"), true);
	assert.equal(pub("HEAD", "/sw.js"), true);
	for (const path of ["/SW.JS", "/Sw.js", "/sw.js/", "/sw.jsx", "/sw.js?x=1", "/sw%2ejs", "/a/../sw.js/", "/"]) {
		assert.equal(pub("GET", path), false, path);
	}
});

test("B2 only GET /api/public/attachments/<b64url>.<b64url> is public", () => {
	assert.equal(pub("GET", `/api/public/attachments/${TOKEN}`), true);
	for (const path of [
		"/api/public",
		"/api/public/",
		"/api/publicx",
		"/api/public/attachments",
		"/api/public/attachments/",
		`/api/public/attachments/${TOKEN}/`,
		`/api/public/attachments/${TOKEN}/x`,
		`/api/public/attachments/${TOKEN}?download=1`,
		`/Api/Public/attachments/${TOKEN}`,
		`/api/public/Attachments/${TOKEN}`,
		"/api/public/attachments/abc",
		"/api/public/attachments/a.b.c",
		"/api/public/attachments/..",
		"/api/public/..%2fmeta",
		"/api/public/..%2Fmeta",
		"/api/public/%2e%2e%2f_session",
		"/api/public/%2e%2e/_session",
		"/Api/Public/..%2F_session",
		"/api/public/attachments/..%2F..%2Fmeta",
		"/api/public/attachments/a%2eb",
		"/api/public/attachments/a%2Fb.c",
		"/api/public/../meta",
		"/api/_session",
		"/api/meta",
	]) {
		assert.equal(pub("GET", path), false, path);
	}
});

test("B3 writes to public paths are not public", () => {
	for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
		assert.equal(pub(method, "/sw.js"), false, method);
		assert.equal(pub(method, `/api/public/attachments/${TOKEN}`), false, method);
	}
	assert.equal(pub("HEAD", `/api/public/attachments/${TOKEN}`), false);
});

// --- Service tokens mapped to a user ------------------------------------------------------------

const CN = "ca82e5aa.access";
const svcNow = (over: Record<string, unknown> = {}) => {
	const now = Math.floor(Date.now() / 1000);
	return service({ iat: now - 60, exp: now + 3600, ...over });
};
const withMap = (env: CloudflareBindings, value: string) =>
	({ ...env, ACCESS_SERVICE_TOKENS_JSON: value }) as unknown as CloudflareBindings;

test("M8 a listed service token acts as its user, with that user's grants", async () => {
	const m = await middlewareFixture();
	try {
		const env = withMap(m.env, JSON.stringify({ [CN]: " Owner@Example.com " }));
		const r = await run(env, { "Cf-Access-Jwt-Assertion": await m.jwt(svcNow()) });
		assert.equal(r.nextCalled, true);
		const principal = r.c.get("principal") as {
			kind: string;
			user: { id: string; email: string; grants: unknown; session: { kind: string } };
		};
		assert.equal(principal.kind, "user");
		assert.equal(principal.user.id, "u_owner");
		assert.deepEqual(principal.user.grants, [{ kind: "all", value: "" }]);
		assert.equal(principal.user.session.kind, "access_service");
		assert.notEqual(r.c.get("authToken"), "access:u_owner"); // its own rate-limit bucket
	} finally {
		m.restore();
	}
});

test("M9 an unlisted or near-miss service token is still not a person", async () => {
	const m = await middlewareFixture();
	try {
		const env = withMap(m.env, JSON.stringify({ "other.access": "owner@example.com" }));
		for (const cn of [CN, "CA82E5AA.access", `${CN} `, "ca82e5aa"]) {
			const r = await run(env, { "Cf-Access-Jwt-Assertion": await m.jwt(svcNow({ common_name: cn })) });
			assert.equal(r.nextCalled, false, cn);
			assert.equal(r.status, 403, cn);
			assert.equal(r.code, "NOT_A_PERSON", cn);
		}
	} finally {
		m.restore();
	}
});

test("M10 a listed token whose user doesn't exist gets 403 NO_ACCOUNT", async () => {
	const m = await middlewareFixture();
	try {
		const env = withMap(m.env, JSON.stringify({ [CN]: "gone@example.com" }));
		const r = await run(env, { "Cf-Access-Jwt-Assertion": await m.jwt(svcNow()) });
		assert.equal(r.nextCalled, false);
		assert.equal(r.status, 403);
		assert.equal(r.code, "NO_ACCOUNT");
	} finally {
		m.restore();
	}
});

test("M11 a malformed mapping admits nothing and throws nothing", async () => {
	const m = await middlewareFixture();
	try {
		for (const value of ["{", "[]", `["${CN}"]`, JSON.stringify({ [CN]: 42 }), JSON.stringify({ [CN]: "" }), "null"]) {
			const r = await run(withMap(m.env, value), { "Cf-Access-Jwt-Assertion": await m.jwt(svcNow()) });
			assert.equal(r.status, 403, value);
			assert.equal(r.code, "NOT_A_PERSON", value);
		}
	} finally {
		m.restore();
	}
});

test("M12 the mapping changes nothing for persons or unsigned tokens", async () => {
	const m = await middlewareFixture();
	try {
		const env = withMap(m.env, JSON.stringify({ [CN]: "owner@example.com", "robin@example.org": "owner@example.com" }));
		const reader = await run(env, { "Cf-Access-Jwt-Assertion": await m.jwt(live({ email: "robin@example.org" })) });
		const principal = reader.c.get("principal") as { user: { id: string; session: { kind: string } } };
		assert.equal(principal.user.id, "u_reader");
		assert.equal(principal.user.session.kind, "access");
		const [h, , s] = (await m.jwt(svcNow())).split(".");
		const forged = `${h}.${Buffer.from(JSON.stringify(svcNow({ common_name: CN, exp: 9_999_999_999 }))).toString("base64url")}.${s}`;
		const r = await run(env, { "Cf-Access-Jwt-Assertion": forged });
		assert.equal(r.status, 401);
	} finally {
		m.restore();
	}
});

// --- review 2026-10-22 findings 2, 3 and 6 ---------------------------------------------------

test("J14 a key removed from the JWKS is distrusted once a refresh succeeds", async () => {
	const f = await fixture();
	const a = await sign(f.team, { alg: "RS256", kid: KID }, person());
	assert.equal((await f.verify(a)).ok, true);
	f.setJwks({ keys: [await jwk(f.rogue, "team-kid-2")] }); // Cloudflare drops A, publishes B
	const b = await sign(f.rogue, { alg: "RS256", kid: "team-kid-2" }, person());
	assert.equal((await f.verify(b, NOW + 61_000)).ok, true);
	assert.equal((await f.verify(a, NOW + 62_000)).ok, false);
});

test("J15 a known key is rechecked within 10 minutes, so a silent removal takes effect", async () => {
	const f = await fixture();
	const a = await sign(f.team, { alg: "RS256", kid: KID }, person({ exp: NOW_S + 7200 }));
	assert.equal((await f.verify(a)).ok, true);
	f.setJwks({ keys: [await jwk(f.rogue, "team-kid-2")] });
	assert.equal((await f.verify(a, NOW + 5 * 60_000)).ok, true); // inside the window: cached
	assert.equal((await f.verify(a, NOW + 10 * 60_000 + 1)).ok, false); // refreshed: gone
	assert.equal(f.fetches(), 2);
});

test("J16 refreshes that keep failing leave keys trusted at most an hour; junk never wipes them", async () => {
	const f = await fixture();
	const a = await sign(f.team, { alg: "RS256", kid: KID }, person({ exp: NOW_S + 7200 }));
	assert.equal((await f.verify(a)).ok, true);
	f.fail(true);
	assert.equal((await f.verify(a, NOW + 30 * 60_000)).ok, true);
	assert.equal((await f.verify(a, NOW + 60 * 60_000 + 1)).ok, false);
	resetJwksCacheForTests();
	f.fail(false);
	assert.equal((await f.verify(a)).ok, true);
	f.setJwks({ keys: [{ kid: "x", kty: "RSA", n: "!!", e: "AQAB" }] } as never);
	assert.equal((await f.verify(a, NOW + 11 * 60_000)).ok, true); // nothing importable: keep set
});

test("J17 NumericDates must be finite; iat may not be in the future or after exp", async () => {
	const f = await fixture();
	const raw = async (payload: string) => {
		const input = `${b64url(JSON.stringify({ alg: "RS256", kid: KID }))}.${b64url(payload)}`;
		const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", f.team.privateKey, enc.encode(input));
		return `${input}.${b64url(new Uint8Array(sig))}`;
	};
	const base = JSON.stringify(person());
	assert.equal((await f.verify(await raw(base))).ok, true);
	assert.equal((await f.verify(await raw(base.replace(/"iat":\d+/, '"iat":1e309')))).ok, false);
	assert.equal((await f.verify(await raw(base.replace(/"exp":\d+/, '"exp":1e309')))).ok, false);
	assert.equal((await f.verify(await raw(base.replace(/"iat":\d+/, '"iat":-1e309')))).ok, false);
	const s = (p: Record<string, unknown>) => sign(f.team, { alg: "RS256", kid: KID }, p);
	assert.equal((await f.verify(await s(person({ iat: NOW_S + 86_400, exp: NOW_S + 3600 })))).ok, false);
	assert.equal((await f.verify(await s(person({ iat: NOW_S + 120 })))).ok, false); // beyond 60 s skew
	assert.equal((await f.verify(await s(person({ iat: NOW_S + 30 })))).ok, true); // within skew
	assert.equal((await f.verify(await s(person({ iat: NOW_S - 10, exp: NOW_S - 20 })))).ok, false);
	assert.equal((await f.verify(await s(person({ nbf: 1e309 })))).ok, false);
});

test("M13 a captured mapped-token JWT is refused as soon as the mapping is removed", async () => {
	const m = await middlewareFixture();
	try {
		const captured = await m.jwt(svcNow());
		const mapped = withMap(m.env, JSON.stringify({ [CN]: "owner@example.com" }));
		assert.equal((await run(mapped, { "Cf-Access-Jwt-Assertion": captured })).nextCalled, true);
		for (const env of [m.env, withMap(m.env, "{}")]) {
			const r = await run(env, { "Cf-Access-Jwt-Assertion": captured });
			assert.equal(r.nextCalled, false);
			assert.equal(r.status, 403);
			assert.equal(r.code, "NOT_A_PERSON");
		}
	} finally {
		m.restore();
	}
});
