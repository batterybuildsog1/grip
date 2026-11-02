/** APNs transport is independent of ingest and D1, so a future relay can reuse it.
 * No mail content is transmitted. Every recipient is checked against current grants/session. */
import { logWarn } from "@/utils/logging";

type Configuration = Pick<
	CloudflareBindings,
	"APNS_KEY_P8" | "APNS_KEY_ID" | "APNS_TEAM_ID" | "APNS_TOPIC"
>;
type Device = {
	token: string;
	env: "sandbox" | "production";
	account: string;
	session_id: string;
	last_seen: number;
};
const encode = (value: string | Uint8Array) => {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export class APNsSender {
	private jwt?: { value: string; at: number };
	private key?: Promise<CryptoKey>;
	private signing?: Promise<string>;
	constructor(
		private readonly config: Configuration,
		private readonly transport: typeof fetch = fetch,
		private readonly clock = Date.now,
	) {}
	private async authorization(): Promise<string> {
		if (this.signing) return this.signing;
		this.signing = this.createAuthorization();
		try {
			return await this.signing;
		} finally {
			this.signing = undefined;
		}
	}
	private async createAuthorization(): Promise<string> {
		const now = Math.floor(this.clock() / 1000);
		if (this.jwt && now >= this.jwt.at && now - this.jwt.at < 50 * 60) return this.jwt.value;
		if (!this.config.APNS_KEY_P8 || !this.config.APNS_KEY_ID || !this.config.APNS_TEAM_ID)
			throw new Error("APNs is not configured");
		if (!this.key) {
			const bytes = Uint8Array.from(
				atob(this.config.APNS_KEY_P8.replace(/-----[^-]+-----|\s/g, "")),
				(char) => char.charCodeAt(0),
			);
			this.key = crypto.subtle.importKey(
				"pkcs8",
				bytes,
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["sign"],
			);
		}
		const header = encode(JSON.stringify({ alg: "ES256", kid: this.config.APNS_KEY_ID }));
		const payload = encode(JSON.stringify({ iss: this.config.APNS_TEAM_ID, iat: now }));
		const message = `${header}.${payload}`;
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			await this.key,
			new TextEncoder().encode(message),
		);
		const value = `${message}.${encode(new Uint8Array(signature))}`;
		this.jwt = { value, at: now };
		return value;
	}
	async send(
		device: Pick<Device, "token" | "env" | "account">,
		messageId: string,
	): Promise<"sent" | "invalid" | "retry"> {
		try {
			const host = device.env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
			const response = await this.transport(`https://${host}/3/device/${device.token}`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(10000),
				headers: {
					authorization: `bearer ${await this.authorization()}`,
					"apns-topic": this.config.APNS_TOPIC || "",
					"apns-push-type": "alert",
					"apns-priority": "10",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					aps: {
						alert: { title: "MailClaw", body: "New message" },
						"mutable-content": 1,
						"thread-id": device.account,
					},
					account: device.account,
					messageId,
				}),
			});
			if (response.ok) return "sent";
			const body = (await response.json().catch(() => null)) as { reason?: string } | null;
			if (response.status === 410 || (response.status === 400 && body?.reason === "BadDeviceToken"))
				return "invalid";
			if (response.status === 403 && body?.reason === "ExpiredProviderToken") this.jwt = undefined;
			return "retry";
		} catch {
			return "retry";
		}
	}
}

let cached: { config: Configuration; sender: APNsSender } | undefined;
function senderFor(config: Configuration): APNsSender {
	if (
		!cached ||
		["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC"].some(
			(key) => cached?.config[key as keyof Configuration] !== config[key as keyof Configuration],
		)
	) {
		const selected = {
			APNS_KEY_P8: config.APNS_KEY_P8,
			APNS_KEY_ID: config.APNS_KEY_ID,
			APNS_TEAM_ID: config.APNS_TEAM_ID,
			APNS_TOPIC: config.APNS_TOPIC,
		};
		cached = { config: selected, sender: new APNsSender(selected) };
	}
	return cached.sender;
}

/** Only call for a newly stored live inbound delivery. Ingest owns duplicate/history filtering. */
export async function notifyNewMail(
	env: Configuration & { D1: D1Database },
	messageId: string,
	sender?: APNsSender,
): Promise<void> {
	if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return;
	try {
		const { results } =
			await env.D1.prepare(`SELECT DISTINCT d.token, d.env, d.account, d.session_id, d.last_seen
   FROM device_tokens d JOIN users u ON u.email=d.account
   JOIN sessions s ON s.id=d.session_id AND s.user_id=u.id
   JOIN emails e ON e.id=? LEFT JOIN threads t ON t.id=e.thread_id
   WHERE s.kind='app' AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled_at IS NULL
    AND e.direction='inbound' AND e.mailbox_state='inbox'
    AND EXISTS (SELECT 1 FROM user_grants g WHERE g.user_id=u.id AND
     (g.kind='all' OR (g.kind='for_person' AND g.value=t.for_person
      AND NOT EXISTS (SELECT 1 FROM emails draft WHERE draft.thread_id=t.id AND draft.mailbox_state='draft'))))`)
				.bind(messageId, Date.now())
				.all<Device>();
		const transport = sender ?? senderFor(env);
		for (let start = 0; start < results.length; start += 8) {
			await Promise.all(
				results.slice(start, start + 8).map(async (device) => {
					const outcome = await transport.send(device, messageId);
					if (outcome === "invalid") {
						// A late failure must not remove a registration rebound/refreshed during delivery.
						await env.D1.prepare(
							"DELETE FROM device_tokens WHERE token=? AND env=? AND account=? AND session_id=? AND last_seen=?",
						)
							.bind(device.token, device.env, device.account, device.session_id, device.last_seen)
							.run();
					}
				}),
			);
		}
	} catch {
		// Push never changes the outcome of committed mail. No tokens, keys or mail in logs.
		logWarn("apns_delivery_unavailable", { operation: "new_mail" });
	}
}
