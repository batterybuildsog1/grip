export function now(): number {
	return Date.now();
}

export function parseTimestamp(value: string): number | null {
	// Try Unix timestamp
	const num = Number(value);
	if (!Number.isNaN(num) && num > 0) {
		// Normalize to milliseconds: values < 1e11 are seconds
		return num < 1e11 ? num * 1000 : num;
	}
	// Try ISO 8601 date string
	const date = new Date(value);
	if (!Number.isNaN(date.getTime())) {
		return date.getTime();
	}
	return null;
}
