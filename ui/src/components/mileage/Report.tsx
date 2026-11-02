/**
 * The month (CLEAN-SPEC M1, "Two things"): the title is the month switcher ("October so far ▾") with
 * "Export October" at the right; one sentence answers the month (its claim figures the largest type);
 * "Report ›" holds everything else, closed by default; the Needs you card asks the next question with
 * its street map and files the answer in place. Every figure is the report's.
 */
import { type Component, createSignal, For, Show } from "solid-js";
import type { MileageReport, MileageTripView } from "../../api/mileage";
import { useApp, type ViewId } from "../../store/app";
import { isMobile } from "../../store/responsive";
import Menu from "../Menu";
import { useViewMenuItems } from "../Sidebar";
import { claimOf, nothingWords, reportLine, reportRows } from "./claim";
import { type AnswerHandle, CardAnswer, SaveFailed } from "./Decision";
import { clock, dayMonth, dayWord, mi, miles, monthName, monthShort, shortAddress } from "./format";
import MileageMap from "./MileageMap";
import { useMileage } from "./store";

/** "October so far" (this month), "September" (a past one). */
export const monthTitle = (r: MileageReport) =>
	r.today.startsWith(r.month) ? `${monthShort(r.month)} so far` : monthShort(r.month);

const Report: Component<{
	cardId: string | null;
	position: { index: number; count: number } | null;
	onOpenTrip: (id: string, queue: string, change?: boolean) => void;
	onQueue: (queue: string) => void;
	onMonth: (month: string) => void;
	onFiled: (id: string) => void;
	onSkip: () => void;
	onSettings: () => void;
	onExport: () => void;
	handle: (h: AnswerHandle) => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const phone = () => isMobile();
	return (
		<div
			data-testid="mileage-report"
			data-phone={phone() ? "true" : "false"}
			class="mx-auto w-full"
			classList={{ "max-w-[1192px] px-8 pb-10": !phone(), "px-4 pb-28": phone() }}
		>
			<Head onMonth={props.onMonth} onExport={props.onExport} />
			<Sentence onSettings={props.onSettings} />
			<Show when={r().totals.trips > 0}>
				<ReportDisclosure
					onQueue={props.onQueue}
					onExport={props.onExport}
					onSettings={props.onSettings}
				/>
				<NeedsCard
					trip={m.trip(props.cardId)}
					position={props.position}
					onOpenTrip={props.onOpenTrip}
					onQueue={props.onQueue}
					onFiled={props.onFiled}
					onSkip={props.onSkip}
					handle={props.handle}
				/>
			</Show>
		</div>
	);
};

/** The title row: the month switcher, and Export (lead's add-back 1). Phone: "Mileage ▾" above it. */
const Head: Component<{ onMonth: (m: string) => void; onExport: () => void }> = (props) => {
	const [, actions] = useApp();
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const views = useViewMenuItems();
	const [open, setOpen] = createSignal(false);
	const [viewsOpen, setViewsOpen] = createSignal(false);
	let button: HTMLButtonElement | undefined;
	let viewsButton: HTMLButtonElement | undefined;
	const months = () => [...new Set([...r().months, r().month])].sort().reverse();
	return (
		<div
			data-testid="report-head"
			class="relative"
			classList={{ "pt-[22px] pb-1": !isMobile(), "pt-3": isMobile() }}
		>
			<Show when={isMobile()}>
				<div class="relative">
					<button
						ref={viewsButton}
						type="button"
						data-testid="phone-views"
						aria-haspopup="menu"
						aria-expanded={viewsOpen()}
						class="mc-title inline-flex items-center rounded-control py-1 text-[30px]"
						onClick={() => setViewsOpen(!viewsOpen())}
					>
						Mileage
						<span class="mc-caret" aria-hidden="true" />
					</button>
					<Show when={viewsOpen()}>
						<Menu
							label="Views"
							class="left-0 top-[48px]"
							anchor={() => viewsButton}
							onClose={() => setViewsOpen(false)}
							sections={[
								{
									items: views(),
									value: "mileage",
									onPick: (v) => {
										setViewsOpen(false);
										actions.setView(v as ViewId);
									},
								},
							]}
						/>
					</Show>
				</div>
			</Show>
			<div class="flex items-baseline">
				<h1>
					<button
						ref={button}
						type="button"
						data-testid="month-switch"
						aria-haspopup="menu"
						aria-expanded={open()}
						aria-label={`Month: ${monthTitle(r())}`}
						class="-ml-2 inline-flex items-center rounded-control px-1.5 py-0.5 hover:bg-raised"
						classList={{
							"mc-title text-[22px]": !isMobile(),
							"text-[17px] text-muted": isMobile(),
						}}
						onClick={() => setOpen(!open())}
					>
						{monthTitle(r())}
						<span class="mc-caret" aria-hidden="true" />
					</button>
				</h1>
				<Show when={r().totals.trips > 0}>
					<span class="flex-1" />
					<button
						type="button"
						data-testid="open-export"
						class="mc-quiet"
						onClick={() => props.onExport()}
					>
						{isMobile() ? "Export" : `Export ${monthShort(r().month)}`}
					</button>
				</Show>
			</div>
			<Show when={open()}>
				<Menu
					label="Months"
					class="left-0 top-[52px]"
					anchor={() => button}
					onClose={() => setOpen(false)}
					sections={[
						{
							items: months().map((mo) => ({
								value: mo,
								label: monthName(mo),
								hint: r().today.startsWith(mo) ? "so far" : undefined,
							})),
							value: r().month,
							onPick: (mo) => {
								setOpen(false);
								props.onMonth(mo);
							},
						},
					]}
				/>
			</Show>
		</div>
	);
};

/** "You can claim 42.5 mi from Acme and $29.75 est. for Side Co, including … for your yes." */
const Sentence: Component<{ onSettings: () => void }> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const claim = () => claimOf(r());
	return (
		<section
			data-testid="claim"
			aria-label={`What you can claim in ${monthName(r().month)}`}
			class="pb-[18px]"
			classList={{ "pt-2": !isMobile(), "pt-3": isMobile() }}
		>
			<Show when={claim().kind === "empty"}>
				<p class="mc-ans-s" data-testid="claim-sentence">
					No trips in {monthName(r().month)}.
				</p>
				<Show when={r().recording_started && (r().recording_started as string) > `${r().month}-31`}>
					<p class="mt-px text-[15px] text-muted">
						Recording started {dayMonth(r().recording_started as string)}.
					</p>
				</Show>
			</Show>
			<Show when={claim().kind === "nothing"}>
				<p class="mc-ans-s" data-testid="claim-sentence">
					{nothingWords(r())}
				</p>
			</Show>
			<Show when={claim().kind === "claim"}>
				<p class="mc-ans-s" data-testid="claim-sentence">
					You can claim{" "}
					<For each={claim().parts}>
						{(p, i) => (
							<>
								{i() > 0 ? (i() === claim().parts.length - 1 ? " and " : ", ") : ""}
								<span
									class="mc-ans-v"
									data-money={p.money ? "" : undefined}
									data-figure={p.company}
								>
									{p.value} <span class="mc-unit">{p.unit}</span>
								</span>{" "}
								{p.words}
							</>
						)}
					</For>
					{claim().waiting ? "," : "."}
				</p>
				<Show when={claim().waiting || claim().noRate}>
					<p class="mt-px text-[15px] text-muted" data-testid="claim-waiting">
						{claim().waiting}
						<Show when={claim().noRate}>
							{claim().waiting ? " " : ""}
							<button
								type="button"
								class="mc-link whitespace-normal"
								onClick={() => props.onSettings()}
							>
								Set the IRS rate
							</button>{" "}
							to see the estimate.
						</Show>
					</p>
				</Show>
			</Show>
		</section>
	);
};

/** "Report ›": closed, the figures the sentence leaves out; open, the month by company. Not remembered. */
const ReportDisclosure: Component<{
	onQueue: (queue: string) => void;
	onExport: () => void;
	onSettings: () => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const [open, setOpen] = createSignal(false);
	return (
		<div class="border-0 border-y border-solid border-rule" data-testid="report-disclosure">
			<button
				type="button"
				class="mc-disc"
				data-testid="report-toggle"
				aria-expanded={open()}
				onClick={() => setOpen(!open())}
			>
				<span class="mc-disc-h">
					Report
					<span class="mc-caret" data-closed={open() ? undefined : ""} aria-hidden="true" />
				</span>
				<span class="mc-disc-a" data-testid="report-line">
					{reportLine(r())}
				</span>
			</button>
			<Show when={open()}>
				<div class="pb-4 pt-0.5" data-testid="report-body">
					<Show
						when={!isMobile()}
						fallback={
							<PhoneReport
								onQueue={props.onQueue}
								onExport={props.onExport}
								onSettings={props.onSettings}
							/>
						}
					>
						<table class="mc-tbl max-w-[980px]" data-testid="report-table">
							<thead>
								<tr>
									<th />
									<th class="num w-[96px]">Trips</th>
									<th class="num w-[96px]">Miles</th>
									<th />
								</tr>
							</thead>
							<tbody>
								<For each={reportRows(r())}>
									{(row) => (
										<tr data-kind={row.kind} data-company={row.company ?? undefined}>
											<td class="w-[240px]">
												<Show when={row.company} fallback={row.label}>
													<button
														type="button"
														class="mc-co-link"
														onClick={() => props.onQueue(`company:${row.company}`)}
													>
														{row.label}
													</button>
												</Show>
											</td>
											<td class="num">{row.trips ?? ""}</td>
											<td class="num">{miles(row.meters)}</td>
											<td class="pl-4 text-muted">
												{row.note}
												<Show when={row.setRate}>
													{row.note ? " · " : ""}
													<button type="button" class="mc-link" onClick={() => props.onSettings()}>
														Set the IRS rate
													</button>
												</Show>
											</td>
										</tr>
									)}
								</For>
							</tbody>
						</table>
						<div class="mt-3.5 flex items-center gap-3.5">
							<button type="button" class="mc-soft" onClick={() => props.onExport()}>
								Export {monthShort(r().month)}
							</button>
							<Show when={r().totals.agent_filed > 0}>
								<button
									type="button"
									class="mc-link"
									data-testid="spot-check"
									onClick={() => props.onQueue("spot")}
								>
									Spot-check the {r().totals.agent_filed} trips the agent filed
								</button>
								<span class="-ml-2 text-[13.5px] text-muted">
									least sure first, nothing to approve
								</span>
							</Show>
							<span class="flex-1" />
							<button
								type="button"
								class="mc-link"
								data-testid="open-settings"
								onClick={() => props.onSettings()}
							>
								Settings
							</button>
						</div>
					</Show>
				</div>
			</Show>
		</div>
	);
};

/** One row of the phone's Report: a figure that opens its trips, or a place to go. */
const PhoneItem: Component<{
	name: string;
	figure?: string;
	note: string;
	onClick?: () => void;
	plain?: boolean;
}> = (p) => (
	<button
		type="button"
		disabled={!p.onClick}
		class="grid min-h-[44px] w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-0 border-t border-solid border-rule py-2.5 text-left first:border-t-0"
		onClick={() => p.onClick?.()}
	>
		<span style={{ "font-weight": p.plain ? undefined : "var(--mc-strong-weight)" }}>{p.name}</span>
		<span class="text-right">{p.figure ?? ""}</span>
		<span class="col-span-2 text-[13.5px] text-muted">{p.note}</span>
	</button>
);

/** The Report on a phone: one row per figure (a company opens its trips), the total, then the rest. */
const PhoneReport: Component<{
	onQueue: (queue: string) => void;
	onExport: () => void;
	onSettings: () => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const rows = () => reportRows(r()).filter((x) => x.kind !== "total");
	return (
		<div>
			<For each={rows()}>
				{(row) => (
					<PhoneItem
						name={row.label}
						figure={miles(row.meters)}
						note={`${row.trips ?? "—"} trips${row.note ? ` · ${row.note}` : ""}`}
						onClick={row.company ? () => props.onQueue(`company:${row.company}`) : undefined}
						plain={!row.company}
					/>
				)}
			</For>
			<p class="mx-0.5 my-2 text-[14px] text-muted">
				All {r().totals.trips} trips · {mi(r().totals.all_meters)} mi
			</p>
			<PhoneItem
				name="Spot-check what the agent filed"
				figure={String(r().totals.agent_filed)}
				note="Least sure first. Nothing there needs a yes."
				onClick={() => props.onQueue("spot")}
				plain
			/>
			<PhoneItem
				name={`Export ${monthShort(r().month)}`}
				note="PDF or CSV, without the agent's guesses unless you include them"
				onClick={() => props.onExport()}
				plain
			/>
			<PhoneItem
				name="Settings"
				note="IRS rates, companies, saved places"
				onClick={() => props.onSettings()}
				plain
			/>
		</div>
	);
};

/** The one question: its street map, both ends, the question, the agent's reason, the answers. */
const NeedsCard: Component<{
	trip: MileageTripView | undefined;
	position: { index: number; count: number } | null;
	onOpenTrip: (id: string, queue: string, change?: boolean) => void;
	onQueue: (queue: string) => void;
	onFiled: (id: string) => void;
	onSkip: () => void;
	handle: (h: AnswerHandle) => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const tz = () => r().timezone;
	const left = () => props.position?.count ?? 0;
	return (
		<section
			data-testid="needs-card"
			data-trip-id={props.trip?.id}
			aria-label="Needs you"
			class="mt-5 overflow-hidden rounded-box border border-solid border-border bg-sheet"
		>
			<SaveFailed />
			<Show
				when={props.trip}
				fallback={
					<div
						class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-4 py-[11px]"
						data-testid="needs-done"
					>
						<h2 class="text-[15px]" style={{ "font-weight": "var(--mc-strong-weight)" }}>
							Needs you
						</h2>
						<span>
							{r().today.startsWith(r().month)
								? `Nothing. Every ${monthShort(r().month)} trip is filed.`
								: `Nothing in ${monthName(r().month)}`}
						</span>
						<Show when={r().totals.agent_filed > 0}>
							<button
								type="button"
								class="mc-link ml-auto text-[13.5px]"
								onClick={() => props.onQueue("spot")}
							>
								Spot-check the {r().totals.agent_filed} the agent filed
							</button>
						</Show>
					</div>
				}
			>
				{(t) => (
					<>
						<div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-0 border-b border-solid border-rule px-4 py-[11px]">
							<h2 class="text-[15px]" style={{ "font-weight": "var(--mc-strong-weight)" }}>
								Needs you
							</h2>
							<span data-testid="card-position">
								{(props.position?.index ?? 0) + 1} of {left()}
							</span>
							<Show when={!isMobile()}>
								<span data-testid="card-finding">
									·{" "}
									{r().totals.unassigned.trips > 0
										? `${miles(r().totals.unassigned.meters)} in no total until you answer`
										: "the agent's guesses wait for your yes"}
								</span>
							</Show>
							<button
								type="button"
								class="mc-link ml-auto text-[13.5px]"
								data-testid="go-through"
								onClick={() => props.onOpenTrip(t().id, "needs")}
							>
								{isMobile() ? "See all" : `Go through all ${left()}`}
							</button>
						</div>
						<MileageMap
							trip={t()}
							class={isMobile() ? "h-[170px]" : "h-[260px]"}
							pad={{ top: 40, right: 44, bottom: 22, left: 44 }}
						/>
						<div class="px-4 pb-3.5 pt-3">
							<p class="mb-0.5 text-[13.5px] text-muted">
								{dayWord(t().date, r().today)} · {miles(t().distance_meters)}
							</p>
							<For each={[[t().start, t().started_at] as const, [t().end, t().ended_at] as const]}>
								{([e, at]) => (
									<p class="mt-0.5 grid grid-cols-[70px_minmax(0,1fr)] gap-x-2">
										<span class="text-muted">{clock(at, tz())}</span>
										<span class="min-w-0">
											<b style={{ "font-weight": "var(--mc-strong-weight)" }}>{e.name}</b>
											<Show
												when={e.address}
												fallback={<span class="text-warn"> · fills in on the next sync</span>}
											>
												<Show when={e.name_source !== "address"}>
													<span class="text-muted"> · {shortAddress(e.address)}</span>
												</Show>
											</Show>
										</span>
									</p>
								)}
							</For>
							<h3
								data-testid="card-question"
								class="mt-2 text-[19px] leading-[1.3]"
								style={{
									"font-weight": "var(--mc-strong-weight)",
									"letter-spacing": "var(--mc-title-tracking)",
								}}
							>
								{t().prompt}
							</h3>
							<Show when={t().reason}>
								<p class="mt-[3px] text-[14px] text-muted" data-testid="card-reason">
									{t().reason}
								</p>
							</Show>
							<CardAnswer
								trip={t()}
								onOpen={(change) => props.onOpenTrip(t().id, "needs", change)}
								onFiled={props.onFiled}
								onSkip={props.onSkip}
								handle={props.handle}
							/>
						</div>
					</>
				)}
			</Show>
		</section>
	);
};

export default Report;
