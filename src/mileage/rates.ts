import { z } from "zod";
import { MileageError, type MileagePrincipal } from "./auth";
import { textSchema } from "./policy";
import { commit, digest, optionalLogic, requireLogic, saved } from "./store";

/** IRS standard mileage rate row; a tax year may have several (2026 changed on July 1). */
export interface Rate {
	tax_year: number;
	effective_from: string;
	usd_per_mile: number;
	source: string;
}
export const effectiveFromSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "effective_from must be YYYY-MM-DD")
	.refine((v) => {
		const [y, m, d] = v.split("-").map(Number);
		const date = new Date(Date.UTC(y, m - 1, d));
		return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
	}, "effective_from is not a calendar date");
export const putRateSchema = z
	.object({
		tax_year: z.number().int().min(1990).max(2100),
		usd_per_mile: z.number().gt(0).lt(10),
		source: textSchema.transform((v) => v.trim()).pipe(z.string().min(1).max(300)),
		idempotency_key: z
			.string()
			.min(1)
			.max(120)
			.regex(/^[A-Za-z0-9_.:-]+$/),
	})
	.strict();
const select =
	"SELECT tax_year,effective_from,usd_per_mile,source FROM mileage_rates ORDER BY effective_from LIMIT 1000";
/** Missing 005 → undefined (no estimate anywhere); rows sorted by effective_from. */
export async function rates(db: D1Database): Promise<Rate[] | undefined> {
	const rows = await optionalLogic(() => db.prepare(select).all<Rate>());
	return rows?.results;
}
export const ratesStatement = (db: D1Database) => db.prepare(select);
/** The latest row on or before the trip's local date within the same tax year; none → no estimate. */
export function rateFor(list: Rate[], date: string): Rate | null {
	const year = Number(date.slice(0, 4));
	let found: Rate | null = null;
	for (const r of list)
		if (
			r.tax_year === year &&
			r.effective_from <= date &&
			(!found || r.effective_from > found.effective_from)
		)
			found = r;
	return found;
}
export async function putRate(
	db: D1Database,
	p: MileagePrincipal,
	effectiveFrom: string,
	b: z.infer<typeof putRateSchema>,
	audit: (op: string, data: unknown) => D1PreparedStatement,
) {
	await requireLogic(() => db.prepare("SELECT 1 FROM mileage_rates LIMIT 1").all());
	if (Number(effectiveFrom.slice(0, 4)) !== b.tax_year)
		throw new MileageError("INVALID_BODY", "tax_year must match the effective_from year");
	const hash = await digest({ op: "rate:put", effective_from: effectiveFrom, ...b });
	const prior = await saved<Rate>(db, p, b.idempotency_key, hash);
	if (prior) return prior;
	const row: Rate = {
		tax_year: b.tax_year,
		effective_from: effectiveFrom,
		usd_per_mile: b.usd_per_mile,
		source: b.source,
	};
	return commit(db, p, b.idempotency_key, hash, row, [], "rate:put", [
		db
			.prepare(
				"INSERT INTO mileage_rates(tax_year,effective_from,usd_per_mile,source,updated_at,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(effective_from) DO UPDATE SET tax_year=excluded.tax_year,usd_per_mile=excluded.usd_per_mile,source=excluded.source,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
			)
			.bind(row.tax_year, row.effective_from, row.usd_per_mile, row.source, Date.now(), p.actor),
		audit("rate:put", row),
	]);
}
export async function deleteRate(
	db: D1Database,
	effectiveFrom: string,
	audit: (op: string, data: unknown) => D1PreparedStatement,
) {
	const existing = await requireLogic(() =>
		db
			.prepare(
				"SELECT tax_year,effective_from,usd_per_mile,source FROM mileage_rates WHERE effective_from=?",
			)
			.bind(effectiveFrom)
			.all<Rate>(),
	);
	const before = existing.results[0];
	if (!before) throw new MileageError("NOT_FOUND", "Rate not found", 404);
	const [result] = await db.batch([
		db.prepare("DELETE FROM mileage_rates WHERE effective_from=?").bind(effectiveFrom),
		audit("rate:delete", before),
	]);
	if (!result.meta.changes) throw new MileageError("NOT_FOUND", "Rate not found", 404);
	return { effective_from: effectiveFrom, deleted: true };
}
