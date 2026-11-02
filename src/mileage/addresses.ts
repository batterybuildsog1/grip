import { z } from "zod";
import { MileageError, type MileagePrincipal } from "./auth";
import { type Trip, textSchema } from "./policy";
import { optionalLogic, requireLogic, trip } from "./store";

/** Apple reverse-geocoded endpoint text, uploaded by the owner's phone. Never part of a trip revision. */
export interface EndpointAddress {
	name: string | null;
	address: string;
}
const clean = (max: number) =>
	textSchema.transform((v) => v.trim()).pipe(z.string().min(1, "Blank text").max(max));
const endpointSchema = z.object({ address: clean(300), name: clean(120).optional() }).strict();
export const putAddressesSchema = z
	.object({ start: endpointSchema.optional(), end: endpointSchema.optional() })
	.strict()
	.refine((b) => b.start !== undefined || b.end !== undefined, "Provide start or end");
type Stored = Map<string, { start?: EndpointAddress; end?: EndpointAddress }>;

/** One query for any number of trips (a single JSON parameter stays under D1's bound-parameter limit). */
export async function ownerAddresses(
	db: D1Database,
	owner: string,
	ids: string[],
): Promise<Stored | undefined> {
	if (!ids.length) return new Map();
	const rows = await optionalLogic(() =>
		db
			.prepare(
				"SELECT trip_id,endpoint,name,address FROM mileage_trip_addresses WHERE owner=? AND trip_id IN (SELECT value FROM json_each(?))",
			)
			.bind(owner, JSON.stringify([...new Set(ids)]))
			.all<{ trip_id: string; endpoint: "start" | "end"; name: string | null; address: string }>(),
	);
	if (!rows) return undefined;
	const map: Stored = new Map();
	for (const r of rows.results) {
		const entry = map.get(r.trip_id) ?? {};
		entry[r.endpoint] = { name: r.name, address: r.address };
		map.set(r.trip_id, entry);
	}
	return map;
}
export function endpointAddresses(stored: Stored | undefined, id: string) {
	const entry = stored?.get(id);
	return {
		...(entry?.start ? { start_address: entry.start } : {}),
		...(entry?.end ? { end_address: entry.end } : {}),
	};
}
function isTrip(value: unknown): value is Trip {
	return (
		!!value &&
		typeof value === "object" &&
		"measured_distance_meters" in value &&
		"revision" in value
	);
}
export function tripIds(value: unknown, ids: string[] = []): string[] {
	if (isTrip(value)) ids.push(value.id);
	else if (Array.isArray(value)) for (const entry of value) tripIds(entry, ids);
	else if (value && typeof value === "object")
		for (const entry of Object.values(value)) tripIds(entry, ids);
	return ids;
}
/** Live owner trip responses only (same hook as places); stored trips, audit and exports never see it. */
export function withAddresses(value: unknown, stored: Stored): unknown {
	if (isTrip(value)) return { ...value, ...endpointAddresses(stored, value.id) };
	if (Array.isArray(value)) return value.map((entry) => withAddresses(entry, stored));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, withAddresses(entry, stored)]),
		);
	return value;
}
/** Last write wins per endpoint; no revision, command or audit row (display data, not a decision). */
export async function putAddresses(
	db: D1Database,
	p: MileagePrincipal,
	id: string,
	b: z.infer<typeof putAddressesSchema>,
) {
	await requireLogic(() => db.prepare("SELECT 1 FROM mileage_trip_addresses LIMIT 1").all());
	const t = await trip(db, p.owner, id);
	const now = Date.now(),
		guard = crypto.randomUUID(),
		statements: D1PreparedStatement[] = [
			db
				.prepare(
					"INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM mileage_trips WHERE owner=? AND id=? AND json_extract(data,'$.deleted_at') IS NULL) THEN 1 ELSE 0 END",
				)
				.bind(guard, p.owner, id),
		];
	for (const endpoint of ["start", "end"] as const) {
		const value = b[endpoint];
		if (!value) continue;
		if (t[`${endpoint}_lat`] === undefined || t[`${endpoint}_lng`] === undefined)
			throw new MileageError(
				"ENDPOINT_UNAVAILABLE",
				"Trip endpoint has no stored coordinates",
				422,
			);
		statements.push(
			db
				.prepare(
					"INSERT INTO mileage_trip_addresses(owner,trip_id,endpoint,name,address,source,resolved_at,updated_at) VALUES(?,?,?,?,?,'apple',?,?) ON CONFLICT(owner,trip_id,endpoint) DO UPDATE SET name=excluded.name,address=excluded.address,resolved_at=excluded.resolved_at,updated_at=excluded.updated_at",
				)
				.bind(p.owner, id, endpoint, value.name ?? null, value.address, now, now),
		);
	}
	statements.push(db.prepare("DELETE FROM mileage_guard WHERE id=?").bind(guard));
	try {
		await db.batch(statements);
	} catch (error) {
		if (/CHECK constraint/i.test(String(error)))
			throw new MileageError("NOT_FOUND", "Trip not found", 404);
		throw error;
	}
	return { trip_id: id, ...endpointAddresses(await ownerAddresses(db, p.owner, [id]), id) };
}
/** Split/merge keep the measured endpoints' addresses; copied before the archived source loses its own. */
export function copyAddress(
	db: D1Database,
	owner: string,
	from: string,
	to: string,
	endpoint: "start" | "end",
): D1PreparedStatement {
	return db
		.prepare(
			"INSERT OR REPLACE INTO mileage_trip_addresses(owner,trip_id,endpoint,name,address,source,resolved_at,updated_at) SELECT owner,?,endpoint,name,address,source,resolved_at,updated_at FROM mileage_trip_addresses WHERE owner=? AND trip_id=? AND endpoint=?",
		)
		.bind(to, owner, from, endpoint);
}
