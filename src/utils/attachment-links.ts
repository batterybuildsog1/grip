export interface AttachmentDownloadPayload {
	key: string;
	filename: string;
	mime_type: string;
	size: number;
	exp: number;
}

export type AttachmentTokenVerification =
	| { ok: true; payload: AttachmentDownloadPayload }
	| { ok: false; reason: "missing_secret" | "malformed" | "expired" | "invalid_signature" };

function getAttachmentLinkSecret(env: CloudflareBindings): string | null {
	return env.ATTACHMENT_LINK_SECRET || env.API_TOKEN || env.VAPID_PRIVATE_KEY || null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function encodeJsonPayload(payload: AttachmentDownloadPayload): string {
	return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeJsonPayload(value: string): AttachmentDownloadPayload | null {
	try {
		const raw = new TextDecoder().decode(base64UrlToBytes(value));
		const payload = JSON.parse(raw) as Partial<AttachmentDownloadPayload>;
		if (
			!payload ||
			typeof payload.key !== "string" ||
			typeof payload.filename !== "string" ||
			typeof payload.mime_type !== "string" ||
			typeof payload.size !== "number" ||
			typeof payload.exp !== "number"
		) {
			return null;
		}
		return payload as AttachmentDownloadPayload;
	} catch {
		return null;
	}
}

async function sign(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	return bytesToBase64Url(new Uint8Array(signature));
}

function timingSafeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) {
		diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return diff === 0;
}

export async function createAttachmentDownloadToken(
	env: CloudflareBindings,
	payload: AttachmentDownloadPayload,
): Promise<string> {
	const secret = getAttachmentLinkSecret(env);
	if (!secret) throw new Error("Attachment link signing secret is not configured");
	const encodedPayload = encodeJsonPayload(payload);
	const signature = await sign(secret, encodedPayload);
	return `${encodedPayload}.${signature}`;
}

export async function verifyAttachmentDownloadToken(
	env: CloudflareBindings,
	token: string,
): Promise<AttachmentTokenVerification> {
	const secret = getAttachmentLinkSecret(env);
	if (!secret) return { ok: false, reason: "missing_secret" };

	const [encodedPayload, receivedSignature, extra] = token.split(".");
	if (!encodedPayload || !receivedSignature || extra !== undefined) {
		return { ok: false, reason: "malformed" };
	}

	const expectedSignature = await sign(secret, encodedPayload);
	if (!timingSafeEqual(receivedSignature, expectedSignature)) {
		return { ok: false, reason: "invalid_signature" };
	}

	const payload = decodeJsonPayload(encodedPayload);
	if (!payload?.key) return { ok: false, reason: "malformed" };
	if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };

	return { ok: true, payload };
}
