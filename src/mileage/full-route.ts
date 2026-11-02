import { z } from "zod";
import { MileageError, type MileagePrincipal } from "./auth";
import { idSchema, type Trip } from "./policy";
import { canonical, cursorDecode, cursorEncode, digest, trip } from "./store";

const TRANSFORM_MAX_POINTS = 200000;
const TRANSFORM_MAX_BYTES = 16000000;
const epoch = z.number().min(0).max(4102444800000);
export const routePointSchema = z
	.object({
		timestamp: epoch,
		received_at: epoch.optional(),
		latitude: z.number(),
		longitude: z.number(),
		horizontal_accuracy: z.number().optional(),
		speed: z.number().optional(),
		accepted: z.boolean().optional(),
		reason: z.string().max(200).optional(),
	})
	.strict()
	.refine(
		(point) =>
			point.accepted === false ||
			(Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180),
		"Accepted route points require valid geographic coordinates",
	);
export type RoutePoint = z.infer<typeof routePointSchema>;
export const routeUploadSchema = z
	.object({
		device_id: idSchema,
		chunk_index: z.number().int().min(0).max(999),
		chunk_count: z.number().int().min(1).max(1000),
		points: z.array(routePointSchema).min(1).max(20000),
	})
	.strict()
	.refine((b) => b.chunk_index < b.chunk_count, "Chunk index exceeds count");
type Upload = z.infer<typeof routeUploadSchema>;
type Manifest = { device_id: string; chunk_count: number };
type Chunk = {
	chunk_index: number;
	point_count: number;
	request_hash: string;
	points: string;
};
const unavailable = () =>
	new MileageError("ROUTE_STORAGE_UNAVAILABLE", "Route storage is unavailable", 503);
const conflict = () =>
	new MileageError("ROUTE_CONFLICT", "Route upload differs from an existing immutable upload", 409);
const incomplete = () =>
	new MileageError("ROUTE_INCOMPLETE", "Full route upload has not completed", 409);
/**
 * No app-level key (decided 2026-10-25): D1 encrypts at rest with Cloudflare-managed keys, and
 * owner-only human auth guards access, so no lost secret can make a stored route unreadable.
 */
async function routeDb(env: CloudflareBindings): Promise<D1Database> {
	try {
		// One probe for all four tables; `points` also refuses the old ciphertext-shaped chunk table.
		await env.MILEAGE_D1?.prepare(
			"SELECT (SELECT trip_id FROM mileage_routes LIMIT 1),(SELECT trip_id FROM mileage_route_expected LIMIT 1),(SELECT points FROM mileage_route_chunks LIMIT 1),(SELECT trip_id FROM mileage_route_tombstones LIMIT 1)",
		).first();
	} catch {
		throw unavailable();
	}
	if (!env.MILEAGE_D1) throw unavailable();
	return env.MILEAGE_D1;
}
export async function routeReady(env: CloudflareBindings) {
	return routeDb(env).then(
		() => true,
		() => false,
	);
}
async function stored(m: Manifest, index: number, points: RoutePoint[]) {
	const json = canonical(points);
	if (new TextEncoder().encode(json).byteLength > 1500000)
		throw new MileageError("ROUTE_CHUNK_TOO_LARGE", "Use smaller route chunks", 413);
	return {
		json,
		hash: await digest({
			device_id: m.device_id,
			chunk_count: m.chunk_count,
			chunk_index: index,
			points,
		}),
	};
}
async function manifest(db: D1Database, owner: string, id: string) {
	return db
		.prepare("SELECT device_id,chunk_count FROM mileage_routes WHERE owner=? AND trip_id=?")
		.bind(owner, id)
		.first<Manifest>();
}
async function active(db: D1Database, owner: string, id: string) {
	const tombstone = await db
		.prepare("SELECT trip_id FROM mileage_route_tombstones WHERE owner=? AND trip_id=?")
		.bind(owner, id)
		.first();
	if (tombstone) throw new MileageError("TRIP_DELETED", "Trip has been deleted", 409);
	const t = await trip(db, owner, id, true);
	if (t.deleted_at !== null) throw new MileageError("TRIP_DELETED", "Trip has been deleted", 409);
	return t;
}
function guard(db: D1Database, sql: string, args: unknown[]) {
	const id = crypto.randomUUID();
	return [
		db
			.prepare(`INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN (${sql}) THEN 1 ELSE 0 END`)
			.bind(id, ...args),
		db.prepare("DELETE FROM mileage_guard WHERE id=?").bind(id),
	];
}
export async function uploadRoute(
	env: CloudflareBindings,
	p: MileagePrincipal,
	id: string,
	b: Upload,
) {
	const db = await routeDb(env);
	await active(db, p.owner, id);
	const source = await db
		.prepare("SELECT device_id FROM mileage_trips WHERE owner=? AND id=?")
		.bind(p.owner, id)
		.first<{ device_id: string }>();
	if (source?.device_id !== b.device_id)
		throw new MileageError("CAPTURE_CONFLICT", "Route must use the captured trip device", 409);
	const m: Manifest = { device_id: b.device_id, chunk_count: b.chunk_count };
	const chunk = await stored(m, b.chunk_index, b.points);
	const payload = [p.owner, id, b.chunk_index, b.points.length, chunk.hash, chunk.json];
	try {
		await db.batch([
			...guard(
				db,
				"EXISTS(SELECT 1 FROM mileage_trips WHERE owner=? AND id=? AND json_extract(data,'$.deleted_at') IS NULL) AND NOT EXISTS(SELECT 1 FROM mileage_route_tombstones WHERE owner=? AND trip_id=?)",
				[p.owner, id, p.owner, id],
			),
			db
				.prepare(
					"INSERT OR IGNORE INTO mileage_routes(owner,trip_id,device_id,chunk_count,created_at) VALUES(?,?,?,?,?)",
				)
				.bind(p.owner, id, b.device_id, b.chunk_count, Date.now()),
			db
				.prepare(
					"INSERT OR IGNORE INTO mileage_route_chunks(owner,trip_id,chunk_index,point_count,request_hash,points) VALUES(?,?,?,?,?,?)",
				)
				.bind(...payload),
			...guard(
				db,
				"EXISTS(SELECT 1 FROM mileage_routes WHERE owner=? AND trip_id=? AND device_id=? AND chunk_count=?) AND EXISTS(SELECT 1 FROM mileage_route_chunks WHERE owner=? AND trip_id=? AND chunk_index=? AND request_hash=?)",
				[p.owner, id, b.device_id, b.chunk_count, p.owner, id, b.chunk_index, chunk.hash],
			),
		]);
	} catch {
		await active(db, p.owner, id);
		const existing = await manifest(db, p.owner, id);
		const prior = await db
			.prepare(
				"SELECT request_hash FROM mileage_route_chunks WHERE owner=? AND trip_id=? AND chunk_index=?",
			)
			.bind(p.owner, id, b.chunk_index)
			.first<{ request_hash: string }>();
		if (
			(existing &&
				(existing.device_id !== b.device_id || existing.chunk_count !== b.chunk_count)) ||
			(prior && prior.request_hash !== chunk.hash)
		)
			throw conflict();

		throw unavailable();
	}
	const count = await db
		.prepare("SELECT COUNT(*) n FROM mileage_route_chunks WHERE owner=? AND trip_id=?")
		.bind(p.owner, id)
		.first<{ n: number }>();
	return {
		trip_id: id,
		chunk_index: b.chunk_index,
		chunk_count: b.chunk_count,
		point_count: b.points.length,
		complete: count?.n === b.chunk_count,
	};
}
async function parseChunk(m: Manifest, row: Chunk): Promise<RoutePoint[]> {
	try {
		const chunk = z.array(routePointSchema).parse(JSON.parse(row.points));
		if (
			chunk.length !== row.point_count ||
			row.request_hash !==
				(await digest({
					device_id: m.device_id,
					chunk_count: m.chunk_count,
					chunk_index: row.chunk_index,
					points: chunk,
				}))
		)
			throw unavailable();
		return chunk;
	} catch {
		throw unavailable();
	}
}
export async function readRoutePage(
	env: CloudflareBindings,
	p: MileagePrincipal,
	id: string,
	cursor?: string,
) {
	const db = await routeDb(env);
	await trip(db, p.owner, id);
	const m = await manifest(db, p.owner, id);
	if (!m)
		throw new MileageError("ROUTE_NOT_FOUND", "No full route was uploaded for this trip", 404);
	const decoded = cursorDecode(cursor);
	let start = 0;
	if (decoded !== undefined) {
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 3 ||
			decoded[0] !== id ||
			decoded[1] !== m.chunk_count ||
			!Number.isInteger(decoded[2]) ||
			decoded[2] < 0 ||
			decoded[2] >= m.chunk_count
		)
			throw new MileageError("INVALID_CURSOR", "Invalid route cursor");
		start = decoded[2];
	}
	// Metadata only: choose a bounded page before fetching any points.
	const meta = await db
		.prepare(
			"SELECT chunk_index,point_count,length(CAST(points AS BLOB)) AS bytes FROM mileage_route_chunks WHERE owner=? AND trip_id=? ORDER BY chunk_index",
		)
		.bind(p.owner, id)
		.all<{ chunk_index: number; point_count: number; bytes: number }>();
	if (meta.results.length !== m.chunk_count || meta.results.some((r, i) => r.chunk_index !== i))
		throw incomplete();
	let end = start,
		total = 0,
		bytes = 0;
	while (
		end < m.chunk_count &&
		(end === start ||
			(total + meta.results[end].point_count <= 20000 &&
				bytes + meta.results[end].bytes <= 1500000)) &&
		end - start < 20
	) {
		total += meta.results[end].point_count;
		bytes += meta.results[end].bytes;
		end++;
	}
	const rows = await db
		.prepare(
			"SELECT chunk_index,point_count,request_hash,points FROM mileage_route_chunks WHERE owner=? AND trip_id=? AND chunk_index>=? AND chunk_index<? ORDER BY chunk_index",
		)
		.bind(p.owner, id, start, end)
		.all<Chunk>();
	if (rows.results.length !== end - start) throw incomplete();
	const points: RoutePoint[] = [];
	for (const row of rows.results) points.push(...(await parseChunk(m, row)));
	await trip(db, p.owner, id);
	return {
		trip_id: id,
		points,
		next_cursor: end < m.chunk_count ? cursorEncode([id, m.chunk_count, end]) : null,
	};
}
async function readTransformRoute(env: CloudflareBindings, p: MileagePrincipal, id: string) {
	const points: RoutePoint[] = [];
	let cursor: string | undefined;
	do {
		const page = await readRoutePage(env, p, id, cursor);
		points.push(...page.points);
		cursor = page.next_cursor ?? undefined;
	} while (cursor);
	return points;
}
/** Build derived tracks and CAS checks before the summary transaction. */
export async function transformRoutes(
	env: CloudflareBindings,
	p: MileagePrincipal,
	sources: Trip[],
	targets:
		| { trip: Trip; points: RoutePoint[] }[]
		| ((points: RoutePoint[][]) => { trip: Trip; points: RoutePoint[] }[]),
) {
	if (!env.MILEAGE_D1) throw unavailable();
	const db = env.MILEAGE_D1;
	// Older schemas without route storage remain usable for summary-only legacy transformations.
	let available = false;
	try {
		await db.prepare("SELECT trip_id FROM mileage_routes LIMIT 1").first();
		available = true;
	} catch {}
	if (!available) return { extra: [], checks: [] };
	await routeDb(env);
	const manifests = await Promise.all(sources.map((t) => manifest(db, p.owner, t.id)));
	const checks = sources.flatMap((t, i) =>
		guard(
			db,
			manifests[i]
				? "EXISTS(SELECT 1 FROM mileage_routes WHERE owner=? AND trip_id=?)"
				: "NOT EXISTS(SELECT 1 FROM mileage_routes WHERE owner=? AND trip_id=?)",
			[p.owner, t.id],
		),
	);
	const expected = await db
		.prepare(
			`SELECT trip_id FROM mileage_route_expected WHERE owner=? AND trip_id IN (${sources.map(() => "?").join(",")})`,
		)
		.bind(p.owner, ...sources.map((t) => t.id))
		.all<{ trip_id: string }>();
	if (sources.some((t, i) => !manifests[i] && expected.results.some((e) => e.trip_id === t.id)))
		throw incomplete();
	if (manifests.every((m) => !m)) return { extra: [], checks };
	if (manifests.some((m) => !m)) throw incomplete();
	const combined = await db
		.prepare(
			`SELECT SUM(point_count) points,SUM(length(CAST(points AS BLOB))) bytes FROM mileage_route_chunks WHERE owner=? AND trip_id IN (${sources.map(() => "?").join(",")})`,
		)
		.bind(p.owner, ...sources.map((t) => t.id))
		.first<{ points: number; bytes: number }>();
	if (combined && (combined.points > TRANSFORM_MAX_POINTS || combined.bytes > TRANSFORM_MAX_BYTES))
		throw new MileageError(
			"ROUTE_TRANSFORM_TOO_LARGE",
			"Full route is too large for an atomic transformation; source routes are unchanged",
			413,
		);
	const all: RoutePoint[][] = [];
	for (const t of sources) all.push(await readTransformRoute(env, p, t.id));
	if (all.reduce((n, ps) => n + ps.length, 0) > TRANSFORM_MAX_POINTS)
		throw new MileageError(
			"ROUTE_TRANSFORM_TOO_LARGE",
			"Full route is too large for an atomic transformation; source routes are unchanged",
			413,
		);
	const derived = typeof targets === "function" ? targets(all) : targets;
	const extra: D1PreparedStatement[] = [];
	for (const { trip: t, points } of derived) {
		const count = Math.max(1, Math.ceil(points.length / 1000)),
			m = { device_id: "owner", chunk_count: count };
		extra.push(
			db
				.prepare(
					"INSERT INTO mileage_routes(owner,trip_id,device_id,chunk_count,created_at) VALUES(?,?,?,?,?)",
				)
				.bind(p.owner, t.id, m.device_id, count, Date.now()),
		);
		for (let i = 0; i < count; i++) {
			const ps = points.slice(i * 1000, (i + 1) * 1000),
				e = await stored(m, i, ps);
			extra.push(
				db
					.prepare(
						"INSERT INTO mileage_route_chunks(owner,trip_id,chunk_index,point_count,request_hash,points) VALUES(?,?,?,?,?,?)",
					)
					.bind(p.owner, t.id, i, ps.length, e.hash, e.json),
			);
		}
	}
	return { extra, checks };
}
