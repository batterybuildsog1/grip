/**
 * Cloudflare Pages Function — same-origin API proxy (ticket 09, 2026-10-22).
 *
 * Who is calling is Cloudflare Access's answer, not ours: the origin middleware
 * (functions/_middleware.ts) has already verified the Access JWT, or the request is one of the
 * two public paths. The proxy forwards that JWT to the Worker, which maps the email to a MailClaw
 * user (src/middleware/auth.ts). The browser holds no MailClaw token; the proxy holds no secret.
 *
 * - Authorization and Cookie are never forwarded: the web is exactly the Access identity.
 * - Without a JWT only GET /api/public/attachments/<token> goes through (a signed link).
 * - CF_Authorization is SameSite=None, so a cross-site page could make the browser send it.
 *   Every request that isn't GET/HEAD must therefore come from this origin (CSRF).
 * - /api/auth/login is refused: the web signs in with Access. /api/auth/set-password stays (the
 *   one-time link sets the password the native app signs in with).
 * - The upstream path is the request's own (still percent-encoded) path, never re-joined from
 *   decoded segments, so an encoded '/' or '..' can't become a different Worker route.
 */
import { accessJwt, isPublicWithoutAccess } from "../../../src/auth/access-jwt";

interface Env {
	WORKER_URL: string; // fallback when service binding is unset
	API?: Fetcher; // service binding to the mailclaw Worker — true internal fetch, no public TLS hop
}

let apiBindingUnavailable = false;

function splitRequestInit(init?: RequestInit): [RequestInit | undefined, RequestInit | undefined] {
	const body = init?.body;
	if (!body || typeof (body as ReadableStream).tee !== "function") {
		return [init, init];
	}
	const [bindingBody, fallbackBody] = (body as ReadableStream).tee();
	return [
		{ ...init, body: bindingBody },
		{ ...init, body: fallbackBody },
	];
}

async function workerFetch(env: Env, url: string, init?: RequestInit): Promise<Response> {
	if (!env.API || apiBindingUnavailable) return fetch(url, init);
	const [bindingInit, fallbackInit] = splitRequestInit(init);
	const bindingResponse = await env.API.fetch(url, bindingInit);
	const path = new URL(url).pathname;
	// Mileage uses 503 for its intentionally optional backend/configuration.
	if (bindingResponse.status !== 503 || path === "/api/mileage" || path.startsWith("/api/mileage/"))
		return bindingResponse;
	apiBindingUnavailable = true;
	return fetch(url, fallbackInit);
}

function refuse(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ success: false, error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

export const onRequest: PagesFunction<Env> = async (context) => {
	const { request, env } = context;
	const url = new URL(request.url);
	const unsafe = request.method !== "GET" && request.method !== "HEAD";
	const jwt = accessJwt(request);

	if (!jwt && !isPublicWithoutAccess(request.method, url)) {
		return refuse(403, "ACCESS_REQUIRED", "Sign in with Cloudflare Access");
	}
	if (unsafe && request.headers.get("Origin") !== url.origin) {
		return refuse(403, "FORBIDDEN_ORIGIN", "Cross-site request refused");
	}
	if (url.pathname === "/api/auth/login") {
		return refuse(404, "NOT_FOUND", "The web signs in with Cloudflare Access");
	}

	const headers = new Headers(request.headers);
	headers.delete("Authorization");
	headers.delete("Cookie");
	headers.delete("Cf-Access-Jwt-Assertion");
	if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);

	const res = await workerFetch(
		env,
		`${env.WORKER_URL.replace(/\/$/, "")}${url.pathname}${url.search}`,
		{
			method: request.method,
			headers,
			body: unsafe ? request.body : null,
		},
	);
	const responseHeaders = new Headers(res.headers);
	responseHeaders.delete("set-cookie"); // Don't leak upstream cookies
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: responseHeaders,
	});
};
