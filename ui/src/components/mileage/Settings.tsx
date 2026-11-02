/**
 * Mileage settings, a page in the sheet (CLEAN-SPEC "Elsewhere"): the IRS rate periods (from, to,
 * cents per mile, source; Add and Remove), the companies (Add a company), the saved places (rename).
 * Each change saves at once with Undo in the toast, then the report is read again (the Side Co
 * estimate follows). A period is its start date: "to" is the server's (the day before the next one).
 */
import { type Component, createResource, createSignal, For, Show } from "solid-js";
import {
	key,
	type MileagePlace,
	type MileageRatePeriod,
	type MileageReport,
	mileage,
} from "../../api/mileage";
import { isMobile } from "../../store/responsive";
import { dayMonthYear, gapWords, monthShort, periodWords, ratesAbout } from "./format";
import { useMileage } from "./store";

const dollars = (cents: number) => Math.round(cents * 10) / 1000;
const nextDay = (iso: string) =>
	new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** What the company is counted as, in words. */
function companyWords(c: MileageReport["companies"][number]): string {
	if (c.treatment === "personal") return "Miles only";
	if (c.split_reimbursable) return "Reimbursable or not reimbursable; home to the office is not";
	if (c.money === "irs-estimate") return "Miles and an estimate at the IRS rate";
	return "Miles and a purpose; added by you";
}

const Section: Component<{ title: string; about: string; children: unknown }> = (props) => (
	<section
		class="grid gap-6 border-0 border-t border-solid border-rule py-[22px] first-of-type:border-t-0"
		classList={{ "grid-cols-[220px_minmax(0,1fr)]": !isMobile(), "grid-cols-1": isMobile() }}
	>
		<div>
			<h2 class="text-[15px]" style={{ "font-weight": "var(--mc-strong-weight)" }}>
				{props.title}
			</h2>
			<p class="mt-1 text-[13.5px] text-muted">{props.about}</p>
		</div>
		<div class="min-w-0">{props.children as never}</div>
	</section>
);

const Settings: Component<{ onBack: () => void }> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const [places, { refetch }] = createResource(() => mileage.places().then((x) => x.places));
	const [problem, setProblem] = createSignal<string | null>(null);
	const [adding, setAdding] = createSignal<{ from: string; cents: string; source: string } | null>(
		null,
	);
	const [newCompany, setNewCompany] = createSignal<string | null>(null);

	/** The address of a saved place, as the report's trips show it. */
	const addressOf = (p: MileagePlace) => {
		for (const t of r().trips)
			for (const e of [t.start, t.end]) if (e.place_id === p.id && e.address) return e.address;
		return "";
	};

	/** Gaps in each year's periods before its first one, and the next year with none. */
	const holes = () => {
		const out: { from: string; to: string }[] = [];
		const years = [...new Set(r().rates.map((x) => x.from.slice(0, 4)))].sort();
		for (const y of years) {
			const first = r()
				.rates.filter((x) => x.from.startsWith(y))
				.sort((a, b) => (a.from < b.from ? -1 : 1))[0];
			if (first && first.from > `${y}-01-01`) {
				const before = new Date(Date.parse(`${first.from}T00:00:00Z`) - 86_400_000)
					.toISOString()
					.slice(0, 10);
				out.push({ from: `${y}-01-01`, to: before });
			}
		}
		return out;
	};
	const nextYear = () => {
		const last = [...r().rates].sort((a, b) => (a.from < b.from ? -1 : 1)).at(-1);
		return last ? nextDay(last.to) : `${r().month.slice(0, 4)}-01-01`;
	};

	const check = (from: string, cents: number, source: string, self?: string): string | null => {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from)))
			return "Give the period a start date.";
		if (!(cents > 0) || cents >= 1000) return "The rate is in cents per mile, more than 0.";
		if (!source.trim()) return "Say where the rate comes from (the IRS notice or announcement).";
		const clash = r().rates.find((x) => x.from === from && x.from !== self);
		if (clash) return `A period already starts on ${dayMonthYear(from)}. Change that one instead.`;
		return null;
	};

	const put = (from: string, cents: number, source: string) =>
		mileage.putRate(from, {
			tax_year: Number(from.slice(0, 4)),
			usd_per_mile: dollars(cents),
			source: source.trim(),
			idempotency_key: key(),
		});

	/** One period edited: its start moved (a new period, the old one removed), its rate or source. */
	const saveRate = (old: MileageRatePeriod, from: string, cents: number, source: string) => {
		const why = check(from, cents, source, old.from);
		setProblem(why);
		if (why) return;
		if (from === old.from && cents === old.cents_per_mile && source.trim() === old.source) return;
		const moved = from !== old.from;
		void m.change(
			async () => {
				await put(from, cents, source);
				if (moved) await mileage.removeRate(old.from);
			},
			moved ? `Moved the period to ${dayMonthYear(from)}` : "Rate saved",
			async () => {
				if (moved) await mileage.removeRate(from);
				await put(old.from, old.cents_per_mile, old.source);
			},
		);
	};

	return (
		<div
			data-testid="mileage-settings"
			class="mx-auto max-w-[1060px]"
			classList={{ "px-8 pb-12": !isMobile(), "px-4 pb-24": isMobile() }}
		>
			<div class="sticky top-0 z-3 mb-3.5 flex h-14 items-center border-0 border-b border-solid border-rule bg-sheet">
				<button
					type="button"
					data-testid="settings-back"
					aria-keyshortcuts="u"
					class="-ml-1.5 inline-flex items-center rounded-control py-1.5 pl-0.5 pr-3 hover:bg-raised"
					style={{ "font-weight": "var(--mc-strong-weight)" }}
					onClick={() => props.onBack()}
				>
					<span class="mc-chevron" aria-hidden="true" />
					{monthShort(r().month)}
				</button>
			</div>
			<h1 class="mc-title mb-1 mt-2 text-[22px]">Mileage settings</h1>

			<Section title="IRS rates" about={ratesAbout(r().companies)}>
				<Show when={problem()}>
					<p role="alert" class="mb-2 text-[13.5px] text-neg" data-testid="rate-problem">
						{problem()}
					</p>
				</Show>
				<div class="overflow-x-auto">
					<table class="mc-tbl mc-rates" data-testid="rates">
						<thead>
							<tr>
								<th>From</th>
								<th>To</th>
								<th class="num">Cents per mile</th>
								<th>Source</th>
								<th />
							</tr>
						</thead>
						<tbody>
							<For each={r().rates}>
								{(rate) => {
									let from: HTMLInputElement | undefined;
									let cents: HTMLInputElement | undefined;
									let source: HTMLInputElement | undefined;
									const save = () =>
										saveRate(rate, from?.value ?? "", Number(cents?.value), source?.value ?? "");
									return (
										<tr data-testid="rate-row" data-from={rate.from}>
											<td class="w-[140px] !pr-2 align-middle" data-label="From">
												<input
													ref={from}
													class="mc-cell"
													type="date"
													aria-label="From"
													value={rate.from}
													onChange={save}
												/>
											</td>
											<td class="w-[130px] align-middle text-muted" data-label="To">
												{dayMonthYear(rate.to)}
											</td>
											<td class="num w-[110px] !pr-2 align-middle" data-label="Cents per mile">
												<input
													ref={cents}
													class="mc-cell w-[86px] text-right"
													inputmode="decimal"
													aria-label="Cents per mile"
													value={rate.cents_per_mile}
													onChange={save}
												/>
											</td>
											<td class="!pr-2 align-middle" data-label="Source">
												<input
													ref={source}
													class="mc-cell"
													aria-label="Source"
													value={rate.source}
													onChange={save}
												/>
											</td>
											<td class="w-[72px] text-right align-middle">
												<button
													type="button"
													class="mc-link"
													data-testid="rate-remove"
													onClick={() =>
														void m.change(
															() => mileage.removeRate(rate.from),
															`Removed the rate from ${dayMonthYear(rate.from)}`,
															() => put(rate.from, rate.cents_per_mile, rate.source),
														)
													}
												>
													Remove
												</button>
											</td>
										</tr>
									);
								}}
							</For>
							<For each={holes()}>
								{(h) => (
									<tr>
										<td colspan="4" class="text-warn">
											No rate for {periodWords(h)}: {gapWords(r().companies)}
										</td>
										<td class="text-right">
											<button
												type="button"
												class="mc-link"
												onClick={() => setAdding({ from: h.from, cents: "", source: "" })}
											>
												Add this period
											</button>
										</td>
									</tr>
								)}
							</For>
							<Show when={adding()}>
								{(a) => {
									let from: HTMLInputElement | undefined;
									let cents: HTMLInputElement | undefined;
									let source: HTMLInputElement | undefined;
									return (
										<tr data-testid="rate-new">
											<td class="!pr-2 align-middle" data-label="From">
												<input
													ref={from}
													class="mc-cell"
													type="date"
													aria-label="From"
													value={a().from}
												/>
											</td>
											<td class="align-middle text-muted" data-label="To">
												set by the next period
											</td>
											<td class="num !pr-2 align-middle" data-label="Cents per mile">
												<input
													ref={cents}
													class="mc-cell w-[86px] text-right"
													inputmode="decimal"
													aria-label="Cents per mile"
													placeholder="Not set"
												/>
											</td>
											<td class="!pr-2 align-middle" data-label="Source">
												<input
													ref={source}
													class="mc-cell"
													aria-label="Source"
													placeholder="IRS notice or announcement"
												/>
											</td>
											<td class="whitespace-nowrap text-right align-middle">
												<button
													type="button"
													class="mc-link"
													data-testid="rate-add-save"
													onClick={() => {
														const f = from?.value ?? "";
														const c = Number(cents?.value);
														const s = source?.value ?? "";
														const why = check(f, c, s);
														setProblem(why);
														if (why) return;
														setAdding(null);
														void m.change(
															() => put(f, c, s),
															`Added the rate from ${dayMonthYear(f)}`,
															() => mileage.removeRate(f),
														);
													}}
												>
													Save
												</button>
											</td>
										</tr>
									);
								}}
							</Show>
							<tr>
								<td colspan="4" class="text-muted">
									From {dayMonthYear(nextYear())}: not set yet
								</td>
								<td class="text-right">
									<button
										type="button"
										class="mc-link"
										data-testid="rate-add"
										onClick={() => setAdding({ from: nextYear(), cents: "", source: "" })}
									>
										Add a period
									</button>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</Section>

			<Section title="Companies" about="Every trip is one of these.">
				<table class="mc-tbl" data-testid="companies">
					<tbody>
						<For each={r().companies}>
							{(c) => (
								<tr>
									<td class="w-[130px]" style={{ "font-weight": "var(--mc-strong-weight)" }}>
										{c.name}
									</td>
									<td class="text-muted">{companyWords(c)}</td>
								</tr>
							)}
						</For>
					</tbody>
				</table>
				<Show
					when={newCompany() !== null}
					fallback={
						<p class="mt-2.5">
							<button
								type="button"
								class="mc-soft"
								data-testid="company-add"
								onClick={() => setNewCompany("")}
							>
								Add a company
							</button>{" "}
							<span class="ml-1.5 text-muted">
								When you need one, it then shows in every company choice
							</span>
						</p>
					}
				>
					<div class="mt-2.5 flex items-center gap-2">
						<input
							class="mc-field max-w-[260px]"
							data-testid="company-name"
							placeholder="Company name"
							aria-label="New company"
							value={newCompany() ?? ""}
							onInput={(e) => setNewCompany(e.currentTarget.value)}
						/>
						<button
							type="button"
							class="mc-soft"
							data-testid="company-save"
							disabled={!newCompany()?.trim()}
							onClick={() => {
								const name = (newCompany() ?? "").trim();
								if (!name) return;
								setNewCompany(null);
								const slug =
									name
										.toLowerCase()
										.replace(/[^a-z0-9]+/g, "-")
										.replace(/^-|-$/g, "") || "company";
								void m.change(
									() =>
										mileage.addCompany({
											name,
											treatment: "business",
											entity_id: slug,
											idempotency_key: key(),
										}),
									`Added ${name}`,
								);
							}}
						>
							Add
						</button>
						<button type="button" class="mc-quiet" onClick={() => setNewCompany(null)}>
							Cancel
						</button>
					</div>
				</Show>
			</Section>

			<Section
				title="Saved places"
				about="Your name for a place wins over the agent's and Apple's. Naming a place on a trip saves it here."
			>
				<Show when={places.error}>
					<p class="text-muted">
						Couldn't load your places.{" "}
						<button type="button" class="mc-link" onClick={() => void refetch()}>
							Try again
						</button>
					</p>
				</Show>
				<table class="mc-tbl" data-testid="places">
					<tbody>
						<For each={places() ?? []}>
							{(p) => (
								<tr data-testid="place-row" data-place={p.id}>
									<td class="w-[240px] !pr-3 align-middle">
										<input
											class="mc-cell max-w-[220px]"
											style={{ "font-weight": "var(--mc-strong-weight)" }}
											aria-label={`Name for ${addressOf(p) || p.name}`}
											value={p.name}
											onChange={(e) => {
												const name = e.currentTarget.value.trim();
												if (!name || name === p.name) return;
												const old = p.name;
												void m
													.change(
														() => mileage.renamePlace(p.id, { name, idempotency_key: key() }),
														`Renamed to ${name}`,
														() =>
															mileage
																.renamePlace(p.id, { name: old, idempotency_key: key() })
																.then(refetch),
													)
													.then(() => refetch());
											}}
										/>
									</td>
									<td class="text-right text-muted">{addressOf(p)}</td>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</Section>
		</div>
	);
};

export default Settings;
