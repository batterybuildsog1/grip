import { MileageError, type MileagePrincipal, requireScope } from "./auth";
import { builtinCompanies } from "./companies";
import {
	type CalendarEvent,
	companyTreatment,
	countedMeters,
	csvCell,
	localDate,
	pdfDocument,
	substantiation,
	type Trip,
} from "./policy";
import { pendingProposals } from "./proposals";
import { type Rate, rateFor, ratesStatement } from "./rates";
import { companyList, countTrips, estimateCents, totalsOf, uncoveredOf } from "./report";
import {
	type Category,
	canonical,
	defaultVehicle,
	digest,
	optionalLogic,
	type Vehicle,
} from "./store";

const ESTIMATE_LABEL = "estimate (IRS standard mileage rate)";
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Reimbursement rows only: the owner's mark, or "Not marked" (old rows and unanswered trips). */
const reimbursableText = (t: Trip) =>
	t.reimbursable === true ? "Yes" : t.reimbursable === false ? "No" : "Not marked";

/**
 * `type`: "irs" (owner only: every trip) or one configured company id (MILEAGE_COMPANIES_JSON,
 * src/mileage/companies.ts). A business company's export carries the IRS-rate estimate; a
 * reimbursement company's is miles only with the reimbursable split. `builtins` = the configured
 * companies plus Personal, the same list the report and the store read.
 */
export async function exportReport(
	db: D1Database,
	p: MileagePrincipal,
	builtins: Category[],
	type: string,
	format: string,
	from: number,
	to: number,
	allowlist: string[],
	includeProposals = false,
): Promise<Response> {
	const companiesBuiltIn = builtinCompanies(builtins);
	const company = companiesBuiltIn.find((co) => co.id === type) ?? null;
	if ((type !== "irs" && !company) || !["csv", "pdf"].includes(format))
		throw new MileageError("INVALID_QUERY", "Unknown export type or format");
	const nameList = (treatment: Category["treatment"]) =>
		company
			? company.treatment === treatment
				? company.name
				: ""
			: companiesBuiltIn
					.filter((co) => co.treatment === treatment)
					.map((co) => co.name)
					.join(" and ");
	const businessNames = nameList("business") || "Business";
	const reimbursementNames = nameList("reimbursement") || "Reimbursement";
	// The reimbursable split: the IRS log and reimbursement companies (never a business one).
	const showReimbursable = type === "irs" || company?.treatment === "reimbursement";
	if (to <= from || to - from > 366 * 86400000)
		throw new MileageError("INVALID_QUERY", "Export period must be positive and at most 366 days");
	if (!p.human) {
		if (type === "irs") throw new MileageError("FORBIDDEN", "IRS log is owner-only", 403);
		requireScope(p, "reports:read", type);
		if (includeProposals)
			throw new MileageError(
				"OWNER_REQUIRED",
				"The agent's guesses are the owner's to include",
				403,
			);
	}
	const ownerIRS = p.human && type === "irs";
	const selection =
		"SELECT id,data FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.started_at')>=? AND json_extract(data,'$.started_at')<?";
	// All reads share one SQLite snapshot, including lineage, evidence, observations and rates.
	const reads = [
		db
			.prepare(`${selection} ORDER BY json_extract(data,'$.started_at'),id LIMIT 2001`)
			.bind(p.owner, from, to),
		db
			.prepare(
				`WITH selected AS (${selection}) SELECT trip_id,revision,actor,operation,data FROM mileage_revisions WHERE owner=? AND (trip_id IN (SELECT id FROM selected) OR trip_id IN (SELECT j.value FROM selected,json_each(selected.data,'$.lineage') j)) ORDER BY seq LIMIT 10001`,
			)
			.bind(p.owner, from, to, p.owner),
		db.prepare("SELECT data FROM mileage_calendar WHERE owner=? LIMIT 501").bind(p.owner),
		db.prepare("SELECT data FROM mileage_vehicle WHERE owner=?").bind(p.owner),
		db
			.prepare(
				"SELECT id,name,treatment,entity_id FROM mileage_categories WHERE owner=? ORDER BY rowid",
			)
			.bind(p.owner),
	];
	// Optional 005: without the rates table every row says "No rate set for YYYY".
	const snapshot =
		(await optionalLogic(() =>
			db.batch<Record<string, unknown>>([...reads, ratesStatement(db)]),
		)) ?? (await db.batch<Record<string, unknown>>(reads));
	const [rows, revisions, calendar, vehicleRows, categoryRows] = snapshot;
	const rateRows = (snapshot[5]?.results ?? []) as unknown as Rate[];
	if (
		rows.results.length > 2000 ||
		revisions.results.length > 10000 ||
		calendar.results.length > 500
	)
		throw new MileageError(
			"EXPORT_TOO_LARGE",
			"Narrow the period; snapshot limits are 2000 trips and 10000 audit records",
			413,
		);
	const names = new Map([
		...builtins.map((c): [string, string] => [c.id, c.name]),
		...categoryRows.results.map((c) => [String(c.id), String(c.name)] as [string, string]),
	]);
	const stored = rows.results.map((r) => JSON.parse(String(r.data)) as Trip);
	// V3: the report's counting. A guess the owner includes is applied (and cited, so it counts as filed).
	const cats: Category[] = [...builtins, ...(categoryRows.results as unknown as Category[])];
	const pending = p.human
		? await pendingProposals(
				db,
				p.owner,
				stored.map((t) => t.id),
			)
		: new Map();
	const counted = countTrips(stored, pending, cats, rateRows, includeProposals);
	const withGuesses = includeProposals
		? counted
		: countTrips(stored, pending, cats, rateRows, true);
	const countedById = new Map(counted.map((x) => [x.trip.id, x]));
	const all: Trip[] = counted.map((x) =>
		x.state === "proposal" && x.guess
			? {
					...x.trip,
					...x.as,
					evidence_ids: [...new Set([...x.trip.evidence_ids, `proposal:${x.guess.id}`])],
				}
			: x.trip,
	);
	const projected = calendar.results
		.map((r) => JSON.parse(String(r.data)) as CalendarEvent)
		.filter((e) => allowlist.includes(e.calendar_id));
	const entityTrips = type === "irs" ? all : all.filter((t) => t.entity_id === type);
	const outcomes = new Map(
		entityTrips.map((t) => [t.id, substantiation(t, projected, Date.now())]),
	);
	const trips = ownerIRS
		? entityTrips
		: entityTrips.filter((t) => companyTreatment(t) && outcomes.get(t.id)?.eligible);
	const omitted = ownerIRS
		? []
		: entityTrips.filter((t) => !trips.some((included) => included.id === t.id));
	const exclusions = {
		count: omitted.length,
		distance_meters: omitted.reduce((s, t) => s + countedMeters(t), 0),
	};
	// Revisions of the trips this export is about (and their lineage), as the entity filter selected before.
	const about = new Set(
		all
			.filter((t) => (type === "irs" || t.entity_id === type) && (ownerIRS || companyTreatment(t)))
			.flatMap((t) => [t.id, ...t.lineage]),
	);
	const revisionRows = revisions.results.filter((r) => about.has(String(r.trip_id)));
	const history = ownerIRS
		? revisionRows.map((r) => ({
				trip_id: r.trip_id,
				revision: r.revision,
				actor: r.actor,
				operation: r.operation,
				snapshot: JSON.parse(String(r.data)),
			}))
		: [];
	const actualVehicle: Vehicle = vehicleRows.results[0]
		? JSON.parse(String(vehicleRows.results[0].data))
		: defaultVehicle();
	const observations = actualVehicle.odometer_readings.filter(
		(r) => r.observed_at >= from && r.observed_at <= to,
	);
	const first = observations[0],
		last = observations.at(-1);
	const intervalTrips =
		first && last
			? all.filter(
					(t) =>
						t.vehicle_id === "default" &&
						t.started_at >= first.observed_at &&
						t.ended_at <= last.observed_at,
				)
			: [];
	const observedMiles =
		first && last && first.id !== last.id ? last.reading_miles - first.reading_miles : null;
	const intervalRecorded = intervalTrips.reduce((s, t) => s + countedMeters(t), 0) / 1609.344;
	const reconciliation = ownerIRS
		? {
				status: observedMiles === null ? "insufficient observations" : "observed interval only",
				start_observation: first ?? null,
				end_observation: last ?? null,
				observed_miles: observedMiles,
				recorded_interval_miles: intervalRecorded,
				unaccounted_miles: observedMiles === null ? null : observedMiles - intervalRecorded,
				annual_completeness:
					"not established; reconcile missing boundary days and unrecorded travel",
			}
		: "owner-only observations omitted";
	// A business company gets an IRS-rate estimate; a reimbursement company is miles only
	// (MILEAGE_COMPANIES_JSON treatment).
	const dollars = type === "irs" || company?.treatment === "business";
	const warnings = [
		"Draft only; no approval, payment, tax certification or ledger posting.",
		"Vehicle-method eligibility remains unknown. Reconciliation covers actual observation intervals only; no readings or annual completeness fabricated.",
		...(company?.treatment === "reimbursement"
			? [
					`${company.name}: miles only, marked reimbursable, not reimbursable or not marked. No dollar amounts.`,
					"Unresolved, commute, personal, missing purpose/endpoints and uncorrected capture gaps are excluded. Explicit owner reconstructions retain capture quality and reasons.",
				]
			: [
					`${businessNames} amounts are an ${ESTIMATE_LABEL} from the configured rates table (source cited per row), not a tax determination.${type === "irs" ? ` ${reimbursementNames} rows are miles only (reimbursable / not reimbursable / not marked); no dollar amounts.` : ""}`,
					"Years without a configured rate have no estimate (No rate set for YYYY). Unresolved, commute, personal, missing purpose/endpoints and uncorrected capture gaps are not substantiated (eligible: no) and company workpapers leave them out. Explicit owner reconstructions retain capture quality and reasons.",
				]),
	];
	// V3: the agent's guesses (pending, sure enough for a Yes) in this export's scope; left out unless included.
	const companies = companyList(cats);
	const inScope = (entity: string | null) => type === "irs" || entity === type;
	const scoped = companies.filter((co) =>
		inScope(cats.find((x) => x.id === co.id)?.entity_id ?? null),
	);
	const guessList = withGuesses.filter((x) => x.state === "proposal" && inScope(x.as.entity_id));
	const guessCompanies = totalsOf(guessList, scoped, rateRows)
		.companies.filter((co) => co.trips)
		.map((co) => ({
			id: co.id,
			trips: co.trips,
			meters: co.meters,
			...(dollars && co.estimate_usd !== undefined ? { estimate_usd: co.estimate_usd } : {}),
		}));
	const guessMeters = guessList.reduce((n, x) => n + countedMeters(x.trip), 0);
	const mi = (m: number) => (m / 1609.344).toFixed(1);
	if (p.human && guessList.length)
		warnings.push(
			`${includeProposals ? "Includes" : "Leaves out"} the agent's guesses that wait for your yes: ${guessList.length} trip${guessList.length === 1 ? "" : "s"}, ${mi(guessMeters)} mi (${guessCompanies
				.map(
					(co) =>
						`${companies.find((x) => x.id === co.id)?.name ?? co.id} ${mi(co.meters)} mi${co.estimate_usd != null ? `, USD ${co.estimate_usd.toFixed(2)} est.` : ""}`,
				)
				.join("; ")}).`,
		);
	const monthly: Record<
		string,
		{ eligible_meters: number; excluded_meters: number; estimate_usd?: number | null }
	> = {};
	const ratesUsed = new Map<string, Rate>();
	// api-r1-01: a business trip with no rate for its date leaves no whole estimate (null, as the report says).
	const uncovered = new Map<string, { from: string; to: string }>();
	const uncoveredMonths = new Set<string>();
	const detail = trips.map((t) => {
		const date = localDate(t);
		const outcome = outcomes.get(t.id) ?? substantiation(t, projected, Date.now());
		const eligible = outcome.eligible;
		// LATE-START §4: a trip's miles = recorded (or corrected) + the phone's start estimate.
		const miles = countedMeters(t) / 1609.344;
		// Business treatment only, and only when substantiated; never a reimbursement company.
		const rate = t.treatment === "business" ? rateFor(rateRows, date) : null;
		// V3: the same per-trip cents as the report; substantiation is its own column (`eligible`).
		const cents = dollars && t.treatment === "business" ? estimateCents(t, rate) : null;
		const estimate = cents === null ? null : cents / 100;
		if (estimate !== null && rate) ratesUsed.set(rate.effective_from, rate);
		const month = date.slice(0, 7);
		monthly[month] ??= {
			eligible_meters: 0,
			excluded_meters: 0,
			...(dollars ? { estimate_usd: null } : {}),
		};
		monthly[month][eligible ? "eligible_meters" : "excluded_meters"] += countedMeters(t);
		if (estimate !== null)
			monthly[month].estimate_usd = round2((monthly[month].estimate_usd ?? 0) + estimate);
		else if (dollars && t.treatment === "business") {
			const hole = uncoveredOf(date, rateRows);
			uncovered.set(hole.from, hole);
			uncoveredMonths.add(month);
		}
		const locationFields: Partial<
			Pick<
				Trip,
				"origin" | "destination" | "vehicle_id" | "start_lat" | "start_lng" | "end_lat" | "end_lng"
			>
		> = ownerIRS
			? {
					origin: t.origin,
					destination: t.destination,
					vehicle_id: t.vehicle_id,
					start_lat: t.start_lat,
					start_lng: t.start_lng,
					end_lat: t.end_lat,
					end_lng: t.end_lng,
				}
			: p.human
				? { origin: t.origin, destination: t.destination }
				: {};
		return {
			id: t.id,
			date,
			started_at: t.started_at,
			ended_at: t.ended_at,
			timezone: t.timezone,
			...locationFields,
			distance_meters: t.distance_meters,
			measured_distance_meters: t.measured_distance_meters,
			miles: Number(miles.toFixed(6)),
			source: t.source,
			quality: t.quality,
			distance_method: outcome.distance_method,
			capture_warning: outcome.capture_warning,
			purpose: t.purpose,
			category_id: t.category_id,
			category_name: t.category_id ? (names.get(t.category_id) ?? t.category_id) : null,
			entity_id: t.entity_id,
			treatment: t.treatment,
			eligible,
			...(showReimbursable
				? { reimbursable: t.treatment === "reimbursement" ? reimbursableText(t) : "" }
				: {}),
			...(dollars
				? {
						rate_usd_per_mile: estimate !== null && rate ? rate.usd_per_mile : null,
						rate_source: estimate !== null && rate ? rate.source : "",
						estimate_usd: estimate,
						estimate_note:
							t.treatment !== "business"
								? ""
								: rate
									? ESTIMATE_LABEL
									: `No rate set for ${date.slice(0, 4)}`,
					}
				: {}),
			revision: t.revision,
			evidence_ids: t.evidence_ids.join(";"),
			lineage: t.lineage.join(";"),
			correction_reason: t.correction_reason ?? "",
			// V3: filed (by you), auto (by the agent), proposal (a guess you included), ask
			state: countedById.get(t.id)?.state ?? "ask",
			// LATE-START §4: the one new column, last; null (blank in the CSV) when there is no estimate.
			start_estimate_mi: t.start_estimate
				? Number((t.start_estimate.meters / 1609.344).toFixed(6))
				: null,
		};
	});
	for (const month of uncoveredMonths) monthly[month].estimate_usd = null;
	const marked = (mark: string) =>
		trips
			.filter((t) => t.treatment === "reimbursement" && reimbursableText(t) === mark)
			.reduce((s, t) => s + countedMeters(t), 0);
	const totals = {
		recorded_meters: trips.reduce((s, t) => s + countedMeters(t), 0),
		business_meters: trips
			.filter((t) => t.treatment === "business")
			.reduce((s, t) => s + countedMeters(t), 0),
		reimbursement_meters: trips
			.filter((t) => t.treatment === "reimbursement")
			.reduce((s, t) => s + countedMeters(t), 0),
		commute_meters: trips
			.filter((t) => t.treatment === "commute")
			.reduce((s, t) => s + countedMeters(t), 0),
		personal_meters: trips
			.filter((t) => t.treatment === "personal")
			.reduce((s, t) => s + countedMeters(t), 0),
		unresolved_meters: trips
			.filter((t) => t.treatment === "needs_review")
			.reduce((s, t) => s + countedMeters(t), 0),
		...(showReimbursable
			? {
					reimbursable_meters: marked("Yes"),
					not_reimbursable_meters: marked("No"),
					not_marked_meters: marked("Not marked"),
				}
			: {}),
		...(dollars
			? {
					estimate_usd:
						detail.some((r) => r.estimate_usd != null) && !uncovered.size
							? round2(detail.reduce((s, r) => s + (r.estimate_usd ?? 0), 0))
							: null,
					uncovered: [...uncovered.values()].sort((a, b) => (a.from < b.from ? -1 : 1)),
					estimate_label: ESTIMATE_LABEL,
					rates_used: [...ratesUsed.values()].sort((a, b) =>
						a.effective_from < b.effective_from ? -1 : 1,
					),
				}
			: {}),
		unassigned_exclusions_count: ownerIRS ? all.filter((t) => !t.entity_id).length : undefined,
		// V3: the report's company totals over this export's trips (equal to the report's with the guesses in).
		companies: totalsOf(
			trips.map((t) => countedById.get(t.id)).filter((x) => x !== undefined),
			scoped,
			rateRows,
			{
				counted: countTrips(
					trips.map((t) => countedById.get(t.id)?.trip ?? t),
					pending,
					cats,
					rateRows,
					false,
				),
				leftOut: (t) => substantiation(t, projected, Date.now()).left_out,
			},
		).companies,
		parking_tolls: "not recorded",
		odometer_reconciliation: reconciliation,
	};
	const manifest = {
		version: 1,
		vehicle: ownerIRS ? actualVehicle : undefined,
		calendar_versions: projected
			.filter((e) => ownerIRS || p.entities.includes(e.entity_id))
			.map((e) => ({
				calendar_id: e.calendar_id,
				id: e.id,
				version: e.version,
			})),
		owner: p.owner,
		type,
		from,
		to,
		inputs: trips.map((t) => {
			const x = countedById.get(t.id);
			return {
				id: t.id,
				revision: t.revision,
				...(x?.state === "proposal" && x.guess ? { proposal_id: x.guess.id } : {}),
			};
		}),
		proposals: p.human
			? {
					included: includeProposals,
					trips: guessList.length,
					meters: guessMeters,
					companies: guessCompanies,
				}
			: undefined,
		totals,
		monthly,
		exclusions,
		detail,
		history: ownerIRS
			? history
			: history.map((r) => ({
					trip_id: r.trip_id,
					revision: r.revision,
					actor: r.actor,
					operation: r.operation,
				})),
		warnings,
	};
	if (canonical(manifest).length > 4000000)
		throw new MileageError(
			"EXPORT_TOO_LARGE",
			"Export snapshot exceeds 4 MB; narrow the period",
			413,
		);
	const inputHash = await digest(manifest),
		exportId = `mileage-${inputHash}`;
	const metadata = [
		`Export ID: ${exportId}`,
		`Input SHA-256: ${inputHash}`,
		`Type: ${type}; from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`,
		`Totals: ${canonical(totals)}`,
		`Monthly: ${canonical(monthly)}`,
		`Aggregated exclusions: ${canonical(exclusions)}`,
		...warnings,
	];
	let body: Uint8Array | string;
	if (format === "pdf") {
		try {
			const title = !company
				? "IRS Mileage Substantiation Log"
				: company.treatment === "business"
					? `Monthly ${company.name} Mileage Workpaper`
					: `${company.name} Mileage Report (miles only)`;
			const miles = (m: number) => (m / 1609.344).toFixed(3);
			const lines = [
				title,
				`Export ID: ${exportId}`,
				`Input SHA-256: ${inputHash}`,
				`Period (UTC): ${new Date(from).toISOString()} through ${new Date(to).toISOString()} exclusive`,
				"",
				`Recorded miles: ${miles(totals.recorded_meters)}`,
				`Excluded records: ${exclusions.count}; excluded miles: ${miles(exclusions.distance_meters)}`,
				`Business: ${miles(totals.business_meters)} | Reimbursement: ${miles(totals.reimbursement_meters)}`,
				`Commute: ${miles(totals.commute_meters)} | Personal: ${miles(totals.personal_meters)} | Unresolved: ${miles(totals.unresolved_meters)}`,
				...(showReimbursable
					? [
							`${reimbursementNames} reimbursable: ${miles(Number(totals.reimbursable_meters))} | not reimbursable: ${miles(Number(totals.not_reimbursable_meters))} | not marked: ${miles(Number(totals.not_marked_meters))}`,
						]
					: []),
				...(dollars
					? [
							`${businessNames} ${ESTIMATE_LABEL}: ${totals.estimate_usd != null ? `USD ${Number(totals.estimate_usd).toFixed(2)}` : uncovered.size ? `none: no IRS rate set for ${[...uncovered.values()].map((u) => `${u.from} to ${u.to}`).join(", ")}` : "none"}`,
							...(totals.rates_used as Rate[]).map(
								(r) => `Rate from ${r.effective_from}: USD ${r.usd_per_mile}/mile (${r.source})`,
							),
						]
					: []),
				...Object.entries(monthly).map(
					([month, total]) =>
						`${month}: eligible candidate miles ${miles(total.eligible_meters)}; excluded ${miles(total.excluded_meters)}${total.estimate_usd != null ? `; estimate USD ${total.estimate_usd.toFixed(2)}` : ""}`,
				),
				...(ownerIRS
					? [
							`Vehicle: ${actualVehicle.name} (${actualVehicle.id}), revision ${actualVehicle.revision}; method eligibility unknown`,
							...observations.map(
								(r) =>
									`Actual odometer ${new Date(r.observed_at).toISOString()}: ${r.reading_miles.toFixed(1)} miles (${r.kind})`,
							),
							`Observed interval miles: ${observedMiles ?? "unavailable"}; recorded interval miles: ${intervalRecorded.toFixed(3)}`,
							`Unaccounted interval miles: ${observedMiles === null ? "unavailable" : (observedMiles - intervalRecorded).toFixed(3)}; annual completeness not established`,
						]
					: []),
				"",
				...warnings,
				"",
				"TRIP LOG",
				...detail.flatMap((r) => [
					"",
					`Trip ${r.id} | revision ${r.revision} | ${r.date} (${r.timezone})`,
					`Time (UTC): ${new Date(r.started_at).toISOString()} to ${new Date(r.ended_at).toISOString()}`,
					...(p.human ? [`From: ${r.origin}`, `To: ${r.destination}`] : []),
					...(ownerIRS
						? [
								`Summary endpoints: ${r.start_lat ?? "unknown"},${r.start_lng ?? "unknown"} -> ${r.end_lat ?? "unknown"},${r.end_lng ?? "unknown"}`,
								`Vehicle: ${r.vehicle_id}`,
							]
						: []),
					`Measured: ${r.measured_distance_meters} m; recorded/corrected: ${r.distance_meters} m${r.start_estimate_mi !== null ? `; start estimate: ${Math.round(r.start_estimate_mi * 1609.344)} m` : ""} (${r.miles} miles)`,
					`Source: ${r.source} | quality: ${r.quality} | distance method: ${r.distance_method}`,
					...(r.capture_warning ? [`Capture warning: ${r.capture_warning}`] : []),
					`Category: ${r.category_name ?? "Needs review"} | entity: ${r.entity_id ?? "unassigned"} | ${r.treatment}`,
					`Purpose: ${r.purpose || "missing"}`,
					...(r.state === "auto"
						? ["Filed by the agent"]
						: r.state === "filed"
							? ["Filed by you"]
							: r.state === "proposal"
								? ["The agent's guess, included (waiting for your yes)"]
								: []),
					`Eligible candidate: ${r.eligible ? "yes" : "no"}`,
					...(r.reimbursable ? [`Reimbursable: ${r.reimbursable}`] : []),
					...(r.estimate_note
						? [
								r.estimate_usd != null
									? `Estimate (IRS standard mileage rate): USD ${r.estimate_usd.toFixed(2)} at ${r.rate_usd_per_mile}/mile (${r.rate_source})`
									: `Estimate: ${r.estimate_note}`,
							]
						: []),
					`Evidence: ${r.evidence_ids || "none"}`,
					`Lineage: ${r.lineage || "original trip"}`,
					...(r.correction_reason ? [`Correction reason: ${r.correction_reason}`] : []),
				]),
				...(ownerIRS
					? [
							"",
							"REVISION HISTORY",
							...history.flatMap((r) => {
								const t = r.snapshot as Trip;
								return [
									"",
									`Trip ${r.trip_id} revision ${r.revision}: ${r.operation} by ${r.actor}`,
									`Updated ${new Date(t.updated_at).toISOString()} | ${t.deleted_at === null ? "active at revision" : "archived input"}`,
									`From ${t.origin} to ${t.destination}`,
									`Measured ${t.measured_distance_meters} m; recorded ${t.distance_meters} m; ${t.source}/${t.quality}`,
									...(t.start_estimate
										? [
												`Start estimate: ${t.start_estimate.meters} m (${t.start_estimate.method} from trip ${t.start_estimate.from_trip_id})`,
											]
										: []),
									`Category ${t.category_id ?? "unassigned"}; entity ${t.entity_id ?? "unassigned"}; ${t.treatment}; human reviewed ${t.human_reviewed}`,
									`Purpose: ${t.purpose || "missing"}`,
									`Evidence: ${t.evidence_ids.join(";") || "none"}`,
									...(t.correction_reason ? [`Correction: ${t.correction_reason}`] : []),
								];
							}),
						]
					: []),
			];
			body = pdfDocument(lines);
		} catch (error) {
			if (String(error).includes("Unicode"))
				throw new MileageError(
					"UNICODE_PDF_UNSUPPORTED",
					"PDF cannot represent these Unicode names; export UTF-8 CSV without data loss",
					422,
				);
			throw error;
		}
	} else {
		const keys = detail.length
			? Object.keys(detail[0])
			: [
					"id",
					"date",
					"purpose",
					"miles",
					...(showReimbursable ? ["reimbursable"] : []),
					...(dollars ? ["rate_usd_per_mile", "rate_source", "estimate_usd", "estimate_note"] : []),
					"start_estimate_mi",
				];
		body = `${[
			...metadata.map((line) => [csvCell("metadata"), csvCell(line)].join(",")),
			keys.map(csvCell).join(","),
			...detail.map((row) =>
				keys.map((k) => csvCell((row as Record<string, unknown>)[k])).join(","),
			),
			...(ownerIRS ? history : []).map((r) => [csvCell("audit"), csvCell(canonical(r))].join(",")),
		].join("\r\n")}\r\n`;
	}
	await db
		.prepare("INSERT OR IGNORE INTO mileage_exports(owner,id,manifest,created_at) VALUES(?,?,?,?)")
		.bind(p.owner, exportId, JSON.stringify(manifest), Date.now())
		.run();
	return new Response(body, {
		headers: {
			"Content-Type": format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${type}-${exportId.slice(8, 24)}.${format}"`,
			"Cache-Control": "private, no-store",
			"X-Mileage-Export-Id": exportId,
			"X-Mileage-Input-SHA256": inputHash,
		},
	});
}
