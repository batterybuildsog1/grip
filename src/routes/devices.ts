import { Hono } from "hono";
import { z } from "zod";
import { getUser } from "@/auth/principal";
import type { AppVariables } from "@/types";
import { ERR, OK } from "@/utils/http";

const devices = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();
const identity = z.object({
	token: z
		.string()
		.regex(/^[a-fA-F0-9]{64,200}$/)
		.refine((value) => value.length % 2 === 0)
		.transform((value) => value.toLowerCase()),
	env: z.enum(["sandbox", "production"]),
});
const registration = identity.extend({ platform: z.enum(["ios", "macos"]) });

devices.use("/api/devices", async (c, next) => {
	const user = getUser(c);
	if (!user || user.session.kind !== "app")
		return c.json(ERR("APP_SESSION_REQUIRED", "Sign in with the native app"), 403);
	await next();
});

devices.post("/api/devices", async (c) => {
	const input = registration.safeParse(await c.req.json().catch(() => null));
	if (!input.success) return c.json(ERR("INVALID_BODY", "Invalid device registration"), 400);
	const user = getUser(c);
	if (!user) return c.json(ERR("APP_SESSION_REQUIRED", "Sign in with the native app"), 403);
	const { token, env, platform } = input.data;
	const now = Date.now();
	await c.env.D1.prepare(`INSERT INTO device_tokens (account, token, env, platform, session_id, created_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (token, env) DO UPDATE SET account=excluded.account, platform=excluded.platform,
   session_id=excluded.session_id, last_seen=excluded.last_seen`)
		.bind(user.email, token, env, platform, user.session.id, now, now)
		.run();
	return c.json(OK({ registered: true }));
});

devices.delete("/api/devices", async (c) => {
	const input = identity.safeParse(await c.req.json().catch(() => null));
	if (!input.success) return c.json(ERR("INVALID_BODY", "Invalid device registration"), 400);
	const user = getUser(c);
	if (!user) return c.json(ERR("APP_SESSION_REQUIRED", "Sign in with the native app"), 403);
	const result = await c.env.D1.prepare(
		"DELETE FROM device_tokens WHERE token=? AND env=? AND account=? AND session_id=?",
	)
		.bind(input.data.token, input.data.env, user.email, user.session.id)
		.run();
	return c.json(OK({ deleted: (result.meta.changes ?? 0) > 0 }));
});
export default devices;
