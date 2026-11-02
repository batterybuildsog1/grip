import type { MileagePrincipal } from "./auth";

const WINDOW_MS = 60_000;
const LIMIT = 240;
const counters = new Map<string, { count: number; until: number }>();
/** Separate namespace/state from mail; rotating agent credentials cannot bypass owner limits. */
/** `limit`: Worker var MILEAGE_RATE_LIMIT (requests a minute; local fixtures seed a month through the routes). */
export function consumeMileageLimit(p: MileagePrincipal, limit = LIMIT) {
	const now = Date.now();
	for (const [key, value] of counters) if (value.until <= now) counters.delete(key);
	const keys = [`mileage:owner:${p.owner}`, `mileage:principal:${p.owner}:${p.actor}`];
	for (const key of keys) {
		const current = counters.get(key);
		if (current && current.count >= limit)
			return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.until - now) / 1000)) };
	}
	for (const key of keys) {
		const current = counters.get(key);
		if (current) current.count++;
		else counters.set(key, { count: 1, until: now + WINDOW_MS });
	}
	return { allowed: true, retryAfter: 60 };
}
