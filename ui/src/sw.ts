/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, PrecacheController, PrecacheRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, NetworkOnly, StaleWhileRevalidate } from "workbox-strategies";

const API_READ_CACHE = "api-reads-swr";
const apiNetworkOnly = new NetworkOnly();

// ── Auto-activate new versions immediately ──
self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		Promise.all([
			self.clients.claim(),
			caches.delete(API_READ_CACHE),
			// Older workers' navigation cache could hold the Access login redirect, or an
			// attachment opened in a tab (/api/ navigations): drop it whole.
			caches.delete("navigations"),
		]),
	);
});

// ── Precache static assets (injected by vite-plugin-pwa) ──
// The precache never fails the install. Signed out of Cloudflare Access, every precache fetch is
// redirected to the login; a rejected install leaves the older worker in charge, and workers from
// before 2026-10-22 answer "/" from their own precache, so the browser never reaches the login and
// keeps that old web for good (a browser can stay on a weeks-old build this way). Whatever wasn't
// stored comes from the network until the next install.
const precache = new PrecacheController({
	plugins: [
		{
			handlerDidError: async ({ event }) =>
				event?.type === "install" ? Response.error() : undefined,
		},
	],
});
precache.precache(self.__WB_MANIFEST);
// No directoryIndex: "/" (the app's start URL) must not be answered with the precached
// index.html, or Cloudflare Access never sees the request and can't send an expired
// session to its login. Navigations go network-first below.
registerRoute(new PrecacheRoute(precache, { directoryIndex: "" }));
cleanupOutdatedCaches();

// ── API reads: mutable mailbox data — never cache ───────────────────────
//
// Email lists, thread detail, and meta counts must reflect recent mutations
// such as mark-read, draft save, send, category feedback, archive, and trash.
// IndexedDB handles local paint speed; the service worker stays out of the
// freshness path.

registerRoute(
	({ url, request }) => url.pathname === "/api/emails" && request.method === "GET",
	apiNetworkOnly,
);

registerRoute(
	({ url, request }) => url.pathname === "/api/conversations" && request.method === "GET",
	apiNetworkOnly,
);

registerRoute(
	({ url, request }) => /^\/api\/emails\/[^/]+$/.test(url.pathname) && request.method === "GET",
	apiNetworkOnly,
);

registerRoute(
	({ url, request }) =>
		/^\/api\/conversations\/[^/]+$/.test(url.pathname) && request.method === "GET",
	apiNetworkOnly,
);

registerRoute(
	({ url, request }) => url.pathname === "/api/meta" && request.method === "GET",
	apiNetworkOnly,
);

// ── API: auth endpoints — never cache ──
registerRoute(({ url }) => url.pathname.startsWith("/api/auth/"), new NetworkOnly());

// Mileage location summaries and exports must never enter a shared cache.
registerRoute(({ url }) => url.pathname.startsWith("/api/mileage/"), new NetworkOnly());

// ── API: push endpoints — never cache ──
registerRoute(({ url }) => url.pathname.startsWith("/api/push/"), new NetworkOnly());

// ── API: all mutations (POST, PATCH, DELETE) — never cache ──
registerRoute(
	({ url, request }) =>
		url.pathname.startsWith("/api/") && ["POST", "PATCH", "DELETE"].includes(request.method),
	new NetworkOnly(),
);

// ── Google Fonts stylesheets ──
registerRoute(
	({ url }) => url.origin === "https://fonts.googleapis.com",
	new StaleWhileRevalidate({ cacheName: "google-fonts-stylesheets" }),
);

// ── Google Fonts webfonts ──
registerRoute(
	({ url }) => url.origin === "https://fonts.gstatic.com",
	new CacheFirst({
		cacheName: "google-fonts-webfonts",
		plugins: [
			new CacheableResponsePlugin({ statuses: [0, 200] }),
			new ExpirationPlugin({
				maxEntries: 30,
				maxAgeSeconds: 60 * 60 * 24 * 365,
			}),
		],
	}),
);

// ── Navigation requests ──
registerRoute(
	new NavigationRoute(
		new NetworkFirst({
			cacheName: "pages",
			networkTimeoutSeconds: 3,
			// Only real pages: the default also keeps status 0, which would store the
			// Cloudflare Access login redirect in place of the app shell.
			plugins: [
				{ cacheWillUpdate: async ({ response }) => response.status === 200 && !response.redirected ? response : null },
				new CacheableResponsePlugin({ statuses: [200] }),
				// Offline with nothing in "pages" yet (first start after install): the precached
				// shell. Only a failed fetch lands here; an Access redirect is a response, so an
				// expired session still reaches the login.
				{ handlerDidError: async () => (await precache.matchPrecache("/index.html")) ?? undefined },
			],
		}),
		// An attachment or raw message opened in a tab is a navigation too: private, never cached.
		// Access's own pages (/cdn-cgi/access/logout) always go to the network.
		{ denylist: [/^\/api\//, /^\/cdn-cgi\//] },
	),
);

type MailClawPushPayload = {
	title: string;
	body: string;
	data: Record<string, unknown>;
};

async function resolvePushPayload(
	title: string,
	body: string,
	data: Record<string, unknown>,
): Promise<MailClawPushPayload> {
	if (body) return { title, body, data };

	try {
		const res = await fetch("/api/emails?limit=1&mailbox_state=inbox", {
			credentials: "same-origin",
		});
		const json = res.ok ? await res.json() : null;
		const email = json?.data?.emails?.[0];
		if (!email) return { title, body: "You have new mail", data };

		return {
			title: email.from_address || "New email",
			body: email.subject || "(no subject)",
			data: { ...data, emailId: email.id },
		};
	} catch {
		return { title, body: "You have new mail", data };
	}
}

async function notifyOpenMailTabs(payload: MailClawPushPayload): Promise<void> {
	const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	for (const client of clients) {
		client.postMessage({
			type: "mailclaw:new-mail",
			title: payload.title,
			body: payload.body,
			data: payload.data,
			receivedAt: Date.now(),
		});
	}
}

// ── Push notifications ──
self.addEventListener("push", (event) => {
	let title = "New email";
	let body = "";
	let data: Record<string, unknown> = {};

	if (event.data) {
		try {
			const payload = event.data.json();
			title = payload.title || title;
			body = payload.body || body;
			data = payload.data || data;
		} catch {
			// Empty or non-JSON push — fetch latest email info
		}
	}

	const handlePush = resolvePushPayload(title, body, data).then((payload) => {
		const tag = `email-${(payload.data.emailId as string) || Date.now()}`;
		return Promise.all([
			notifyOpenMailTabs(payload).catch(() => undefined),
			self.registration.showNotification(payload.title, {
				body: payload.body,
				icon: "/icon-192.png",
				tag,
				data: payload.data,
				requireInteraction: false,
			}),
		]);
	});

	event.waitUntil(handlePush);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: "window" }).then((cls) => {
			const existing = cls.find((c) => c.url.includes("/"));
			if (existing) return existing.focus();
			return self.clients.openWindow(
				event.notification.data?.emailId ? `/?email=${event.notification.data.emailId}` : "/",
			);
		}),
	);
});
