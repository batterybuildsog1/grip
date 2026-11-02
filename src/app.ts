import { Hono } from "hono";
import { accessMiddleware } from "@/middleware/access";
import { authMiddleware } from "@/middleware/auth";
import mileageRoutes from "@/mileage/routes";
import accountRoutes from "@/routes/account";
import adminRoutes from "@/routes/admin";
import agentRoutes from "@/routes/agent";
import { authPublicRoutes, authRoutes } from "@/routes/auth";
import classifierRoutes from "@/routes/classifier";
import conversationsRoutes from "@/routes/conversations";
import devicesRoutes from "@/routes/devices";
import emailRoutes from "@/routes/emails";
import entitiesRoutes from "@/routes/entities";
import exportRoutes from "@/routes/export";
import healthRoutes from "@/routes/health";
import metaRoutes from "@/routes/meta";
import notesRoutes from "@/routes/notes";
import publicRoutes from "@/routes/public";
import pushRoutes from "@/routes/push";
import sendersRoutes from "@/routes/senders";
import type { AppVariables } from "@/types";
import { ERR } from "@/utils/http";
import { createRequestId, getRequestContext, logError, logInfo, logWarn } from "@/utils/logging";
import { getAllowedOrigins } from "@/utils/platform";
import { consumeApiRateLimit } from "@/utils/rate-limit";

const app = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();

app.use("*", async (c, next) => {
	const requestId = createRequestId();
	const startedAt = Date.now();
	c.set("requestId", requestId);

	await next();

	c.header("X-Request-Id", requestId);

	if (c.req.path.startsWith("/api/")) {
		logInfo("request_completed", {
			...getRequestContext(c),
			status: c.res.status,
			duration_ms: Date.now() - startedAt,
		});
	}
});

app.use("/api/*", async (c, next) => {
	const origin = c.req.header("Origin");
	const allowedOrigins = getAllowedOrigins(c.env);
	const isAllowedOrigin = Boolean(origin && allowedOrigins.includes(origin));

	if (c.req.method === "OPTIONS") {
		const headers = new Headers();
		headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
		headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
		headers.set("Vary", "Origin");

		if (isAllowedOrigin && origin) {
			headers.set("Access-Control-Allow-Origin", origin);
		}

		return new Response(null, { status: 204, headers });
	}

	await next();

	if (isAllowedOrigin && origin) {
		c.header("Access-Control-Allow-Origin", origin);
		c.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
		c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
		c.header("Vary", "Origin");
	}
});

// Health check (no auth)
app.route("/", healthRoutes);
app.route("/", publicRoutes);
// Login and the set-password link (no auth; login is throttled in src/database/login-attempts.ts)
app.route("/", authPublicRoutes);

// Mileage has a separate optional store and explicit owner/scoped credential boundary.
app.route("/api/mileage", mileageRoutes);

// Auth middleware for all API routes after health: one principal per request
app.use("/api/*", authMiddleware);
// What a signed-in user may reach (operator routes, grants)
app.use("/api/*", accessMiddleware);

app.use("/api/*", async (c, next) => {
	const token = c.get("authToken");

	if (!token) {
		logWarn("rate_limit_skipped", {
			...getRequestContext(c),
			reason: "missing_auth_token",
		});
		await next();
		return;
	}

	const result = consumeApiRateLimit(token);
	if (!result.allowed) {
		c.header("Retry-After", String(result.retryAfter));
		logWarn("rate_limited", {
			...getRequestContext(c),
			scope: "api",
			retry_after: result.retryAfter,
		});
		return c.json(ERR("RATE_LIMITED", "Too many requests"), 429);
	}

	await next();
});

// API responses are per caller: never cached by the browser or anything between.
app.use("/api/*", async (c, next) => {
	await next();
	if (c.req.method === "GET" && c.res.ok && !c.res.headers.has("Cache-Control")) {
		c.header("Cache-Control", "private, no-store");
	}
});

app.route("/", authRoutes);
app.route("/", accountRoutes);
// Email routes
app.route("/", exportRoutes);
app.route("/", emailRoutes);
app.route("/", conversationsRoutes);
app.route("/", metaRoutes);
app.route("/", pushRoutes);
app.route("/", devicesRoutes);
app.route("/", agentRoutes);
app.route("/", classifierRoutes);
app.route("/", adminRoutes);
app.route("/", sendersRoutes);
app.route("/", entitiesRoutes);
app.route("/", notesRoutes);

// 404
app.notFound((c) => {
	return c.json(ERR("NOT_FOUND", "Route not found"), 404);
});

// Error handler
app.onError((err, c) => {
	logError("unhandled_error", {
		...getRequestContext(c),
		error: err.message,
	});
	return c.json(ERR("INTERNAL_ERROR", err.message), 500);
});

export default app;
