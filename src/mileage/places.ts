import { z } from "zod";
import { MileageError, type MileagePrincipal } from "./auth";
import { idSchema, type Trip, textSchema } from "./policy";
import { commit, digest, saved, trip } from "./store";

export interface Place {
	id: string;
	name: string;
	lat: number;
	lng: number;
	radius_m: number;
	updated_at: number;
}
const nameSchema = textSchema.transform((name) => name.trim()).pipe(z.string().min(1).max(80));
const radiusSchema = z.number().int().min(50).max(1000);
const keySchema = z
	.string()
	.min(1)
	.max(120)
	.regex(/^[A-Za-z0-9_.:-]+$/);
export const createPlaceSchema = z.union([
	z
		.object({
			name: nameSchema,
			lat: z.number().min(-90).max(90),
			lng: z.number().min(-180).max(180),
			radius_m: radiusSchema.default(150),
			idempotency_key: keySchema,
		})
		.strict(),
	z
		.object({
			name: nameSchema,
			trip_id: idSchema,
			end: z.enum(["start", "end"]),
			idempotency_key: keySchema,
		})
		.strict(),
]);
export const patchPlaceSchema = z
	.object({
		name: nameSchema.optional(),
		radius_m: radiusSchema.optional(),
		idempotency_key: keySchema,
	})
	.strict()
	.refine((b) => b.name !== undefined || b.radius_m !== undefined, "Provide name or radius_m");

/** Optional 004 capability: only a missing table permits legacy summary reads. */
export async function ownerPlaces(db: D1Database, owner: string): Promise<Place[] | undefined> {
	try {
		const rows = await db
			.prepare(
				"SELECT id,name,lat,lng,radius_m,updated_at FROM mileage_places WHERE owner=? AND deleted_at IS NULL ORDER BY id",
			)
			.bind(owner)
			.all<Place>();
		return rows.results;
	} catch (error) {
		if (/no such table: mileage_places/i.test(String(error))) return undefined;
		throw new MileageError("MILEAGE_UNAVAILABLE", "Known places storage is unavailable", 503);
	}
}
export async function requirePlaces(db: D1Database, owner: string): Promise<Place[]> {
	const places = await ownerPlaces(db, owner);
	if (!places)
		throw new MileageError("MILEAGE_UNAVAILABLE", "Known places schema is not initialized", 503);
	return places;
}
export async function createPlace(
	db: D1Database,
	p: MileagePrincipal,
	b: z.infer<typeof createPlaceSchema>,
) {
	await requirePlaces(db, p.owner);
	const hash = await digest({ op: "place:create", ...b });
	const prior = await saved<Place>(db, p, b.idempotency_key, hash);
	if (prior) return prior;
	let lat: number, lng: number;
	if ("trip_id" in b) {
		const t = await trip(db, p.owner, b.trip_id);
		const latitude = t[`${b.end}_lat`],
			longitude = t[`${b.end}_lng`];
		if (latitude === undefined || longitude === undefined)
			throw new MileageError(
				"ENDPOINT_UNAVAILABLE",
				"Trip endpoint has no stored coordinates",
				422,
			);
		lat = latitude;
		lng = longitude;
	} else {
		lat = b.lat;
		lng = b.lng;
	}
	const now = Date.now();
	const place: Place = {
		id: crypto.randomUUID(),
		name: b.name,
		lat,
		lng,
		radius_m: "radius_m" in b ? b.radius_m : 150,
		updated_at: now,
	};
	return commit(db, p, b.idempotency_key, hash, place, [], "place:create", [
		db
			.prepare(
				"INSERT INTO mileage_places(id,owner,name,lat,lng,radius_m,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(place.id, p.owner, place.name, lat, lng, place.radius_m, now, now),
	]);
}
export async function patchPlace(
	db: D1Database,
	p: MileagePrincipal,
	id: string,
	b: z.infer<typeof patchPlaceSchema>,
) {
	const places = await requirePlaces(db, p.owner);
	const hash = await digest({ op: "place:patch", id, ...b });
	const prior = await saved<Place>(db, p, b.idempotency_key, hash);
	if (prior) return prior;
	const before = places.find((place) => place.id === id);
	if (!before) throw new MileageError("NOT_FOUND", "Place not found", 404);
	const place = {
		...before,
		name: b.name ?? before.name,
		radius_m: b.radius_m ?? before.radius_m,
		updated_at: Math.max(Date.now(), before.updated_at + 1),
	};
	const guard = crypto.randomUUID();
	return commit(
		db,
		p,
		b.idempotency_key,
		hash,
		place,
		[],
		"place:patch",
		[
			db
				.prepare("UPDATE mileage_places SET name=?,radius_m=?,updated_at=? WHERE owner=? AND id=?")
				.bind(place.name, place.radius_m, place.updated_at, p.owner, id),
		],
		[
			db
				.prepare(
					"INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM mileage_places WHERE owner=? AND id=? AND updated_at=? AND deleted_at IS NULL) THEN 1 ELSE 0 END",
				)
				.bind(guard, p.owner, id, before.updated_at),
			db.prepare("DELETE FROM mileage_guard WHERE id=?").bind(guard),
		],
	);
}
export async function deletePlace(db: D1Database, p: MileagePrincipal, id: string) {
	await requirePlaces(db, p.owner);
	const result = await db
		.prepare(
			"UPDATE mileage_places SET deleted_at=?,updated_at=MAX(updated_at+1,?) WHERE owner=? AND id=?",
		)
		.bind(Date.now(), Date.now(), p.owner, id)
		.run();
	if (!result.meta.changes) throw new MileageError("NOT_FOUND", "Place not found", 404);
	return { id, deleted: true };
}
function distance(lat: number, lng: number, place: Place) {
	const rad = Math.PI / 180;
	const a =
		Math.sin(((place.lat - lat) * rad) / 2) ** 2 +
		Math.cos(lat * rad) * Math.cos(place.lat * rad) * Math.sin(((place.lng - lng) * rad) / 2) ** 2;
	return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
export function nearest(lat: number | undefined, lng: number | undefined, places: Place[]) {
	if (lat === undefined || lng === undefined) return undefined;
	let selected: Place | undefined,
		closest = Number.POSITIVE_INFINITY;
	for (const place of places) {
		const meters = distance(lat, lng, place);
		// ownerPlaces is ordered by ID, making exact distance ties deterministic.
		if (meters <= place.radius_m && meters < closest) {
			selected = place;
			closest = meters;
		}
	}
	return selected ? { id: selected.id, name: selected.name } : undefined;
}
function isTrip(value: unknown): value is Trip {
	return (
		!!value &&
		typeof value === "object" &&
		"measured_distance_meters" in value &&
		"revision" in value
	);
}
/** Only live trip response routes call this. Never changes stored objects or audit/export payloads. */
export function hasTrip(value: unknown): boolean {
	return (
		isTrip(value) ||
		(Array.isArray(value)
			? value.some(hasTrip)
			: !!value && typeof value === "object" && Object.values(value).some(hasTrip))
	);
}
export function withPlaces(value: unknown, places: Place[]): unknown {
	if (isTrip(value)) {
		const start = nearest(value.start_lat, value.start_lng, places),
			end = nearest(value.end_lat, value.end_lng, places);
		return {
			...value,
			...(start ? { start_place: start } : {}),
			...(end ? { end_place: end } : {}),
		};
	}
	if (Array.isArray(value)) return value.map((entry) => withPlaces(entry, places));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, withPlaces(entry, places)]),
		);
	return value;
}
