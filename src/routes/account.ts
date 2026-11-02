/**
 * The signed-in person's own account (release 1.0, SPEC §2-§3; v64).
 *
 *   GET  /api/account/ai-consent   -> {state: "allowed"|"declined", version, can_decide}
 *   PUT  /api/account/ai-consent   {allow: boolean, version} (the mailbox owner only)
 *   POST /api/account/delete       {password} -> {request_id, email, requested_at, status: "pending"}
 * Operator:
 *   GET  /api/admin/deletions      open deletion requests (`?all=1` includes completed ones)
 *
 * Reachable by every signed-in person whatever their grants (src/middleware/access.ts), like
 * /api/auth/*. Passwords are never logged.
 */

import { createId } from "@paralleldrive/cuid2";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
	FULL_MAILBOX_OWNER,
	getPrincipal,
	getUser,
	isPrivileged,
	verifyPassword,
} from "@/auth/principal";
import { admitLogin, loginKeys } from "@/database/login-attempts";
import { getLoginUser } from "@/database/users";
import { readJson, throttled } from "@/routes/auth";
import {
	CONSENT_VERSION,
	canDecide,
	consentState,
	decisionStatements,
	latestDecision,
} from "@/services/ai-consent";
import { AI_PAUSED, billingConfig, usageStatement } from "@/services/ai-usage";
import type { AppVariables } from "@/types";
import { ERR, OK } from "@/utils/http";
import { getRequestContext, logError, logInfo, logWarn } from "@/utils/logging";

type Env = { Bindings: CloudflareBindings; Variables: AppVariables };
type AppContext = Context<Env>;

const consentSchema = z.object({ allow: z.boolean(), version: z.number().int() }).strict();
const deleteSchema = z.object({ password: z.string().min(1).max(1024) }).strict();

const account = new Hono<Env>();

async function consentView(c: AppContext): Promise<Response> {
	let decision: Awaited<ReturnType<typeof latestDecision>>;
	try {
		decision = await latestDecision(c.env.D1);
	} catch (error) {
		logError("ai_consent_read_failed", {
			...getRequestContext(c),
			error: error instanceof Error ? error.message : String(error),
		});
		return c.json(ERR("AI_CONSENT_UNAVAILABLE", "AI sorting settings could not be read"), 503);
	}
	return c.json(
		OK({
			state: consentState(decision),
			version: CONSENT_VERSION,
			can_decide: canDecide(getUser(c)),
		}),
	);
}

account.get("/api/account/ai-usage", async (c) => {
	if (!canDecide(getUser(c)) && !isPrivileged(c))
		return c.json(ERR("FORBIDDEN", "Only the owner can read AI usage"), 403);
	const cfg = billingConfig(c.env);
	if (!cfg) return c.json(OK({ unlimited: true, ai_sorting_state: "active" }));
	const usage = await usageStatement(c.env.D1, cfg, undefined, false);
	return c.json(
		OK({
			...usage,
			calls: undefined,
			message: usage.ai_sorting_state === "allowance_used" ? AI_PAUSED : null,
		}),
	);
});
account.get("/api/account/ai-consent", (c) => consentView(c));

account.put("/api/account/ai-consent", async (c) => {
	const user = getUser(c);
	if (!canDecide(user) || !user) {
		return c.json(
			ERR("AI_CONSENT_OWNER_ONLY", "Only the mailbox owner can change AI sorting"),
			403,
		);
	}
	const parsed = await readJson(c, consentSchema);
	if ("response" in parsed) return parsed.response;
	const { allow, version } = parsed.data;
	const current = await latestDecision(c.env.D1).catch(() => null);
	// Same effective setting: nothing to write (a redundant On would void live leases).
	if (consentState(current) !== (allow ? "allowed" : "declined")) {
		try {
			await c.env.D1.batch(
				decisionStatements(c.env.D1, {
					allow,
					userId: user.id,
					email: user.email,
					source: "owner",
					now: Date.now(),
				}),
			);
		} catch (error) {
			logError("ai_consent_write_failed", {
				...getRequestContext(c),
				error: error instanceof Error ? error.message : String(error),
			});
			return c.json(ERR("AI_CONSENT_UNAVAILABLE", "AI sorting could not be changed"), 503);
		}
		logInfo("ai_consent_decided", {
			...getRequestContext(c),
			user_id: user.id,
			state: allow ? "allowed" : "declined",
			version,
		});
	}
	return consentView(c);
});

account.post("/api/account/delete", async (c) => {
	const principal = getPrincipal(c);
	if (principal?.kind !== "user") {
		return c.json(ERR("NOT_A_SESSION", "Only a signed-in person can delete their account"), 400);
	}
	const user = principal.user;
	if (user.session.kind === "access_service") {
		return c.json(ERR("NOT_A_PERSON", "A service token cannot delete an account"), 403);
	}
	const parsed = await readJson(c, deleteSchema);
	if ("response" in parsed) return parsed.response;

	const now = Date.now();
	// The login's throttle counters (this address from this network, and from anywhere): a wrong
	// password here counts toward the same lock (v67, src/database/login-attempts.ts).
	const admission = await admitLogin(
		c.env.D1,
		await loginKeys(user.email, c.req.header("CF-Connecting-IP")),
		now,
	);
	if (!admission.allowed) return throttled(c, admission.retryAfter, "account_delete_throttled");
	const login = await getLoginUser(c.env.D1, user.email);
	if (!login) return c.json(ERR("INVALID_CREDENTIALS", "Wrong password"), 401);
	if (!(await verifyPassword(parsed.data.password, login.password_hash))) {
		logWarn("account_delete_wrong_password", { ...getRequestContext(c), user_id: login.id });
		return c.json(ERR("INVALID_CREDENTIALS", "Wrong password"), 401);
	}

	// One batch: the request, the disable, every session (and password link), web push and APNs
	// (v63 device_tokens) registrations, and for the mailbox owner AI consent off (which also
	// ends every lease).
	const db = c.env.D1;
	const pushKey = login.owner_key ?? `user:${login.id}`;
	const isOwner = login.owner_key === FULL_MAILBOX_OWNER;
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO account_deletions (id, user_id, email, owner_key, requested_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(createId(), login.id, login.email, login.owner_key, now),
		db
			.prepare(
				"UPDATE users SET disabled_at = COALESCE(disabled_at, ?), signed_out_at = ? WHERE id = ?",
			)
			.bind(now, now, login.id),
		db
			.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
			.bind(now, login.id),
		db.prepare("DELETE FROM push_subscriptions WHERE workspace_id = ?").bind(pushKey),
		db.prepare("DELETE FROM device_tokens WHERE account = ?").bind(login.email),
		...(isOwner
			? decisionStatements(db, {
					allow: false,
					userId: login.id,
					email: login.email,
					source: "account_deletion",
					now,
				})
			: []),
	]);

	// Mileage D1 is a separate database: its named-agent tokens are refused through
	// users.disabled_at already (src/mileage/auth.ts); revoking them here is belt and braces.
	if (c.env.MILEAGE_D1) {
		await c.env.MILEAGE_D1.prepare(
			"UPDATE mileage_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE owner = ?",
		)
			.bind(now, login.email)
			.run()
			.catch((error: unknown) =>
				logWarn("account_delete_mileage_tokens_failed", {
					...getRequestContext(c),
					user_id: login.id,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	}

	const request = await db
		.prepare(
			`SELECT id, email, requested_at FROM account_deletions
			 WHERE user_id = ? AND completed_at IS NULL ORDER BY requested_at LIMIT 1`,
		)
		.bind(login.id)
		.first<{ id: string; email: string; requested_at: number }>();
	logInfo("account_deletion_requested", {
		...getRequestContext(c),
		user_id: login.id,
		request_id: request?.id ?? null,
		owner: isOwner,
	});
	return c.json(
		OK({
			request_id: request?.id ?? null,
			email: login.email,
			requested_at: request?.requested_at ?? now,
			status: "pending" as const,
		}),
	);
});

account.get("/api/admin/deletions", async (c) => {
	if (!isPrivileged(c)) {
		return c.json(ERR("FORBIDDEN", "Needs the API token or an administrator"), 403);
	}
	const all = c.req.query("all") === "1";
	const { results } = await c.env.D1.prepare(
		`SELECT id, user_id, email, owner_key, requested_at, completed_at,
			requested_at + 30 * 86400000 AS due_at
		 FROM account_deletions ${all ? "" : "WHERE completed_at IS NULL"}
		 ORDER BY requested_at LIMIT 200`,
	).all<Record<string, unknown>>();
	return c.json(
		OK({
			deletions: results.map((row) => ({
				...row,
				whole_mailbox: row.owner_key === FULL_MAILBOX_OWNER,
			})),
		}),
	);
});

export default account;
