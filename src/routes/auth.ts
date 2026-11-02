/**
 * Accounts and login (ticket 09).
 *
 * The web signs in with Cloudflare Access (src/auth/access-jwt.ts); passwords are for clients that
 * don't pass Access: the native app.
 *
 * Public (mounted before the auth middleware; login has its own throttle, v67):
 *   POST /api/auth/login          {email, password} -> {token, session, user} (a 90-day app session)
 *   POST /api/auth/set-password   {token, password} (the one-time link)            -> {email}
 * Signed in:
 *   GET  /api/auth/me             who is calling
 *   POST /api/auth/logout         end this app session (the web signs out of Access instead)
 *   POST /api/auth/logout-all     "Sign out everywhere": every app session, and every browser's
 *                                 Access JWT issued until now
 *   POST /api/auth/password       {password}: the web's App password (Access sign-ins only) -> {emails}
 * Operator (API_TOKEN or an admin; `mailclaw admin user ...`):
 *   GET    /api/admin/users
 *   POST   /api/admin/users       {email, name?, is_admin?, owner_key?, grants} -> set-password link
 *   POST   /api/admin/users/:email/password-link
 *   DELETE /api/admin/users/:email
 *
 * Passwords and tokens are never logged or returned, except the new session token (to its
 * owner) and the link (to the operator).
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
	type Grant,
	getPrincipal,
	getUser,
	hashPassword,
	isPrivileged,
	MIN_PASSWORD_LENGTH,
	SESSION_MS,
	verifyPassword,
} from "@/auth/principal";
import { admitLogin, loginKeys } from "@/database/login-attempts";
import {
	claimPasswordLink,
	createPasswordLink,
	createSession,
	createUser,
	deleteUser,
	getLoginUser,
	getUserSummary,
	listUsers,
	revokeSession,
	revokeUserSessions,
	setAppPassword,
	setPassword,
} from "@/database/users";
import type { AppVariables } from "@/types";
import { ERR, OK } from "@/utils/http";
import { getRequestContext, logInfo, logWarn } from "@/utils/logging";

type Env = { Bindings: CloudflareBindings; Variables: AppVariables };
type AppContext = Context<Env>;

/** Where set-password links point: the web UI's /set-password screen. */
const WEB_URL = ""; // No operator origin: relative links until UI_ORIGIN is set.
const MAX_PASSWORD_LENGTH = 1024;

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const emailSchema = z
	.string()
	.trim()
	.min(3)
	.max(254)
	.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Not an email address");

const loginSchema = z.object({
	email: z.string().max(254),
	password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const setPasswordSchema = z.object({
	token: z.string().min(16).max(200),
	password: z.string().max(MAX_PASSWORD_LENGTH),
});

const appPasswordSchema = z.object({ password: z.string().max(MAX_PASSWORD_LENGTH) }).strict();

const grantSchema = z.object({
	kind: z.enum(["all", "address", "for_person"]),
	value: z.string().trim().max(254).optional(),
});

const createUserSchema = z.object({
	email: emailSchema,
	name: z.string().trim().max(120).optional(),
	is_admin: z.boolean().optional(),
	owner_key: z.string().trim().min(1).max(64).optional(),
	grants: z.array(grantSchema).max(20).default([]),
});

/** JSON bodies only: an HTML form cannot send application/json cross-site (login CSRF). */
export async function readJson<T>(
	c: AppContext,
	schema: z.ZodType<T>,
): Promise<{ data: T } | { response: Response }> {
	const type = c.req.header("Content-Type") ?? "";
	if (!/^application\/json\b/i.test(type)) {
		return {
			response: c.json(
				ERR("UNSUPPORTED_MEDIA_TYPE", "Send JSON (Content-Type: application/json)"),
				415,
			),
		};
	}
	const body = await c.req.json().catch(() => undefined);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		return {
			response: c.json(ERR("INVALID_BODY", parsed.error.issues[0]?.message ?? "Invalid body"), 400),
		};
	}
	return { data: parsed.data };
}

/** 429 LOGIN_THROTTLED (login and account deletion's password check share the counters). */
export function throttled(c: AppContext, retryAfter: number, event: string) {
	c.header("Retry-After", String(retryAfter));
	logWarn(event, { ...getRequestContext(c), retry_after: retryAfter });
	return c.json(ERR("LOGIN_THROTTLED", "Too many wrong passwords. Try again later."), 429);
}

function linkUrl(token: string, uiOrigin: string | undefined) {
	return `${(uiOrigin || WEB_URL).replace(/\/+$/, "")}/set-password#token=${token}`;
}

// --- Public -----------------------------------------------------------------------------------

export const authPublicRoutes = new Hono<Env>();

/**
 * The native app's sign-in. The throttle (src/database/login-attempts.ts) reserves a try before any
 * password work, keyed by the typed address whether or not it has an account, so an absent address
 * answers exactly like a present one (same statuses, Retry-After and work: one counter batch, one
 * read, one PBKDF2; a failure writes nothing else). The session is fenced on the hash checked.
 */
authPublicRoutes.post("/api/auth/login", async (c) => {
	const parsed = await readJson(c, loginSchema);
	if ("response" in parsed) return parsed.response;
	const body = parsed.data;
	const email = normalizeEmail(body.email);
	const now = Date.now();
	const keys = await loginKeys(email, c.req.header("CF-Connecting-IP"));
	const admission = await admitLogin(c.env.D1, keys, now);
	if (!admission.allowed) return throttled(c, admission.retryAfter, "login_throttled");

	const user = await getLoginUser(c.env.D1, email);
	const passwordHash = user?.password_hash ?? null;
	if (!(await verifyPassword(body.password, passwordHash)) || !user || !passwordHash) {
		logWarn("login_failed", { ...getRequestContext(c), user_id: user?.id ?? null });
		return c.json(ERR("INVALID_CREDENTIALS", "Wrong email or password"), 401);
	}

	// v64: an account being deleted never signs in again (checked after the password, so a
	// wrong guess learns nothing).
	if (user.disabled_at !== null) {
		logWarn("login_refused_deleted", { ...getRequestContext(c), user_id: user.id });
		return c.json(ERR("ACCOUNT_DELETED", "This account is being deleted"), 403);
	}

	const kind = "app";
	const borrowed = false;
	const session = await createSession(
		c.env.D1,
		{
			userId: user.id,
			passwordHash,
			kind,
			borrowed,
			name: c.req.header("User-Agent")?.slice(0, 160) ?? null,
			ttlMs: SESSION_MS,
			attempts: keys,
		},
		now,
	);
	if (!session) {
		// The password changed (or a deletion began) while this login was checking the old one.
		logWarn("login_superseded", { ...getRequestContext(c), user_id: user.id });
		return c.json(ERR("INVALID_CREDENTIALS", "Wrong email or password"), 401);
	}
	logInfo("login", { ...getRequestContext(c), user_id: user.id, session_id: session.id, kind });
	return c.json(
		OK({
			token: session.token,
			session: { id: session.id, kind, borrowed, expires_at: session.expires_at },
			user: { email: user.email, name: user.name, is_admin: user.is_admin },
		}),
	);
});

authPublicRoutes.post("/api/auth/set-password", async (c) => {
	const parsed = await readJson(c, setPasswordSchema);
	if ("response" in parsed) return parsed.response;
	const { token, password } = parsed.data;
	if (password.length < MIN_PASSWORD_LENGTH) {
		return c.json(ERR("WEAK_PASSWORD", `Use at least ${MIN_PASSWORD_LENGTH} characters`), 400);
	}
	const userId = await claimPasswordLink(c.env.D1, token);
	if (!userId) {
		return c.json(ERR("INVALID_LINK", "This link has expired or was already used"), 400);
	}
	const email = await setPassword(c.env.D1, userId, await hashPassword(password));
	logInfo("password_set", { ...getRequestContext(c), user_id: userId });
	return c.json(OK({ email }));
});

// --- Signed in --------------------------------------------------------------------------------

export const authRoutes = new Hono<Env>();

authRoutes.get("/api/auth/me", (c) => {
	const principal = getPrincipal(c);
	if (principal?.kind !== "user") return c.json(OK({ principal: principal?.kind ?? null }));
	const { user } = principal;
	return c.json(
		OK({
			principal: "user",
			user: { email: user.email, name: user.name, is_admin: user.is_admin },
			grants: user.grants,
			session: {
				id: user.session.id,
				kind: user.session.kind,
				borrowed: user.session.borrowed,
				expires_at: user.session.expires_at,
			},
		}),
	);
});

authRoutes.post("/api/auth/logout", async (c) => {
	const user = getUser(c);
	if (!user) return c.json(ERR("NOT_A_SESSION", "Only a signed-in session can sign out"), 400);
	const revoked = await revokeSession(c.env.D1, user.session.id);
	logInfo("logout", { ...getRequestContext(c), user_id: user.id, session_id: user.session.id });
	return c.json(OK({ revoked }));
});

authRoutes.post("/api/auth/logout-all", async (c) => {
	const user = getUser(c);
	if (!user) return c.json(ERR("NOT_A_SESSION", "Only a signed-in session can sign out"), 400);
	const revoked = await revokeUserSessions(c.env.D1, user.id);
	logInfo("logout_all", { ...getRequestContext(c), user_id: user.id, revoked });
	return c.json(OK({ revoked }));
});

/**
 * The web's App password (account menu, /app-password): a person Cloudflare Access just verified
 * sets the password the native app signs in with, so nobody needs an operator's link. Access
 * sign-ins only: an app bearer or a service token can't change it (a stolen app session can't lock
 * its owner out), and the API token mints links instead. The owner's goes on every owner address
 * (setAppPassword), so the app opens Mileage whichever address the browser signed in with.
 */
authRoutes.post("/api/auth/password", async (c) => {
	const user = getUser(c);
	if (!user) return c.json(ERR("NOT_A_SESSION", "Only a person sets an app password"), 400);
	if (user.session.kind !== "access") {
		return c.json(
			ERR("WEB_SIGN_IN_REQUIRED", "Set the app password on the web, signed in as yourself"),
			403,
		);
	}
	const parsed = await readJson(c, appPasswordSchema);
	if ("response" in parsed) return parsed.response;
	const { password } = parsed.data;
	if (password.length < MIN_PASSWORD_LENGTH) {
		return c.json(ERR("WEAK_PASSWORD", `Use at least ${MIN_PASSWORD_LENGTH} characters`), 400);
	}
	const emails = await setAppPassword(c.env.D1, user, await hashPassword(password));
	logInfo("app_password_set", {
		...getRequestContext(c),
		user_id: user.id,
		addresses: emails.length,
	});
	return c.json(OK({ emails }));
});

// --- Operator ---------------------------------------------------------------------------------

function requireOperator(c: AppContext): Response | null {
	return isPrivileged(c)
		? null
		: c.json(ERR("FORBIDDEN", "Needs the API token or an administrator"), 403);
}

authRoutes.get("/api/admin/users", async (c) => {
	const denied = requireOperator(c);
	if (denied) return denied;
	return c.json(OK({ users: await listUsers(c.env.D1) }));
});

authRoutes.post("/api/admin/users", async (c) => {
	const denied = requireOperator(c);
	if (denied) return denied;
	const parsed = await readJson(c, createUserSchema);
	if ("response" in parsed) return parsed.response;
	const body = parsed.data;

	const grants: Grant[] = [];
	for (const grant of body.grants) {
		if (grant.kind === "address") {
			return c.json(
				ERR("GRANT_NOT_SUPPORTED", "Address grants are not built yet (ticket 09: hires)"),
				400,
			);
		}
		const value = grant.kind === "all" ? "" : (grant.value ?? "");
		if (grant.kind === "for_person" && !value) {
			return c.json(ERR("INVALID_BODY", "A for_person grant needs a person's name"), 400);
		}
		if (!grants.some((g) => g.kind === grant.kind && g.value === value)) {
			grants.push({ kind: grant.kind, value });
		}
	}

	const email = normalizeEmail(body.email);
	const id = await createUser(c.env.D1, {
		email,
		name: body.name || null,
		is_admin: body.is_admin === true,
		owner_key: body.owner_key ?? null,
		grants,
	});
	if (!id) return c.json(ERR("USER_EXISTS", `${email} already has an account`), 409);
	const link = await createPasswordLink(c.env.D1, id);
	logInfo("user_created", {
		...getRequestContext(c),
		user_id: id,
		grants,
		is_admin: body.is_admin === true,
	});
	return c.json(
		OK({
			user: await getUserSummary(c.env.D1, email),
			set_password_url: linkUrl(link.token, c.env.UI_ORIGIN),
			link_expires_at: link.expires_at,
		}),
		201,
	);
});

authRoutes.post("/api/admin/users/:email/password-link", async (c) => {
	const denied = requireOperator(c);
	if (denied) return denied;
	const user = await getUserSummary(c.env.D1, normalizeEmail(c.req.param("email")));
	if (!user) return c.json(ERR("NOT_FOUND", "No such user"), 404);
	const link = await createPasswordLink(c.env.D1, user.id);
	logInfo("password_link_issued", { ...getRequestContext(c), user_id: user.id });
	return c.json(
		OK({
			email: user.email,
			set_password_url: linkUrl(link.token, c.env.UI_ORIGIN),
			link_expires_at: link.expires_at,
		}),
	);
});

authRoutes.delete("/api/admin/users/:email", async (c) => {
	const denied = requireOperator(c);
	if (denied) return denied;
	const email = normalizeEmail(c.req.param("email"));
	if (!(await deleteUser(c.env.D1, email))) return c.json(ERR("NOT_FOUND", "No such user"), 404);
	logInfo("user_deleted", { ...getRequestContext(c), email });
	return c.json(OK({ email, deleted: true }));
});
