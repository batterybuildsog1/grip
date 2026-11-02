/**
 * The password-guessing throttle (v67, 2026-11-02; docs/release-1.0/failure-modes-login-hardening.md).
 *
 * The lock exists to bound online guessing, nothing else. Two counters per typed address, both
 * reserved atomically BEFORE any password work (so parallel requests can't all slip under):
 *   - this address from this network (CF-Connecting-IP; IPv6 by /64): NETWORK_LIMIT per window, so a
 *     stranger's wrong tries never lock the owner out of their own network;
 *   - this address from anywhere: ADDRESS_LIMIT per window, the ceiling for a spread-out attacker.
 * Keys are the typed address whether or not an account exists, so an absent address throttles
 * exactly like a present one. Only sha256 keys are stored.
 */
import { hashToken } from "@/auth/principal";

export const NETWORK_LIMIT = 5;
export const NETWORK_WINDOW_MS = 15 * 60 * 1000;
export const ADDRESS_LIMIT = 50;
export const ADDRESS_WINDOW_MS = 60 * 60 * 1000;
const PRUNE_BATCH = 100;

export interface LoginKeys {
	/** This address from this network. */
	network: string;
	/** This address from anywhere. */
	address: string;
	/** Every counter of this address (a new password clears them). */
	subject: string;
}

/** The client's network: an IPv4 address, or an IPv6 address's /64 (one attacker holds a whole /64). */
export function clientNetwork(ip: string | null | undefined): string {
	const value = (ip ?? "").trim().toLowerCase();
	if (!value.includes(":")) return value || "unknown";
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	if (mapped) return mapped[1];
	const [head, tail = ""] = value.split("::", 2);
	const left = head ? head.split(":") : [];
	const right = value.includes("::") && tail ? tail.split(":") : [];
	const groups = value.includes("::")
		? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
		: left;
	return `${groups
		.slice(0, 4)
		.map((g) => (g || "0").replace(/^0+(?=.)/, ""))
		.join(":")}::/64`;
}

export const loginSubject = (email: string) => hashToken(`login-subject\0${email}`);

export async function loginKeys(email: string, ip: string | null | undefined): Promise<LoginKeys> {
	return {
		network: await hashToken(`login-network\0${email}\0${clientNetwork(ip)}`),
		address: await hashToken(`login-address\0${email}`),
		subject: await loginSubject(email),
	};
}

const RESERVE_SQL = `INSERT INTO login_attempts (key, subject, attempts, expires_at) VALUES (?, ?, 1, ?)
	ON CONFLICT(key) DO UPDATE SET
		attempts = CASE WHEN login_attempts.expires_at <= ? THEN 1 ELSE login_attempts.attempts + 1 END,
		expires_at = CASE WHEN login_attempts.expires_at <= ? THEN excluded.expires_at
			ELSE login_attempts.expires_at END
	RETURNING attempts, expires_at`;

/**
 * Reserve one try on both counters in one transaction (and prune a bounded batch of expired rows).
 * Throws if the table is missing: the caller fails closed.
 */
export async function admitLogin(
	db: D1Database,
	keys: LoginKeys,
	now = Date.now(),
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
	const [, network, address] = await db.batch<{ attempts: number; expires_at: number }>([
		db
			.prepare(
				`DELETE FROM login_attempts WHERE key IN
					(SELECT key FROM login_attempts WHERE expires_at <= ? LIMIT ${PRUNE_BATCH})`,
			)
			.bind(now),
		db.prepare(RESERVE_SQL).bind(keys.network, keys.subject, now + NETWORK_WINDOW_MS, now, now),
		db.prepare(RESERVE_SQL).bind(keys.address, keys.subject, now + ADDRESS_WINDOW_MS, now, now),
	]);
	// A counter past its limit refuses until its window ends; a missing row (can't happen) refuses too.
	const refusedUntil = (
		[
			[network.results?.[0], NETWORK_LIMIT],
			[address.results?.[0], ADDRESS_LIMIT],
		] as const
	).flatMap(([row, limit]) =>
		!row ? [now + NETWORK_WINDOW_MS] : Number(row.attempts) > limit ? [Number(row.expires_at)] : [],
	);
	if (refusedUntil.length === 0) return { allowed: true };
	const retryAfter = Math.max(1, Math.ceil((Math.max(...refusedUntil) - now) / 1000));
	return { allowed: false, retryAfter };
}

/**
 * A sign-in that made session `sessionId`: clear this network's counter and give back the try it
 * reserved on the address counter. Conditional on the session row, so they run in the session's
 * own batch and do nothing when the fenced insert inserted nothing.
 */
export function loginSucceededStatements(db: D1Database, keys: LoginKeys, sessionId: string) {
	const made = "EXISTS (SELECT 1 FROM sessions WHERE id = ?)";
	return [
		db
			.prepare(`DELETE FROM login_attempts WHERE key = ? AND ${made}`)
			.bind(keys.network, sessionId),
		db
			.prepare(
				`UPDATE login_attempts SET attempts = MAX(attempts - 1, 0) WHERE key = ? AND ${made}`,
			)
			.bind(keys.address, sessionId),
	];
}

/** A new password: every counter of the address goes. */
export function clearLoginAttemptsStatement(db: D1Database, subject: string) {
	return db.prepare("DELETE FROM login_attempts WHERE subject = ?").bind(subject);
}
