/**
 * The month's answer in words (CLEAN-SPEC M1): the sentence, the Report line and the Report table, all
 * from the report's totals in the server's company order. Words only: no figure is added or derived.
 */
import type { MileageCompanyTotals, MileageReport } from "../../api/mileage";
import { cents, dayMonthYear, known, mi, miles, monthShort, periodWords, usd } from "./format";

export interface ClaimPart {
	/** "42.5" / "$29.75" */
	value: string;
	/** "mi" / "est." */
	unit: string;
	money: boolean;
	/** "from Acme" / "for Side Co" / "for Side Co, no IRS rate set" */
	words: string;
	/** The company's id, for "Set the IRS rate". */
	company: string;
	noRate: boolean;
}

export interface Claim {
	kind: "claim" | "nothing" | "empty";
	parts: ClaimPart[];
	/** "including 4.1 mi and $2.24 est. that wait for your yes." or null. */
	waiting: string | null;
	/** Companies whose trips have no IRS rate (the sentence links "Set the IRS rate"). */
	noRate: boolean;
}

export const totalsOf = (r: MileageReport, id: string): MileageCompanyTotals | undefined =>
	r.totals.companies.find((c) => c.id === id);

/** Display order for the Report: the claimable companies first, Personal last (server order within). */
export const reportOrder = (r: MileageReport) => [
	...r.companies.filter((c) => c.treatment !== "personal"),
	...r.companies.filter((c) => c.treatment === "personal"),
];

const join = (xs: string[]) =>
	xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? "");

/**
 * "You can claim 42.5 mi from Acme and $29.75 est. for Side Co, including 3.2 mi and $2.24 est.
 * that wait for your yes." Personal is never in it; a business company with no rate says so.
 */
export function claimOf(r: MileageReport): Claim {
	if (r.totals.trips === 0) return { kind: "empty", parts: [], waiting: null, noRate: false };
	const parts: ClaimPart[] = [];
	const waits: string[] = [];
	for (const c of r.companies) {
		const k = totalsOf(r, c.id);
		if (!k || k.trips === 0 || c.treatment === "personal") continue;
		if (c.split_reimbursable) {
			parts.push({
				value: mi(k.reimbursable_meters ?? 0),
				unit: "mi",
				money: false,
				words: `from ${c.name}`,
				company: c.id,
				noRate: false,
			});
			if (k.proposed_reimbursable_meters) waits.push(miles(k.proposed_reimbursable_meters));
		} else if (c.money === "irs-estimate") {
			// A rate gap anywhere in the month leaves no whole estimate (null): miles, "no IRS rate set".
			if (known(k.estimate_usd)) {
				parts.push({
					value: usd(k.estimate_usd),
					unit: "est.",
					money: true,
					words: `for ${c.name}`,
					company: c.id,
					noRate: false,
				});
				if (known(k.proposed_estimate_usd) && k.proposed_meters)
					waits.push(`${usd(k.proposed_estimate_usd)} est.`);
			} else {
				parts.push({
					value: mi(k.meters),
					unit: "mi",
					money: false,
					words: `for ${c.name}, no IRS rate set`,
					company: c.id,
					noRate: true,
				});
				if (k.proposed_meters) waits.push(`${miles(k.proposed_meters)} for ${c.name}`);
			}
		} else {
			parts.push({
				value: mi(k.meters),
				unit: "mi",
				money: false,
				words: `for ${c.name}`,
				company: c.id,
				noRate: false,
			});
			if (k.proposed_meters) waits.push(miles(k.proposed_meters));
		}
	}
	if (parts.length === 0) return { kind: "nothing", parts, waiting: null, noRate: false };
	return {
		kind: "claim",
		parts,
		waiting: waits.length
			? `including ${join(waits)} that ${waits.length > 1 ? "wait" : "waits"} for your yes.`
			: null,
		noRate: parts.some((p) => p.noRate),
	};
}

/** "Nothing to claim in October yet." */
export const nothingWords = (r: MileageReport) => `Nothing to claim in ${monthShort(r.month)} yet.`;

/** The Report line, closed: the figures the sentence doesn't show. */
export function reportLine(r: MileageReport): string {
	const out: string[] = [];
	for (const c of reportOrder(r)) {
		const k = totalsOf(r, c.id);
		if (!k || k.trips === 0) continue;
		if (c.split_reimbursable)
			out.push(`${c.name} ${miles(k.not_reimbursable_meters ?? 0)} not reimbursable`);
		else if (c.money === "irs-estimate") {
			if (known(k.estimate_usd)) out.push(`${c.name} ${miles(k.meters)}`);
		} else if (c.treatment === "personal") out.push(`${c.name} ${miles(k.meters)}`);
	}
	return out.join(" · ");
}

/** " for Oct 1 – 14, 2026" (the stretch with trips and no rate), or "". */
export function uncoveredWords(k: MileageCompanyTotals): string {
	const u = k.uncovered ?? [];
	return u.length ? ` for ${u.map(periodWords).join(" and ")}` : "";
}

/** "at 76¢/mi, the IRS rate from Jul 1, 2026" / "at the IRS rate for each trip's date" / "". */
export function rateNote(k: MileageCompanyTotals): string {
	const used = k.rates_used ?? [];
	if (used.length === 1)
		return `at ${cents(used[0].cents_per_mile)}, the IRS rate from ${dayMonthYear(used[0].from)}`;
	if (used.length > 1) return "at the IRS rate for each trip's date";
	return "";
}

export interface ReportRow {
	label: string;
	/** Opens that company's trips in the rail. */
	company: string | null;
	trips: number | null;
	meters: number;
	note: string;
	/** "Set the IRS rate" after the note. */
	setRate?: boolean;
	kind?: "apart" | "total";
}

/** The Report table: each company (Acme by its split), not answered yet, all trips. */
export function reportRows(r: MileageReport): ReportRow[] {
	const rows: ReportRow[] = [];
	const wait = (m: number | undefined, est?: number | null) =>
		m ? `includes ${miles(m)}${known(est) ? ` (${usd(est)} est.)` : ""} waiting for your yes` : "";
	for (const c of reportOrder(r)) {
		const k = totalsOf(r, c.id);
		if (!k) continue;
		if (c.split_reimbursable) {
			rows.push({
				label: `${c.name}, reimbursable`,
				company: c.id,
				trips: k.reimbursable_trips ?? null,
				meters: k.reimbursable_meters ?? 0,
				note: wait(k.proposed_reimbursable_meters),
			});
			rows.push({
				label: `${c.name}, not reimbursable`,
				company: c.id,
				trips: k.not_reimbursable_trips ?? null,
				meters: k.not_reimbursable_meters ?? 0,
				note: wait(k.proposed_not_reimbursable_meters),
			});
		} else if (c.money === "irs-estimate") {
			const w = wait(k.proposed_meters, k.proposed_estimate_usd);
			rows.push({
				label: c.name,
				company: c.id,
				trips: k.trips,
				meters: k.meters,
				note: known(k.estimate_usd)
					? `${usd(k.estimate_usd)} est. ${rateNote(k)}${w ? `; ${w}` : ""}`
					: `No IRS rate set${uncoveredWords(k)}${w ? `; ${w}` : ""}`,
				setRate: !known(k.estimate_usd) || (k.uncovered ?? []).length > 0,
			});
		} else {
			rows.push({
				label: c.name,
				company: c.id,
				trips: k.trips,
				meters: k.meters,
				note: wait(k.proposed_meters),
			});
		}
	}
	if (r.totals.unassigned.trips > 0)
		rows.push({
			label: "Not answered yet",
			company: null,
			trips: r.totals.unassigned.trips,
			meters: r.totals.unassigned.meters,
			note: "in no total until you answer",
			kind: "apart",
		});
	rows.push({
		label: "All trips",
		company: null,
		trips: r.totals.trips,
		meters: r.totals.all_meters,
		note: "",
		kind: "total",
	});
	return rows;
}
