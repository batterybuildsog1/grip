import { logError, logInfo } from "@/utils/logging";

interface PushSubscriptionRow {
	id: string;
	workspace_id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	created_at: number;
}

/**
 * Build a VAPID Authorization header (JWT signed with the private key).
 * This is the minimal VAPID implementation for Cloudflare Workers using
 * crypto.subtle — no external libraries needed.
 */
async function buildVapidAuth(
	endpoint: string,
	vapidPublicKey: string,
	vapidPrivateKey: string,
): Promise<{ authorization: string; cryptoKey: string }> {
	const audience = new URL(endpoint).origin;

	// JWT header
	const header = { typ: "JWT", alg: "ES256" };

	// JWT payload — valid for 12 hours
	const payload = {
		aud: audience,
		exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
		sub: "mailto:push@mailclaw.app",
	};

	const encodeBase64Url = (data: Uint8Array): string => {
		let binary = "";
		for (const byte of data) {
			binary += String.fromCharCode(byte);
		}
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	};

	const textToBase64Url = (text: string): string => {
		return encodeBase64Url(new TextEncoder().encode(text));
	};

	// Import VAPID private key as ECDSA P-256
	const rawPrivateKey = Uint8Array.from(
		atob(vapidPrivateKey.replace(/-/g, "+").replace(/_/g, "/")),
		(c) => c.charCodeAt(0),
	);

	// Build JWK from raw 32-byte private key + 65-byte public key
	const rawPublicKey = Uint8Array.from(
		atob(vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/")),
		(c) => c.charCodeAt(0),
	);

	// The public key is 65 bytes (uncompressed point: 0x04 + 32-byte x + 32-byte y)
	const x = encodeBase64Url(rawPublicKey.slice(1, 33));
	const y = encodeBase64Url(rawPublicKey.slice(33, 65));
	const d = encodeBase64Url(rawPrivateKey);

	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		x,
		y,
		d,
	};

	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);

	// Sign the JWT
	const unsignedToken = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		new TextEncoder().encode(unsignedToken),
	);

	// Convert DER signature to raw r||s (64 bytes) — crypto.subtle returns raw for ECDSA
	const jwt = `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;

	// VAPID public key in uncompressed URL-safe base64
	const cryptoKey = vapidPublicKey.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

	return {
		authorization: `vapid t=${jwt}, k=${cryptoKey}`,
		cryptoKey,
	};
}

/**
 * Send an empty push notification to a single subscription.
 * An empty push (no payload) triggers the service worker push event,
 * which then fetches the latest email info to display the notification.
 * This avoids the complexity of Web Push payload encryption (ECDH + HKDF + AES-GCM).
 */
async function sendEmptyPush(
	subscription: PushSubscriptionRow,
	vapidPublicKey: string,
	vapidPrivateKey: string,
): Promise<{ ok: boolean; expired: boolean }> {
	try {
		const { authorization } = await buildVapidAuth(
			subscription.endpoint,
			vapidPublicKey,
			vapidPrivateKey,
		);

		const response = await fetch(subscription.endpoint, {
			method: "POST",
			headers: {
				Authorization: authorization,
				TTL: "86400",
				"Content-Length": "0",
				"Content-Type": "application/octet-stream",
			},
			body: new Uint8Array(0),
		});

		if (response.status === 201 || response.status === 202) {
			return { ok: true, expired: false };
		}

		// 404 or 410 means the subscription is expired/invalid — safe to delete
		if (response.status === 404 || response.status === 410) {
			logInfo("push_subscription_expired", {
				subscription_id: subscription.id,
				status: response.status,
			});
			return { ok: false, expired: true };
		}

		// Other errors (429 rate limit, 500 server error) are transient — don't delete
		logError("push_send_failed", {
			subscription_id: subscription.id,
			status: response.status,
			body: await response.text().catch(() => ""),
		});
		return { ok: false, expired: false };
	} catch (err) {
		logError("push_send_error", {
			subscription_id: subscription.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ok: false, expired: false };
	}
}

/**
 * Send push notifications to all subscriptions for a workspace.
 * Expired/invalid subscriptions are automatically cleaned up.
 */
export async function notifyWorkspacePush(
	d1: D1Database,
	workspaceId: string,
	vapidPublicKey: string,
	vapidPrivateKey: string,
): Promise<{ sent: number; failed: number; cleaned: number }> {
	const { results } = await d1
		.prepare("SELECT * FROM push_subscriptions WHERE workspace_id = ?")
		.bind(workspaceId)
		.all<PushSubscriptionRow>();

	if (!results || results.length === 0) {
		return { sent: 0, failed: 0, cleaned: 0 };
	}

	let sent = 0;
	let failed = 0;
	const expiredIds: string[] = [];

	await Promise.all(
		results.map(async (sub) => {
			const result = await sendEmptyPush(sub, vapidPublicKey, vapidPrivateKey);
			if (result.ok) {
				sent++;
			} else {
				failed++;
				// Only delete truly expired subscriptions (404/410), not transient failures
				if (result.expired) {
					expiredIds.push(sub.id);
				}
			}
		}),
	);

	// Clean up expired subscriptions
	let cleaned = 0;
	if (expiredIds.length > 0) {
		try {
			const placeholders = expiredIds.map(() => "?").join(", ");
			const result = await d1
				.prepare(`DELETE FROM push_subscriptions WHERE id IN (${placeholders})`)
				.bind(...expiredIds)
				.run();
			cleaned = result.meta.changes;
		} catch {
			// Non-critical — will be cleaned up on next push attempt
		}
	}

	logInfo("push_notify_complete", {
		workspace_id: workspaceId,
		subscriptions: results.length,
		sent,
		failed,
		cleaned,
	});

	return { sent, failed, cleaned };
}
