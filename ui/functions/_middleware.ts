import {
	accessConfig,
	accessJwt,
	isPublicWithoutAccess,
	verifyAccessJwt,
} from "../../src/auth/access-jwt";

interface Env {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	UI_ORIGIN?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function forbidden(): Response {
	return new Response(
		JSON.stringify({
			success: false,
			error: { code: "ACCESS_REQUIRED", message: "Sign in with Cloudflare Access" },
		}),
		{ status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
	);
}

/**
 * Every request to the web origin, before the SPA fallback, static assets or the API proxy.
 *
 * 1. *.pages.dev redirects to the configured UI_ORIGIN (zone features: Early Hints, 0-RTT, cache rules).
 * 2. The origin, not Access's path matching, is the boundary (ticket 09; review 2026-10-22):
 *    without an Access JWT the origin verifies itself (src/auth/access-jwt.ts), only GET/HEAD
 *    /sw.js and GET /api/public/attachments/<token> are served; everything else is 403. A service
 *    token passes here (it can load the app shell); the Worker refuses it mail (NOT_A_PERSON).
 *    Local dev (localhost) skips the check.
 */
export const onRequest: PagesFunction<Env> = async (context) => {
	const url = new URL(context.request.url);
	if (url.hostname.endsWith(".pages.dev") && context.env.UI_ORIGIN) {
		try {
			const origin = new URL(context.env.UI_ORIGIN);
			if (
				origin.protocol !== "https:" ||
				origin.username ||
				origin.password ||
				origin.port ||
				origin.pathname !== "/" ||
				origin.search ||
				origin.hash ||
				origin.hostname.endsWith(".pages.dev")
			)
				return forbidden();
			return Response.redirect(`${origin.origin}${url.pathname}${url.search}`, 308);
		} catch {
			return forbidden();
		}
	}
	if (LOCAL_HOSTS.has(url.hostname) || isPublicWithoutAccess(context.request.method, url)) {
		return context.next();
	}
	const config = accessConfig(context.env);
	const jwt = accessJwt(context.request);
	if (!config || !jwt || !(await verifyAccessJwt(jwt, config)).ok) return forbidden();
	return context.next();
};
