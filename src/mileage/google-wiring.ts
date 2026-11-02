import { MileageError, type MileagePrincipal } from "./auth";
import { builtinCategories } from "./companies";
import {
	type GoogleCalendarAllowlistEntry,
	type GoogleCalendarCredentials,
	type GoogleCalendarSource,
	GoogleCalendarSyncError,
	syncGoogleCalendars,
} from "./google-calendar";

interface Configuration {
	allowlist: GoogleCalendarAllowlistEntry[];
	sources: GoogleCalendarSource[];
	credentials: GoogleCalendarCredentials;
}
const unavailable = () =>
	new MileageError(
		"MILEAGE_GOOGLE_UNAVAILABLE",
		"Dedicated owner Google Calendar configuration and optional mileage migration are required",
		503,
	);
function ownerValue(raw: string | undefined, owner: string): unknown {
	if (!raw || raw.length > 256000) throw unavailable();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw unavailable();
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, owner))
		throw unavailable();
	return (value as Record<string, unknown>)[owner];
}
/** Server-only owner dictionaries; source/site/credential overrides never come from request JSON. */
export async function googleConfiguration(
	env: CloudflareBindings,
	p: MileagePrincipal,
): Promise<Configuration> {
	if (!p.human || !env.MILEAGE_D1) throw unavailable();
	const allowlist = ownerValue(env.MILEAGE_GOOGLE_CALENDAR_ALLOWLIST_JSON, p.owner),
		sources = ownerValue(env.MILEAGE_GOOGLE_CALENDAR_SOURCES_JSON, p.owner),
		credentials = ownerValue(env.MILEAGE_GOOGLE_CALENDAR_CREDENTIALS_JSON, p.owner);
	if (
		!Array.isArray(allowlist) ||
		allowlist.length < 1 ||
		allowlist.length > 20 ||
		!Array.isArray(sources) ||
		sources.length < 1 ||
		sources.length > 4 ||
		!credentials ||
		typeof credentials !== "object" ||
		Array.isArray(credentials)
	)
		throw unavailable();
	const allowed = (env.MILEAGE_CALENDAR_ALLOWLIST ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const secret = credentials as Record<string, unknown>;
	if (
		secret.purpose !== "mileage-calendar" ||
		!["account_id", "client_id", "client_secret", "refresh_token"].every(
			(k) => typeof secret[k] === "string" && Boolean(secret[k]),
		)
	)
		throw unavailable();
	for (const item of sources) {
		if (
			!item ||
			typeof item !== "object" ||
			!allowed.includes(item.calendar_id) ||
			item.kind !== "work" ||
			item.account_id !== secret.account_id ||
			!item.site_policy ||
			!Array.isArray(item.site_policy.sites) ||
			!allowlist.some(
				(a) =>
					a?.calendar_id === item.calendar_id &&
					a?.google_calendar_id === item.google_calendar_id &&
					a?.account_id === item.account_id &&
					a?.kind === "work",
			)
		)
			throw unavailable();
	}
	try {
		await env.MILEAGE_D1.batch([
			env.MILEAGE_D1.prepare("SELECT calendar_id FROM mileage_google_sync LIMIT 1"),
			env.MILEAGE_D1.prepare("SELECT fence FROM mileage_google_lease LIMIT 1"),
		]);
	} catch {
		throw unavailable();
	}
	return {
		allowlist: allowlist as GoogleCalendarAllowlistEntry[],
		sources: sources as GoogleCalendarSource[],
		credentials: credentials as GoogleCalendarCredentials,
	};
}
export async function runGoogleSync(
	env: CloudflareBindings,
	p: MileagePrincipal,
	configuration: Configuration,
) {
	if (!env.MILEAGE_D1) throw unavailable();
	try {
		return await syncGoogleCalendars({
			db: env.MILEAGE_D1,
			principal: p,
			...configuration,
			builtins: builtinCategories(env),
		});
	} catch (error) {
		if (error instanceof GoogleCalendarSyncError) {
			const allowed = [400, 403, 409, 413, 429, 502, 503, 504];
			const status = allowed.includes(error.status) ? error.status : 502;
			throw new MileageError(error.code, error.message, status as MileageError["status"]);
		}
		throw new MileageError(
			"MILEAGE_GOOGLE_UNAVAILABLE",
			"Google Calendar sync could not complete; capture remains stored",
			503,
		);
	}
}
