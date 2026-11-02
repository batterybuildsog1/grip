import { z } from "zod";
import type { MileagePrincipal } from "./auth";
import { defaultBuiltinCategories } from "./companies";
import { type CalendarEvent, eventSchema, idSchema } from "./policy";
import { type Category, categories, digest } from "./store";

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_ROOT = "https://www.googleapis.com/calendar/v3/calendars/";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const MAX_PROJECTIONS = 500;
const LEASE_MS = 180_000;
const TOTAL_MS = 120_000;
const aliasSchema = eventSchema.shape.calendar_id;
const hasControls = (s: string, spaces = false) =>
	[...s].some((c) => c.charCodeAt(0) <= (spaces ? 32 : 31) || c.charCodeAt(0) === 127);
const boundedText = z
	.string()
	.min(1)
	.max(500)
	.refine((s) => s.trim().length > 0 && s.isWellFormed() && !hasControls(s));
const siteSchema = z
	.object({
		location: boundedText,
		lat: z.number().min(-90).max(90),
		lng: z.number().min(-180).max(180),
		category_id: idSchema,
		confirmed: z.boolean(),
		travel_eligible: z.boolean(),
		commute: z.boolean(),
		travel_basis: z.enum([
			"workplace_to_workplace",
			"confirmed_home_office",
			"ineligible",
			"unknown",
		]),
		facts_reference: boundedText,
	})
	.strict();
const allowSchema = z
	.object({
		calendar_id: aliasSchema,
		google_calendar_id: z
			.string()
			.min(3)
			.max(1024)
			.refine((s) => s.includes("@") && s.isWellFormed() && !hasControls(s, true)),
		account_id: idSchema,
		kind: z.literal("work"),
	})
	.strict();
const sourceSchema = allowSchema
	.extend({
		category_id: idSchema,
		time_min: z.iso.datetime({ offset: true }),
		time_max: z.iso.datetime({ offset: true }),
		site_policy: z.object({ version: idSchema, sites: z.array(siteSchema).max(100) }).strict(),
	})
	.strict()
	.refine((s) => {
		const min = Date.parse(s.time_min),
			max = Date.parse(s.time_max);
		return min >= 0 && max <= 4102444800000 && max > min && max - min <= 366 * 86400000;
	})
	.refine(
		(s) => new Set(s.site_policy.sites.map((p) => p.location)).size === s.site_policy.sites.length,
	);
const secretSchema = z
	.string()
	.min(1)
	.max(8192)
	.refine((s) => !hasControls(s, true));
const credentialsSchema = z
	.object({
		account_id: idSchema,
		purpose: z.literal("mileage-calendar"),
		client_id: secretSchema,
		client_secret: secretSchema,
		refresh_token: secretSchema,
	})
	.strict();

export type GoogleCalendarSitePolicy = z.infer<typeof siteSchema>;
export type GoogleCalendarAllowlistEntry = z.infer<typeof allowSchema>;
export type GoogleCalendarSource = z.infer<typeof sourceSchema>;
export type GoogleCalendarCredentials = z.infer<typeof credentialsSchema>;
export type GoogleCalendarFetch = (
	url: string,
	init: RequestInit & { credentials?: "omit" },
) => Promise<Response>;
export interface GoogleCalendarSyncInput {
	/** Dedicated MILEAGE_D1 only. Principal must come from mileage identify(), never request JSON. */
	db: D1Database;
	principal: MileagePrincipal;
	sources: GoogleCalendarSource[];
	allowlist: GoogleCalendarAllowlistEntry[];
	/** Dedicated Worker secret input; never a mail token or personal-calendar credential. */
	credentials: GoogleCalendarCredentials;
	fetch?: GoogleCalendarFetch;
	/** Can lower the fixed 10-second request ceiling for synthetic tests. */
	requestTimeoutMs?: number;
	/** The configured companies (src/mileage/companies.ts); unset = the default list. */
	builtins?: Category[];
}
export interface GoogleCalendarSourceSummary {
	calendar_id: string;
	pages: number;
	received: number;
	projected: number;
	excluded: number;
	cancelled: number;
	reset: boolean;
	generation: number;
	last_success_at: number;
}
export interface GoogleCalendarSyncSummary {
	sources: GoogleCalendarSourceSummary[];
}
export class GoogleCalendarSyncError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status = 400,
	) {
		super(message);
		this.name = "GoogleCalendarSyncError";
	}
}
function fail(code: string, message: string, status = 400): never {
	throw new GoogleCalendarSyncError(code, message, status);
}
function record(v: unknown): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v))
		fail("INVALID_GOOGLE_RESPONSE", "Invalid Google response", 502);
	return v as Record<string, unknown>;
}
function token(v: unknown): string {
	if (typeof v !== "string" || !v.length || v.length > 4096 || hasControls(v, true))
		fail("INVALID_GOOGLE_RESPONSE", "Invalid Google pagination token", 502);
	return v;
}
function cleanPurpose(v: unknown): string {
	if (typeof v !== "string") return "";
	return [...v.toWellFormed()]
		.filter((s) => s.charCodeAt(0) >= 32 && s.charCodeAt(0) !== 127)
		.slice(0, 250)
		.join("");
}
export interface GoogleCalendarProjectionContext {
	source: GoogleCalendarSource;
	now: number;
	entity_ids: Record<string, string>;
	fingerprint: string;
	previous?: CalendarEvent;
}
/** Pure minimized projection. Does not infer site/travel permission from titles or addresses. */
export async function projectGoogleCalendarEvent(
	value: unknown,
	context: GoogleCalendarProjectionContext,
): Promise<CalendarEvent | null> {
	const e = record(value),
		{ source, now, previous } = context;
	if (typeof e.id !== "string" || !e.id.length || e.id.length > 1024)
		fail("INVALID_GOOGLE_RESPONSE", "Invalid Google event identity", 502);
	// Google instance IDs, not iCalUID/recurringEventId, distinguish recurrence exceptions.
	const id = `g_${await digest({ source: source.calendar_id, id: e.id })}`;
	if (previous && previous.id !== id)
		fail("INVALID_GOOGLE_RESPONSE", "Invalid prior event identity", 502);
	if (!["confirmed", "tentative", "cancelled"].includes(String(e.status)))
		fail("INVALID_GOOGLE_RESPONSE", "Invalid Google event status", 502);
	let data: Omit<CalendarEvent, "version">;
	if (e.status === "cancelled" && previous) {
		const { version: _version, ...old } = previous;
		data = { ...old, status: "cancelled", observed_at: now, travel_eligible: false };
	} else {
		if (e.status === "cancelled" && (!e.start || !e.end)) return null;
		const start = record(e.start),
			end = record(e.end);
		const allDay = typeof start.date === "string" || typeof end.date === "string";
		const parseTime = (v: unknown) => {
			if (
				typeof v !== "string" ||
				!(allDay ? z.iso.date() : z.iso.datetime({ offset: true })).safeParse(v).success
			)
				fail("INVALID_GOOGLE_RESPONSE", "Invalid Google event time", 502);
			const ms = Date.parse(allDay ? `${v}T00:00:00Z` : v);
			if (!Number.isFinite(ms)) fail("INVALID_GOOGLE_RESPONSE", "Invalid Google event time", 502);
			return ms;
		};
		const starts = parseTime(allDay ? start.date : start.dateTime),
			ends = parseTime(allDay ? end.date : end.dateTime);
		if (ends <= starts) fail("INVALID_GOOGLE_RESPONSE", "Invalid Google event interval", 502);
		// Keep the configured window fixed for a sync-token generation. Incremental requests omit
		// Google's incompatible timeMin/timeMax parameters; updates are filtered locally as well.
		if (ends <= Date.parse(source.time_min) || starts >= Date.parse(source.time_max)) return null;
		const site = source.site_policy.sites.find((s) => s.location === e.location);
		const virtual =
			Boolean(e.hangoutLink || e.conferenceData) ||
			(typeof e.location === "string" &&
				/https?:\/\/|\b(?:zoom|virtual|online|remote|teams|google meet)\b/i.test(e.location)) ||
			(typeof e.eventType === "string" && e.eventType !== "default");
		const trusted = Boolean(site?.confirmed);
		const eligible = Boolean(
			trusted &&
				site?.travel_eligible &&
				!site.commute &&
				["workplace_to_workplace", "confirmed_home_office"].includes(site.travel_basis) &&
				e.status === "confirmed" &&
				!virtual &&
				!allDay,
		);
		const category = site?.category_id ?? source.category_id;
		const entity = context.entity_ids[category];
		if (!entity) fail("INVALID_CATEGORY", "Configured site category is unavailable");
		data = {
			id,
			calendar_id: source.calendar_id,
			starts_at: starts,
			ends_at: ends,
			lat: trusted ? (site?.lat ?? null) : null,
			lng: trusted ? (site?.lng ?? null) : null,
			status: e.status as CalendarEvent["status"],
			virtual,
			all_day: allDay,
			observed_at: now,
			site_confirmed: trusted,
			travel_eligible: eligible,
			commute: site?.commute ?? false,
			category_id: category,
			entity_id: entity,
			purpose: cleanPurpose(e.summary),
		};
	}
	const { observed_at: _observed, ...versioned } = data;
	const version = await digest({
		fingerprint: context.fingerprint,
		etag: typeof e.etag === "string" ? e.etag : null,
		data: versioned,
	});
	const { entity_id, ...schemaFields } = { ...data, version };
	const validated = eventSchema.safeParse(schemaFields);
	if (!validated.success)
		fail("INVALID_GOOGLE_RESPONSE", "Google event cannot be safely projected", 502);
	return { ...validated.data, entity_id };
}

interface SyncState {
	fingerprint: string;
	sync_token: string | null;
	generation: number;
	last_success_at: number | null;
}
interface Network {
	fetch: GoogleCalendarFetch;
	deadline: number;
	timeout: number;
}
async function googleJSON(
	network: Network,
	url: string,
	init: RequestInit,
	maxBytes: number,
): Promise<Record<string, unknown>> {
	const remaining = network.deadline - Date.now();
	if (remaining <= 0) fail("GOOGLE_TIMEOUT", "Google sync deadline exceeded", 504);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const task = async (): Promise<Record<string, unknown>> => {
		const response = await network.fetch(url, {
			...init,
			redirect: "error",
			credentials: "omit",
			cache: "no-store",
			signal: controller.signal,
		});
		if (controller.signal.aborted) fail("GOOGLE_TIMEOUT", "Google request timed out", 504);
		if (response.status === 410 && url.startsWith(CALENDAR_ROOT))
			fail("GOOGLE_CURSOR_EXPIRED", "Google cursor expired", 409);
		if (!response.ok)
			fail(
				response.status === 429 ? "GOOGLE_RATE_LIMITED" : "GOOGLE_HTTP_ERROR",
				"Google request failed",
				response.status === 429 ? 429 : 502,
			);
		// An injected fetch may expose redirected responses; never accept them either.
		if (response.redirected || (response.url && response.url !== url))
			fail("GOOGLE_REDIRECT", "Google redirect rejected", 502);
		const length = response.headers.get("content-length");
		if (length && Number(length) > maxBytes)
			fail("GOOGLE_BODY_TOO_LARGE", "Google response exceeds size limit", 502);
		if (!response.body) fail("INVALID_GOOGLE_RESPONSE", "Empty Google response", 502);
		const reader = response.body.getReader();
		bodyReader = reader;
		let size = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes)
					fail("GOOGLE_BODY_TOO_LARGE", "Google response exceeds size limit", 502);
				chunks.push(value);
			}
		} finally {
			void reader.cancel().catch(() => {});
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		try {
			return record(
				JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
			);
		} catch (error) {
			if (error instanceof GoogleCalendarSyncError) throw error;
			return fail("INVALID_GOOGLE_RESPONSE", "Invalid Google JSON", 502);
		}
	};
	try {
		return await Promise.race([
			task(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => {
						controller.abort();
						void bodyReader?.cancel().catch(() => {});
						reject(new GoogleCalendarSyncError("GOOGLE_TIMEOUT", "Google request timed out", 504));
					},
					Math.min(network.timeout, remaining),
				);
			}),
		]);
	} catch (error) {
		if (error instanceof GoogleCalendarSyncError) throw error;
		return fail("GOOGLE_NETWORK_ERROR", "Google network request failed", 502);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
// Browsers/Node support literal error mode. workerd rejects that option synchronously,
// before I/O, so reproduce error semantics using manual mode only for that exact error.
const defaultGoogleFetch: GoogleCalendarFetch = async (url, init) => {
	try {
		return await fetch(url, init);
	} catch (error) {
		if (
			!(error instanceof TypeError) ||
			!error.message.startsWith('Invalid redirect value, must be one of "follow" or "manual"')
		)
			throw error;
		const response = await fetch(url, { ...init, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			void response.body?.cancel().catch(() => {});
			fail("GOOGLE_REDIRECT", "Google redirect rejected", 502);
		}
		return response;
	}
};
async function accessToken(
	network: Network,
	credentials: GoogleCalendarCredentials,
): Promise<string> {
	const result = await googleJSON(
		network,
		OAUTH_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: credentials.client_id,
				client_secret: credentials.client_secret,
				refresh_token: credentials.refresh_token,
			}).toString(),
		},
		16384,
	);
	if (
		result.token_type !== "Bearer" ||
		typeof result.access_token !== "string" ||
		!secretSchema.safeParse(result.access_token).success ||
		typeof result.expires_in !== "number" ||
		result.expires_in < 180 ||
		result.expires_in > 86400 ||
		(result.scope !== undefined &&
			(typeof result.scope !== "string" || result.scope.trim() !== SCOPE))
	)
		fail("INVALID_OAUTH_RESPONSE", "Read-only Calendar OAuth response required", 502);
	return result.access_token;
}

/** Optional manual adapter only: no schedule, account discovery, mail credentials or matching. */
export async function syncGoogleCalendars(
	input: GoogleCalendarSyncInput,
): Promise<GoogleCalendarSyncSummary> {
	if (
		!input.principal?.human ||
		input.principal.tokenId ||
		!input.principal.owner ||
		!input.principal.actor.startsWith("human:")
	)
		fail("OWNER_REQUIRED", "Authenticated mileage owner required", 403);
	const sourcesResult = z.array(sourceSchema).min(1).max(4).safeParse(input.sources);
	const allowResult = z.array(allowSchema).max(20).safeParse(input.allowlist);
	const credentialsResult = credentialsSchema.safeParse(input.credentials);
	if (
		!sourcesResult.success ||
		!allowResult.success ||
		!credentialsResult.success ||
		(input.requestTimeoutMs !== undefined &&
			(!Number.isInteger(input.requestTimeoutMs) ||
				input.requestTimeoutMs < 1 ||
				input.requestTimeoutMs > 10_000))
	)
		fail("INVALID_CONFIG", "Invalid dedicated Calendar configuration");
	const sources = sourcesResult.data,
		credentials = credentialsResult.data;
	if (
		new Set(sources.map((s) => s.calendar_id)).size !== sources.length ||
		new Set(sources.map((s) => s.google_calendar_id)).size !== sources.length
	)
		fail("INVALID_CONFIG", "Calendar aliases and true IDs must be unique");
	for (const source of sources) {
		if (
			source.account_id !== credentials.account_id ||
			!allowResult.data.some(
				(a) =>
					a.calendar_id === source.calendar_id &&
					a.google_calendar_id === source.google_calendar_id &&
					a.account_id === source.account_id,
			)
		)
			fail(
				"CALENDAR_NOT_ALLOWED",
				"Calendar and dedicated account must be explicitly allowlisted",
				403,
			);
	}
	const { db } = input,
		owner = input.principal.owner;
	const cats = await categories(db, owner, input.builtins ?? defaultBuiltinCategories());
	const entityIds: Record<string, string> = Object.create(null);
	for (const cat of cats)
		if (["business", "reimbursement"].includes(cat.treatment)) entityIds[cat.id] = cat.entity_id;
	for (const source of sources)
		for (const category of [
			source.category_id,
			...source.site_policy.sites.map((s) => s.category_id),
		])
			if (!entityIds[category])
				fail("INVALID_CATEGORY", "Calendar policy requires explicit business categories");
	const leaseToken = crypto.randomUUID(),
		now = Date.now();
	let lease: { fence: number } | null;
	try {
		lease = await db
			.prepare(`INSERT INTO mileage_google_lease(owner,fence,lease_token,expires_at) VALUES(?,1,?,?)
   ON CONFLICT(owner) DO UPDATE SET fence=fence+1,lease_token=excluded.lease_token,expires_at=excluded.expires_at
   WHERE expires_at<=? RETURNING fence`)
			.bind(owner, leaseToken, now + LEASE_MS, now)
			.first<{ fence: number }>();
	} catch {
		fail("GOOGLE_SYNC_UNAVAILABLE", "Apply optional Google Calendar migration to mileage D1", 503);
	}
	if (!lease) fail("GOOGLE_SYNC_BUSY", "Another owner Calendar sync is in progress", 409);
	const network: Network = {
		fetch: input.fetch ?? defaultGoogleFetch,
		deadline: now + TOTAL_MS,
		timeout: input.requestTimeoutMs ?? 10_000,
	};
	const summaries: GoogleCalendarSourceSummary[] = [];
	let active: { source: GoogleCalendarSource; fingerprint: string } | undefined;
	try {
		// OAuth is deliberately inside the lease: parallel sync cannot even refresh a token.
		let bearer: string | undefined;
		for (const source of sources) {
			const fingerprint = await digest({
				adapter: 1,
				source,
				client_id: credentials.client_id,
				entity_ids: entityIds,
				query: { singleEvents: true, showDeleted: true, maxResults: 250 },
			});
			active = { source, fingerprint };
			const state = await db
				.prepare(
					"SELECT fingerprint,sync_token,generation,last_success_at FROM mileage_google_sync WHERE owner=? AND calendar_id=?",
				)
				.bind(owner, source.calendar_id)
				.first<SyncState>();
			const snapshot = await db.batch([
				db
					.prepare("SELECT calendar_id,id,data FROM mileage_calendar WHERE owner=? LIMIT 501")
					.bind(owner),
				db
					.prepare(
						"SELECT COALESCE(MAX(seq),0) AS version FROM mileage_admin_audit WHERE owner=? AND operation='calendar_projection'",
					)
					.bind(owner),
			]);
			const rows = snapshot[0].results as { calendar_id: string; id: string; data: string }[];
			if (rows.length > MAX_PROJECTIONS)
				fail("CALENDAR_TOO_LARGE", "Owner projection cap exceeded", 413);
			const auditVersion = Number((snapshot[1].results[0] as { version: number }).version);
			const old = new Map(
				rows
					.filter((r) => r.calendar_id === source.calendar_id)
					.map((r) => [r.id, JSON.parse(r.data) as CalendarEvent]),
			);
			let reset = !state?.sync_token || state.fingerprint !== fingerprint;
			let cursor = reset ? undefined : (state?.sync_token ?? undefined);
			if (!bearer) bearer = await accessToken(network, credentials);
			let pages = 0,
				received = 0,
				nextSync = "";
			let projected = reset ? new Map<string, CalendarEvent>() : new Map(old);
			let retried410 = false;
			const seenPages = new Set<string>(),
				seenIds = new Set<string>();
			for (;;) {
				let pageToken: string | undefined;
				try {
					do {
						if (++pages > 20) fail("GOOGLE_PAGE_LIMIT", "Google page limit exceeded", 413);
						const url = new URL(
							`${CALENDAR_ROOT}${encodeURIComponent(source.google_calendar_id)}/events`,
						);
						url.searchParams.set("singleEvents", "true");
						url.searchParams.set("showDeleted", "true");
						url.searchParams.set("maxResults", "250");
						// Only required event fields, including conference presence for conservative exclusion.
						url.searchParams.set(
							"fields",
							"items(id,etag,status,summary,location,start,end,recurringEventId,originalStartTime,hangoutLink,conferenceData(conferenceId),eventType),nextPageToken,nextSyncToken",
						);
						if (cursor) url.searchParams.set("syncToken", cursor);
						else {
							url.searchParams.set("timeMin", source.time_min);
							url.searchParams.set("timeMax", source.time_max);
						}
						if (pageToken) url.searchParams.set("pageToken", pageToken);
						const page = await googleJSON(
							network,
							url.toString(),
							{
								method: "GET",
								headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
							},
							524288,
						);
						if (page.items !== undefined && !Array.isArray(page.items))
							fail("INVALID_GOOGLE_RESPONSE", "Invalid Google events page", 502);
						const items = (page.items ?? []) as unknown[];
						received += items.length;
						if (items.length > 250 || received > 2000)
							fail("GOOGLE_EVENT_LIMIT", "Google event limit exceeded", 413);
						for (const item of items) {
							const raw = record(item);
							if (typeof raw.id !== "string" || seenIds.has(raw.id))
								fail("INVALID_GOOGLE_RESPONSE", "Invalid or repeated event identity", 502);
							seenIds.add(raw.id);
							const id = `g_${await digest({ source: source.calendar_id, id: raw.id })}`;
							const event = await projectGoogleCalendarEvent(item, {
								source,
								now: Date.now(),
								entity_ids: entityIds,
								fingerprint,
								previous: projected.get(id) ?? old.get(id),
							});
							if (event) projected.set(id, event);
							else projected.delete(id);
						}
						if (page.nextPageToken !== undefined && page.nextSyncToken !== undefined)
							fail("INVALID_GOOGLE_RESPONSE", "Ambiguous Google pagination", 502);
						pageToken = page.nextPageToken === undefined ? undefined : token(page.nextPageToken);
						if (pageToken) {
							if (seenPages.has(pageToken))
								fail("INVALID_GOOGLE_RESPONSE", "Repeated Google page token", 502);
							seenPages.add(pageToken);
						} else nextSync = token(page.nextSyncToken);
					} while (pageToken);
					break;
				} catch (error) {
					if (
						!(error instanceof GoogleCalendarSyncError) ||
						error.code !== "GOOGLE_CURSOR_EXPIRED" ||
						!cursor ||
						retried410
					)
						throw error;
					// Discard all partially downloaded changes. Rebuild this source only, atomically on success.
					retried410 = true;
					reset = true;
					cursor = undefined;
					projected = new Map();
					seenPages.clear();
					seenIds.clear();
				}
			}
			const committedAt = Date.now();
			// A complete incremental traversal verifies unchanged events, refreshing source freshness.
			projected = new Map(
				[...projected]
					.filter(
						([, e]) =>
							e.ends_at > Date.parse(source.time_min) && e.starts_at < Date.parse(source.time_max),
					)
					.map(([id, e]) => [id, { ...e, observed_at: committedAt }]),
			);
			if (rows.length - old.size + projected.size > MAX_PROJECTIONS)
				fail("CALENDAR_TOO_LARGE", "At most 500 owner projections are retained", 413);
			const values = [...projected.values()];
			const summary: GoogleCalendarSourceSummary = {
				calendar_id: source.calendar_id,
				pages,
				received,
				projected: values.length,
				excluded: values.filter((e) => !e.travel_eligible || !e.purpose.trim()).length,
				cancelled: values.filter((e) => e.status === "cancelled").length,
				reset,
				generation: (state?.generation ?? 0) + 1,
				last_success_at: committedAt,
			};
			const guardId = `google:${crypto.randomUUID()}`;
			const statements = [
				db
					.prepare(`INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN
     EXISTS(SELECT 1 FROM mileage_google_lease WHERE owner=? AND fence=? AND lease_token=? AND expires_at>?)
     AND (SELECT COALESCE(MAX(seq),0) FROM mileage_admin_audit WHERE owner=? AND operation='calendar_projection')=?
     THEN 1 ELSE 0 END`)
					.bind(guardId, owner, lease.fence, leaseToken, committedAt, owner, auditVersion),
				db
					.prepare("DELETE FROM mileage_calendar WHERE owner=? AND calendar_id=?")
					.bind(owner, source.calendar_id),
			];
			// One JSON parameter avoids D1's SQL variable limit while inserting up to 500 rows.
			statements.push(
				db
					.prepare(`INSERT INTO mileage_calendar(owner,calendar_id,id,data)
    SELECT ?,?,json_extract(value,'$.id'),value FROM json_each(?)`)
					.bind(owner, source.calendar_id, JSON.stringify(values)),
			);
			statements.push(
				db
					.prepare(
						`INSERT INTO mileage_guard(id,valid) SELECT ?,CASE WHEN (SELECT count(*) FROM mileage_calendar WHERE owner=?)<=500 THEN 1 ELSE 0 END`,
					)
					.bind(`${guardId}:cap`, owner),
				db
					.prepare(`INSERT INTO mileage_google_sync(owner,calendar_id,fingerprint,sync_token,last_success_at,last_attempt_at,status,error_code,generation)
     VALUES(?,?,?,?,?,?,'fresh',NULL,?) ON CONFLICT(owner,calendar_id) DO UPDATE SET fingerprint=excluded.fingerprint,
     sync_token=excluded.sync_token,last_success_at=excluded.last_success_at,last_attempt_at=excluded.last_attempt_at,status='fresh',error_code=NULL,generation=excluded.generation`)
					.bind(
						owner,
						source.calendar_id,
						fingerprint,
						nextSync,
						committedAt,
						now,
						summary.generation,
					),
				db
					.prepare(
						"INSERT INTO mileage_admin_audit(owner,actor,operation,data,created_at) VALUES(?,'calendar:google','calendar_projection',?,?)",
					)
					.bind(owner, JSON.stringify(summary), committedAt),
				db.prepare("DELETE FROM mileage_guard WHERE id IN (?,?)").bind(guardId, `${guardId}:cap`),
			);
			try {
				await db.batch(statements);
			} catch {
				fail("GOOGLE_SYNC_CONFLICT", "Calendar projection or sync lease changed; retry", 409);
			}
			summaries.push(summary);
			active = undefined;
		}
		return { sources: summaries };
	} catch (error) {
		// Failure metadata contains only fixed error codes; preserve cursor/fingerprint/last success.
		if (active) {
			const code = error instanceof GoogleCalendarSyncError ? error.code : "GOOGLE_SYNC_FAILED";
			await db
				.prepare(`INSERT INTO mileage_google_sync(owner,calendar_id,fingerprint,sync_token,last_success_at,last_attempt_at,status,error_code,generation)
    SELECT ?,?,?,NULL,NULL,?,'error',?,0 WHERE EXISTS(SELECT 1 FROM mileage_google_lease WHERE owner=? AND fence=? AND lease_token=? AND expires_at>?)
    ON CONFLICT(owner,calendar_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status='error',error_code=excluded.error_code`)
				.bind(
					owner,
					active.source.calendar_id,
					active.fingerprint,
					Date.now(),
					code,
					owner,
					lease.fence,
					leaseToken,
					Date.now(),
				)
				.run();
		}
		if (error instanceof GoogleCalendarSyncError) throw error;
		fail("GOOGLE_SYNC_FAILED", "Calendar sync failed", 502);
	} finally {
		await db
			.prepare(
				"UPDATE mileage_google_lease SET lease_token=NULL,expires_at=0 WHERE owner=? AND fence=? AND lease_token=?",
			)
			.bind(owner, lease.fence, leaseToken)
			.run();
	}
}
