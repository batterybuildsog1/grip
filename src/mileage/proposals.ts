import { z } from "zod";
import { endpointAddresses, ownerAddresses } from "./addresses";
import { MileageError, type MileagePrincipal } from "./auth";
import { nearest, ownerPlaces } from "./places";
import { type CalendarEvent, companyTreatment, idSchema, type Trip, textSchema } from "./policy";
import {
	type Category,
	categories,
	changed,
	classifyTrip,
	commit,
	digest,
	optionalLogic,
	requireLogic,
	saved,
	trip,
} from "./store";

/** Where a suggestion came from; texts (Mac-side, derived only) weigh most. */
export const basisKinds = [
	"texts",
	"calendar",
	"past_trips",
	"apple_poi",
	"place",
	"other",
] as const;
const nonBlank = textSchema.refine((v) => v.trim().length > 0, "Blank text");
const basisSchema = z
	.object({
		kind: z.enum(basisKinds),
		detail: nonBlank.refine((v) => v.length <= 300, "Basis detail is at most 300 characters"),
	})
	.strict()
	.refine(
		(b) => b.kind !== "texts" || b.detail.length <= 120,
		"A texts basis detail is at most 120 characters",
	);
export const proposalSchema = z
	.object({
		expected_revision: z.number().int().min(1).max(1000000000),
		idempotency_key: z
			.string()
			.min(1)
			.max(120)
			.regex(/^[A-Za-z0-9_.:-]+$/),
		confidence: z.number().min(0).max(1),
		basis: z.array(basisSchema).min(1).max(10),
		category_id: idSchema.optional(),
		purpose: nonBlank.optional(),
		reimbursable: z.boolean().optional(),
		origin: nonBlank.optional(),
		destination: nonBlank.optional(),
	})
	.strict()
	.refine(
		(b) =>
			[b.category_id, b.purpose, b.reimbursable, b.origin, b.destination].some(
				(v) => v !== undefined,
			),
		"Propose at least one of category_id, purpose, reimbursable, origin or destination",
	);
export type ProposalBody = z.infer<typeof proposalSchema>;
type Fields = Omit<ProposalBody, "expected_revision" | "idempotency_key" | "confidence">;
export interface Proposal extends Fields {
	id: string;
	trip_id: string;
	trip_revision: number;
	actor: string;
	status: "pending" | "applied" | "superseded" | "resolved";
	confidence: number;
	created_at: number;
	resolved_at: number | null;
}
export interface ProposalResult {
	proposal: Proposal;
	trip_revision: number;
}
/** Worker var MILEAGE_AGENT_AUTO_CONFIDENCE; unset or unparsable → 0.9. */
export function autoConfidence(raw: string | undefined): number {
	const n = raw === undefined || !raw.trim() ? Number.NaN : Number(raw);
	return Number.isFinite(n) ? n : 0.9;
}
export function requireSuggester(p: MileagePrincipal) {
	if (!p.human && !p.scopes.includes("trips:suggest"))
		throw new MileageError("FORBIDDEN", "Mileage scope or entity is not granted", 403);
}
export function requireSuggestAgent(p: MileagePrincipal) {
	if (p.human || !p.scopes.includes("trips:suggest"))
		throw new MileageError(
			"FORBIDDEN",
			"Only a trips:suggest agent credential can post proposals",
			403,
		);
}
/** The built-in suggester acts under its own actor so its commands and proposals stay distinguishable. */
export const systemPrincipal = (p: MileagePrincipal): MileagePrincipal => ({
	owner: p.owner,
	actor: "system:suggest",
	human: false,
	scopes: ["trips:suggest"],
	entities: [],
});
const proposalTable = (db: D1Database) =>
	requireLogic(() => db.prepare("SELECT 1 FROM mileage_proposals LIMIT 1").all());
function check(db: D1Database, sql: string, args: unknown[]): D1PreparedStatement[] {
	const id = crypto.randomUUID();
	return [
		db
			.prepare(`INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN (${sql}) THEN 1 ELSE 0 END`)
			.bind(id, ...args),
		db.prepare("DELETE FROM mileage_guard WHERE id=?").bind(id),
	];
}
interface ProposalRow {
	id: string;
	trip_id: string;
	trip_revision: number;
	actor: string;
	data: string;
	confidence: number;
	status: Proposal["status"];
	created_at: number;
	resolved_at: number | null;
}
const fromRow = ({ data, ...r }: ProposalRow): Proposal => ({
	...r,
	...(JSON.parse(data) as Fields),
});
/** Pending proposals for these trips (one query); missing 005 → empty. Newest first. */
export async function pendingProposals(
	db: D1Database,
	owner: string,
	ids: string[],
): Promise<Map<string, Proposal[]>> {
	const map = new Map<string, Proposal[]>();
	if (!ids.length) return map;
	const rows = await optionalLogic(() =>
		db
			.prepare(
				"SELECT id,trip_id,trip_revision,actor,data,confidence,status,created_at,resolved_at FROM mileage_proposals WHERE owner=? AND status='pending' AND trip_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,id",
			)
			.bind(owner, JSON.stringify([...new Set(ids)]))
			.all<ProposalRow>(),
	);
	for (const row of rows?.results ?? []) {
		const list = map.get(row.trip_id) ?? [];
		list.push(fromRow(row));
		map.set(row.trip_id, list);
	}
	return map;
}
/** Proposals by id, any status (the ones trips cite as `proposal:<id>` evidence); missing 005 → empty. */
export async function proposalsById(
	db: D1Database,
	owner: string,
	ids: string[],
): Promise<Map<string, Proposal>> {
	const map = new Map<string, Proposal>();
	if (!ids.length) return map;
	const rows = await optionalLogic(() =>
		db
			.prepare(
				"SELECT id,trip_id,trip_revision,actor,data,confidence,status,created_at,resolved_at FROM mileage_proposals WHERE owner=? AND id IN (SELECT value FROM json_each(?))",
			)
			.bind(owner, JSON.stringify([...new Set(ids)]))
			.all<ProposalRow>(),
	);
	for (const row of rows?.results ?? []) map.set(row.id, fromRow(row));
	return map;
}
export async function findProposal(db: D1Database, owner: string, id: string, tripId: string) {
	const rows = await requireLogic(() =>
		db
			.prepare(
				"SELECT id,trip_id,trip_revision,actor,data,confidence,status,created_at,resolved_at FROM mileage_proposals WHERE owner=? AND id=?",
			)
			.bind(owner, id)
			.all<ProposalRow>(),
	);
	const row = rows.results[0];
	if (!row || row.trip_id !== tripId)
		throw new MileageError("NOT_FOUND", "Proposal not found for this trip", 404);
	return fromRow(row);
}
/**
 * One path for named agents and the built-in suggester. High confidence plus a complete classification
 * applies in one batch (new revision, still not human-reviewed); anything else waits for the owner.
 */
export async function propose(
	db: D1Database,
	p: MileagePrincipal,
	tripId: string,
	b: ProposalBody,
	threshold: number,
	builtins: Category[],
): Promise<ProposalResult> {
	await proposalTable(db);
	const hash = await digest({ op: "proposal", trip_id: tripId, ...b });
	const prior = await saved<ProposalResult>(db, p, b.idempotency_key, hash);
	if (prior) return prior;
	const t = await trip(db, p.owner, tripId);
	if (t.revision !== b.expected_revision)
		throw new MileageError("REVISION_CONFLICT", "Trip revision changed", 409);
	if (t.human_reviewed)
		throw new MileageError("HUMAN_DECISION_LOCKED", "The owner already decided this trip", 403);
	const list = await categories(db, p.owner, builtins);
	if (b.category_id !== undefined && !list.some((x) => x.id === b.category_id))
		throw new MileageError("INVALID_CATEGORY", "Category not found");
	const cat = list.find((x) => x.id === (b.category_id ?? t.category_id));
	const treatment = b.category_id !== undefined && cat ? cat.treatment : t.treatment;
	if (b.reimbursable !== undefined && treatment !== "reimbursement")
		throw new MileageError(
			"INVALID_REIMBURSABLE",
			"Reimbursable applies only to a reimbursement category",
		);
	const purpose = b.purpose ?? t.purpose,
		reimbursable = b.reimbursable ?? t.reimbursable ?? null;
	const complete =
		!!cat &&
		treatment !== "needs_review" &&
		(!companyTreatment({ treatment }) || Boolean(purpose.trim())) &&
		(treatment !== "reimbursement" || reimbursable !== null);
	const { expected_revision: _r, idempotency_key, confidence, ...fields } = b;
	const auto = complete && confidence >= threshold,
		id = crypto.randomUUID(),
		now = Date.now();
	const proposal: Proposal = {
		id,
		trip_id: t.id,
		trip_revision: t.revision,
		actor: p.actor,
		status: auto ? "applied" : "pending",
		confidence,
		...fields,
		created_at: now,
		resolved_at: auto ? now : null,
	};
	const insert = db
		.prepare(
			"INSERT INTO mileage_proposals(owner,id,trip_id,trip_revision,actor,data,confidence,status,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
		)
		.bind(
			p.owner,
			id,
			t.id,
			t.revision,
			p.actor,
			JSON.stringify(fields),
			confidence,
			proposal.status,
			now,
			proposal.resolved_at,
		);
	// The built-in suggester never replaces a named agent's pending proposal, even one that lands mid-run.
	const precedence = p.actor.startsWith("system:")
		? check(
				db,
				"NOT EXISTS(SELECT 1 FROM mileage_proposals WHERE owner=? AND trip_id=? AND status='pending' AND actor NOT LIKE 'system:%')",
				[p.owner, t.id],
			)
		: [];
	if (auto) {
		const next = changed(t, {
			...(await classifyTrip(
				db,
				p.owner,
				builtins,
				t,
				b.category_id,
				b.purpose,
				undefined,
				b.reimbursable,
			)),
			...(b.origin !== undefined && !t.origin.trim() ? { origin: b.origin } : {}),
			...(b.destination !== undefined && !t.destination.trim()
				? { destination: b.destination }
				: {}),
			evidence_ids: [...new Set([...t.evidence_ids, `proposal:${id}`])],
		});
		// The trip update supersedes older pending proposals (005 trigger) before this row is inserted.
		return commit(
			db,
			p,
			idempotency_key,
			hash,
			{ proposal, trip_revision: next.revision },
			[{ before: t, after: next }],
			"proposal",
			[insert],
			precedence,
		);
	}
	return commit(
		db,
		p,
		idempotency_key,
		hash,
		{ proposal, trip_revision: t.revision },
		[],
		"proposal",
		[
			db
				.prepare(
					"UPDATE mileage_proposals SET status='superseded',resolved_at=? WHERE owner=? AND trip_id=? AND status='pending'",
				)
				.bind(now, p.owner, t.id),
			insert,
			db
				.prepare(
					"INSERT OR IGNORE INTO mileage_questions(owner,id,trip_id,trip_revision,prompt) VALUES(?,?,?,?,?)",
				)
				.bind(
					p.owner,
					`${t.id}:${t.revision}`,
					t.id,
					t.revision,
					"Choose category and specific purpose for this trip",
				),
		],
		[
			...check(
				db,
				"EXISTS(SELECT 1 FROM mileage_trips WHERE owner=? AND id=? AND revision=? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.human_reviewed')=0)",
				[p.owner, t.id, t.revision],
			),
			...precedence,
		],
	);
}
export interface HistoryTrip {
	id: string;
	started_at: number;
	category_id: string | null;
	treatment: Trip["treatment"];
	reimbursable: boolean | null;
	purpose: string;
	origin: string;
	destination: string;
}
export interface QueueItem {
	id: string;
	revision: number;
	started_at: number;
	ended_at: number;
	timezone: string;
	distance_meters: number;
	quality: Trip["quality"];
	category_id: string | null;
	entity_id: string | null;
	treatment: Trip["treatment"];
	reimbursable: boolean | null;
	purpose: string;
	origin: string;
	destination: string;
	start_lat?: number;
	start_lng?: number;
	end_lat?: number;
	end_lng?: number;
	start_place?: { id: string; name: string };
	end_place?: { id: string; name: string };
	start_address?: { name: string | null; address: string };
	end_address?: { name: string | null; address: string };
	pending_proposal: Proposal | null;
	calendar: QueueEvent[];
	history: HistoryTrip[];
}
export interface QueueEvent {
	calendar_id: string;
	id: string;
	version: string;
	starts_at: number;
	ends_at: number;
	status: CalendarEvent["status"];
	all_day: boolean;
	virtual: boolean;
	category_id: string;
	entity_id: string;
	purpose: string;
	site_confirmed: boolean;
	travel_eligible: boolean;
	commute: boolean;
	lat: number | null;
	lng: number | null;
}
const HISTORY_RADIUS_M = 200,
	WINDOW_MS = 2 * 3600000;
function meters(aLat: number, aLng: number, bLat: number, bLng: number) {
	const rad = Math.PI / 180;
	const a =
		Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
		Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLng - aLng) * rad) / 2) ** 2;
	return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
function box(lat: number, lng: number) {
	const dLat = (HISTORY_RADIUS_M / 111000) * 1.05,
		dLng = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
	return [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
}
/** Up to 10 newest owner-reviewed trips whose start and end each lie within 200 m (same direction). */
export async function histories(db: D1Database, owner: string, trips: Trip[]) {
	const located = trips.filter(
		(t) =>
			t.start_lat !== undefined &&
			t.start_lng !== undefined &&
			t.end_lat !== undefined &&
			t.end_lng !== undefined,
	);
	const result = new Map<string, HistoryTrip[]>();
	if (!located.length) return result;
	const pages = await db.batch<{ data: string }>(
		located.map((t) =>
			db
				.prepare(
					"SELECT data FROM mileage_trips WHERE owner=? AND id<>? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.human_reviewed')=1 AND json_extract(data,'$.start_lat') BETWEEN ? AND ? AND json_extract(data,'$.start_lng') BETWEEN ? AND ? AND json_extract(data,'$.end_lat') BETWEEN ? AND ? AND json_extract(data,'$.end_lng') BETWEEN ? AND ? ORDER BY json_extract(data,'$.started_at') DESC,id DESC LIMIT 100",
				)
				.bind(
					owner,
					t.id,
					...box(Number(t.start_lat), Number(t.start_lng)),
					...box(Number(t.end_lat), Number(t.end_lng)),
				),
		),
	);
	located.forEach((t, i) => {
		result.set(
			t.id,
			pages[i].results
				.map((r) => JSON.parse(r.data) as Trip)
				.filter(
					(h) =>
						h.start_lat !== undefined &&
						h.start_lng !== undefined &&
						h.end_lat !== undefined &&
						h.end_lng !== undefined &&
						meters(Number(t.start_lat), Number(t.start_lng), h.start_lat, h.start_lng) <=
							HISTORY_RADIUS_M &&
						meters(Number(t.end_lat), Number(t.end_lng), h.end_lat, h.end_lng) <= HISTORY_RADIUS_M,
				)
				.slice(0, 10)
				.map((h) => ({
					id: h.id,
					started_at: h.started_at,
					category_id: h.category_id,
					treatment: h.treatment,
					reimbursable: h.reimbursable ?? null,
					purpose: h.purpose,
					origin: h.origin,
					destination: h.destination,
				})),
		);
	});
	return result;
}
function queueEvent(e: CalendarEvent): QueueEvent {
	return {
		calendar_id: e.calendar_id,
		id: e.id,
		version: e.version,
		starts_at: e.starts_at,
		ends_at: e.ends_at,
		status: e.status,
		all_day: e.all_day,
		virtual: e.virtual,
		category_id: e.category_id,
		entity_id: e.entity_id,
		purpose: e.purpose,
		site_confirmed: e.site_confirmed,
		travel_eligible: e.travel_eligible,
		commute: e.commute,
		lat: e.lat,
		lng: e.lng,
	};
}
/** Queue items for the suggestion queue and the built-in suggester (events: allowlisted projections). */
export async function queueItems(
	db: D1Database,
	owner: string,
	trips: Trip[],
	events: CalendarEvent[],
): Promise<QueueItem[]> {
	const ids = trips.map((t) => t.id);
	const [places, addresses, pending, history] = await Promise.all([
		ownerPlaces(db, owner),
		ownerAddresses(db, owner, ids),
		pendingProposals(db, owner, ids),
		histories(db, owner, trips),
	]);
	return trips.map((t) => {
		const start = places ? nearest(t.start_lat, t.start_lng, places) : undefined,
			end = places ? nearest(t.end_lat, t.end_lng, places) : undefined;
		return {
			id: t.id,
			revision: t.revision,
			started_at: t.started_at,
			ended_at: t.ended_at,
			timezone: t.timezone,
			distance_meters: t.distance_meters,
			quality: t.quality,
			category_id: t.category_id,
			entity_id: t.entity_id,
			treatment: t.treatment,
			reimbursable: t.reimbursable ?? null,
			purpose: t.purpose,
			origin: t.origin,
			destination: t.destination,
			start_lat: t.start_lat,
			start_lng: t.start_lng,
			end_lat: t.end_lat,
			end_lng: t.end_lng,
			...(start ? { start_place: start } : {}),
			...(end ? { end_place: end } : {}),
			...endpointAddresses(addresses, t.id),
			pending_proposal: pending.get(t.id)?.[0] ?? null,
			calendar: events
				.filter((e) => e.starts_at < t.ended_at + WINDOW_MS && e.ends_at > t.started_at - WINDOW_MS)
				.sort((a, b) => a.starts_at - b.starts_at || (a.id < b.id ? -1 : 1))
				.slice(0, 10)
				.map(queueEvent),
			history: history.get(t.id) ?? [],
		};
	});
}
/** Order for the owner's question cards: texts-backed agent proposals, other agent proposals. */
export function agentSuggestions(list: Proposal[]) {
	const texts = (x: Proposal) => x.basis.some((b) => b.kind === "texts");
	return [...list]
		.sort((a, b) => Number(texts(b)) - Number(texts(a)) || b.created_at - a.created_at)
		.map((x) => ({
			source: "agent" as const,
			proposal_id: x.id,
			confidence: x.confidence,
			basis: x.basis,
			...(x.category_id !== undefined ? { category_id: x.category_id } : {}),
			...(x.purpose !== undefined ? { purpose: x.purpose } : {}),
			...(x.reimbursable !== undefined ? { reimbursable: x.reimbursable } : {}),
			...(x.origin !== undefined ? { origin: x.origin } : {}),
			...(x.destination !== undefined ? { destination: x.destination } : {}),
		}));
}
