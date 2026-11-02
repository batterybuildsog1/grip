/** Manual unsubscribe only. No ingest or cron caller executes these requests. */
import { getRawEmailArtifactByEmailId } from "@/services/raw-email";
import type { EmailRecord } from "@/types";

/**
 * Parse RFC 2369 List-Unsubscribe header into its HTTPS and mailto parts.
 * Returns first matching URL for each type; null if absent.
 */
export function parseListUnsubscribe(raw: string | null | undefined): {
	url: string | null;
	mailto: string | null;
} {
	if (!raw) return { url: null, mailto: null };
	const parts = raw.match(/<[^<>]+>/g) ?? raw.split(",").map((s) => s.trim());
	let url: string | null = null;
	let mailto: string | null = null;
	for (const part of parts) {
		const m = part.match(/^<([^>]+)>$/);
		const candidate = m ? m[1] : part;
		try {
			const parsed = new URL(candidate);
			if (parsed.username || parsed.password) continue;
			if (parsed.protocol === "https:" && !url) url = parsed.toString();
			else if (parsed.protocol === "mailto:" && !mailto) mailto = parsed.toString();
		} catch {
			// An invalid list entry does not hide a later usable one.
		}
	}
	return { url, mailto };
}

const ONE_CLICK_TIMEOUT_MS = 10_000;

/**
 * RFC 8058 one-click unsubscribe: POST "List-Unsubscribe=One-Click" to the header's URL.
 * Ticket 07: https only, never follow a redirect (a 3xx is not success), 10 s timeout, and only
 * a 2xx counts as sent. Never mailto. `status` is the HTTP status when there was a response.
 */
export async function postOneClickUnsubscribe(
	url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, error: "invalid URL" };
	}
	if (parsed.protocol !== "https:") return { ok: false, error: "not https" };
	try {
		const res = await fetch(parsed.toString(), {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
			signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
		});
		if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
		return { ok: false, status: res.status, error: `HTTP ${res.status}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Read a bounded raw header when v58 is absent or older mail has not been backfilled. */
export async function readListUnsubscribePost(
	env: CloudflareBindings,
	email: EmailRecord,
): Promise<string | null> {
	if (email.list_unsubscribe_post) return email.list_unsubscribe_post;
	if (!env.ATTACHMENTS) return null;
	const { artifact, error } = await getRawEmailArtifactByEmailId(env.D1, email.id);
	if (error) throw error;
	if (!artifact || artifact.expires_at <= Date.now()) return null;
	const raw = await env.ATTACHMENTS.get(artifact.object_key, {
		range: { offset: 0, length: 64 * 1024 },
	});
	if (!raw) return null;
	const prefix = await raw.text();
	const end = prefix.search(/\r?\n\r?\n/);
	if (end < 0) return null; // Truncated headers are not consent to POST.
	const headers = prefix.slice(0, end).replace(/\r?\n[ \t]+/g, " ");
	return headers.match(/^List-Unsubscribe-Post:[ \t]*(.*)$/im)?.[1].trim() ?? null;
}

/** RFC 6068: only the URI recipient, subject and body are inputs to MailClaw's send path. */
export function unsubscribeMailto(
	uri: string,
): { to: string; subject: string; text: string } | null {
	try {
		const parsed = new URL(uri);
		if (parsed.protocol !== "mailto:") return null;
		return {
			to: decodeURIComponent(parsed.pathname),
			subject: parsed.searchParams.get("subject") || "Unsubscribe",
			text: parsed.searchParams.get("body") || "Please unsubscribe me from this mailing list.",
		};
	} catch {
		return null;
	}
}

/** Start the durable log before a side effect; a crash leaves an honest unconfirmed attempt. */
export async function startUnsubscribeDecision(
	db: D1Database,
	email: EmailRecord,
	method: string,
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO sender_unsubscribe_status (address, domain, decision, method, error, at)
		 VALUES (?, ?, 'kept', ?, 'Outcome not confirmed', ?) RETURNING id`,
		)
		.bind(email.from_address, email.domain, method, Date.now())
		.first<{ id: number }>();
	if (!row) throw new Error("Unsubscribe decision was not recorded");
	return row.id;
}

export async function finishUnsubscribeDecision(
	db: D1Database,
	id: number,
	result: { ok: boolean; status?: number; error?: string },
): Promise<void> {
	await db
		.prepare(
			"UPDATE sender_unsubscribe_status SET decision = ?, http_status = ?, error = ? WHERE id = ?",
		)
		.bind(result.ok ? "unsubscribed" : "kept", result.status ?? null, result.error ?? null, id)
		.run();
}
