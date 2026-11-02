import { createId } from "@paralleldrive/cuid2";
import { Hono } from "hono";
import { ownerKey } from "@/auth/principal";
import type { AppVariables } from "@/types";
import { now } from "@/utils/helpers";
import { ERR, OK } from "@/utils/http";
import { getRequestContext, logError, logInfo } from "@/utils/logging";

const push = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();

/** Return the public VAPID key so the browser can subscribe. */
push.get("/api/push/vapid-key", (c) => {
	const key = c.env.VAPID_PUBLIC_KEY;
	if (!key) {
		return c.json(ERR("NOT_CONFIGURED", "VAPID keys are not configured"), 503);
	}
	return c.json(OK({ key }));
});

/** Store a push subscription for the caller (keyed by owner, src/auth/principal.ts). */
push.post("/api/push/subscribe", async (c) => {
	const workspaceId = ownerKey(c);

	let body: { endpoint: string; keys: { p256dh: string; auth: string } };
	try {
		body = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
		return c.json(ERR("INVALID_BODY", "Missing endpoint or keys (p256dh, auth)"), 400);
	}

	const id = createId();
	const createdAt = now();

	try {
		await c.env.D1.prepare(
			`INSERT INTO push_subscriptions (id, workspace_id, endpoint, p256dh, auth, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (endpoint) DO UPDATE SET
				 workspace_id = excluded.workspace_id,
				 p256dh = excluded.p256dh,
				 auth = excluded.auth,
				 created_at = excluded.created_at`,
		)
			.bind(id, workspaceId, body.endpoint, body.keys.p256dh, body.keys.auth, createdAt)
			.run();

		logInfo("push_subscribed", {
			...getRequestContext(c),
			workspace_id: workspaceId,
		});

		return c.json(OK({ id }));
	} catch (err) {
		logError("push_subscribe_failed", {
			...getRequestContext(c),
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(ERR("D1_ERROR", "Failed to store subscription"), 500);
	}
});

/** Remove a push subscription by endpoint. */
push.post("/api/push/unsubscribe", async (c) => {
	let body: { endpoint: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	if (!body.endpoint) {
		return c.json(ERR("INVALID_BODY", "Missing endpoint"), 400);
	}

	try {
		const result = await c.env.D1.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
			.bind(body.endpoint)
			.run();

		logInfo("push_unsubscribed", {
			...getRequestContext(c),
			deleted: result.meta.changes > 0,
		});

		return c.json(OK({ deleted: result.meta.changes > 0 }));
	} catch (err) {
		logError("push_unsubscribe_failed", {
			...getRequestContext(c),
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(ERR("D1_ERROR", "Failed to remove subscription"), 500);
	}
});

export default push;
