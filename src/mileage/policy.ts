import { z } from "zod";

export const idSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9_-]+$/);
export const textSchema = z
	.string()
	.max(500)
	.refine((v) => v.isWellFormed(), "Invalid Unicode text")
	.refine(
		(v) =>
			![...v].some((c) => {
				const n = c.charCodeAt(0);
				return n === 127 || (n < 32 && ![9, 10, 13].includes(n));
			}),
	);
export const timeSchema = z.number().int().min(0).max(4102444800000);
/**
 * The phone's estimated start leg (LATE-START §3): Apple Maps driving metres from where the car was
 * parked (the previous trip's end) to the first recorded fix. Set only by the phone at upload; never
 * merged into measured metres. Bad values are 400 INVALID_START_ESTIMATE (routes map the path).
 */
export const startEstimateSchema = z
	.object({
		meters: z.number().int().min(0).max(5000),
		method: z.literal("apple_maps_driving"),
		from_trip_id: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[A-Za-z0-9_-]+$/),
		reason: z.literal("parked_continuity"),
	})
	.strict();
export type StartEstimate = z.infer<typeof startEstimateSchema>;
export const treatmentSchema = z.enum([
	"business",
	"reimbursement",
	"personal",
	"commute",
	"needs_review",
]);
export const measurementSchema = z
	.object({
		id: idSchema,
		started_at: timeSchema,
		ended_at: timeSchema,
		timezone: z
			.string()
			.max(80)
			.refine((v) => {
				try {
					new Intl.DateTimeFormat("en", { timeZone: v });
					return true;
				} catch {
					return false;
				}
			}),
		distance_meters: z.number().int().min(0).max(3000000),
		origin: textSchema,
		destination: textSchema,
		vehicle_id: idSchema,
		source: z.enum(["gps", "manual"]),
		quality: z.enum(["complete", "delayed_start", "gap", "manual"]),
		start_lat: z.number().min(-90).max(90).optional(),
		start_lng: z.number().min(-180).max(180).optional(),
		end_lat: z.number().min(-90).max(90).optional(),
		end_lng: z.number().min(-180).max(180).optional(),
		// null and absent are the same capture: the sync route drops a null before hashing.
		start_estimate: startEstimateSchema.nullable().optional(),
	})
	.strict()
	.superRefine((v, c) => {
		if (v.ended_at <= v.started_at || v.ended_at - v.started_at > 7 * 86400000)
			c.addIssue({ code: "custom", message: "Invalid trip interval" });
		if (
			v.source === "gps" &&
			(v.distance_meters / ((v.ended_at - v.started_at) / 1000) > 75 || v.quality === "manual")
		)
			c.addIssue({ code: "custom", message: "Implausible GPS measurement" });
		if (
			(v.start_lat === undefined) !== (v.start_lng === undefined) ||
			(v.end_lat === undefined) !== (v.end_lng === undefined)
		)
			c.addIssue({ code: "custom", message: "Coordinates require pairs" });
	});
export type Measurement = z.infer<typeof measurementSchema>;
export interface Trip extends Measurement {
	measured_distance_meters: number;
	category_id: string | null;
	entity_id: string | null;
	purpose: string;
	treatment: z.infer<typeof treatmentSchema>;
	revision: number;
	human_reviewed: boolean;
	deleted_at: number | null;
	updated_at: number;
	lineage: string[];
	evidence_ids: string[];
	correction_reason?: string;
	reconstruction_confirmed?: boolean;
	/** Acme (reimbursement treatment) only; absent on old rows reads as null. */
	reimbursable?: boolean | null;
	/** The phone's estimated start leg; absent (old rows, no estimate) or null (removed) = none. */
	start_estimate?: StartEstimate | null;
}
const METERS_PER_MILE = 1609.344;
/** Rule A + LATE-START §4: a trip's miles in the report and every export = recorded (or the owner's corrected) + estimate. */
export function countedMeters(t: Pick<Trip, "distance_meters" | "start_estimate">): number {
	return t.distance_meters + (t.start_estimate?.meters ?? 0);
}
/** The §4 flag for a trip that started recording late (quality `delayed_start`, or an estimate); "" otherwise. */
export function lateStartFlag(t: Pick<Trip, "quality" | "start_estimate">): string {
	if (t.start_estimate)
		return `recording started late; includes ${(t.start_estimate.meters / METERS_PER_MILE).toFixed(1)} mi estimated start (Apple Maps from where the car was parked)`;
	return t.quality === "delayed_start" ? "recording started late; recorded miles only" : "";
}
export const validateMeasurement = (v: unknown) => measurementSchema.parse(v);
export function agentSummary(t: Trip) {
	return {
		id: t.id,
		started_at: t.started_at,
		ended_at: t.ended_at,
		timezone: t.timezone,
		distance_meters: t.distance_meters,
		category_id: t.category_id,
		entity_id: t.entity_id,
		purpose: t.purpose,
		treatment: t.treatment,
		quality: t.quality,
		revision: t.revision,
		human_reviewed: t.human_reviewed,
		updated_at: t.updated_at,
		deleted_at: t.deleted_at,
		evidence_ids: t.evidence_ids,
		reimbursable: t.reimbursable ?? null,
	};
}
/** Trip-local calendar date `YYYY-MM-DD`; rates, months and report dates all use it. */
export function localDate(t: Pick<Trip, "started_at" | "timezone">): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: t.timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(t.started_at);
}
export function csvCell(value: unknown): string {
	let s = String(value ?? "");
	if (/^[\s]*[=+@-]/.test(s) || [...s].some((c) => c.charCodeAt(0) < 32)) s = `'${s}`;
	return `"${s.replace(/"/g, '""')}"`;
}
export const eventSchema = z
	.object({
		id: idSchema,
		calendar_id: z
			.string()
			.min(1)
			.max(254)
			.regex(/^[A-Za-z0-9_.@+-]+$/),
		version: textSchema.min(1).max(100),
		starts_at: timeSchema,
		ends_at: timeSchema,
		lat: z.number().min(-90).max(90).nullable().default(null),
		lng: z.number().min(-180).max(180).nullable().default(null),
		status: z.enum(["confirmed", "cancelled", "tentative"]),
		virtual: z.boolean(),
		all_day: z.boolean(),
		observed_at: timeSchema,
		site_confirmed: z.boolean(),
		travel_eligible: z.boolean(),
		commute: z.boolean(),
		category_id: idSchema,
		purpose: textSchema,
	})
	.strict()
	.refine(
		(v) => v.ends_at > v.starts_at && v.observed_at <= Date.now() + 60000,
		"Invalid event timestamps",
	);
export type CalendarEvent = z.infer<typeof eventSchema> & { entity_id: string };
export function companyTreatment(t: Pick<Trip, "treatment">): boolean {
	return t.treatment === "business" || t.treatment === "reimbursement";
}
export function ownerReconstruction(t: Trip): boolean {
	return (
		t.human_reviewed && t.reconstruction_confirmed !== false && Boolean(t.correction_reason?.trim())
	);
}
export function endpointEvidence(t: Trip): boolean {
	return (
		Boolean(t.origin.trim() || (t.start_lat != null && t.start_lng != null)) &&
		Boolean(t.destination.trim() || (t.end_lat != null && t.end_lng != null))
	);
}
function calendarAtDestination(t: Trip, e: CalendarEvent, now: number): boolean {
	if (e.status !== "confirmed" || e.virtual || e.all_day || !e.site_confirmed) return false;
	if (e.observed_at <= 0 || now - e.observed_at > 7 * 86400000 || e.observed_at > now + 60000)
		return false;
	if (
		t.source !== "gps" ||
		t.end_lat == null ||
		t.end_lng == null ||
		e.lat == null ||
		e.lng == null
	)
		return false;
	if (Math.abs(t.ended_at - e.starts_at) > 90 * 60000) return false;
	const rad = Math.PI / 180,
		dlat = (e.lat - t.end_lat) * rad,
		dlng = (e.lng - t.end_lng) * rad;
	const a =
		Math.sin(dlat / 2) ** 2 +
		Math.cos(t.end_lat * rad) * Math.cos(e.lat * rad) * Math.sin(dlng / 2) ** 2;
	return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= 250;
}
export function calendarCommute(t: Trip, e: CalendarEvent, now: number): boolean {
	return e.commute && calendarAtDestination(t, e, now);
}
// Category/purpose evidence is separate from the stricter distance-substantiation gate below.
export function calendarCandidate(t: Trip, e: CalendarEvent, now: number): boolean {
	return (
		!e.commute &&
		e.travel_eligible &&
		Boolean(e.purpose.trim()) &&
		(t.quality === "complete" || t.quality === "delayed_start") &&
		calendarAtDestination(t, e, now)
	);
}
export interface CalendarSuggestion {
	category_id: string;
	purpose: string;
	event_starts_at: number;
	calendar_id: string;
	reasons: string[];
}
/** Review hints only. Caller supplies current allowlisted owner projections, never export evidence. */
export function calendarSuggestions(
	t: Trip,
	projected: CalendarEvent[],
	now: number,
): CalendarSuggestion[] {
	if (t.human_reviewed || t.deleted_at !== null || ["personal", "commute"].includes(t.treatment))
		return [];
	const nearby = projected.filter(
		(e) =>
			e.status === "confirmed" &&
			!e.virtual &&
			!e.all_day &&
			e.observed_at > 0 &&
			now - e.observed_at <= 7 * 86400000 &&
			e.observed_at <= now + 60000 &&
			Math.abs(t.ended_at - e.starts_at) <= 90 * 60000 &&
			Boolean(e.purpose.trim()),
	);
	// Two meetings are ambiguous even when their entity/title happen to agree.
	if (nearby.length !== 1 || nearby[0].commute) return [];
	const e = nearby[0];
	const reasons = ["time_match"];
	if (!e.site_confirmed) reasons.push("site_unconfirmed");
	if (!e.travel_eligible) reasons.push("travel_unconfirmed");
	if (e.site_confirmed && !calendarAtDestination(t, e, now))
		reasons.push("destination_unconfirmed");
	return [
		{
			category_id: e.category_id,
			purpose: e.purpose.replace(/\s+/gu, " ").trim(),
			event_starts_at: e.starts_at,
			calendar_id: e.calendar_id,
			reasons,
		},
	];
}
/** Why a company export leaves a business or Acme trip out. Started late counts, flagged (LATE-START rule A). */
export type LeftOutReason = "recording_gap" | "no_endpoints" | "unconfirmed";
export function substantiation(t: Trip, projected: CalendarEvent[], now: number) {
	const candidates = projected.filter((e) => calendarCandidate(t, e, now));
	const decisions = new Set(candidates.map((e) => `${e.category_id}\n${e.purpose}`));
	// V3: a trip the agent filed (an applied proposal, cited as `proposal:<id>`) counts as filed, as on screen.
	const supported =
		t.human_reviewed ||
		t.evidence_ids.some((e) => e.startsWith("proposal:")) ||
		(!projected.some((e) => calendarCommute(t, e, now)) &&
			decisions.size === 1 &&
			candidates.some(
				(e) =>
					e.category_id === t.category_id &&
					e.purpose === t.purpose &&
					t.evidence_ids.includes(`calendar:${e.calendar_id}:${e.id}:${e.version}`),
			));
	const reconstructed = ownerReconstruction(t);
	// Rule A (LATE-START §1): a started-late trip counts its recorded miles (plus any estimate), flagged.
	const measured = t.quality !== "gap" || reconstructed;
	const eligible =
		supported &&
		companyTreatment(t) &&
		Boolean(t.purpose.trim()) &&
		Boolean(t.category_id) &&
		endpointEvidence(t) &&
		measured;
	const left_out: LeftOutReason | null =
		eligible || !companyTreatment(t)
			? null
			: !measured
				? "recording_gap"
				: !endpointEvidence(t)
					? "no_endpoints"
					: "unconfirmed";
	const late = lateStartFlag(t);
	return {
		eligible,
		left_out,
		distance_method: reconstructed
			? "owner_reconstructed"
			: t.correction_reason
				? "mixed_reconstruction_unconfirmed"
				: t.source,
		capture_warning:
			reconstructed && !["complete", "manual"].includes(t.quality)
				? `Capture ${t.quality}; owner reconstruction retained`
				: [t.quality === "gap" ? "Capture gap; not substantiated" : "", late]
						.filter(Boolean)
						.join("; "),
	};
}
/** WinAnsiEncoding (cp1252) bytes 0x80-0x9F by position ("\0": no character); 0xA0-0xFF are Latin-1's own. */
const CP1252_80 = "€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ";
/** A character's byte in the PDF font's WinAnsiEncoding; undefined outside cp1252 or for a control. */
function winAnsi(c: string): number | undefined {
	if (c.length !== 1) return undefined;
	const n = c.charCodeAt(0);
	if ((n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff)) return n;
	const i = c === "\0" ? -1 : CP1252_80.indexOf(c);
	return i >= 0 ? 0x80 + i : undefined;
}
/** Plain forms for characters outside cp1252 that have an obvious ASCII spelling. */
const PDF_PLAIN: Record<string, string> = {
	"→": "->",
	"←": "<-",
	"↔": "<->",
	"⇒": "=>",
	"⇐": "<=",
	"−": "-",
	"‐": "-",
	"‑": "-",
	"‒": "-",
	"―": "-",
	"′": "'",
	"″": '"',
	"≤": "<=",
	"≥": ">=",
	"≠": "!=",
};
/**
 * A line in the PDF font's characters (ux-s-p0-5 round 3): a character outside cp1252 is written in
 * its plain form (PDF_PLAIN; else its letters without their marks, "ở" -> "o"; else left out, as CJK
 * or an emoji are), never refusing the month. `changed` says whether anything was replaced.
 */
function pdfPlain(line: string): { text: string; changed: boolean } {
	let text = "",
		changed = false;
	for (const c of line.replace(/[\t\r\n]/g, " ")) {
		if (winAnsi(c) !== undefined) {
			text += c;
			continue;
		}
		changed = true;
		const folded = PDF_PLAIN[c] ?? c.normalize("NFKD").replace(/\p{M}/gu, "");
		if ([...folded].every((f) => winAnsi(f) !== undefined)) text += folded;
	}
	return {
		text: changed ? text.replace(/ {2,}/g, " ").replace(/ +([,.;:])/g, "$1") : text,
		changed,
	};
}
/**
 * Basic Type1 PDF in WinAnsiEncoding (Latin letters, curly quotes, dashes, "·"), so Apple's names and
 * addresses print as written (ux-s-p0-5). Anything else prints in its plain form and the file ends with
 * one note saying so, never refusing the export; the UTF-8 CSV keeps the exact text.
 */
export function pdfDocument(input: string[]): Uint8Array {
	const plain = input.map(pdfPlain);
	const lines = plain.map((p) => p.text);
	if (plain.some((p) => p.changed))
		lines.push(
			"",
			"Note: some characters can't be shown in this PDF, so they are printed in a plain form or left out. The CSV export has the exact text.",
		);
	// PDF string escapes first, then every byte past ASCII as an octal escape: the file stays 7-bit.
	const pdfString = (line: string) =>
		line
			.replace(/([\\()])/g, "\\$1")
			.replace(/[^\x20-\x7e]/g, (c) => `\\${(winAnsi(c) ?? 0x3f).toString(8)}`);
	const wrapped = lines.flatMap((line) => {
		const result: string[] = [];
		let current = "";
		for (let word of line.replace(/[\r\n\t]/g, " ").split(/ +/)) {
			if (current && current.length + word.length + 1 > 88) {
				result.push(current);
				current = "";
			}
			while (word.length > 88) {
				result.push(word.slice(0, 88));
				word = word.slice(88);
			}
			current = current ? `${current} ${word}` : word;
		}
		result.push(current);
		return result;
	});
	const pages: string[][] = [];
	for (let i = 0; i < wrapped.length; i += 45) pages.push(wrapped.slice(i, i + 45));
	if (!pages.length) pages.push([]);
	const objects: string[] = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
	];
	const kids: string[] = [];
	for (const [pageIndex, page] of pages.entries()) {
		const pageId = objects.length + 1,
			streamId = pageId + 1;
		kids.push(`${pageId} 0 R`);
		const stream = `BT /F1 10 Tf 40 800 Td 16 TL ${page.map((l) => `(${pdfString(l)}) Tj T*`).join("\n")} ET BT /F1 9 Tf 40 25 Td (Page ${pageIndex + 1} / ${pages.length}) Tj ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}
	objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
		.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}
