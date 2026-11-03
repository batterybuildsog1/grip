/**
 * Mileage V3 "Answer first": one trip state, one totals function and one trip view. The report
 * (`GET /report`) and the exports both count through `countTrips` + `totalsOf`, so an export that
 * includes the agent's guesses has exactly the report's totals (docs/mileage/V3-CONTRACT.md).
 */
import type { EndpointAddress } from "./addresses";
import { nearest, type Place } from "./places";
import { countedMeters, type LeftOutReason, type StartEstimate, type Trip } from "./policy";
import type { Proposal } from "./proposals";
import { type Rate, rateFor } from "./rates";
import type { Category } from "./store";

export type TripState = "filed" | "auto" | "proposal" | "ask";
/** A pending guess below this is the agent asking ("Side Co or personal?"), not a guess to say Yes to. */
export const ASK_BELOW = 0.5;
const METERS_PER_MILE = 1609.344;

export interface Company {
	id: string;
	name: string;
	treatment: Trip["treatment"];
	money: "none" | "irs-estimate";
	split_reimbursable: boolean;
}
/**
 * Server order (the 1 2 3 keys): Personal, the built-in companies in MILEAGE_COMPANIES_JSON order (default
 * none), then the companies the owner added, in the order they were added (`categories`
 * lists built-ins first and reads the owner's by rowid). api-r1-02: never by treatment.
 */
export function companyList(cats: Category[]): Company[] {
	const rank = (c: Category) => (c.id === "personal" ? 0 : 1);
	return cats
		.map((c, i) => ({ c, i }))
		.sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
		.map(({ c }) => ({
			id: c.id,
			name: c.name,
			treatment: c.treatment,
			money: c.treatment === "business" ? "irs-estimate" : "none",
			split_reimbursable: c.treatment === "reimbursement",
		}));
}
/** A dated IRS rate period: `to` is the day before the next period of the same tax year, else Dec 31. */
export interface Period {
	from: string;
	to: string;
	cents_per_mile: number;
	source: string;
}
const dayBefore = (date: string) =>
	new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const cents3 = (usd: number) => Math.round(usd * 100000) / 1000;
export function periods(rates: Rate[]): Period[] {
	const sorted = [...rates].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
	return sorted.map((r) => {
		const next = sorted.find(
			(x) => x.tax_year === r.tax_year && x.effective_from > r.effective_from,
		);
		return {
			from: r.effective_from,
			to: next ? dayBefore(next.effective_from) : `${r.tax_year}-12-31`,
			cents_per_mile: cents3(r.usd_per_mile),
			source: r.source,
		};
	});
}
/** The stretch of a trip's tax year with no rate around `date` (the period Settings should fill). */
export function uncoveredOf(date: string, rates: Rate[]): { from: string; to: string } {
	const year = Number(date.slice(0, 4));
	const first = rates
		.filter((r) => r.tax_year === year)
		.sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))[0];
	return { from: `${year}-01-01`, to: first ? dayBefore(first.effective_from) : `${year}-12-31` };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Local `YYYY-MM-DD` of an instant in a time zone (cached formatters: thousands of trips per call). */
export function localDay(at: number, timezone: string): string {
	let f = formatters.get(timezone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		formatters.set(timezone, f);
	}
	return f.format(at);
}
function offsetMs(at: number, timezone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const local = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour") % 24,
		get("minute"),
		get("second"),
	);
	return local - Math.floor(at / 1000) * 1000;
}
/** Epoch ms of local midnight on the first day of `month` (YYYY-MM) and of the next month. */
export function monthBounds(month: string, timezone: string): { from: number; to: number } {
	const [y, m] = month.split("-").map(Number);
	const midnight = (year: number, mon: number) => {
		const guess = Date.UTC(year, mon - 1, 1);
		const first = guess - offsetMs(guess, timezone);
		return guess - offsetMs(first, timezone);
	};
	return { from: midnight(y, m), to: m === 12 ? midnight(y + 1, 1) : midnight(y, m + 1) };
}

interface Classification {
	category_id: string | null;
	entity_id: string | null;
	treatment: Trip["treatment"];
	purpose: string;
	reimbursable: boolean | null;
}
const own = (t: Trip): Classification => ({
	category_id: t.category_id,
	entity_id: t.entity_id,
	treatment: t.treatment,
	purpose: t.purpose,
	reimbursable: t.reimbursable ?? null,
});
function guessed(t: Trip, p: Proposal, cats: Category[]): Classification {
	const cat = cats.find((x) => x.id === (p.category_id ?? t.category_id));
	const treatment = p.category_id !== undefined ? (cat?.treatment ?? "needs_review") : t.treatment;
	return {
		category_id: cat?.id ?? null,
		entity_id: cat?.entity_id ?? null,
		treatment,
		purpose: p.purpose ?? t.purpose,
		reimbursable: treatment === "reimbursement" ? (p.reimbursable ?? t.reimbursable ?? null) : null,
	};
}
/** Filed means: a company; a purpose for business and reimbursement; reimbursable or not for Acme. */
export function complete(c: Classification): boolean {
	return (
		Boolean(c.category_id) &&
		c.treatment !== "needs_review" &&
		(!["business", "reimbursement"].includes(c.treatment) || Boolean(c.purpose.trim())) &&
		(c.treatment !== "reimbursement" || c.reimbursable !== null)
	);
}
/** The guess the owner sees: texts-backed first, then the newest. */
export function topGuess(list: Proposal[] | undefined): Proposal | null {
	if (!list?.length) return null;
	const texts = (x: Proposal) => x.basis.some((b) => b.kind === "texts");
	return [...list].sort(
		(a, b) => Number(texts(b)) - Number(texts(a)) || b.created_at - a.created_at,
	)[0];
}

export interface Counted {
	trip: Trip;
	date: string;
	state: TripState;
	/** The classification as counted: the guess's for state "proposal", else the trip's own. */
	as: Classification;
	/** The pending guess shown with the trip (also on an ask, as a hint), if any. */
	guess: Proposal | null;
	rate: Rate | null;
	cents: number | null;
}
/** Business trips only: counted miles × the dated rate, rounded to the cent per trip (null: no rate for that date). */
export function estimateCents(
	t: Pick<Trip, "distance_meters" | "start_estimate">,
	rate: Rate | null,
): number | null {
	return rate ? Math.round((countedMeters(t) / METERS_PER_MILE) * rate.usd_per_mile * 100) : null;
}
/**
 * The one state rule. `withGuesses` false (the export's default) counts each trip as stored.
 * proposal: a pending, sure-enough guess that would file the trip with one Yes;
 * filed / auto: the trip is complete, by the owner / by the agent (or a calendar match);
 * ask: everything else (unclassified, Acme without a mark, a weak or incomplete guess).
 */
export function countTrips(
	trips: Trip[],
	pending: Map<string, Proposal[]>,
	cats: Category[],
	rates: Rate[],
	withGuesses: boolean,
): Counted[] {
	return trips.map((t) => {
		const date = localDay(t.started_at, t.timezone);
		const guess = t.human_reviewed ? null : topGuess(pending.get(t.id));
		let state: TripState, as: Classification;
		const classifies =
			guess && [guess.category_id, guess.purpose, guess.reimbursable].some((v) => v !== undefined);
		const g = guess && classifies ? guessed(t, guess, cats) : null;
		if (withGuesses && guess && g && guess.confidence >= ASK_BELOW && complete(g)) {
			state = "proposal";
			as = g;
		} else {
			as = own(t);
			state = complete(as) ? (t.human_reviewed ? "filed" : "auto") : "ask";
		}
		const rate = state !== "ask" && as.treatment === "business" ? rateFor(rates, date) : null;
		const cents = state !== "ask" && as.treatment === "business" ? estimateCents(t, rate) : null;
		return { trip: t, date, state, as, guess: withGuesses ? guess : null, rate, cents };
	});
}

export interface CompanyTotals {
	id: string;
	trips: number;
	meters: number;
	proposed_trips: number;
	proposed_meters: number;
	reimbursable_trips?: number;
	reimbursable_meters?: number;
	not_reimbursable_trips?: number;
	not_reimbursable_meters?: number;
	proposed_reimbursable_meters?: number;
	proposed_not_reimbursable_meters?: number;
	estimate_usd?: number | null;
	proposed_estimate_usd?: number | null;
	rates_used?: Period[];
	uncovered?: { from: string; to: string }[];
	/** The company's default export: without the agent's guesses, only the trips it substantiates. */
	confirmed?: Confirmed;
}
export interface Confirmed {
	trips: number;
	meters: number;
	reimbursable_trips?: number;
	reimbursable_meters?: number;
	not_reimbursable_trips?: number;
	not_reimbursable_meters?: number;
	estimate_usd?: number | null;
	/** Filed trips the company export leaves out, by reason (empty when none). */
	left_out: {
		reason: LeftOutReason;
		trips: number;
		meters: number;
		estimate_usd?: number | null;
	}[];
}
/** The same trips counted without the guesses, and why a company export would leave one out. */
export interface WithoutGuesses {
	counted: Counted[];
	leftOut: (t: Trip) => LeftOutReason | null;
}
export interface Totals {
	all_meters: number;
	trips: number;
	to_review: number;
	agent_filed: number;
	proposed: { trips: number; meters: number };
	unassigned: { trips: number; meters: number };
	companies: CompanyTotals[];
}
const meters = (xs: Counted[]) => xs.reduce((s, x) => s + countedMeters(x.trip), 0);
const usd = (xs: Counted[]) =>
	xs.some((x) => x.cents === null) ? null : xs.reduce((s, x) => s + (x.cents ?? 0), 0) / 100;
/**
 * Every trip lands in exactly one place: one company (and for Acme one side) or `unassigned`.
 * `withoutGuesses` (the same trips counted with `countTrips(..., false)`) adds each company's `confirmed`.
 */
export function totalsOf(
	counted: Counted[],
	companies: Company[],
	rates: Rate[],
	without?: WithoutGuesses,
): Totals {
	const reasonOf = (x: Counted) =>
		without && x.state !== "ask" && ["business", "reimbursement"].includes(x.as.treatment)
			? without.leftOut(x.trip)
			: null;
	const confirmed = without
		? totalsOf(
				without.counted.filter((x) => !reasonOf(x)),
				companies,
				rates,
			).companies
		: null;
	const leftOut = without ? without.counted.filter((x) => reasonOf(x)) : [];
	const known = new Set(companies.map((c) => c.id));
	const inCompany = counted.filter((x) => x.state !== "ask" && known.has(x.as.category_id ?? ""));
	const unassigned = counted.filter((x) => !inCompany.includes(x));
	const all = periods(rates);
	const periodOf = (r: Rate) => all.find((p) => p.from === r.effective_from);
	return {
		all_meters: meters(counted),
		trips: counted.length,
		to_review: counted.filter((x) => x.state === "ask" || x.state === "proposal").length,
		agent_filed: counted.filter((x) => x.state === "auto").length,
		proposed: {
			trips: inCompany.filter((x) => x.state === "proposal").length,
			meters: meters(inCompany.filter((x) => x.state === "proposal")),
		},
		unassigned: { trips: unassigned.length, meters: meters(unassigned) },
		companies: companies.map((co) => {
			const xs = inCompany.filter((x) => x.as.category_id === co.id);
			const guesses = xs.filter((x) => x.state === "proposal");
			const totals: CompanyTotals = {
				id: co.id,
				trips: xs.length,
				meters: meters(xs),
				proposed_trips: guesses.length,
				proposed_meters: meters(guesses),
			};
			if (co.split_reimbursable) {
				const side = (ys: Counted[], mark: boolean) =>
					meters(ys.filter((x) => x.as.reimbursable === mark));
				totals.reimbursable_trips = xs.filter((x) => x.as.reimbursable === true).length;
				totals.reimbursable_meters = side(xs, true);
				totals.not_reimbursable_trips = xs.filter((x) => x.as.reimbursable === false).length;
				totals.not_reimbursable_meters = side(xs, false);
				totals.proposed_reimbursable_meters = side(guesses, true);
				totals.proposed_not_reimbursable_meters = side(guesses, false);
			}
			if (co.money === "irs-estimate") {
				const used = new Map<string, Period>();
				const holes = new Map<string, { from: string; to: string }>();
				for (const x of xs) {
					const period = x.rate ? periodOf(x.rate) : undefined;
					if (period) used.set(period.from, period);
					else {
						const hole = uncoveredOf(x.date, rates);
						holes.set(hole.from, hole);
					}
				}
				totals.estimate_usd = usd(xs);
				totals.proposed_estimate_usd = usd(guesses);
				totals.rates_used = [...used.values()].sort((a, b) => (a.from < b.from ? -1 : 1));
				totals.uncovered = [...holes.values()].sort((a, b) => (a.from < b.from ? -1 : 1));
			}
			const mine = confirmed?.find((c) => c.id === co.id);
			if (mine)
				totals.confirmed = {
					trips: mine.trips,
					meters: mine.meters,
					...(co.split_reimbursable
						? {
								reimbursable_trips: mine.reimbursable_trips,
								reimbursable_meters: mine.reimbursable_meters,
								not_reimbursable_trips: mine.not_reimbursable_trips,
								not_reimbursable_meters: mine.not_reimbursable_meters,
							}
						: {}),
					...(co.money === "irs-estimate" ? { estimate_usd: mine.estimate_usd } : {}),
					left_out: (["recording_gap", "no_endpoints", "unconfirmed"] as const)
						.map((reason) => {
							const xs = leftOut.filter(
								(x) => x.as.category_id === co.id && reasonOf(x) === reason,
							);
							return {
								reason,
								trips: xs.length,
								meters: meters(xs),
								...(co.money === "irs-estimate" ? { estimate_usd: usd(xs) } : {}),
							};
						})
						.filter((x) => x.trips),
				};
			return totals;
		}),
	};
}

/* ---------------------------------------------------------------- the trip view (report only) */

export type NameSource = "saved" | "trip" | "agent" | "apple" | "address" | "coordinates";
export interface Endpoint {
	lat: number | null;
	lng: number | null;
	name: string | null;
	name_source: NameSource;
	name_basis: { kind: string; detail: string } | null;
	address: string | null;
	place_id: string | null;
}
export interface Gap {
	meters: number | null;
	seconds: number | null;
	from_at: number | null;
	to_at: number | null;
}
interface RoutePointLite {
	timestamp: number;
	latitude: number;
	longitude: number;
	accepted?: boolean;
	reason?: string;
}
function haversine(aLat: number, aLng: number, bLat: number, bLng: number) {
	const rad = Math.PI / 180;
	const a =
		Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
		Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLng - aLng) * rad) / 2) ** 2;
	return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
/**
 * The unrecorded stretch of a gap trip, from its stored route: points marked `reason: "gap"` (rebuilt along
 * the roads, as the design kit's are) or else the longest silence between two recorded points.
 */
export function gapOf(points: RoutePointLite[]): Gap {
	const pts = points.filter((p) => p.accepted !== false).sort((a, b) => a.timestamp - b.timestamp);
	const marked = pts.filter((p) => p.reason === "gap");
	let from: RoutePointLite | undefined, to: RoutePointLite | undefined;
	if (marked.length >= 2) {
		from = marked[0];
		to = marked[marked.length - 1];
	} else {
		let best = 0;
		for (let i = 1; i < pts.length; i++)
			if (pts[i].timestamp - pts[i - 1].timestamp > best) {
				best = pts[i].timestamp - pts[i - 1].timestamp;
				from = pts[i - 1];
				to = pts[i];
			}
	}
	if (!from || !to) return { meters: null, seconds: null, from_at: null, to_at: null };
	const stretch = pts.filter((p) => p.timestamp >= from.timestamp && p.timestamp <= to.timestamp);
	let m = 0;
	for (let i = 1; i < stretch.length; i++)
		m += haversine(
			stretch[i - 1].latitude,
			stretch[i - 1].longitude,
			stretch[i].latitude,
			stretch[i].longitude,
		);
	return {
		meters: Math.round(m),
		seconds: Math.round((to.timestamp - from.timestamp) / 1000),
		// Whole epoch ms: phones send fractional timestamps, and the contract (and the Apple decoder) say integers.
		from_at: Math.round(from.timestamp),
		to_at: Math.round(to.timestamp),
	};
}

export interface TripView {
	id: string;
	revision: number;
	started_at: number;
	ended_at: number;
	timezone: string;
	date: string;
	minutes: number;
	/** The trip's miles as counted: recorded (or your correction) + `start_estimate.meters`. */
	distance_meters: number;
	quality: Trip["quality"];
	/** The phone's estimated start leg (Apple Maps from where the car was parked), or null. */
	start_estimate: StartEstimate | null;
	gap: Gap | null;
	start: Endpoint;
	end: Endpoint;
	company_id: string | null;
	reimbursable: boolean | null;
	purpose: string | null;
	state: TripState;
	set_by: "you" | "agent" | null;
	proposal: {
		id: string;
		company_id: string | null;
		reimbursable: boolean | null;
		purpose: string | null;
		confidence: number;
		reason: string | null;
		sources: string[];
	} | null;
	auto: { confidence: number | null; reason: string | null; sources: string[] } | null;
	prompt: string | null;
	/** The short form for rail rows ("Side Co or personal?", "Filed: Acme, reimbursable"). */
	rail_prompt: string;
	/** The agent's one line on why it filed, guesses or asks (never texts); null on a trip you filed. */
	reason: string | null;
	return_of: string | null;
	estimate_usd: number | null;
	cents_per_mile: number | null;
}
export interface ViewContext {
	companies: Company[];
	places: Place[];
	addresses: Map<string, { start?: EndpointAddress; end?: EndpointAddress }>;
	/** Proposals cited by trips' `proposal:<id>` evidence (any status): what the agent filed or named. */
	cited: Map<string, Proposal>;
	gaps: Map<string, Gap>;
}
const RETURN_RADIUS_M = 200;
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const reasonOf = (p: Proposal) => p.basis[0]?.detail ?? null;
const sourcesOf = (p: Proposal) => [...new Set(p.basis.map((b) => b.kind))];
function citedOf(t: Trip, cited: Map<string, Proposal>): Proposal[] {
	return t.evidence_ids
		.filter((e) => e.startsWith("proposal:"))
		.map((e) => cited.get(e.slice(9)))
		.filter((p): p is Proposal => !!p)
		.sort((a, b) => b.created_at - a.created_at);
}
/** Short words for an Apple address with no name: "100 Example Street, Springfield" (street and city). */
const shortAddress = (address: string) => address.split(/,\s*/).slice(0, 2).join(", ");
/** One end's name and address: the screen's (trip view) and the exports' (`endWords`) one rule. */
export function endpoint(
	c: Counted,
	which: "start" | "end",
	ctx: Pick<ViewContext, "places" | "addresses" | "cited">,
	shownGuess: Proposal | null,
): Endpoint {
	const t = c.trip;
	const lat = (which === "start" ? t.start_lat : t.end_lat) ?? null;
	const lng = (which === "start" ? t.start_lng : t.end_lng) ?? null;
	const field = which === "start" ? "origin" : "destination";
	const apple = ctx.addresses.get(t.id)?.[which];
	const saved = lat !== null && lng !== null ? nearest(lat, lng, ctx.places) : undefined;
	const base = { lat, lng, address: apple?.address ?? null, place_id: saved?.id ?? null };
	const basis = (p: Proposal) =>
		p.basis[0] ? { kind: p.basis[0].kind, detail: p.basis[0].detail } : null;
	if (saved) return { ...base, name: saved.name, name_source: "saved", name_basis: null };
	const text = t[field].trim();
	if (text) {
		const namer = citedOf(t, ctx.cited).find((p) => p[field]?.trim() === text);
		return namer
			? { ...base, name: text, name_source: "agent", name_basis: basis(namer) }
			: { ...base, name: text, name_source: "trip", name_basis: null };
	}
	const proposed = shownGuess?.[field]?.trim();
	if (shownGuess && proposed)
		return { ...base, name: proposed, name_source: "agent", name_basis: basis(shownGuess) };
	if (apple?.name) return { ...base, name: apple.name, name_source: "apple", name_basis: null };
	if (apple)
		return { ...base, name: shortAddress(apple.address), name_source: "address", name_basis: null };
	return {
		...base,
		name: lat !== null && lng !== null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : null,
		name_source: "coordinates",
		name_basis: null,
	};
}
/**
 * An end as an export prints it, in the trip sheet's words: the name, then " · " and Apple's full address
 * ("Home · 214 Juniper Ln, Anytown, UT 84000"). Apple's short address and coordinates are not names;
 * nothing known is "" (ux-s-p0-5).
 */
export function endWords(e: Endpoint): string {
	const name = e.name_source === "address" || e.name_source === "coordinates" ? null : e.name;
	return [name, e.address].filter(Boolean).join(" · ");
}
/** A drive back: right after the trip before it on the same day, from where that trip ended, to a saved place or its start. */
export function returnPairs(counted: Counted[], places: Place[]): Map<string, string> {
	const byTime = [...counted].sort(
		(a, b) => a.trip.started_at - b.trip.started_at || (a.trip.id < b.trip.id ? -1 : 1),
	);
	const near = (aLat?: number, aLng?: number, bLat?: number, bLng?: number) =>
		aLat !== undefined &&
		aLng !== undefined &&
		bLat !== undefined &&
		bLng !== undefined &&
		haversine(aLat, aLng, bLat, bLng) <= RETURN_RADIUS_M;
	const pairs = new Map<string, string>();
	for (let i = 1; i < byTime.length; i++) {
		const a = byTime[i - 1].trip,
			b = byTime[i].trip;
		if (byTime[i - 1].date !== byTime[i].date || a.ended_at > b.started_at) continue;
		const atSaved = !!nearest(b.end_lat, b.end_lng, places);
		if (
			near(a.end_lat, a.end_lng, b.start_lat, b.start_lng) &&
			(atSaved || near(b.end_lat, b.end_lng, a.start_lat, a.start_lng))
		)
			pairs.set(b.id, a.id);
	}
	return pairs;
}
/** The question in full (`prompt`) and its short form for rail rows (`rail_prompt`), made here so every client agrees. */
function promptsOf(
	c: Counted,
	view: Pick<TripView, "end" | "return_of">,
	ctx: ViewContext,
): { prompt: string | null; rail: string } {
	const co = (id: string | null) => ctx.companies.find((x) => x.id === id);
	const both = (text: string) => ({ prompt: text, rail: text });
	if (c.state === "filed" || c.state === "auto") {
		const company = co(c.as.category_id);
		const side = company?.split_reimbursable
			? c.as.reimbursable
				? ", reimbursable"
				: ", not reimbursable"
			: "";
		return { prompt: null, rail: `Filed: ${company?.name ?? ""}${side}` };
	}
	if (c.state === "proposal") {
		const company = co(c.as.category_id);
		if (company?.split_reimbursable)
			return both(`${company.name}, ${c.as.reimbursable ? "reimbursable" : "not reimbursable"}?`);
		if (company && ["business", "reimbursement"].includes(company.treatment) && c.as.purpose.trim())
			return both(`${company.name}: ${lcFirst(c.as.purpose.trim())}?`);
		return both(`${company?.name ?? ""}?`);
	}
	const mine = co(c.trip.category_id);
	if (
		mine?.split_reimbursable &&
		c.trip.reimbursable == null &&
		c.trip.treatment === "reimbursement"
	)
		return both(`${mine.name}, reimbursable?`);
	// A sure guess that can't be filed with one Yes asks for what it lacks.
	const sure =
		c.guess && c.guess.confidence >= ASK_BELOW ? co(c.guess.category_id ?? null) : undefined;
	if (sure?.split_reimbursable && c.guess?.reimbursable === undefined)
		return both(`${sure.name}, reimbursable?`);
	if (view.return_of) return both("Same as the trip there?");
	const place = view.end.name_source !== "coordinates" ? view.end.name : null;
	const hint =
		c.guess && c.guess.confidence < ASK_BELOW ? co(c.guess.category_id ?? null) : undefined;
	if (hint && place)
		return hint.id === "personal"
			? { prompt: `Was the ${place} stop personal?`, rail: "Personal?" }
			: {
					prompt: `Was the ${place} stop for ${hint.name} or personal?`,
					rail: `${hint.name} or personal?`,
				};
	return {
		prompt: place ? `What was this trip to ${place}?` : "What was this trip?",
		rail: "What was this trip?",
	};
}
export function tripView(c: Counted, returnOf: string | null, ctx: ViewContext): TripView {
	const t = c.trip;
	const shown = c.guess;
	const start = endpoint(c, "start", ctx, shown),
		end = endpoint(c, "end", ctx, shown);
	let auto: TripView["auto"] = null;
	if (c.state === "auto") {
		const applied = citedOf(t, ctx.cited).find((p) => p.status === "applied");
		auto = applied
			? { confidence: applied.confidence, reason: reasonOf(applied), sources: sourcesOf(applied) }
			: t.evidence_ids.some((e) => e.startsWith("calendar:"))
				? { confidence: null, reason: "A calendar event at the destination", sources: ["calendar"] }
				: { confidence: null, reason: null, sources: [] };
	}
	const view = {
		id: t.id,
		revision: t.revision,
		started_at: t.started_at,
		ended_at: t.ended_at,
		timezone: t.timezone,
		date: c.date,
		minutes: Math.round((t.ended_at - t.started_at) / 60000),
		distance_meters: countedMeters(t),
		quality: t.quality,
		start_estimate: t.start_estimate ?? null,
		gap:
			t.quality === "gap"
				? (ctx.gaps.get(t.id) ?? { meters: null, seconds: null, from_at: null, to_at: null })
				: null,
		start,
		end,
		company_id: t.category_id,
		reimbursable: t.treatment === "reimbursement" ? (t.reimbursable ?? null) : null,
		purpose: t.purpose.trim() ? t.purpose : null,
		state: c.state,
		set_by: c.state === "filed" ? "you" : c.state === "auto" ? "agent" : null,
		proposal: shown
			? {
					id: shown.id,
					company_id: shown.category_id ?? null,
					reimbursable: shown.reimbursable ?? null,
					purpose: shown.purpose ?? null,
					confidence: shown.confidence,
					reason: reasonOf(shown),
					sources: sourcesOf(shown),
				}
			: null,
		auto,
		prompt: null as string | null,
		rail_prompt: "",
		reason: null as string | null,
		return_of: returnOf,
		estimate_usd: c.cents === null ? null : c.cents / 100,
		cents_per_mile: c.cents === null || !c.rate ? null : cents3(c.rate.usd_per_mile),
	} satisfies TripView;
	const prompts = promptsOf(c, view, ctx);
	view.prompt = prompts.prompt;
	view.rail_prompt = prompts.rail;
	view.reason = view.proposal?.reason ?? auto?.reason ?? null;
	return view;
}
/** "Needs you": newest first, and a drive back right after its trip there when both are open. */
export function queueOrder(views: TripView[]): string[] {
	const open = views
		.filter((v) => v.state === "ask" || v.state === "proposal")
		.sort((a, b) => b.started_at - a.started_at || (a.id < b.id ? 1 : -1));
	const ids = open.map((v) => v.id);
	for (const v of open) {
		if (!v.return_of || !ids.includes(v.return_of)) continue;
		ids.splice(ids.indexOf(v.id), 1);
		ids.splice(ids.indexOf(v.return_of) + 1, 0, v.id);
	}
	return ids;
}
/** Agent-filed trips, least sure first (a calendar match has no confidence and goes last), newest first. */
export function spotCheck(views: TripView[]): string[] {
	return views
		.filter((v) => v.state === "auto")
		.sort(
			(a, b) =>
				(a.auto?.confidence ?? 2) - (b.auto?.confidence ?? 2) || b.started_at - a.started_at,
		)
		.map((v) => v.id);
}

/**
 * Why an open trip with no guess asks, from what the server can check: the drive back's trip, an Acme mark, or the
 * saved places, calendar events and earlier trips it found nothing in. (The Mac agent's own reasons, texts included,
 * arrive as its proposals' first basis.) `facts`: per ask, whether a calendar event or an earlier trip is near.
 */
export function fillAskReasons(
	views: TripView[],
	facts: Map<string, { calendar: boolean; history: boolean }>,
): void {
	const byId = new Map(views.map((v) => [v.id, v]));
	for (const v of views) {
		if (v.state !== "ask" || v.reason) continue;
		const there = v.return_of ? byId.get(v.return_of) : undefined;
		if (v.rail_prompt.endsWith(", reimbursable?") && v.company_id)
			v.reason = "Choose reimbursable or not; until then this trip counts in no total";
		else if (there) v.reason = `Return leg of the trip to ${there.end.name ?? "the place before"}`;
		else {
			const f = facts.get(v.id) ?? { calendar: false, history: false };
			const place = v.end.name_source === "coordinates" ? "this place" : v.end.name;
			v.reason =
				v.end.name_source !== "saved" && !f.calendar && !f.history
					? `No saved place, calendar event or earlier trip near ${place}`
					: "Nothing on file says what this trip was for";
		}
	}
}
