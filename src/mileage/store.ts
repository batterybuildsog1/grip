import { hashToken } from "@/auth/principal";
import { MileageError, type MileagePrincipal } from "./auth";
import type { Trip } from "./policy";
export interface Category {
	id: string;
	name: string;
	treatment: Trip["treatment"];
	entity_id: string;
}
/** `builtins`: the configured companies plus Personal (src/mileage/companies.ts), then the owner's. */
export async function categories(
	db: D1Database,
	owner: string,
	builtins: Category[],
): Promise<Category[]> {
	const rows = await db
		.prepare(
			"SELECT id,name,treatment,entity_id FROM mileage_categories WHERE owner=? ORDER BY rowid",
		)
		.bind(owner)
		.all<Category>();
	return [...builtins, ...rows.results];
}
export async function trip(
	db: D1Database,
	owner: string,
	id: string,
	archived = false,
): Promise<Trip> {
	const row = await db
		.prepare("SELECT data FROM mileage_trips WHERE owner=? AND id=?")
		.bind(owner, id)
		.first<{ data: string }>();
	const t: Trip | undefined = row ? JSON.parse(row.data) : undefined;
	if (!t || (!archived && t.deleted_at !== null))
		throw new MileageError("NOT_FOUND", "Trip not found", 404);
	return t;
}
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) => hashToken(canonical(value));
export async function saved<T>(
	db: D1Database,
	p: MileagePrincipal,
	key: string,
	hash: string,
): Promise<T | undefined> {
	const row = await db
		.prepare("SELECT request_hash,result FROM mileage_commands WHERE owner=? AND actor=? AND key=?")
		.bind(p.owner, p.actor, key)
		.first<{ request_hash: string; result: string }>();
	if (!row) return undefined;
	if (row.request_hash !== hash)
		throw new MileageError(
			"IDEMPOTENCY_CONFLICT",
			"Idempotency key was used for different input",
			409,
		);
	return JSON.parse(row.result) as T;
}
export interface Change {
	before?: Trip;
	after: Trip;
	measurementHash?: string;
	deviceId?: string;
}
/** One SQLite batch owns CAS, result, snapshots and question lifecycle. Guard CHECK aborts all. */
export async function commit<T>(
	db: D1Database,
	p: MileagePrincipal,
	key: string,
	hash: string,
	result: T,
	changes: Change[],
	operation: string,
	extra: D1PreparedStatement[] = [],
	checks: D1PreparedStatement[] = [],
): Promise<T> {
	const prior = await saved<T>(db, p, key, hash);
	if (prior !== undefined) return prior;
	const guards: string[] = [],
		args: unknown[] = [];
	for (const change of changes) {
		if (change.before) {
			guards.push(
				"EXISTS(SELECT 1 FROM mileage_trips WHERE owner=? AND id=? AND revision=? AND json_extract(data,'$.deleted_at') IS NULL)",
			);
			args.push(p.owner, change.before.id, change.before.revision);
		} else {
			guards.push("NOT EXISTS(SELECT 1 FROM mileage_trips WHERE owner=? AND id=?)");
			args.push(p.owner, change.after.id);
		}
	}
	if (p.tokenId) {
		guards.push(
			"EXISTS(SELECT 1 FROM mileage_tokens WHERE id=? AND owner=? AND revoked_at IS NULL AND expires_at>?)",
		);
		args.push(p.tokenId, p.owner, Date.now());
	}
	const guardId = crypto.randomUUID();
	const statements = [
		db
			.prepare(
				"INSERT INTO mileage_commands(owner,actor,key,request_hash,result,created_at) VALUES(?,?,?,?,?,?)",
			)
			.bind(p.owner, p.actor, key, hash, JSON.stringify(result), Date.now()),
		db
			.prepare(
				`INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN ${guards.join(" AND ") || "1"} THEN 1 ELSE 0 END`,
			)
			.bind(guardId, ...args),
	];
	statements.push(...checks);
	for (const change of changes) {
		if (change.before)
			statements.push(
				db
					.prepare(
						"UPDATE mileage_trips SET revision=?,data=?,actor=?,operation=? WHERE owner=? AND id=? AND revision=?",
					)
					.bind(
						change.after.revision,
						JSON.stringify(change.after),
						p.actor,
						operation,
						p.owner,
						change.after.id,
						change.before.revision,
					),
			);
		else
			statements.push(
				db
					.prepare(
						"INSERT INTO mileage_trips(owner,id,revision,data,measurement_hash,device_id,actor,operation) VALUES(?,?,?,?,?,?,?,?)",
					)
					.bind(
						p.owner,
						change.after.id,
						change.after.revision,
						JSON.stringify(change.after),
						change.measurementHash ?? "derived",
						change.deviceId ?? "owner",
						p.actor,
						operation,
					),
			);
	}
	statements.push(...extra, db.prepare("DELETE FROM mileage_guard WHERE id=?").bind(guardId));
	try {
		await db.batch(statements);
	} catch (error) {
		const replay = await saved<T>(db, p, key, hash);
		if (replay !== undefined) return replay;
		if (/CHECK constraint|UNIQUE constraint/i.test(String(error))) {
			// A credential revoked or expired while this batch was prepared fails as auth, not as a race.
			if (
				p.tokenId &&
				!(await db
					.prepare(
						"SELECT id FROM mileage_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?",
					)
					.bind(p.tokenId, Date.now())
					.first())
			)
				throw new MileageError("UNAUTHORIZED", "Unknown or revoked mileage credential", 401);
			throw new MileageError("REVISION_CONFLICT", "Trip changed; refresh before retrying", 409);
		}
		throw error;
	}
	return result;
}
/**
 * One classification rule for owner edits, answers, calendar matches and agent proposals.
 * `reimbursable` exists only under reimbursement treatment; any other category clears it.
 * The key is added only when it holds a value or the trip already had it, so old rows stay byte-identical.
 */
export async function classifyTrip(
	db: D1Database,
	owner: string,
	builtins: Category[],
	t: Trip,
	categoryId: string | null | undefined,
	purpose: string | undefined,
	treatment: Trip["treatment"] | undefined,
	reimbursable?: boolean | null,
): Promise<Partial<Trip>> {
	const list = await categories(db, owner, builtins);
	const cat =
		categoryId === undefined
			? list.find((x) => x.id === t.category_id)
			: list.find((x) => x.id === categoryId);
	if (categoryId && !cat) throw new MileageError("INVALID_CATEGORY", "Category not found");
	const nextTreatment =
		treatment ?? (categoryId === undefined ? t.treatment : (cat?.treatment ?? "needs_review"));
	if (
		cat &&
		nextTreatment !== cat.treatment &&
		!(cat.id === "personal" && nextTreatment === "commute")
	)
		throw new MileageError(
			"INVALID_TREATMENT",
			"Treatment must agree with the explicitly configured category; choose Personal for commuting",
		);
	if (!cat && nextTreatment !== "needs_review")
		throw new MileageError("INVALID_TREATMENT", "A configured category is required");
	const nextPurpose = purpose ?? t.purpose;
	if ((nextTreatment === "business" || nextTreatment === "reimbursement") && !nextPurpose.trim())
		throw new MileageError(
			"PURPOSE_REQUIRED",
			"A specific purpose is required for business or reimbursement",
		);
	if (reimbursable != null && nextTreatment !== "reimbursement")
		throw new MileageError(
			"INVALID_REIMBURSABLE",
			"Reimbursable applies only to a reimbursement category",
		);
	const nextReimbursable =
		nextTreatment === "reimbursement"
			? reimbursable === undefined
				? (t.reimbursable ?? null)
				: reimbursable
			: null;
	return {
		category_id: cat?.id ?? null,
		entity_id: cat?.entity_id ?? null,
		treatment: nextTreatment,
		purpose: nextPurpose,
		...(nextReimbursable !== null || "reimbursable" in t ? { reimbursable: nextReimbursable } : {}),
	};
}
export function changed(before: Trip, patch: Partial<Trip>): Trip {
	return { ...before, ...patch, revision: before.revision + 1, updated_at: Date.now() };
}
export function cursorEncode(v: unknown) {
	return btoa(JSON.stringify(v));
}
export function cursorDecode(v: string | undefined): unknown {
	if (!v) return undefined;
	if (v.length > 512) throw new MileageError("INVALID_CURSOR", "Cursor too long");
	try {
		return JSON.parse(atob(v));
	} catch {
		throw new MileageError("INVALID_CURSOR", "Invalid cursor");
	}
}

export interface Vehicle {
	id: "default";
	name: string;
	revision: number;
	method_eligibility: "unknown";
	odometer_readings: {
		id: string;
		observed_at: number;
		reading_miles: number;
		kind: "baseline" | "reading" | "year_end";
	}[];
}
export const defaultVehicle = (): Vehicle => ({
	id: "default",
	name: "Default vehicle",
	revision: 0,
	method_eligibility: "unknown",
	odometer_readings: [],
});
export async function vehicle(db: D1Database, owner: string): Promise<Vehicle> {
	const row = await db
		.prepare("SELECT data FROM mileage_vehicle WHERE owner=?")
		.bind(owner)
		.first<{ data: string }>();
	return row ? JSON.parse(row.data) : defaultVehicle();
}
const logicTables = /no such table: (?:main\.)?mileage_(?:trip_addresses|proposals|rates)\b/i;
/** Optional migration 005: only a missing logic table reads as undefined (old schema keeps working). */
export async function optionalLogic<T>(run: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch (error) {
		if (logicTables.test(String(error))) return undefined;
		throw error;
	}
}
export const logicUnavailable = () =>
	new MileageError(
		"MILEAGE_UNAVAILABLE",
		"Mileage logic schema (migration 005) is not initialized",
		503,
	);
export async function requireLogic<T>(run: () => Promise<T>): Promise<T> {
	const value = await optionalLogic(run);
	if (value === undefined) throw logicUnavailable();
	return value;
}
