/**
 * Mileage V3 contract client (docs/mileage/V3-CONTRACT.md). One read renders the whole view:
 * `report(month)`. Every number, prompt and place name on screen comes from it; the client adds no
 * totals, writes no prompts and ranks no names. Writes reuse the existing owner endpoints.
 */
import { api } from "./client";

export type MoneyKind = "none" | "irs-estimate";
export type NameSource = "saved" | "trip" | "agent" | "apple" | "address" | "coordinates";
export type TripState = "filed" | "auto" | "proposal" | "ask";

export interface MileageCompany {
	id: string;
	name: string;
	treatment: string;
	money: MoneyKind;
	/** Acme: a trip isn't filed until reimbursable or not is chosen. */
	split_reimbursable: boolean;
}

/** One dated IRS rate period; `to` is its last day (the day before the next period starts). */
export interface MileageRatePeriod {
	from: string;
	to: string;
	cents_per_mile: number;
	source: string;
}

export interface MileageCompanyTotals {
	id: string;
	trips: number;
	meters: number;
	/** Of `trips` and `meters`, the agent's guesses still waiting for a yes. */
	proposed_trips: number;
	proposed_meters: number;
	reimbursable_trips?: number;
	reimbursable_meters?: number;
	not_reimbursable_trips?: number;
	not_reimbursable_meters?: number;
	proposed_reimbursable_meters?: number;
	proposed_not_reimbursable_meters?: number;
	/** IRS-estimate companies only; null when any of those trips has no rate for its date (never $0). */
	estimate_usd?: number | null;
	proposed_estimate_usd?: number | null;
	rates_used?: MileageRatePeriod[];
	/** Days with trips and no rate period ("no IRS rate set", never $0). */
	uncovered?: { from: string; to: string }[];
	/** The company's default export: without the agent's guesses, only the trips it substantiates. */
	confirmed?: {
		trips: number;
		meters: number;
		reimbursable_trips?: number;
		reimbursable_meters?: number;
		not_reimbursable_trips?: number;
		not_reimbursable_meters?: number;
		estimate_usd?: number | null;
		/** Filed trips the company export leaves out, by reason, in the server's order (empty when none). */
		left_out?: MileageLeftOut[];
	};
}

export interface MileageLeftOut {
	reason: "recording_gap" | "no_endpoints" | "unconfirmed" | (string & {});
	trips: number;
	meters: number;
	estimate_usd?: number | null;
}

export interface MileageTotals {
	all_meters: number;
	trips: number;
	to_review: number;
	agent_filed: number;
	/** The agent's guesses waiting for a yes (included in the companies' figures). */
	proposed: { meters: number; trips: number };
	/** Trips in no total until answered. */
	unassigned: { meters: number; trips: number };
	companies: MileageCompanyTotals[];
}

export interface MileageBasis {
	kind: string;
	detail: string;
}

export interface MileageEnd {
	lat: number;
	lng: number;
	name: string;
	name_source: NameSource;
	/** What the agent's name is based on, when `name_source` is "agent". */
	name_basis: MileageBasis | null;
	address: string | null;
	place_id: string | null;
}

export interface MileageProposal {
	id: string;
	company_id: string;
	reimbursable: boolean | null;
	purpose: string | null;
	confidence: number;
	reason: string;
	sources: (string | MileageBasis)[];
}

export interface MileageAuto {
	confidence: number;
	reason: string;
	sources: (string | MileageBasis)[];
}

/** LATE-START §3: set by the phone at upload; the owner can only remove it. */
export interface MileageStartEstimate {
	meters: number;
	method: "apple_maps_driving";
	from_trip_id: string;
	reason: "parked_continuity";
}

/** One trip as the report shows it (contract "trip view"). */
export interface MileageTripView {
	id: string;
	revision: number;
	started_at: number;
	ended_at: number;
	timezone: string;
	/** YYYY-MM-DD in the trip's timezone. */
	date: string;
	minutes: number;
	/** The trip's miles as counted: recorded + `start_estimate.meters`. */
	distance_meters: number;
	quality: string;
	/** The phone's estimated start leg (Apple Maps from where the car was parked), or null. */
	start_estimate: MileageStartEstimate | null;
	gap: { meters: number; seconds: number; from_at?: number; to_at?: number } | null;
	start: MileageEnd;
	end: MileageEnd;
	company_id: string | null;
	reimbursable: boolean | null;
	purpose: string | null;
	state: TripState;
	set_by: "you" | "agent" | null;
	proposal: MileageProposal | null;
	auto: MileageAuto | null;
	/** The question's words, made on the server so every client asks the same thing. */
	prompt: string | null;
	/** The trip there, when this is the drive back. */
	return_of: string | null;
	/** The rail row's short words: the question ("Side Co or personal?") or "Filed: Side Co". */
	rail_prompt: string;
	/** The one line on why it was filed, guessed or asked (asks with no guess too); null when you filed it. */
	reason: string | null;
	estimate_usd: number | null;
	cents_per_mile: number | null;
}

export interface MileageReport {
	month: string;
	from: number;
	to: number;
	timezone: string;
	today: string;
	/** The first trip's date: an earlier month is empty because recording hadn't started. */
	recording_started: string | null;
	/** Months that have trips (YYYY-MM), for the switcher. */
	months: string[];
	companies: MileageCompany[];
	rates: MileageRatePeriod[];
	totals: MileageTotals;
	/** "Needs you", in order (newest first; a drive back right after its trip there). */
	queue: string[];
	/** Agent-filed trip ids, least sure first. */
	spot_check: string[];
	/** Every trip of the month, newest first. */
	trips: MileageTripView[];
}

/** One fix of a trip's GPS journal; rejected fixes (`accepted: false`) are never drawn. */
export interface MileageRoutePoint {
	timestamp: number;
	latitude: number;
	longitude: number;
	accepted?: boolean;
}

export interface MileageRoutePage {
	trip_id: string;
	points: MileageRoutePoint[];
	next_cursor?: string | null;
}

export interface MileagePlace {
	id: string;
	name: string;
	lat: number;
	lng: number;
	radius_m: number;
	updated_at: number;
}

/** A filing: the answer to a question, Yes to the agent's guess, or an edit of a filed trip. */
export interface MileageFiling {
	expected_revision: number;
	category_id: string;
	purpose?: string;
	reimbursable?: boolean;
	/** Yes to the agent's guess. */
	proposal_id?: string;
	/** File these trips (the drive back) with the same answer, in one batch. */
	also?: { trip_id: string; expected_revision: number }[];
	/** Your name for this trip's destination only (not a saved place). */
	destination?: string;
	idempotency_key: string;
}

const enc = encodeURIComponent;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const key = () => crypto.randomUUID();

export const mileage = {
	report: (month: string | null, signal?: AbortSignal) =>
		api.request<MileageReport>(`/mileage/report${month ? `?month=${enc(month)}` : ""}`, {
			signal,
		}),
	/** One page of the owner-only route (same origin; coordinates go nowhere else). */
	route: (id: string, cursor: string | null, signal?: AbortSignal) =>
		api.request<MileageRoutePage>(
			`/mileage/trips/${enc(id)}/route${cursor ? `?cursor=${enc(cursor)}` : ""}`,
			{ signal },
		),
	file: (id: string, body: MileageFiling) =>
		api.request<unknown>(`/mileage/trips/${enc(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	/** Removes the phone's estimated start leg (the owner can't type one); Undo restores it. */
	removeEstimate: (id: string, body: { expected_revision: number; idempotency_key: string }) =>
		api.request<unknown>(`/mileage/trips/${enc(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ ...body, start_estimate: null }),
		}),
	/** Reverts the owner's last change to the trip (and its `also` batch); 409 if anything moved. */
	undo: (id: string, body: { expected_revision: number; idempotency_key: string }) =>
		api.request<unknown>(`/mileage/trips/${enc(id)}/undo`, post(body)),
	/** Sent only after the 5-second hold (the client's "Deleted · Undo"). */
	remove: (id: string, body: { expected_revision: number; idempotency_key: string }) =>
		api.request<unknown>(`/mileage/trips/${enc(id)}`, {
			method: "DELETE",
			body: JSON.stringify(body),
		}),
	/** Adds or replaces the rate period starting on `from`. */
	putRate: (
		from: string,
		body: { tax_year: number; usd_per_mile: number; source: string; idempotency_key: string },
	) =>
		api.request<unknown>(`/mileage/rates/${enc(from)}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	removeRate: (from: string) =>
		api.request<unknown>(`/mileage/rates/${enc(from)}`, { method: "DELETE" }),
	addCompany: (body: {
		name: string;
		treatment: "business" | "reimbursement" | "personal";
		entity_id: string;
		idempotency_key: string;
	}) => api.request<unknown>("/mileage/categories", post(body)),
	places: () => api.request<{ places: MileagePlace[] }>("/mileage/places"),
	/** Saves the place around one end of a trip (the server reads that end's coordinates). */
	namePlace: (body: {
		name: string;
		trip_id: string;
		end: "start" | "end";
		idempotency_key: string;
	}) => api.request<MileagePlace>("/mileage/places", post(body)),
	renamePlace: (id: string, body: { name: string; idempotency_key: string }) =>
		api.request<MileagePlace>(`/mileage/places/${enc(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	removePlace: (id: string) =>
		api.request<unknown>(`/mileage/places/${enc(id)}`, { method: "DELETE" }),
	/** The export as a file (CSV or PDF); the agent's guesses only with `include_proposals`. */
	exportFile: (query: URLSearchParams) => api.request<Response>(`/mileage/exports?${query}`),
};
