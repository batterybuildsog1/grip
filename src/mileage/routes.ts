import { type Context, Hono } from "hono";
import { z } from "zod";
import { hashToken, newToken } from "@/auth/principal";
import { aiConsent, CONSENT_REQUIRED } from "@/services/ai-consent";
import { getAllowedOrigins, tokensMatch } from "@/utils/platform";
import {
	copyAddress,
	ownerAddresses,
	putAddresses,
	putAddressesSchema,
	tripIds,
	withAddresses,
} from "./addresses";
import {
	csvList,
	identify,
	MileageError,
	type MileagePrincipal,
	requireHuman,
	requireScope,
} from "./auth";
import { builtinCategories, builtinCompanies } from "./companies";
import { exportReport } from "./exports";
import {
	readRoutePage,
	routeReady,
	routeUploadSchema,
	transformRoutes,
	uploadRoute,
} from "./full-route";
import { googleConfiguration, runGoogleSync } from "./google-wiring";
import {
	createPlace,
	createPlaceSchema,
	deletePlace,
	hasTrip,
	ownerPlaces,
	patchPlace,
	patchPlaceSchema,
	requirePlaces,
	withPlaces,
} from "./places";
import {
	agentSummary,
	type CalendarEvent,
	calendarCandidate,
	calendarCommute,
	calendarSuggestions,
	companyTreatment,
	eventSchema,
	idSchema,
	type Measurement,
	measurementSchema,
	ownerReconstruction,
	substantiation,
	type Trip,
	textSchema,
	timeSchema,
	treatmentSchema,
} from "./policy";
import {
	agentSuggestions,
	autoConfidence,
	findProposal,
	histories,
	type Proposal,
	pendingProposals,
	proposalSchema,
	proposalsById,
	propose,
	queueItems,
	requireSuggestAgent,
	requireSuggester,
	systemPrincipal,
} from "./proposals";
import { consumeMileageLimit } from "./rate-limit";
import { deleteRate, effectiveFromSchema, putRate, putRateSchema, rates } from "./rates";
import {
	companyList,
	countTrips,
	fillAskReasons,
	type Gap,
	gapOf,
	localDay,
	monthBounds,
	periods,
	queueOrder,
	returnPairs,
	spotCheck,
	totalsOf,
	tripView,
} from "./report";
import {
	type Category,
	type Change,
	categories,
	changed,
	classifyTrip,
	commit,
	cursorDecode,
	cursorEncode,
	digest,
	saved,
	trip,
	type Vehicle,
	vehicle,
} from "./store";
import { runSuggester } from "./suggest";

type Env = { Bindings: CloudflareBindings; Variables: { mileage: MileagePrincipal } };
type Ctx = Context<Env>;
const routes = new Hono<Env>();
const ok = <T>(data: T) => ({ success: true as const, data });
const db = (c: Ctx) => {
	if (!c.env.MILEAGE_D1)
		throw new MileageError("MILEAGE_UNAVAILABLE", "Mileage is not configured", 503);
	return c.env.MILEAGE_D1;
};
const principal = (c: Ctx) => c.get("mileage");
/** The configured companies plus Personal (MILEAGE_COMPANIES_JSON, src/mileage/companies.ts). */
const builtins = (c: Ctx) => builtinCategories(c.env);
const keySchema = z
	.string()
	.min(1)
	.max(120)
	.regex(/^[A-Za-z0-9_.:-]+$/);
const revisionSchema = z.number().int().min(1).max(1000000000);
async function body<T>(c: Ctx, schema: z.ZodType<T>, maxBytes = 128000): Promise<T> {
	if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? ""))
		throw new MileageError("UNSUPPORTED_MEDIA_TYPE", "Send application/json", 415);
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw new MileageError("INVALID_BODY", "Missing JSON body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new MileageError("BODY_TOO_LARGE", `JSON body exceeds ${maxBytes} bytes`, 413);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new MileageError("INVALID_BODY", "Invalid JSON");
	}
	const result = schema.safeParse(value);
	if (!result.success) {
		// LATE-START §3: a bad start estimate has its own code, wherever it sits in the body.
		const late = result.error.issues.find((i) => i.path.includes("start_estimate"));
		throw new MileageError(
			late ? "INVALID_START_ESTIMATE" : "INVALID_BODY",
			(late ?? result.error.issues[0])?.message ?? "Invalid input",
		);
	}
	return result.data;
}
function query(c: Ctx, allowed: string[]) {
	for (const [name] of new URL(c.req.url).searchParams)
		if (!allowed.includes(name))
			throw new MileageError("INVALID_QUERY", `Unknown parameter: ${name}`);
}
function integer(value: string | undefined, fallback: number, min = 0, max = 4102444800000) {
	if (value === undefined) return fallback;
	if (
		!/^\d{1,16}$/.test(value) ||
		!Number.isSafeInteger(Number(value)) ||
		Number(value) < min ||
		Number(value) > max
	)
		throw new MileageError("INVALID_QUERY", "Invalid integer query parameter");
	return Number(value);
}
function present(p: MileagePrincipal, t: Trip) {
	if (!p.human) {
		requireScope(p, "trips:read:summary", t.entity_id);
		if (!["business", "reimbursement"].includes(t.treatment))
			throw new MileageError(
				"FORBIDDEN",
				"Personal, commuting and unclassified travel is not exposed to agents",
				403,
			);
	}
	return p.human ? t : agentSummary(t);
}
function fresh(t: Trip, expected: number) {
	if (t.revision !== expected)
		throw new MileageError("REVISION_CONFLICT", "Trip revision changed", 409);
}
function classify(
	c: Ctx,
	t: Trip,
	categoryId: string | null | undefined,
	purpose: string | undefined,
	treatment: Trip["treatment"] | undefined,
	reimbursable?: boolean | null,
): Promise<Partial<Trip>> {
	return classifyTrip(
		db(c),
		principal(c).owner,
		builtins(c),
		t,
		categoryId,
		purpose,
		treatment,
		reimbursable,
	);
}
function initial(m: Measurement): Trip {
	return {
		...m,
		measured_distance_meters: m.distance_meters,
		category_id: null,
		entity_id: null,
		purpose: "",
		treatment: "needs_review",
		revision: 1,
		human_reviewed: false,
		deleted_at: null,
		updated_at: Date.now(),
		lineage: [],
		evidence_ids: [],
	};
}
function transactionCheck(c: Ctx, sql: string, args: unknown[]): D1PreparedStatement[] {
	const id = crypto.randomUUID();
	return [
		db(c)
			.prepare(`INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN (${sql}) THEN 1 ELSE 0 END`)
			.bind(id, ...args),
		db(c).prepare("DELETE FROM mileage_guard WHERE id=?").bind(id),
	];
}
/**
 * LATE-START §3: an estimate's `from_trip_id` is this owner's trip (archived ones too: the car was still parked
 * there) that ended before this trip started, with no live trip of the owner starting in between. Checked only
 * when the trip is first stored, so a retried upload never turns into a refusal later.
 */
async function checkStartEstimate(c: Ctx, m: Measurement) {
	const e = m.start_estimate;
	if (!e) return;
	const refuse = () =>
		new MileageError(
			"INVALID_START_ESTIMATE",
			"start_estimate must come from your previous trip, which ended before this one started",
		);
	if (e.from_trip_id === m.id) throw refuse();
	const owner = principal(c).owner;
	const from = await db(c)
		.prepare(
			"SELECT json_extract(data,'$.ended_at') AS ended_at FROM mileage_trips WHERE owner=? AND id=?",
		)
		.bind(owner, e.from_trip_id)
		.first<{ ended_at: number }>();
	if (!from || Number(from.ended_at) > m.started_at) throw refuse();
	const between = await db(c)
		.prepare(
			"SELECT 1 FROM mileage_trips WHERE owner=? AND id NOT IN (?,?) AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.started_at')>=? AND json_extract(data,'$.started_at')<? LIMIT 1",
		)
		.bind(owner, e.from_trip_id, m.id, Number(from.ended_at), m.started_at)
		.first();
	if (between) throw refuse();
}
async function calendarSnapshot(c: Ctx): Promise<{ events: CalendarEvent[]; version: number }> {
	const owner = principal(c).owner;
	const [rows, state] = await db(c).batch<Record<string, unknown>>([
		db(c).prepare("SELECT data FROM mileage_calendar WHERE owner=? LIMIT 501").bind(owner),
		db(c)
			.prepare(
				"SELECT COALESCE(MAX(seq),0) AS version FROM mileage_admin_audit WHERE owner=? AND operation='calendar_projection'",
			)
			.bind(owner),
	]);
	if (rows.results.length > 500)
		throw new MileageError("CALENDAR_TOO_LARGE", "Reduce calendar projections", 413);
	const allow = (c.env.MILEAGE_CALENDAR_ALLOWLIST ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	return {
		events: rows.results
			.map((r) => JSON.parse(String(r.data)) as CalendarEvent)
			.filter((e) => allow.includes(e.calendar_id)),
		version: Number(state.results[0].version),
	};
}
async function events(c: Ctx): Promise<CalendarEvent[]> {
	return (await calendarSnapshot(c)).events;
}
function calendarCheck(c: Ctx, version: number) {
	return transactionCheck(
		c,
		"SELECT COALESCE(MAX(seq),0)=? FROM mileage_admin_audit WHERE owner=? AND operation='calendar_projection'",
		[version, principal(c).owner],
	);
}
/** Split/merge carry endpoint addresses (optional 005; absent table → nothing to copy). */
async function addressCopies(
	c: Ctx,
	copies: [string, string, "start" | "end"][],
): Promise<D1PreparedStatement[]> {
	const owner = principal(c).owner;
	if (!(await ownerAddresses(db(c), owner, ["_"]))) return [];
	return copies.map(([from, to, endpoint]) => copyAddress(db(c), owner, from, to, endpoint));
}
async function logicTables(c: Ctx) {
	if (!(await ownerAddresses(db(c), principal(c).owner, ["_"])))
		throw new MileageError(
			"MILEAGE_UNAVAILABLE",
			"Mileage logic schema (migration 005) is not initialized",
			503,
		);
}
routes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	if (c.req.url.length > 4096)
		return c.json(
			{
				success: false,
				error: { code: "QUERY_TOO_LARGE", message: "URL exceeds 4096 characters" },
			},
			413,
		);
	// This boundary handles all mileage paths, including 404s, without mail middleware fallthrough.
	try {
		if (!c.env.MILEAGE_D1 || !csvList(c.env.MILEAGE_OWNER_EMAILS).length)
			throw new MileageError(
				"MILEAGE_UNAVAILABLE",
				"Dedicated mileage binding and explicit owner allowlist required",
				503,
			);
		builtins(c); // an invalid MILEAGE_COMPANIES_JSON is 503 everywhere, never the default list
		try {
			await db(c).prepare("SELECT id FROM mileage_tokens LIMIT 1").first();
		} catch {
			throw new MileageError("MILEAGE_UNAVAILABLE", "Mileage schema is not initialized", 503);
		}
		// Places explicitly deny mail API credentials; other mileage auth keeps its existing contract.
		if (/^\/api\/mileage\/places(?:\/|$)/.test(c.req.path)) {
			const token = c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{1,256})$/)?.[1];
			if (
				token &&
				((c.env.API_TOKEN && tokensMatch(token, c.env.API_TOKEN)) ||
					(c.env.API_TOKEN_PREVIOUS && tokensMatch(token, c.env.API_TOKEN_PREVIOUS)))
			)
				throw new MileageError("OWNER_REQUIRED", "Only the owner can access known places", 403);
		}
		c.set("mileage", await identify(c.req.raw, c.env));
		// AI consent (SPEC §2): a named agent (`mlg_` credential) is outside Cloudflare, so every
		// read or write it makes needs the owner's grant. The owner's own requests and the built-in
		// deterministic suggester are not gated.
		if (!principal(c).human && !(await aiConsent(c.env.D1)).allowed)
			throw new MileageError(CONSENT_REQUIRED.code, CONSENT_REQUIRED.message, 403);
		// A trips:suggest credential reads the queue and posts proposals; nothing else.
		if (
			principal(c).scopes.includes("trips:suggest") &&
			!/^\/api\/mileage\/(?:suggestions\/(?:queue|run)|trips\/[^/]+\/proposals)$/.test(c.req.path)
		)
			throw new MileageError(
				"FORBIDDEN",
				"A trips:suggest credential may only read the suggestion queue and post proposals",
				403,
			);
		const perMinute = Number(c.env.MILEAGE_RATE_LIMIT);
		const limit = consumeMileageLimit(
			principal(c),
			Number.isInteger(perMinute) && perMinute > 0 ? perMinute : undefined,
		);
		if (!limit.allowed) {
			c.header("Retry-After", String(limit.retryAfter));
			return c.json(
				{
					success: false,
					error: { code: "MILEAGE_RATE_LIMITED", message: "Too many mileage requests" },
				},
				429,
			);
		}
		if (!["GET", "HEAD"].includes(c.req.method)) {
			const origin = c.req.header("Origin");
			if (
				origin &&
				origin !== new URL(c.req.url).origin &&
				!getAllowedOrigins(c.env).includes(origin)
			)
				throw new MileageError("FORBIDDEN_ORIGIN", "Untrusted mutation origin", 403);
		}
		await next();
		// Compute names once after persistence/replay, solely on live trip response routes.
		// Audit snapshots, route points and all agent responses bypass this projection. The owner's
		// exports print the same names through report.ts `endpoint()` (ux-s-p0-5).
		if (
			principal(c).human &&
			c.res.ok &&
			/^\/api\/mileage\/(?:sync|trips(?:\/[^/]+(?:\/(?:split|undo))?)?|questions\/[^/]+\/answer|calendar\/(?:match|google\/sync))$/.test(
				c.req.path,
			)
		) {
			const payload = (await c.res.clone().json()) as { data: unknown };
			if (hasTrip(payload.data)) {
				const owner = principal(c).owner;
				const [places, addresses] = await Promise.all([
					ownerPlaces(db(c), owner),
					ownerAddresses(db(c), owner, tripIds(payload.data)),
				]);
				if (places || addresses?.size) {
					let data = places ? withPlaces(payload.data, places) : payload.data;
					if (addresses?.size) data = withAddresses(data, addresses);
					c.res = Response.json(
						{ ...payload, data },
						{ status: c.res.status, headers: c.res.headers },
					);
				}
			}
		}
	} catch (error) {
		if (error instanceof MileageError)
			return c.json(
				{ success: false, error: { code: error.code, message: error.message } },
				error.status,
			);
		throw error;
	}
});
routes.onError((error, c) =>
	error instanceof z.ZodError
		? c.json(
				{
					success: false,
					error: { code: "INVALID_BODY", message: error.issues[0]?.message ?? "Invalid input" },
				},
				400,
			)
		: error instanceof MileageError
			? c.json(
					{ success: false, error: { code: error.code, message: error.message } },
					error.status,
				)
			: c.json(
					{
						success: false,
						error: { code: "MILEAGE_INTERNAL_ERROR", message: "Mileage operation failed" },
					},
					500,
				),
);
routes.get("/config", async (c) => {
	const p = principal(c);
	requireScope(p, "trips:read:summary");
	const googleReady = p.human
		? await googleConfiguration(c.env, p).then(
				() => true,
				() => false,
			)
		: false;
	const cats = (await categories(db(c), p.owner, builtins(c))).filter(
		(cat) =>
			p.human ||
			(p.entities.includes(cat.entity_id) &&
				["business", "reimbursement"].includes(cat.treatment) &&
				cat.entity_id !== "personal"),
	);
	return c.json(
		ok({
			categories: cats,
			vehicles: p.human ? [await vehicle(db(c), p.owner)] : [],
			capture_defaults: {
				opt_in: true,
				raw_retention_days: 30,
				upload_raw_routes: p.human && (await routeReady(c.env)),
			},
			rates: (await rates(db(c))) ?? [],
			agent_auto_confidence: autoConfidence(c.env.MILEAGE_AGENT_AUTO_CONFIDENCE),
			capabilities: {
				calendar_projection: true,
				live_calendar: googleReady,
				oauth: googleReady,
			},
			// One entry per configured company: `<id>_dollars` (business), `<id>_amounts` (reimbursement).
			restrictions: Object.fromEntries(
				builtinCompanies(builtins(c)).map((co) =>
					co.treatment === "business"
						? [
								`${co.id}_dollars`,
								"estimate at the IRS standard mileage rate from the rates table; not a tax determination",
							]
						: [
								`${co.id}_amounts`,
								"miles only: reimbursable, not reimbursable and not marked; no dollar amounts",
							],
				),
			),
		}),
	);
});
/**
 * V3: one call renders the whole Mileage view (docs/mileage/V3-CONTRACT.md). Owner only. Every number the
 * clients show comes from here, through the same counting as the exports.
 */
routes.get("/report", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, ["month"]);
	const asked = c.req.query("month");
	if (asked !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(asked))
		throw new MileageError("INVALID_QUERY", "month is YYYY-MM");
	await logicTables(c);
	const owner = p.owner;
	const [latest, lifetime] = await db(c).batch<{ at: number; tz: string }>([
		db(c)
			.prepare(
				"SELECT json_extract(data,'$.started_at') AS at,json_extract(data,'$.timezone') AS tz FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL ORDER BY json_extract(data,'$.started_at') DESC LIMIT 1",
			)
			.bind(owner),
		db(c)
			.prepare(
				"SELECT json_extract(data,'$.started_at') AS at,json_extract(data,'$.timezone') AS tz FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL LIMIT 50001",
			)
			.bind(owner),
	]);
	// Prefer the newest trip's recorded zone; an empty instance uses its configured zone or UTC.
	const timezone = latest.results[0]?.tz ?? c.env.INSTANCE_TIME_ZONE ?? "UTC";
	const fixed = c.env.MILEAGE_TODAY?.trim();
	const today = fixed && /^\d{4}-\d{2}-\d{2}$/.test(fixed) ? fixed : localDay(Date.now(), timezone);
	const month = asked ?? today.slice(0, 7);
	const { from, to } = monthBounds(month, timezone);
	const rows = await db(c)
		.prepare(
			"SELECT data FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.started_at')>=? AND json_extract(data,'$.started_at')<? ORDER BY json_extract(data,'$.started_at') DESC,id DESC LIMIT 2001",
		)
		.bind(owner, from, to)
		.all<{ data: string }>();
	if (rows.results.length > 2000)
		throw new MileageError("REPORT_TOO_LARGE", "More than 2000 trips in one month", 413);
	const trips = rows.results.map((r) => JSON.parse(r.data) as Trip);
	const ids = trips.map((t) => t.id);
	const [pending, cats, rateRows, places, addresses] = await Promise.all([
		pendingProposals(db(c), owner, ids),
		categories(db(c), owner, builtins(c)),
		rates(db(c)),
		ownerPlaces(db(c), owner),
		ownerAddresses(db(c), owner, ids),
	]);
	const cited = await proposalsById(
		db(c),
		owner,
		trips.flatMap((t) =>
			t.evidence_ids.filter((e) => e.startsWith("proposal:")).map((e) => e.slice(9)),
		),
	);
	const gaps = new Map<string, Gap>();
	const gapIds = trips.filter((t) => t.quality === "gap").map((t) => t.id);
	if (gapIds.length) {
		try {
			const chunks = await db(c)
				.prepare(
					"SELECT trip_id,points FROM mileage_route_chunks WHERE owner=? AND trip_id IN (SELECT value FROM json_each(?)) ORDER BY trip_id,chunk_index",
				)
				.bind(owner, JSON.stringify(gapIds))
				.all<{ trip_id: string; points: string }>();
			const byTrip = new Map<string, Parameters<typeof gapOf>[0]>();
			for (const chunk of chunks.results)
				byTrip.set(chunk.trip_id, [
					...(byTrip.get(chunk.trip_id) ?? []),
					...JSON.parse(chunk.points),
				]);
			for (const [id, points] of byTrip) gaps.set(id, gapOf(points));
		} catch {
			/* No route storage (003): gap trips say quality "gap" with no located stretch. */
		}
	}
	const rateList = rateRows ?? [];
	const companies = companyList(cats);
	// The default company export's rule, so `confirmed` is exactly what it holds (allowlisted calendar evidence).
	const projected = await events(c);
	const now = Date.now();
	const counted = countTrips(trips, pending, cats, rateList, true);
	const pairs = returnPairs(counted, places ?? []);
	const ctx = { companies, places: places ?? [], addresses: addresses ?? new Map(), cited, gaps };
	const views = counted.map((x) => tripView(x, pairs.get(x.trip.id) ?? null, ctx));
	// Why each open trip with no guess asks: a calendar event near its end time, or earlier trips between the same ends.
	const asks = counted.filter((x) => {
		const v = views.find((w) => w.id === x.trip.id);
		return v?.state === "ask" && !v.reason;
	});
	const history = await histories(
		db(c),
		owner,
		asks.map((x) => x.trip),
	);
	fillAskReasons(
		views,
		new Map(
			asks.map((x) => [
				x.trip.id,
				{
					calendar: projected.some(
						(e) =>
							Math.abs(e.starts_at - x.trip.ended_at) <= 2 * 3600000 && e.status !== "cancelled",
					),
					history: (history.get(x.trip.id) ?? []).length > 0,
				},
			]),
		),
	);
	const months = new Set<string>();
	let first: { at: number; tz: string } | undefined;
	for (const r of lifetime.results) {
		months.add(localDay(Number(r.at), r.tz).slice(0, 7));
		if (!first || Number(r.at) < Number(first.at)) first = r;
	}
	return c.json(
		ok({
			month,
			from,
			to,
			timezone,
			today,
			recording_started: first ? localDay(Number(first.at), first.tz) : null,
			months: [...months].sort().reverse(),
			companies,
			rates: periods(rateList),
			totals: totalsOf(counted, companies, rateList, {
				counted: countTrips(trips, pending, cats, rateList, false),
				leftOut: (t) => substantiation(t, projected, now).left_out,
			}),
			queue: queueOrder(views),
			spot_check: spotCheck(views),
			trips: views,
		}),
	);
});
routes.get("/places", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	return c.json(ok({ places: await requirePlaces(db(c), p.owner) }));
});
routes.post("/places", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	return c.json(ok(await createPlace(db(c), p, await body(c, createPlaceSchema))), 201);
});
routes.patch("/places/:id", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	return c.json(
		ok(
			await patchPlace(
				db(c),
				p,
				idSchema.parse(c.req.param("id")),
				await body(c, patchPlaceSchema),
			),
		),
	);
});
routes.delete("/places/:id", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	return c.json(ok(await deletePlace(db(c), p, idSchema.parse(c.req.param("id")))));
});
routes.get("/trips", async (c) => {
	query(c, ["from", "to", "category_id", "limit", "cursor"]);
	const p = principal(c);
	const from = integer(c.req.query("from"), 0),
		to = integer(c.req.query("to"), 4102444800000),
		limit = integer(c.req.query("limit"), 100, 1, 100);
	if (to <= from) throw new MileageError("INVALID_QUERY", "to must follow from");
	const catId = c.req.query("category_id");
	if (catId && !idSchema.safeParse(catId).success)
		throw new MileageError("INVALID_QUERY", "Invalid category ID");
	if (!p.human) {
		const cat = (await categories(db(c), p.owner, builtins(c))).find((x) => x.id === catId);
		requireScope(
			p,
			"trips:read:summary",
			cat && ["business", "reimbursement"].includes(cat.treatment) ? cat.entity_id : null,
		);
	}
	const cursor = cursorDecode(c.req.query("cursor"));
	const parsed = z.tuple([timeSchema, idSchema]).safeParse(cursor ?? [0, "_"]);
	if (!parsed.success) throw new MileageError("INVALID_CURSOR", "Invalid trip cursor");
	const [at, id] = cursor === undefined ? [-1, ""] : parsed.data;
	const rows = await db(c)
		.prepare(
			`SELECT data FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.started_at')>=? AND json_extract(data,'$.started_at')<? ${catId ? "AND json_extract(data,'$.category_id')=?" : ""} AND (json_extract(data,'$.started_at')>? OR (json_extract(data,'$.started_at')=? AND id>?)) ORDER BY json_extract(data,'$.started_at'),id LIMIT ?`,
		)
		.bind(p.owner, from, to, ...(catId ? [catId] : []), at, at, id, limit + 1)
		.all<{ data: string }>();
	const trips = rows.results.slice(0, limit).map((r) => JSON.parse(r.data) as Trip);
	const last = trips.at(-1);
	return c.json(
		ok({
			trips: trips.map((t) => present(p, t)),
			next_cursor:
				rows.results.length > limit && last ? cursorEncode([last.started_at, last.id]) : null,
		}),
	);
});
routes.get("/trips/:id", async (c) => {
	const p = principal(c);
	return c.json(ok(present(p, await trip(db(c), p.owner, c.req.param("id")))));
});
routes.put("/trips/:id/addresses", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	const id = idSchema.parse(c.req.param("id"));
	return c.json(ok(await putAddresses(db(c), p, id, await body(c, putAddressesSchema))));
});
routes.get("/trips/:id/route", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, ["cursor"]);
	const id = idSchema.parse(c.req.param("id"));
	return c.json(ok(await readRoutePage(c.env, p, id, c.req.query("cursor"))));
});
routes.post("/trips/:id/route", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	const id = idSchema.parse(c.req.param("id"));
	return c.json(ok(await uploadRoute(c.env, p, id, await body(c, routeUploadSchema, 2000000))));
});
routes.delete("/trips/:id", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const id = idSchema.parse(c.req.param("id"));
	const b = await body(
		c,
		z.object({ expected_revision: revisionSchema, idempotency_key: keySchema }).strict(),
	);
	const hash = await digest({ op: "delete", id, ...b });
	const prior = await saved<Trip>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(prior));
	const t = await trip(db(c), p.owner, id, true);
	if (t.deleted_at !== null) return c.json(ok(t));
	fresh(t, b.expected_revision);
	const next = changed(t, { deleted_at: Date.now() });
	return c.json(
		ok(
			await commit(db(c), p, b.idempotency_key, hash, next, [{ before: t, after: next }], "delete"),
		),
	);
});
routes.get("/trips/:id/audit", async (c) => {
	const p = principal(c);
	requireHuman(p);
	await trip(db(c), p.owner, c.req.param("id"), true);
	const rows = await db(c)
		.prepare(
			"SELECT revision,data,actor,operation FROM mileage_revisions WHERE owner=? AND trip_id=? ORDER BY revision LIMIT 1001",
		)
		.bind(p.owner, c.req.param("id"))
		.all<{ revision: number; data: string; actor: string; operation: string }>();
	return c.json(
		ok({
			revisions: rows.results.slice(0, 1000).map((r) => ({ ...r, data: JSON.parse(r.data) })),
			truncated: rows.results.length > 1000,
		}),
	);
});
routes.post("/sync", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(
		c,
		z
			.object({
				device_id: idSchema,
				trips: z.array(measurementSchema).max(50),
				cursor: z.string().max(512).nullable().optional(),
			})
			.strict(),
	);
	const cursor = cursorDecode(b.cursor ?? undefined);
	if (cursor !== undefined && (!Number.isSafeInteger(cursor) || Number(cursor) < 0))
		throw new MileageError("INVALID_CURSOR", "Invalid sync cursor");
	const accepted: { id: string; revision: number }[] = [],
		conflicts: { id: string; code: string; revision?: number }[] = [];
	const newIds: string[] = [];
	for (const raw of b.trips) {
		// A null estimate is the same capture as none (same hash, no key stored).
		const { start_estimate, ...rest } = raw;
		const m: Measurement = start_estimate ? { ...rest, start_estimate } : rest;
		const hash = await digest({ device_id: b.device_id, measurement: m });
		let existing = await db(c)
			.prepare(
				"SELECT revision,measurement_hash,device_id,json_extract(data,'$.deleted_at') AS deleted_at FROM mileage_trips WHERE owner=? AND id=?",
			)
			.bind(p.owner, m.id)
			.first<{
				revision: number;
				measurement_hash: string;
				device_id: string;
				deleted_at: number | null;
			}>();
		if (!existing) {
			let tombstoned = false;
			try {
				tombstoned = !!(await db(c)
					.prepare("SELECT trip_id FROM mileage_route_tombstones WHERE owner=? AND trip_id=?")
					.bind(p.owner, m.id)
					.first());
			} catch {}
			if (tombstoned) {
				conflicts.push({ id: m.id, code: "TRIP_DELETED" });
				continue;
			}
			await checkStartEstimate(c, m);
			const t = initial(m);
			try {
				await commit(
					db(c),
					p,
					`capture:${m.id}`,
					hash,
					t,
					[{ after: t, measurementHash: hash, deviceId: b.device_id }],
					"capture",
				);
				newIds.push(m.id);
			} catch (error) {
				if (!(error instanceof MileageError) || error.status !== 409) throw error;
			}
			existing = await db(c)
				.prepare(
					"SELECT revision,measurement_hash,device_id,json_extract(data,'$.deleted_at') AS deleted_at FROM mileage_trips WHERE owner=? AND id=?",
				)
				.bind(p.owner, m.id)
				.first();
		}
		if (existing?.deleted_at != null)
			conflicts.push({ id: m.id, code: "TRIP_DELETED", revision: existing.revision });
		else if (existing?.measurement_hash === hash && existing.device_id === b.device_id)
			accepted.push({ id: m.id, revision: existing.revision });
		else conflicts.push({ id: m.id, code: "CAPTURE_CONFLICT", revision: existing?.revision });
	}
	const rows = await db(c)
		.prepare(
			"SELECT r.seq,t.data FROM mileage_revisions r JOIN mileage_trips t ON t.owner=r.owner AND t.id=r.trip_id AND t.revision=r.revision WHERE r.owner=? AND r.seq>? ORDER BY r.seq LIMIT 101",
		)
		.bind(p.owner, cursor ?? 0)
		.all<{ seq: number; data: string }>();
	const page = rows.results.slice(0, 100);
	if (newIds.length) {
		// The ACK must never await OAuth/network. Human CAS is rechecked by the shared matcher.
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const configuration = await googleConfiguration(c.env, p);
					await runGoogleSync(c.env, p, configuration);
					await matchTrips(c, {
						trip_ids: newIds,
						idempotency_key: `google-capture-${crypto.randomUUID()}`,
					});
				} catch {
					/* Capture persists even when Google is unavailable, busy, stale or rate-limited. */
				}
				try {
					// After calendar matching, so a calendar decision lands first; never part of the ACK.
					if (/^(?:0|off|false)$/i.test(c.env.MILEAGE_SUGGEST_ON_CAPTURE?.trim() ?? "")) return;
					await runSuggester(
						db(c),
						systemPrincipal(p),
						autoConfidence(c.env.MILEAGE_AGENT_AUTO_CONFIDENCE),
						builtins(c),
						newIds,
					);
				} catch {
					/* Suggestions are optional; the capture is already stored. */
				}
			})(),
		);
	}

	return c.json(
		ok({
			accepted,
			conflicts,
			trips: page.map((r) => JSON.parse(r.data)),
			cursor: cursorEncode(page.at(-1)?.seq ?? cursor ?? 0),
			has_more: rows.results.length > 100,
		}),
	);
});
const manualSchema = z
	.object({
		...measurementSchema.shape,
		id: idSchema.optional(),
		source: z.literal("manual").default("manual"),
		quality: z.literal("manual").default("manual"),
		category_id: idSchema.nullable().optional(),
		purpose: textSchema.optional(),
		treatment: treatmentSchema.optional(),
		reimbursable: z.boolean().nullable().optional(),
		// LATE-START §3: only the phone sets an estimate; a typed trip can't carry one.
		start_estimate: z.null().optional(),
		idempotency_key: keySchema,
	})
	.strict();
routes.post("/trips", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(c, manualSchema);
	const hash = await digest({ op: "manual", ...b });
	const prior = await saved<Trip>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(prior));
	const {
		idempotency_key,
		category_id,
		purpose,
		treatment,
		reimbursable,
		start_estimate: _none,
		...m
	} = b;
	const measurement = measurementSchema.parse({ ...m, id: m.id ?? crypto.randomUUID() });
	let t = initial(measurement);
	t = {
		...t,
		...(await classify(c, t, category_id, purpose, treatment, reimbursable)),
		human_reviewed: true,
	};
	return c.json(
		ok(
			await commit(
				db(c),
				p,
				idempotency_key,
				hash,
				t,
				[{ after: t, measurementHash: await digest(measurement) }],
				"manual",
			),
		),
	);
});
const alsoSchema = z
	.array(z.object({ trip_id: idSchema, expected_revision: revisionSchema }).strict())
	.min(1)
	.max(10);
const patchSchema = z
	.object({
		expected_revision: revisionSchema,
		category_id: idSchema.nullable().optional(),
		purpose: textSchema.optional(),
		treatment: treatmentSchema.optional(),
		origin: textSchema.optional(),
		destination: textSchema.optional(),
		distance_meters: z.number().int().min(0).max(3000000).optional(),
		reason: textSchema.optional(),
		reimbursable: z.boolean().nullable().optional(),
		// V3: a Yes to the agent's guess (its fields fill whatever the body leaves out) ...
		proposal_id: idSchema.optional(),
		// ... and the drive back filed with the same answer in the same batch (one Undo reverts both).
		also: alsoSchema.optional(),
		// LATE-START §3: the owner can remove the phone's estimate (null) but never type one.
		start_estimate: z.null().optional(),
		idempotency_key: keySchema,
	})
	.strict()
	.refine(
		(b) =>
			[
				b.category_id,
				b.purpose,
				b.treatment,
				b.origin,
				b.destination,
				b.distance_meters,
				b.reimbursable,
				b.proposal_id,
				b.start_estimate,
			].some((v) => v !== undefined),
		"No change supplied",
	);
/** Owner filings (PATCH and answers) record what they changed, so Undo can revert the whole batch. */
async function filingAudit(c: Ctx, key: string, changes: { before: Trip; after: Trip }[]) {
	const pending = await pendingProposals(
		db(c),
		principal(c).owner,
		changes.map((x) => x.before.id),
	);
	return adminAudit(c, "file", {
		key,
		trips: changes.map(({ before, after }) => ({
			id: after.id,
			revision: after.revision,
			before: before.revision,
			reopen: (pending.get(before.id) ?? []).map((x) => x.id),
		})),
	});
}
routes.patch("/trips/:id", async (c) => {
	const p = principal(c),
		id = c.req.param("id"),
		b = await body(c, patchSchema),
		hash = await digest({ op: "patch", id, ...b });
	const prior = await saved<Trip>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(p.human ? prior : agentSummary(prior)));
	const t = await trip(db(c), p.owner, id);
	fresh(t, b.expected_revision);
	if (!p.human && b.reimbursable !== undefined)
		throw new MileageError("FORBIDDEN", "Only the owner marks trips reimbursable", 403);
	if (!p.human && (b.proposal_id !== undefined || b.also !== undefined))
		throw new MileageError("OWNER_REQUIRED", "Only the owner files with proposal_id or also", 403);
	if (!p.human && b.start_estimate !== undefined)
		throw new MileageError("OWNER_REQUIRED", "Only the owner removes a start estimate", 403);
	// Removing the estimate alone is not a filing: review state, classification and pending guesses stay.
	const estimateOnly =
		b.start_estimate !== undefined &&
		[
			b.category_id,
			b.purpose,
			b.treatment,
			b.origin,
			b.destination,
			b.distance_meters,
			b.reimbursable,
			b.proposal_id,
			b.also,
		].every((v) => v === undefined);
	let guess: Proposal | undefined;
	if (b.proposal_id !== undefined) guess = await findProposal(db(c), p.owner, b.proposal_id, t.id);
	// A Yes takes the guess's company (and its reimbursable mark) unless the body chooses a company itself.
	const fromGuess = guess !== undefined && b.category_id === undefined;
	const categoryId = fromGuess ? guess?.category_id : b.category_id;
	const reimbursable =
		b.reimbursable !== undefined ? b.reimbursable : fromGuess ? guess?.reimbursable : undefined;
	const purpose = b.purpose ?? guess?.purpose;
	const origin = b.origin ?? (guess?.origin && !t.origin.trim() ? guess.origin : undefined);
	const destination =
		b.destination ?? (guess?.destination && !t.destination.trim() ? guess.destination : undefined);
	const classification = estimateOnly
		? {}
		: await classify(c, t, categoryId, purpose, b.treatment, reimbursable);
	const checks: D1PreparedStatement[] = [];
	if (!p.human) {
		requireScope(p, "trips:classify", t.entity_id);
		if (!companyTreatment(t) || !companyTreatment({ ...t, ...classification }))
			throw new MileageError(
				"FORBIDDEN",
				"Agents may only classify business/reimbursement summaries",
				403,
			);
		requireScope(p, "trips:classify", classification.entity_id);
		if (
			t.human_reviewed ||
			b.distance_meters !== undefined ||
			b.origin !== undefined ||
			b.destination !== undefined ||
			b.reason !== undefined
		)
			throw new MileageError(
				"HUMAN_DECISION_LOCKED",
				"Agents cannot replace human decisions or measurements",
				403,
			);
		const snapshot = await calendarSnapshot(c);
		checks.push(...calendarCheck(c, snapshot.version));
		const candidates = snapshot.events.filter((e) => calendarCandidate(t, e, Date.now()));
		if (snapshot.events.some((e) => calendarCommute(t, e, Date.now())))
			throw new MileageError(
				"EVIDENCE_REQUIRED",
				"Confirmed commute evidence cannot be promoted by an agent",
				403,
			);
		const cats = new Set(candidates.map((e) => `${e.category_id}\n${e.purpose}`));
		if (
			cats.size !== 1 ||
			!candidates.some(
				(e) => e.category_id === classification.category_id && e.purpose === classification.purpose,
			)
		)
			throw new MileageError(
				"EVIDENCE_REQUIRED",
				"Unique trusted calendar/site/travel evidence must match purpose and category",
				403,
			);
		classification.evidence_ids = candidates.map(
			(e) => `calendar:${e.calendar_id}:${e.id}:${e.version}`,
		);
	}
	if (b.distance_meters !== undefined && !b.reason?.trim())
		throw new MileageError("REASON_REQUIRED", "Distance correction requires a reason");
	const next = changed(t, {
		...classification,
		...(origin !== undefined ? { origin } : {}),
		...(destination !== undefined ? { destination } : {}),
		...(b.distance_meters !== undefined
			? {
					distance_meters: b.distance_meters,
					correction_reason: b.reason,
					reconstruction_confirmed: true,
				}
			: {}),
		// Your distance is the whole trip, so it replaces the estimate (no double count); the key is
		// written only on trips that had one, so other rows stay byte-identical.
		...((b.start_estimate === null || b.distance_meters !== undefined) &&
		t.start_estimate !== undefined
			? { start_estimate: null }
			: {}),
		...(guess ? { evidence_ids: [...new Set([...t.evidence_ids, `proposal:${guess.id}`])] } : {}),
		human_reviewed: estimateOnly ? t.human_reviewed : p.human || t.human_reviewed,
	});
	const changes = [{ before: t, after: next }];
	if (b.also) {
		if (!next.category_id)
			throw new MileageError("INVALID_BODY", "also files the same answer: choose a company");
		const ids = b.also.map((a) => a.trip_id);
		if (new Set(ids).size !== ids.length || ids.includes(t.id))
			throw new MileageError("INVALID_BODY", "also lists each other trip once");
		for (const a of b.also) {
			const other = await trip(db(c), p.owner, a.trip_id);
			fresh(other, a.expected_revision);
			const same = await classify(
				c,
				other,
				next.category_id,
				next.purpose,
				next.treatment,
				next.treatment === "reimbursement" ? (next.reimbursable ?? null) : null,
			);
			changes.push({ before: other, after: changed(other, { ...same, human_reviewed: true }) });
		}
	}
	const result = b.also ? { ...next, also: changes.slice(1).map((x) => x.after) } : next;
	// The 005 trigger ends a trip's pending guesses on any owner revision; an estimate removal reopens them
	// in the same batch (as Undo does), since it answers nothing.
	const keep = estimateOnly
		? ((await pendingProposals(db(c), p.owner, [t.id])).get(t.id) ?? [])
		: [];
	const saved_ = await commit(
		db(c),
		p,
		b.idempotency_key,
		hash,
		result,
		changes,
		"edit",
		[
			...(p.human ? [await filingAudit(c, b.idempotency_key, changes)] : []),
			...(keep.length
				? [
						db(c)
							.prepare(
								"UPDATE mileage_proposals SET status='pending',resolved_at=NULL WHERE owner=? AND trip_id=? AND status='resolved' AND id IN (SELECT value FROM json_each(?))",
							)
							.bind(p.owner, t.id, JSON.stringify(keep.map((x) => x.id))),
					]
				: []),
		],
		checks,
	);
	return c.json(ok(p.human ? saved_ : agentSummary(saved_)));
});
/** The filing batch a revision belongs to (from the owner's `file` audit row); none: that trip alone. */
async function filingBatch(c: Ctx, id: string, revision: number) {
	const row = await db(c)
		.prepare(
			"SELECT a.data FROM mileage_admin_audit a,json_each(a.data,'$.trips') j WHERE a.owner=? AND a.operation='file' AND json_extract(j.value,'$.id')=? AND json_extract(j.value,'$.revision')=? ORDER BY a.seq DESC LIMIT 1",
		)
		.bind(principal(c).owner, id, revision)
		.first<{ data: string }>();
	const batch = row
		? (
				JSON.parse(row.data) as {
					trips: { id: string; revision: number; before: number; reopen: string[] }[];
				}
			).trips
		: [{ id, revision, before: revision - 1, reopen: [] as string[] }];
	return batch;
}
routes.post("/trips/:id/undo", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	const id = idSchema.parse(c.req.param("id"));
	const b = await body(
		c,
		z.object({ expected_revision: revisionSchema, idempotency_key: keySchema }).strict(),
	);
	const hash = await digest({ op: "undo", id, ...b });
	const prior = await saved<{ trips: Trip[] }>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(prior));
	const t = await trip(db(c), p.owner, id);
	fresh(t, b.expected_revision);
	const head = await db(c)
		.prepare(
			"SELECT actor,operation FROM mileage_revisions WHERE owner=? AND trip_id=? AND revision=?",
		)
		.bind(p.owner, id, t.revision)
		.first<{ actor: string; operation: string }>();
	// Only the owner's own filing or edit is undone: never a capture, the agent's, a calendar match or an undo.
	if (!head || head.actor !== p.actor || !["edit", "answer"].includes(head.operation))
		throw new MileageError(
			"NOTHING_TO_UNDO",
			"The last change to this trip isn't yours to undo",
			409,
		);
	const changes: { before: Trip; after: Trip }[] = [];
	const extra: D1PreparedStatement[] = [];
	const now = Date.now();
	for (const entry of await filingBatch(c, id, t.revision)) {
		let current: Trip;
		try {
			current = entry.id === id ? t : await trip(db(c), p.owner, entry.id);
		} catch {
			throw new MileageError("REVISION_CONFLICT", "A trip in that answer changed since", 409);
		}
		if (current.revision !== entry.revision || entry.before < 1)
			throw new MileageError("REVISION_CONFLICT", "A trip in that answer changed since", 409);
		const earlier = await db(c)
			.prepare("SELECT data FROM mileage_revisions WHERE owner=? AND trip_id=? AND revision=?")
			.bind(p.owner, entry.id, entry.before)
			.first<{ data: string }>();
		if (!earlier) throw new MileageError("NOTHING_TO_UNDO", "No earlier revision to restore", 409);
		const restored: Trip = {
			...(JSON.parse(earlier.data) as Trip),
			revision: current.revision + 1,
			updated_at: now,
			deleted_at: null,
		};
		changes.push({ before: current, after: restored });
		// The trip update resolves nothing (none pending); then the guesses that answer closed are open again.
		if (entry.reopen.length)
			extra.push(
				db(c)
					.prepare(
						"UPDATE mileage_proposals SET status='pending',resolved_at=NULL WHERE owner=? AND trip_id=? AND status='resolved' AND id IN (SELECT value FROM json_each(?))",
					)
					.bind(p.owner, entry.id, JSON.stringify(entry.reopen)),
				db(c)
					.prepare(
						"INSERT OR IGNORE INTO mileage_questions(owner,id,trip_id,trip_revision,prompt) VALUES(?,?,?,?,?)",
					)
					.bind(
						p.owner,
						`${entry.id}:${restored.revision}`,
						entry.id,
						restored.revision,
						"Choose category and specific purpose for this trip",
					),
			);
	}
	extra.push(
		adminAudit(c, "undo", {
			key: b.idempotency_key,
			trips: changes.map((x) => ({
				id: x.after.id,
				revision: x.after.revision,
				restored: x.before.revision,
			})),
		}),
	);
	const result = { trips: changes.map((x) => x.after) };
	return c.json(
		ok(await commit(db(c), p, b.idempotency_key, hash, result, changes, "undo", extra)),
	);
});
routes.post("/trips/:id/split", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const id = c.req.param("id"),
		b = await body(
			c,
			z
				.object({
					expected_revision: revisionSchema,
					fraction: z.number().min(0.01).max(0.99),
					idempotency_key: keySchema,
				})
				.strict(),
		);
	const hash = await digest({ op: "split", id, ...b }),
		prior = await saved<{ trips: Trip[] }>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(prior));
	const t = await trip(db(c), p.owner, id);
	fresh(t, b.expected_revision);
	const mid = Math.round(t.started_at + (t.ended_at - t.started_at) * b.fraction);
	if (mid <= t.started_at || mid >= t.ended_at)
		throw new MileageError("INVALID_SPLIT", "Trip interval too short");
	const meters = Math.floor(t.distance_meters * b.fraction),
		measured = Math.floor(t.measured_distance_meters * b.fraction),
		now = Date.now();
	const lineage = [...new Set([...t.lineage, t.id])];
	if (lineage.length > 1000)
		throw new MileageError("LINEAGE_TOO_LARGE", "Trip lineage limit reached", 413);
	const a: Trip = {
		...t,
		id: crypto.randomUUID(),
		ended_at: mid,
		distance_meters: meters,
		measured_distance_meters: measured,
		revision: 1,
		human_reviewed: true,
		lineage,
		evidence_ids: [...t.evidence_ids],
		updated_at: now,
	};
	const bTrip: Trip = {
		...a,
		id: crypto.randomUUID(),
		started_at: mid,
		ended_at: t.ended_at,
		distance_meters: t.distance_meters - meters,
		measured_distance_meters: t.measured_distance_meters - measured,
	};
	// No inferred midpoint coordinates: only the measured original endpoints remain known.
	// The estimated start leg belongs to the first part only.
	delete bTrip.start_estimate;
	delete a.end_lat;
	delete a.end_lng;
	delete bTrip.start_lat;
	delete bTrip.start_lng;
	a.destination = "Split point (unmeasured)";
	bTrip.origin = "Split point (unmeasured)";
	const result = { trips: [a, bTrip] };
	const routeChange = await transformRoutes(c.env, p, [t], ([points]) => [
		{ trip: a, points: points.filter((point) => point.timestamp <= mid) },
		{ trip: bTrip, points: points.filter((point) => point.timestamp > mid) },
	]);
	return c.json(
		ok(
			await commit(
				db(c),
				p,
				b.idempotency_key,
				hash,
				result,
				[{ before: t, after: changed(t, { deleted_at: now }) }, { after: a }, { after: bTrip }],
				"split",
				routeChange.extra,
				[
					...(await addressCopies(c, [
						[t.id, a.id, "start"],
						[t.id, bTrip.id, "end"],
					])),
					...routeChange.checks,
				],
			),
		),
	);
});
routes.post("/trips/merge", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(
		c,
		z
			.object({
				ids: z.array(idSchema).min(2).max(10),
				expected_revisions: z.array(revisionSchema).min(2).max(10),
				idempotency_key: keySchema,
			})
			.strict(),
	);
	if (b.ids.length !== b.expected_revisions.length || new Set(b.ids).size !== b.ids.length)
		throw new MileageError("INVALID_MERGE", "IDs and revisions must correspond uniquely");
	const hash = await digest({ op: "merge", ...b }),
		prior = await saved<Trip>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(prior));
	const trips: Trip[] = [];
	for (let i = 0; i < b.ids.length; i++) {
		const t = await trip(db(c), p.owner, b.ids[i]);
		fresh(t, b.expected_revisions[i]);
		trips.push(t);
	}
	for (let i = 1; i < trips.length; i++) {
		const prev = trips[i - 1],
			t = trips[i];
		if (
			t.started_at < prev.ended_at ||
			t.started_at - prev.ended_at > 6 * 3600000 ||
			t.vehicle_id !== prev.vehicle_id ||
			t.category_id !== prev.category_id ||
			t.treatment !== prev.treatment ||
			t.purpose !== prev.purpose ||
			t.timezone !== prev.timezone ||
			t.source !== prev.source ||
			(t.reimbursable ?? null) !== (prev.reimbursable ?? null)
		)
			throw new MileageError(
				"INVALID_MERGE",
				"Merge requires chronological nonoverlapping compatible trips within six hours",
			);
		const middle = await db(c)
			.prepare(
				"SELECT id FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND id NOT IN (?,?) AND json_extract(data,'$.started_at')>=? AND json_extract(data,'$.started_at')<=? LIMIT 1",
			)
			.bind(p.owner, prev.id, t.id, prev.started_at, t.started_at)
			.first();
		if (middle) throw new MileageError("INVALID_MERGE", "Trips must be adjacent");
	}
	const adjacencyChecks: D1PreparedStatement[] = [];
	for (let i = 1; i < trips.length; i++) {
		const a = trips[i - 1],
			b = trips[i];
		adjacencyChecks.push(
			...transactionCheck(
				c,
				"NOT EXISTS(SELECT 1 FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND id NOT IN (?,?) AND json_extract(data,'$.started_at')>=? AND json_extract(data,'$.started_at')<=?)",
				[p.owner, a.id, b.id, a.started_at, b.started_at],
			),
		);
	}
	const first = trips[0],
		last = trips[trips.length - 1],
		now = Date.now();
	const merged: Trip = {
		...first,
		id: crypto.randomUUID(),
		ended_at: last.ended_at,
		destination: last.destination,
		distance_meters: trips.reduce((s, t) => s + t.distance_meters, 0),
		measured_distance_meters: trips.reduce((s, t) => s + t.measured_distance_meters, 0),
		reconstruction_confirmed:
			trips.every((t) => ["complete", "manual"].includes(t.quality) || ownerReconstruction(t)) &&
			trips.every((t, i) => i === 0 || t.started_at === trips[i - 1].ended_at),
		revision: 1,
		human_reviewed: true,
		updated_at: now,
		lineage: [...new Set(trips.flatMap((t) => [...t.lineage, t.id]))],
		evidence_ids: [...new Set(trips.flatMap((t) => t.evidence_ids))],
		quality: trips.some(
			(t, i) =>
				(t.quality !== "complete" && t.quality !== "manual") ||
				(i > 0 && t.started_at > trips[i - 1].ended_at),
		)
			? "gap"
			: first.quality,
	};
	if (
		merged.lineage.length > 1000 ||
		merged.distance_meters > 3000000 ||
		merged.ended_at - merged.started_at > 7 * 86400000
	)
		throw new MileageError("INVALID_MERGE", "Merged trip exceeds distance or lineage limits", 413);
	delete merged.end_lat;
	delete merged.end_lng;
	if (last.end_lat !== undefined) {
		merged.end_lat = last.end_lat;
		merged.end_lng = last.end_lng;
	}
	const routeChange = await transformRoutes(c.env, p, trips, (points) => [
		{ trip: merged, points: points.flat() },
	]);
	return c.json(
		ok(
			await commit(
				db(c),
				p,
				b.idempotency_key,
				hash,
				merged,
				[
					...trips.map((t) => ({ before: t, after: changed(t, { deleted_at: now }) })),
					{ after: merged },
				],
				"merge",
				routeChange.extra,
				[
					...(await addressCopies(c, [
						[first.id, merged.id, "start"],
						[last.id, merged.id, "end"],
					])),
					...adjacencyChecks,
					...routeChange.checks,
				],
			),
		),
	);
});
routes.get("/questions", async (c) => {
	const p = principal(c);
	requireScope(p, "trips:read:summary");
	query(c, []);
	const rows = await db(c)
		.prepare(
			"SELECT q.id,q.trip_id,q.trip_revision,q.prompt,t.data FROM mileage_questions q JOIN mileage_trips t ON t.owner=q.owner AND t.id=q.trip_id AND t.revision=q.trip_revision WHERE q.owner=? AND q.status='pending' ORDER BY q.trip_id LIMIT 100",
		)
		.bind(p.owner)
		.all<{
			id: string;
			trip_id: string;
			trip_revision: number;
			prompt: string;
			data: string;
		}>();
	const cats = await categories(db(c), p.owner, builtins(c));
	const projected = await events(c);
	const now = Date.now();
	// Agent proposals carry labels: owner only, and listed before calendar items.
	const proposals = p.human
		? await pendingProposals(
				db(c),
				p.owner,
				rows.results.map((r) => r.trip_id),
			)
		: new Map();
	return c.json(
		ok({
			questions: rows.results
				.filter((r) => {
					const t = JSON.parse(r.data) as Trip;
					return p.human || (companyTreatment(t) && p.entities.includes(t.entity_id ?? ""));
				})
				.map(({ data, ...q }) => ({
					...q,
					suggestions: [
						...agentSuggestions(proposals.get(q.trip_id) ?? []),
						...calendarSuggestions(JSON.parse(data) as Trip, projected, now)
							.filter((suggestion) =>
								cats.some(
									(cat) =>
										cat.id === suggestion.category_id &&
										companyTreatment(cat) &&
										(p.human || p.entities.includes(cat.entity_id)),
								),
							)
							.map((suggestion) => ({ source: "calendar" as const, ...suggestion })),
					],
					choices: cats
						.filter(
							(cat) => p.human || (companyTreatment(cat) && p.entities.includes(cat.entity_id)),
						)
						.map((cat) => ({ category_id: cat.id, label: cat.name })),
				})),
		}),
	);
});
routes.post("/questions", async (c) => {
	const p = principal(c),
		b = await body(
			c,
			z
				.object({
					trip_id: idSchema,
					expected_revision: revisionSchema,
					idempotency_key: keySchema,
				})
				.strict(),
		),
		hash = await digest({ op: "question", ...b });
	const prior = await saved<{ id: string; trip_id: string; trip_revision: number }>(
		db(c),
		p,
		b.idempotency_key,
		hash,
	);
	if (prior) return c.json(ok(prior));
	const t = await trip(db(c), p.owner, b.trip_id);
	requireScope(p, "questions:propose", t.entity_id);
	if (!p.human && !companyTreatment(t))
		throw new MileageError(
			"FORBIDDEN",
			"Personal/commute/unresolved questions are owner-only",
			403,
		);
	fresh(t, b.expected_revision);
	if (t.human_reviewed)
		throw new MileageError(
			"HUMAN_DECISION_LOCKED",
			"Human-reviewed trips need no agent question",
			403,
		);
	const id = `${t.id}:${t.revision}`,
		result = { id, trip_id: t.id, trip_revision: t.revision };
	const guard = db(c)
		.prepare(
			"INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM mileage_trips WHERE owner=? AND id=? AND revision=? AND json_extract(data,'$.deleted_at') IS NULL) THEN 1 ELSE 0 END",
		)
		.bind(`q:${crypto.randomUUID()}`, p.owner, t.id, t.revision);
	// Guard rows for explicit checks are cleared in this same batch.
	const extra = [
		guard,
		db(c)
			.prepare(
				"INSERT OR IGNORE INTO mileage_questions(owner,id,trip_id,trip_revision,prompt) VALUES(?,?,?,?,?)",
			)
			.bind(p.owner, id, t.id, t.revision, "Choose category and specific purpose for this trip"),
		db(c).prepare("DELETE FROM mileage_guard WHERE id LIKE 'q:%'"),
	];
	return c.json(ok(await commit(db(c), p, b.idempotency_key, hash, result, [], "question", extra)));
});
routes.post("/questions/:id/answer", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const id = c.req.param("id"),
		b = await body(
			c,
			z
				.object({
					expected_revision: revisionSchema,
					category_id: idSchema,
					purpose: textSchema,
					origin: textSchema.optional(),
					destination: textSchema.optional(),
					reimbursable: z.boolean().nullable().optional(),
					proposal_id: idSchema.optional(),
					idempotency_key: keySchema,
				})
				.strict(),
		),
		hash = await digest({ op: "answer", id, ...b });
	const prior = await saved<Trip>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(prior));
	const q = await db(c)
		.prepare("SELECT trip_id,trip_revision,status FROM mileage_questions WHERE owner=? AND id=?")
		.bind(p.owner, id)
		.first<{ trip_id: string; trip_revision: number; status: string }>();
	if (!q) throw new MileageError("NOT_FOUND", "Question not found", 404);
	if (q.status !== "pending" || q.trip_revision !== b.expected_revision)
		throw new MileageError("REVISION_CONFLICT", "Question is no longer current", 409);
	const t = await trip(db(c), p.owner, q.trip_id);
	fresh(t, b.expected_revision);
	// The trip update resolves every pending proposal for it (005 trigger); this one is cited as evidence.
	if (b.proposal_id !== undefined) await findProposal(db(c), p.owner, b.proposal_id, t.id);
	const next = changed(t, {
		...(await classify(c, t, b.category_id, b.purpose, undefined, b.reimbursable)),
		...(b.origin !== undefined ? { origin: b.origin } : {}),
		...(b.destination !== undefined ? { destination: b.destination } : {}),
		...(b.proposal_id !== undefined
			? { evidence_ids: [...new Set([...t.evidence_ids, `proposal:${b.proposal_id}`])] }
			: {}),
		human_reviewed: true,
	});
	const result = await commit(
		db(c),
		p,
		b.idempotency_key,
		hash,
		next,
		[{ before: t, after: next }],
		"answer",
		[
			db(c)
				.prepare("UPDATE mileage_questions SET status='answered' WHERE owner=? AND id=?")
				.bind(p.owner, id),
			await filingAudit(c, b.idempotency_key, [{ before: t, after: next }]),
		],
	);
	return c.json(ok(result));
});
function adminAudit(c: Ctx, op: string, data: unknown) {
	const p = principal(c);
	return db(c)
		.prepare(
			"INSERT INTO mileage_admin_audit(owner,actor,operation,data,created_at) VALUES(?,?,?,?,?)",
		)
		.bind(p.owner, p.actor, op, JSON.stringify(data), Date.now());
}
routes.post("/categories", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(
		c,
		z
			.object({
				name: textSchema.refine((v) => v.trim().length > 0),
				treatment: treatmentSchema,
				entity_id: idSchema,
				idempotency_key: keySchema.optional(),
			})
			.strict(),
	);
	// A built-in company keeps its treatment (a reimbursement company is never business and the
	// other way round); Personal is neither.
	const builtin = builtins(c).find((x) => x.entity_id === b.entity_id);
	if (
		builtin &&
		["business", "reimbursement"].includes(b.treatment) &&
		b.treatment !== builtin.treatment
	)
		throw new MileageError(
			"INVALID_TREATMENT",
			"Entity treatment is incompatible with its configured tax/employer role",
		);
	const hash = await digest({ op: "category", ...b }),
		key = b.idempotency_key ?? `category:${hash}`;
	const prior = await saved<Category>(db(c), p, key, hash);
	if (prior) return c.json(ok(prior));
	const { idempotency_key: _key, ...definition } = b;
	const category: Category = { id: crypto.randomUUID(), ...definition };
	const result = await commit(db(c), p, key, hash, category, [], "category_create", [
		db(c)
			.prepare(
				"INSERT INTO mileage_categories(owner,id,name,treatment,entity_id) VALUES(?,?,?,?,?)",
			)
			.bind(p.owner, category.id, category.name, category.treatment, category.entity_id),
		adminAudit(c, "category_create", category),
	]);
	return c.json(ok(result));
});
routes.post("/vehicles/default/odometer", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(
		c,
		z
			.object({
				observed_at: timeSchema.refine(
					(v) => v <= Date.now() + 60000,
					"Odometer observation cannot be in the future",
				),
				reading_miles: z.number().min(0).max(2000000).multipleOf(0.1),
				kind: z.enum(["baseline", "reading", "year_end"]),
				expected_revision: z.number().int().min(0).optional(),
				idempotency_key: keySchema,
			})
			.strict(),
	);
	const hash = await digest({ op: "odometer", ...b }),
		prior = await saved<Vehicle>(db(c), p, b.idempotency_key, hash);
	if (prior) return c.json(ok(prior));
	const current = await vehicle(db(c), p.owner);
	if (b.expected_revision !== undefined && b.expected_revision !== current.revision)
		throw new MileageError("REVISION_CONFLICT", "Vehicle revision changed", 409);
	if (current.odometer_readings.length >= 1000)
		throw new MileageError("ODOMETER_LIMIT", "At most 1000 actual observations are retained", 413);
	if (
		current.odometer_readings.some(
			(r) =>
				r.observed_at === b.observed_at ||
				(r.observed_at < b.observed_at && r.reading_miles > b.reading_miles) ||
				(r.observed_at > b.observed_at && r.reading_miles < b.reading_miles),
		)
	)
		throw new MileageError(
			"INVALID_ODOMETER",
			"Readings must increase with observation time; use unique timestamps",
		);
	const next: Vehicle = {
		...current,
		revision: current.revision + 1,
		odometer_readings: [
			...current.odometer_readings,
			{
				id: crypto.randomUUID(),
				observed_at: b.observed_at,
				reading_miles: b.reading_miles,
				kind: b.kind,
			},
		].sort((a, b) => a.observed_at - b.observed_at),
	};
	const checks = transactionCheck(
		c,
		current.revision === 0
			? "NOT EXISTS(SELECT 1 FROM mileage_vehicle WHERE owner=?)"
			: "EXISTS(SELECT 1 FROM mileage_vehicle WHERE owner=? AND revision=?)",
		[p.owner, ...(current.revision === 0 ? [] : [current.revision])],
	);
	return c.json(
		ok(
			await commit(
				db(c),
				p,
				b.idempotency_key,
				hash,
				next,
				[],
				"odometer",
				[
					db(c)
						.prepare(
							"INSERT INTO mileage_vehicle(owner,revision,data) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,data=excluded.data",
						)
						.bind(p.owner, next.revision, JSON.stringify(next)),
					adminAudit(c, "odometer", next),
				],
				checks,
			),
		),
	);
});
routes.get("/tokens", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const rows = await db(c)
		.prepare(
			"SELECT id,name,scopes,entity_ids,created_at,expires_at,revoked_at FROM mileage_tokens WHERE owner=? ORDER BY created_at DESC LIMIT 100",
		)
		.bind(p.owner)
		.all<{ id: string; name: string; scopes: string; entity_ids: string }>();
	return c.json(
		ok({
			tokens: rows.results.map((r) => ({
				...r,
				scopes: JSON.parse(r.scopes),
				entity_ids: JSON.parse(r.entity_ids),
			})),
		}),
	);
});
routes.post("/tokens", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(
		c,
		z
			.object({
				name: z.string().trim().min(1).max(100),
				scopes: z
					.array(
						z.enum([
							"trips:read:summary",
							"trips:classify",
							"questions:propose",
							"reports:read",
							"trips:suggest",
						]),
					)
					.min(1)
					.max(5),
				entity_ids: z.array(idSchema).max(20),
				expires_at: timeSchema.optional(),
			})
			.strict(),
	);
	// trips:suggest stands alone and is granted no entity; every other scope needs at least one.
	if (b.scopes.includes("trips:suggest")) {
		if (new Set(b.scopes).size !== 1 || b.entity_ids.length)
			throw new MileageError(
				"INVALID_SCOPE",
				"trips:suggest cannot be combined with other scopes or entities",
			);
	} else if (!b.entity_ids.length)
		throw new MileageError("INVALID_BODY", "At least one entity is required");
	const entitySet = new Set(
		(await categories(db(c), p.owner, builtins(c)))
			.filter(
				(cat) =>
					["business", "reimbursement"].includes(cat.treatment) && cat.entity_id !== "personal",
			)
			.map((cat) => cat.entity_id),
	);
	if (b.entity_ids.some((id) => !entitySet.has(id)))
		throw new MileageError(
			"INVALID_ENTITY",
			"Only explicitly configured business entities may be granted",
		);
	const now = Date.now(),
		expires = b.expires_at ?? now + 90 * 86400000;
	if (expires <= now || expires > now + 366 * 86400000)
		throw new MileageError("INVALID_EXPIRY", "Token expiry must be within 366 days");
	const token = `mlg_${newToken()}`,
		id = crypto.randomUUID();
	const metadata = {
		id,
		name: b.name,
		scopes: [...new Set(b.scopes)],
		entity_ids: [...new Set(b.entity_ids)],
		created_at: now,
		expires_at: expires,
	};
	await db(c).batch([
		db(c)
			.prepare(
				"INSERT INTO mileage_tokens(id,owner,name,token_hash,scopes,entity_ids,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(
				id,
				p.owner,
				b.name,
				await hashToken(token),
				JSON.stringify(metadata.scopes),
				JSON.stringify(metadata.entity_ids),
				now,
				expires,
			),
		adminAudit(c, "token_issue", metadata),
	]);
	return c.json(ok({ ...metadata, token }));
});
routes.delete("/tokens/:id", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const id = c.req.param("id");
	const exists = await db(c)
		.prepare("SELECT id FROM mileage_tokens WHERE owner=? AND id=?")
		.bind(p.owner, id)
		.first();
	if (!exists) throw new MileageError("NOT_FOUND", "Token not found", 404);
	await db(c).batch([
		db(c)
			.prepare("UPDATE mileage_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE owner=? AND id=?")
			.bind(Date.now(), p.owner, id),
		adminAudit(c, "token_revoke", { id }),
	]);
	return c.json(ok({ id, revoked: true }));
});
routes.get("/calendar/events", async (c) => {
	requireHuman(principal(c));
	query(c, []);
	return c.json(ok({ events: await events(c) }));
});
routes.post("/calendar/events", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(
		c,
		z
			.object({
				events: z.array(eventSchema).min(1).max(50),
				idempotency_key: keySchema.optional(),
			})
			.strict(),
	);
	const hash = await digest({ op: "calendar_projection", ...b }),
		key = b.idempotency_key ?? `calendar:${hash}`;
	const prior = await saved<{ accepted: { id: string; version: string }[] }>(db(c), p, key, hash);
	if (prior) return c.json(ok(prior));
	const allow = (c.env.MILEAGE_CALENDAR_ALLOWLIST ?? "")
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean),
		cats = await categories(db(c), p.owner, builtins(c)),
		statements: D1PreparedStatement[] = [];
	const count = Number(
		(
			await db(c)
				.prepare("SELECT count(*) AS n FROM mileage_calendar WHERE owner=?")
				.bind(p.owner)
				.first<{ n: number }>()
		)?.n ?? 0,
	);
	let additions = 0;
	if (new Set(b.events.map((e) => `${e.calendar_id}:${e.id}`)).size !== b.events.length)
		throw new MileageError("INVALID_BODY", "Duplicate event IDs in batch");
	for (const e of b.events) {
		if (!allow.includes(e.calendar_id))
			throw new MileageError("CALENDAR_NOT_ALLOWED", "Calendar is not explicitly allowlisted", 403);
		const cat = cats.find((cat) => cat.id === e.category_id);
		if (!cat || !["business", "reimbursement"].includes(cat.treatment))
			throw new MileageError(
				"INVALID_CATEGORY",
				"Calendar projections require an explicit business entity",
			);
		const projected: CalendarEvent = { ...e, entity_id: cat.entity_id };
		const prev = await db(c)
			.prepare("SELECT data FROM mileage_calendar WHERE owner=? AND calendar_id=? AND id=?")
			.bind(p.owner, e.calendar_id, e.id)
			.first<{ data: string }>();
		if (!prev) additions++;
		if (prev) {
			const before = JSON.parse(prev.data) as CalendarEvent;
			if (
				e.observed_at < before.observed_at ||
				(before.version === e.version &&
					(await digest({ ...before, observed_at: e.observed_at })) !== (await digest(projected)))
			)
				throw new MileageError(
					"EVENT_VERSION_CONFLICT",
					"Changed projection requires a new source version",
					409,
				);
		}
		statements.push(
			...transactionCheck(
				c,
				prev
					? "EXISTS(SELECT 1 FROM mileage_calendar WHERE owner=? AND calendar_id=? AND id=? AND data=?)"
					: "NOT EXISTS(SELECT 1 FROM mileage_calendar WHERE owner=? AND calendar_id=? AND id=?)",
				[p.owner, e.calendar_id, e.id, ...(prev ? [prev.data] : [])],
			),
		);
		statements.push(
			db(c)
				.prepare(
					"INSERT INTO mileage_calendar(owner,calendar_id,id,data) VALUES(?,?,?,?) ON CONFLICT(owner,calendar_id,id) DO UPDATE SET data=excluded.data",
				)
				.bind(p.owner, e.calendar_id, e.id, JSON.stringify(projected)),
		);
	}
	if (count + additions > 500)
		throw new MileageError("CALENDAR_TOO_LARGE", "At most 500 projected events are retained", 413);
	const result = {
		accepted: b.events.map((e) => ({ id: e.id, version: e.version })),
	};
	const limitId = `calendar:${crypto.randomUUID()}`;
	statements.push(
		db(c)
			.prepare(
				"INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN (SELECT count(*) FROM mileage_calendar WHERE owner=?)<=500 THEN 1 ELSE 0 END",
			)
			.bind(limitId, p.owner),
		db(c).prepare("DELETE FROM mileage_guard WHERE id=?").bind(limitId),
		adminAudit(c, "calendar_projection", b),
	);
	try {
		await commit(db(c), p, key, hash, result, [], "calendar_projection", statements);
	} catch (error) {
		if (/CHECK constraint/.test(String(error)))
			throw new MileageError(
				"CALENDAR_TOO_LARGE",
				"Calendar snapshot changed or the 500-event projection limit was exceeded",
				413,
			);
		throw error;
	}
	return c.json(ok(result));
});
async function matchTrips(c: Ctx, b: { trip_ids: string[]; idempotency_key: string }) {
	const p = principal(c);
	requireHuman(p);
	const hash = await digest({ op: "calendar_match", ...b });
	const prior = await saved<{ applied: string[]; held: string[] }>(
		db(c),
		p,
		b.idempotency_key,
		hash,
	);
	if (prior) return prior;
	const snapshot = await calendarSnapshot(c),
		projected = snapshot.events,
		changes: Change[] = [],
		applied: string[] = [],
		held: string[] = [];
	for (const id of new Set(b.trip_ids)) {
		const t = await trip(db(c), p.owner, id);
		if (t.human_reviewed) {
			held.push(id);
			continue;
		}
		const commutes = projected.filter((e) => calendarCommute(t, e, Date.now()));
		const candidates = projected.filter((e) => calendarCandidate(t, e, Date.now()));
		let patch: Partial<Trip>;
		if (commutes.length) {
			patch = {
				category_id: "personal",
				entity_id: "personal",
				treatment: "commute",
				purpose: "Confirmed commute",
				evidence_ids: commutes.map((e) => `calendar:${e.calendar_id}:${e.id}:${e.version}`),
			};
		} else if (new Set(candidates.map((e) => `${e.category_id}\n${e.purpose}`)).size === 1) {
			const e = candidates[0];
			patch = {
				...(await classify(c, t, e.category_id, e.purpose, undefined)),
				evidence_ids: candidates.map((e) => `calendar:${e.calendar_id}:${e.id}:${e.version}`),
			};
		} else {
			held.push(id);
			if (t.category_id)
				changes.push({
					before: t,
					after: changed(t, {
						category_id: null,
						entity_id: null,
						purpose: "",
						treatment: "needs_review",
						evidence_ids: [],
					}),
				});
			continue;
		}
		if (
			t.category_id === patch.category_id &&
			t.entity_id === patch.entity_id &&
			t.treatment === patch.treatment &&
			t.purpose === patch.purpose &&
			JSON.stringify(t.evidence_ids.slice().sort()) ===
				JSON.stringify(patch.evidence_ids?.slice().sort())
		) {
			held.push(id);
			continue;
		}
		changes.push({ before: t, after: changed(t, patch) });
		applied.push(id);
	}
	return commit(
		db(c),
		p,
		b.idempotency_key,
		hash,
		{ applied, held },
		changes,
		"calendar_match",
		[],
		calendarCheck(c, snapshot.version),
	);
}
routes.post("/calendar/match", async (c) => {
	requireHuman(principal(c));
	const b = await body(
		c,
		z.object({ trip_ids: z.array(idSchema).min(1).max(50), idempotency_key: keySchema }).strict(),
	);
	return c.json(ok(await matchTrips(c, b)));
});
routes.post("/calendar/google/sync", async (c) => {
	const p = principal(c);
	requireHuman(p);
	const b = await body(c, z.object({ trip_ids: z.array(idSchema).max(50).optional() }).strict());
	const configuration = await googleConfiguration(c.env, p);
	// Explicit selection is owner-only; absent selection refreshes the newest 50 pending decisions.
	const rows = b.trip_ids
		? null
		: await db(c)
				.prepare(
					"SELECT id FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.human_reviewed')=0 ORDER BY json_extract(data,'$.started_at') DESC,id LIMIT 51",
				)
				.bind(p.owner)
				.all<{ id: string }>();
	const ids = b.trip_ids ?? rows?.results.slice(0, 50).map((r) => r.id) ?? [];
	for (const id of ids) await trip(db(c), p.owner, id);
	try {
		const sync = await runGoogleSync(c.env, p, configuration);
		const matching = ids.length
			? await matchTrips(c, {
					trip_ids: ids,
					idempotency_key: `google-manual-${crypto.randomUUID()}`,
				})
			: { applied: [], held: [] };
		return c.json(
			ok({ ...sync, matching: { ...matching, has_more: (rows?.results.length ?? 0) > 50 } }),
		);
	} catch (error) {
		if (error instanceof MileageError && error.status === 429) c.header("Retry-After", "60");
		throw error;
	}
});
routes.get("/suggestions/queue", async (c) => {
	const p = principal(c);
	requireSuggester(p);
	query(c, ["limit", "cursor"]);
	const limit = integer(c.req.query("limit"), 50, 1, 50);
	const cursor = cursorDecode(c.req.query("cursor"));
	const parsed = z.tuple([timeSchema, idSchema]).safeParse(cursor);
	if (cursor !== undefined && !parsed.success)
		throw new MileageError("INVALID_CURSOR", "Invalid queue cursor");
	await logicTables(c);
	const [at, after] = parsed.success ? parsed.data : [null, ""];
	const rows = await db(c)
		.prepare(
			"SELECT data FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.human_reviewed')=0 AND (? IS NULL OR json_extract(data,'$.started_at')<? OR (json_extract(data,'$.started_at')=? AND id<?)) ORDER BY json_extract(data,'$.started_at') DESC,id DESC LIMIT ?",
		)
		.bind(p.owner, at, at, at, after, limit + 1)
		.all<{ data: string }>();
	const trips = rows.results.slice(0, limit).map((r) => JSON.parse(r.data) as Trip);
	const last = trips.at(-1);
	return c.json(
		ok({
			items: await queueItems(db(c), p.owner, trips, await events(c)),
			next_cursor:
				rows.results.length > limit && last ? cursorEncode([last.started_at, last.id]) : null,
		}),
	);
});
routes.post("/trips/:id/proposals", async (c) => {
	const p = principal(c);
	requireSuggestAgent(p);
	query(c, []);
	const id = idSchema.parse(c.req.param("id"));
	const b = await body(c, proposalSchema);
	return c.json(
		ok(
			await propose(
				db(c),
				p,
				id,
				b,
				autoConfidence(c.env.MILEAGE_AGENT_AUTO_CONFIDENCE),
				builtins(c),
			),
		),
	);
});
routes.post("/suggestions/run", async (c) => {
	const p = principal(c);
	requireSuggester(p);
	query(c, []);
	await body(c, z.object({}).strict());
	return c.json(
		ok(
			await runSuggester(
				db(c),
				p.human ? systemPrincipal(p) : p,
				autoConfidence(c.env.MILEAGE_AGENT_AUTO_CONFIDENCE),
				builtins(c),
			),
		),
	);
});
routes.put("/rates/:effective_from", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	const effective = effectiveFromSchema.parse(c.req.param("effective_from"));
	const b = await body(c, putRateSchema);
	return c.json(ok(await putRate(db(c), p, effective, b, (op, data) => adminAudit(c, op, data))));
});
routes.delete("/rates/:effective_from", async (c) => {
	const p = principal(c);
	requireHuman(p);
	query(c, []);
	const effective = effectiveFromSchema.parse(c.req.param("effective_from"));
	return c.json(ok(await deleteRate(db(c), effective, (op, data) => adminAudit(c, op, data))));
});
routes.get("/exports", async (c) => {
	query(c, ["type", "format", "from", "to", "include_proposals"]);
	const guesses = c.req.query("include_proposals") ?? "0";
	if (!["0", "1"].includes(guesses))
		throw new MileageError("INVALID_QUERY", "include_proposals is 0 or 1");
	const from = integer(c.req.query("from"), -1),
		to = integer(c.req.query("to"), -1);
	if (from < 0 || to < 0)
		throw new MileageError("INVALID_QUERY", "Explicit from and to are required");
	return exportReport(
		db(c),
		principal(c),
		builtins(c),
		c.req.query("type") ?? "irs",
		c.req.query("format") ?? "csv",
		from,
		to,
		(c.env.MILEAGE_CALENDAR_ALLOWLIST ?? "").split(",").map((v) => v.trim()),
		guesses === "1",
	);
});
routes.all("*", (c) =>
	c.json({ success: false, error: { code: "NOT_FOUND", message: "Mileage route not found" } }, 404),
);
export default routes;
