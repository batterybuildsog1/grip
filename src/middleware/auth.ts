import type { Context, Next } from "hono";
import { accessConfig, verifyAccessJwt } from "@/auth/access-jwt";
import {
	findAccessUser,
	findSessionUser,
	isDeletedAccountToken,
	touchSession,
} from "@/database/users";
import type { AppVariables } from "@/types";
import { ERR } from "@/utils/http";
import { getRequestContext, logInfo, logWarn } from "@/utils/logging";
import { tokensMatch } from "@/utils/platform";

type AppContext = Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>;

/**
 * Resolves exactly one principal per request (src/auth/principal.ts). Anything else is 401/403.
 *
 * - `Authorization: Bearer` decides alone: API_TOKEN, or a native-app session token.
 * - Otherwise `Cf-Access-Jwt-Assertion` (the web: the Pages proxy forwards the Access JWT):
 *   a verified person with a users row. The service token's JWT is not a person (agents use
 *   API_TOKEN), and a person Access lets in without a MailClaw account gets nothing.
 */
export async function authMiddleware(c: AppContext, next: Next) {
	const authHeader = c.req.header("Authorization");

	if (!authHeader) {
		const jwt = c.req.header("Cf-Access-Jwt-Assertion");
		const config = accessConfig(c.env);
		if (jwt && config) return accessPerson(c, next, jwt, config);
	}

	if (!authHeader?.startsWith("Bearer ")) {
		logWarn("auth_failed", {
			...getRequestContext(c),
			reason: "missing_or_invalid_authorization_header",
		});
		return c.json(ERR("UNAUTHORIZED", "Missing or invalid Authorization header"), 401);
	}

	const token = authHeader.slice(7);
	c.set("authToken", token);

	// API_TOKEN is a privileged super-token used by scripts, CLI, and cross-site integrations.
	// See docs/ROTATION.md.
	if (c.env.API_TOKEN && tokensMatch(token, c.env.API_TOKEN)) {
		c.set("principal", { kind: "api" });
		await next();
		return;
	}

	// Rotation grace: the old API_TOKEN keeps working while consumers are
	// moved over. Every use is logged so stragglers can be found; delete
	// the secret to end the grace period (docs/ROTATION.md).
	if (c.env.API_TOKEN_PREVIOUS && tokensMatch(token, c.env.API_TOKEN_PREVIOUS)) {
		logWarn("auth_previous_api_token", {
			...getRequestContext(c),
			user_agent: c.req.header("User-Agent") ?? null,
			origin: c.req.header("Origin") ?? null,
		});
		c.set("principal", { kind: "api" });
		await next();
		return;
	}

	// A signed-in native app (ticket 09): the bearer its password sign-in returned.
	const user = token.length >= 32 ? await findSessionUser(c.env.D1, token) : null;
	if (user) {
		c.set("principal", { kind: "user", user });
		c.executionCtx.waitUntil(touchSession(c.env.D1, user).catch(() => {}));
		await next();
		return;
	}

	// v64: a session of an account being deleted says so (the app treats it as done).
	if (token.length >= 32 && (await isDeletedAccountToken(c.env.D1, token))) {
		return c.json(ERR("ACCOUNT_DELETED", "This account is being deleted"), 401);
	}

	logWarn("auth_failed", {
		...getRequestContext(c),
		reason: "invalid_token",
	});
	return c.json(ERR("UNAUTHORIZED", "Invalid token"), 401);
}

async function accessPerson(
	c: AppContext,
	next: Next,
	jwt: string,
	config: NonNullable<ReturnType<typeof accessConfig>>,
) {
	const verdict = await verifyAccessJwt(jwt, config);
	if (!verdict.ok) {
		logWarn("auth_failed", { ...getRequestContext(c), reason: `access_jwt_${verdict.reason}` });
		return c.json(ERR("UNAUTHORIZED", "Invalid Cloudflare Access token"), 401);
	}
	const { identity } = verdict;
	// A service token is a person only when ACCESS_SERVICE_TOKENS_JSON names it (e.g. a token
	// that lets browser E2Es open a real user's mailbox).
	const email =
		identity.kind === "person" ? identity.email : serviceTokenUser(c.env, identity.commonName);
	if (!email) {
		logWarn("auth_failed", { ...getRequestContext(c), reason: "access_service_token" });
		return c.json(
			ERR(
				"NOT_A_PERSON",
				"A Cloudflare Access service token is not a person; agents use API_TOKEN",
			),
			403,
		);
	}
	const row = await findAccessUser(c.env.D1, email);
	if (!row) {
		logInfo("access_no_account", { ...getRequestContext(c), email });
		return c.json(ERR("NO_ACCOUNT", `${email} has no MailClaw account`), 403);
	}
	if (row.disabled_at !== null) {
		return c.json(ERR("ACCOUNT_DELETED", "This account is being deleted"), 403);
	}
	// "Sign out everywhere" ends browsers. A mapped token mints a fresh JWT per request: revoke it by
	// removing its ACCESS_SERVICE_TOKENS_JSON entry (docs/ROTATION.md), not in Access alone.
	if (
		identity.kind === "person" &&
		row.signed_out_at !== null &&
		identity.issuedAt <= row.signed_out_at
	) {
		return c.json(ERR("SIGNED_OUT", "Signed out everywhere. Sign in again."), 401);
	}
	const { signed_out_at: _signedOut, disabled_at: _disabled, ...user } = row;
	const viaService = identity.kind === "service";
	c.set("principal", {
		kind: "user",
		user: {
			...user,
			session: {
				id: viaService ? `access_service:${identity.commonName}` : `access:${user.id}`,
				kind: viaService ? "access_service" : "access",
				borrowed: false,
				expires_at: identity.expiresAt,
				last_seen_at: Date.now(),
				issued_at: identity.issuedAt,
			},
		},
	});
	if (viaService) {
		logInfo("access_service_token_as_user", {
			...getRequestContext(c),
			common_name: identity.commonName,
		});
	}
	// The API rate limiter keys on this: one bucket per person, one per mapped token.
	c.set("authToken", viaService ? `access_service:${identity.commonName}` : `access:${user.id}`);
	await next();
}

/**
 * ACCESS_SERVICE_TOKENS_JSON: {"<service token client id>": "<users.email>"}. The key is the
 * JWT's common_name, matched exactly. Anything unparsable admits nothing.
 */
function serviceTokenUser(env: CloudflareBindings, commonName: string): string | null {
	if (!env.ACCESS_SERVICE_TOKENS_JSON) return null;
	try {
		const map = JSON.parse(env.ACCESS_SERVICE_TOKENS_JSON) as unknown;
		if (!map || typeof map !== "object" || Array.isArray(map)) return null;
		if (!Object.hasOwn(map, commonName)) return null;
		const email = (map as Record<string, unknown>)[commonName];
		return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
	} catch {
		return null;
	}
}
