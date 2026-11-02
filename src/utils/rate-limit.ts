const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 120;
const SEND_LIMIT = 20;

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

const counters = new Map<string, RateLimitEntry>();

function pruneExpired(nowMs: number) {
	for (const [key, entry] of counters.entries()) {
		if (entry.resetAt <= nowMs) {
			counters.delete(key);
		}
	}
}

function consume(key: string, limit: number, nowMs: number) {
	pruneExpired(nowMs);

	const current = counters.get(key);
	if (!current || current.resetAt <= nowMs) {
		const entry: RateLimitEntry = { count: 1, resetAt: nowMs + WINDOW_MS };
		counters.set(key, entry);
		return {
			allowed: true,
			remaining: limit - 1,
			retryAfter: Math.ceil(WINDOW_MS / 1000),
		};
	}

	if (current.count >= limit) {
		return {
			allowed: false,
			remaining: 0,
			retryAfter: Math.max(1, Math.ceil((current.resetAt - nowMs) / 1000)),
		};
	}

	current.count += 1;
	return {
		allowed: true,
		remaining: Math.max(0, limit - current.count),
		retryAfter: Math.max(1, Math.ceil((current.resetAt - nowMs) / 1000)),
	};
}

export function consumeApiRateLimit(token: string) {
	return consume(`api:${token}`, REQUEST_LIMIT, Date.now());
}

export function consumeSendRateLimit(token: string) {
	return consume(`send:${token}`, SEND_LIMIT, Date.now());
}
