/**
 * Words for Mileage's figures. Formatting only: every figure is the server's (the report); nothing
 * here adds, rounds into a total or decides a name.
 */
import type { MileageCompany, MileageReport, MileageTripView } from "../../api/mileage";

const METERS_PER_MILE = 1609.344;

/** "42.5" (one decimal, as the report and the export print it). */
export const mi = (meters: number) => (meters / METERS_PER_MILE).toFixed(1);
/** "42.5 mi" */
export const miles = (meters: number) => `${mi(meters)} mi`;
/** "$29.75" */
/** An estimate the server could make (a number); null or absent means "no IRS rate set", never $0. */
export const known = (x: number | null | undefined): x is number => typeof x === "number";

export const usd = (n: number) =>
	new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
/** "76¢/mi" */
export const cents = (c: number) => `${Number.isInteger(c) ? c : c.toFixed(1)}¢/mi`;

// Sentences that name companies come from the report's list (MILEAGE_COMPANIES_JSON plus the
// owner's), so each instance names its own companies. No literals.

/** "A", "A and B", "A, B and C". */
export function nameList(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The companies that show an IRS estimate, and the others with Personal last. */
export function byMoney(companies: MileageCompany[]) {
	const estimating = companies.filter((c) => c.money === "irs-estimate").map((c) => c.name);
	const others = companies.filter((c) => c.money !== "irs-estimate");
	const personal = others.filter((c) => c.treatment === "personal").map((c) => c.name);
	return {
		estimating,
		others: [...others.filter((c) => c.treatment !== "personal").map((c) => c.name), ...personal],
	};
}

/** Settings' IRS rates note: "Side Co trips show an estimate … Acme and Personal never …". */
export function ratesAbout(companies: MileageCompany[]): string {
	const { estimating, others } = byMoney(companies);
	return [
		estimating.length > 0
			? `${nameList(estimating)} trips show an estimate at the rate for each trip's date.`
			: "",
		others.length > 0 ? `${nameList(others)} never show dollars.` : "",
		"Changes apply at once, with Undo.",
	]
		.filter(Boolean)
		.join(" ");
}

/** A rate gap's consequence: "Side Co trips then show \"Set the IRS rate\"". */
export function gapWords(companies: MileageCompany[]): string {
	const { estimating } = byMoney(companies);
	return `${estimating.length > 0 ? `${nameList(estimating)} trips` : "Estimates"} then show "Set the IRS rate"`;
}

/** The 1 2 3 keys: the report's first three companies (Personal first), the ones they file to. */
export function keysWords(companies: MileageCompany[] | null | undefined): string {
	if (!companies?.length) return "File as the first, second or third company";
	return `File as ${companies
		.slice(0, 3)
		.map((c) => c.name)
		.join(", ")}`;
}

const parts = (iso: string) => {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
};
const utc = (opts: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });

/** "October 2026" */
export const monthName = (month: string) =>
	utc({ month: "long", year: "numeric" }).format(parts(`${month}-01`));
/** "October" */
export const monthShort = (month: string) => utc({ month: "long" }).format(parts(`${month}-01`));
/** "Oct 24" */
export const dayMonth = (iso: string) => utc({ month: "short", day: "numeric" }).format(parts(iso));
/** "Sat, Oct 24" */
export const weekdayDate = (iso: string) =>
	utc({ weekday: "short", month: "short", day: "numeric" }).format(parts(iso));

/** "1:05 PM" in the report's timezone. */
export const clock = (ms: number, timezone: string) =>
	new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "2-digit",
		timeZone: timezone,
	}).format(ms);

/** "Today", "Yesterday", "Sat" within the week, else "Oct 12". */
export function dayWord(date: string, today: string): string {
	if (date === today) return "Today";
	const days = Math.round((parts(today).getTime() - parts(date).getTime()) / 86_400_000);
	if (days === 1) return "Yesterday";
	if (days > 1 && days < 7) return utc({ weekday: "short" }).format(parts(date));
	return dayMonth(date);
}

/** "Oct 1 – 26 so far" (this month) or "Oct 1 – 31". */
export function rangeWords(r: MileageReport): string {
	const first = `${r.month}-01`;
	const so = r.today.startsWith(r.month);
	const last = so
		? r.today
		: new Date(Date.UTC(Number(r.month.slice(0, 4)), Number(r.month.slice(5, 7)), 0))
				.toISOString()
				.slice(0, 10);
	return `${dayMonth(first)} – ${Number(last.slice(8, 10))}${so ? " so far" : ""}`;
}

/** "9:30 AM – 9:41 AM" */
export const span = (t: MileageTripView, tz: string) =>
	`${clock(t.started_at, tz)} – ${clock(t.ended_at, tz)}`;

export const companyOf = (r: MileageReport, id: string | null): MileageCompany | undefined =>
	id ? r.companies.find((c) => c.id === id) : undefined;

/** "Acme, reimbursable" / "Side Co" / "not filed". */
export function filedAs(r: MileageReport, t: Pick<MileageTripView, "company_id" | "reimbursable">) {
	const c = companyOf(r, t.company_id);
	if (!c) return "not filed";
	if (!c.split_reimbursable) return c.name;
	if (t.reimbursable === null) return c.name;
	return `${c.name}, ${t.reimbursable ? "reimbursable" : "not reimbursable"}`;
}

/** Where a place's name came from, in words (the trip view's `name_source`). */
export function nameSourceWords(e: MileageTripView["start"]): string {
	switch (e.name_source) {
		case "saved":
			return "your saved place";
		case "trip":
			return "your name for this trip only";
		case "agent": {
			const d = e.name_basis?.detail ?? "";
			if (!d) return "named by the agent";
			if (/^Location of /.test(d)) return `named from ${d.replace(/^Location of /, "")}`;
			return `named by the agent: ${d.charAt(0).toLowerCase()}${d.slice(1)}`;
		}
		case "apple":
			return "name from Apple Maps";
		case "address":
			return "Apple's address; no name yet";
		default:
			return "no address yet: it fills in on the next sync";
	}
}

/**
 * The company, split and purpose a trip shows under: what it's filed as, or the agent's guess while
 * the guess waits for a yes (on-screen totals include guesses, lead ruling L1).
 */
export const shown = (t: MileageTripView) =>
	t.state === "proposal" && t.proposal
		? {
				company_id: t.proposal.company_id,
				reimbursable: t.proposal.reimbursable,
				purpose: t.proposal.purpose,
			}
		: { company_id: t.company_id, reimbursable: t.reimbursable, purpose: t.purpose };

/** "Jul 1, 2026" */
export const dayMonthYear = (iso: string) =>
	utc({ month: "short", day: "numeric", year: "numeric" }).format(parts(iso));
/** "Jul 1 – Dec 31, 2026" */
export const periodWords = (p: { from: string; to: string }) =>
	`${dayMonth(p.from)} – ${dayMonthYear(p.to)}`;

/** The card's short address: the street and town, without the state and ZIP. */
export const shortAddress = (a: string | null) =>
	(a ?? "").replace(/, [A-Z]{2} \d{5}(-\d{4})?$/, "");

const SOURCE_WORDS: Record<string, string> = {
	calendar: "your calendar",
	texts: "your texts",
	past_trips: "earlier trips",
	place: "a saved place",
	apple_poi: "Apple Maps",
};
/** "your calendar and earlier trips" */
export function sourceList(sources: (string | { kind: string })[] | undefined): string {
	const words = (sources ?? [])
		.map((s) => (typeof s === "string" ? s : s.kind))
		.map((k) => SOURCE_WORDS[k] ?? k.replace(/_/g, " "));
	return words.length > 1
		? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
		: (words[0] ?? "");
}

/** How sure the agent was, in words, by what it did. */
export function agentHow(t: MileageTripView): string {
	if (t.state === "auto") return "sure, so it filed the trip without asking";
	if (t.state === "proposal") return "fairly sure, so it asks you before filing";
	if (t.state === "ask") return "it couldn't tell, so it asks you";
	return "";
}

/** The end whose name matters (the decision's), as the kit frames the map. */
export const endThatMatters = (t: MileageTripView) =>
	t.end.name_source === "saved" && t.start.name_source !== "saved" ? t.start : t.end;
