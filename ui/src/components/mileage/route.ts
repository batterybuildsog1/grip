/**
 * A trip's drawn route: every page of the owner's GPS journal (accepted fixes only), kept per trip and
 * revision for the session, and how to frame it. Nothing here is a total or a name: only geometry.
 */
import { ApiHttpError } from "../../api/client";
import { type MileageTripView, mileage } from "../../api/mileage";

/** [lat, lng, timestamp]. */
export type Fix = [number, number, number];

const cache = new Map<string, Promise<Fix[]>>();

async function fetchAll(id: string): Promise<Fix[]> {
	const out: Fix[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < 50; page++) {
		let res: Awaited<ReturnType<typeof mileage.route>>;
		try {
			res = await mileage.route(id, cursor);
		} catch (e) {
			// The phone hasn't uploaded a route: the map frames the two ends.
			if (e instanceof ApiHttpError && e.status === 404) return out;
			throw e;
		}
		for (const p of res.points ?? [])
			if (p.accepted !== false) out.push([p.latitude, p.longitude, p.timestamp]);
		cursor = res.next_cursor ?? null;
		if (!cursor) break;
	}
	return out;
}

/** The trip's fixes; a trip with no stored route falls back to its two ends. */
export function routeOf(trip: MileageTripView): Promise<Fix[]> {
	const key = `${trip.id}@${trip.revision}`;
	let p = cache.get(key);
	if (!p) {
		p = fetchAll(trip.id).then((fixes) =>
			fixes.length > 1
				? fixes
				: [
						[trip.start.lat, trip.start.lng, trip.started_at],
						[trip.end.lat, trip.end.lng, trip.ended_at],
					],
		);
		// A failed read is retried by the next draw ("Try again"), not remembered.
		p.catch(() => cache.delete(key));
		cache.set(key, p);
	}
	return p;
}

/**
 * Where the recording gap is: the server's `from_at`/`to_at` when it sends them, else the longest
 * pause between two fixes. [first index, last index] of the unrecorded stretch, or null.
 */
export function gapOf(trip: MileageTripView, fixes: Fix[]): [number, number] | null {
	const gap = trip.gap;
	if (!gap || fixes.length < 3) return null;
	if (gap.from_at !== undefined && gap.to_at !== undefined) {
		const a = fixes.findIndex((f) => f[2] >= (gap.from_at as number));
		let b = -1;
		for (let i = fixes.length - 1; i >= 0; i--)
			if (fixes[i][2] <= (gap.to_at as number)) {
				b = i;
				break;
			}
		return a >= 0 && b > a ? [a, b] : null;
	}
	let at = -1;
	let longest = 0;
	for (let i = 1; i < fixes.length; i++) {
		const d = fixes[i][2] - fixes[i - 1][2];
		if (d > longest) {
			longest = d;
			at = i;
		}
	}
	return at > 0 && longest >= gap.seconds * 500 ? [at - 1, at] : null;
}

/**
 * The endpoint that matters (lead ruling L5): the start when the destination is a saved place and
 * the start isn't (a drive back to Home), else the destination.
 */
export function focusOf(trip: MileageTripView): "start" | "end" {
	return trip.end.name_source === "saved" && trip.start.name_source !== "saved" ? "start" : "end";
}

const RAD = Math.PI / 180;
const km = (a: Fix, b: Fix) => {
	const dLat = (b[0] - a[0]) * RAD;
	const dLng = (b[1] - a[1]) * RAD;
	const h =
		Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/** Street level at one end: the last ~1.1 km of road into it, and a few blocks around it. */
export function closeUp(fixes: Fix[], which: "start" | "end"): [number, number][] {
	const p = which === "start" ? [...fixes].reverse() : fixes;
	const e = p[p.length - 1];
	const out: [number, number][] = [[e[0], e[1]]];
	let d = 0;
	for (let i = p.length - 2; i >= 0 && d < 1.1; i--) {
		d += km(p[i], p[i + 1]);
		out.push([p[i][0], p[i][1]]);
	}
	out.push([e[0] + 0.0035, e[1] - 0.006], [e[0] - 0.0035, e[1] + 0.006]);
	return out;
}
