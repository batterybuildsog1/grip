/**
 * One trip in the sheet (CLEAN-SPEC M2, M3): one 760 column. "‹ October" (and "2 of 6 · Prev · Next"
 * when the column is hidden); the day, time and distance; the question as the title; the street map at
 * the endpoint that matters; both ends (time, name · address); the decision; "Details ›" (the gap, or
 * the times and where the name came from; open: Times, Names, The agent, Recording, Set by, Delete
 * trip). Details' open state is kept for the session, across j and k. Phone: one trip per screen.
 */
import { type Component, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { MileageReport, MileageTripView } from "../../api/mileage";
import { useDialogFocus } from "../../lib/dialog";
import { useApp } from "../../store/app";
import { isMobile } from "../../store/responsive";
import { type AnswerHandle, SaveFailed, SheetDecision } from "./Decision";
import {
	agentHow,
	clock,
	dayWord,
	endThatMatters,
	miles,
	monthShort,
	nameSourceWords,
	sourceList,
	weekdayDate,
} from "./format";
import MileageMap from "./MileageMap";
import { useMileage } from "./store";

/** Details open or closed: one setting for the session (CLEAN-SPEC), across j and k. */
const [detailsOpen, setDetailsOpen] = createSignal(false);

const TripSheet: Component<{
	trip: MileageTripView;
	position: { index: number; count: number } | null;
	onBack: () => void;
	onHop: (d: number) => void;
	onFiled: (id: string) => void;
	onSkip: () => void;
	onDelete: (t: MileageTripView) => void;
	onSettings: () => void;
	handle: (h: AnswerHandle) => void;
	/** Ask before deleting (Details' Delete trip); ⌫ deletes with Undo straight away. */
	confirming: boolean;
	setConfirming: (on: boolean) => void;
}> = (props) => {
	const [state] = useApp();
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const tz = () => r().timezone;
	const t = () => props.trip;
	const asking = () => t().state === "ask" || t().state === "proposal";
	/** LATE-START §4: the trip started recording late (or carries the phone's estimated start leg). */
	const lateStart = () => {
		const e = t().start_estimate;
		if (e)
			return `Started recording late. Includes ${miles(e.meters)} estimated from where you parked (Apple Maps).`;
		return t().quality === "delayed_start"
			? "Started recording late. Miles are what was recorded."
			: null;
	};
	const heading = () =>
		asking() && t().prompt ? (t().prompt as string) : `${t().start.name} → ${t().end.name}`;
	const day = () => (t().date === r().today ? "Today" : weekdayDate(t().date));
	/** Where Back goes: the phone's search results when the trip came from them, else the month. */
	const backTo = () =>
		isMobile() && state.mileage.queue === "search" ? "Results" : monthShort(r().month);
	const showPosition = () => (!state.sidebarShown || isMobile() ? props.position : null);

	return (
		<div
			data-testid="trip-sheet"
			data-trip={t().id}
			data-state={t().state}
			class="min-h-full bg-sheet text-[14px] text-text"
			classList={{ "pb-24": isMobile() }}
		>
			<div classList={{ "mx-auto max-w-[824px] px-8 pb-24": !isMobile() }}>
				<div
					data-testid="trip-bar"
					class="sticky top-0 z-10 flex shrink-0 items-center gap-1.5 border-0 border-b border-solid border-rule bg-sheet"
					classList={{ "mb-3.5 h-14": !isMobile(), "h-12 px-2": isMobile() }}
				>
					<button
						type="button"
						data-testid="trip-back"
						aria-keyshortcuts="u"
						aria-label={`Back to ${backTo()}`}
						class="-ml-1.5 inline-flex min-w-0 items-center rounded-control py-1.5 pl-0.5 pr-3 hover:bg-raised"
						style={{ "font-weight": "var(--mc-strong-weight)" }}
						onClick={() => props.onBack()}
					>
						<span class="mc-chevron" aria-hidden="true" />
						<span class="truncate">{backTo()}</span>
					</button>
					<Show when={showPosition()}>
						{(at) => (
							<>
								<span
									data-testid="trip-position"
									class="whitespace-nowrap text-[13px] text-muted"
									classList={{ "ml-2.5": !isMobile(), "mx-auto": isMobile() }}
								>
									{at().index + 1} of {at().count}
								</span>
								<Show
									when={!isMobile()}
									fallback={
										<Show when={asking()}>
											<button
												type="button"
												class="mc-quiet !text-accent"
												onClick={() => props.onSkip()}
											>
												Skip
											</button>
										</Show>
									}
								>
									<button
										type="button"
										class="mc-quiet"
										disabled={at().index <= 0}
										onClick={() => props.onHop(-1)}
									>
										Prev
									</button>
									<button
										type="button"
										class="mc-quiet"
										disabled={at().index >= at().count - 1}
										onClick={() => props.onHop(1)}
									>
										Next
									</button>
								</Show>
							</>
						)}
					</Show>
				</div>

				<Show when={isMobile()}>
					<MileageMap trip={t()} class="h-[224px]" />
				</Show>
				<div classList={{ "px-4 pt-3": isMobile() }}>
					<p class="text-muted" data-testid="trip-meta">
						{day()} · {clock(t().started_at, tz())} · {miles(t().distance_meters)}
					</p>
					<h1
						data-testid="trip-heading"
						class="mc-title mb-1 mt-0.5 leading-[1.2]"
						classList={{ "text-[26px]": !isMobile(), "text-[22px]": isMobile() }}
					>
						{heading()}
					</h1>
					<Show when={t().state === "ask" && t().reason}>
						<p class="max-w-[70ch] text-muted" data-testid="trip-reason">
							{t().reason}
						</p>
					</Show>
					<Show when={!isMobile()}>
						<MileageMap trip={t()} class="mt-3 h-[232px] rounded-box" />
					</Show>

					<div
						data-testid="trip-ends"
						class="mt-3.5 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3.5 gap-y-1"
					>
						<For each={[[t().start, t().started_at] as const, [t().end, t().ended_at] as const]}>
							{([e, at]) => (
								<>
									<span class="pt-px text-muted">{clock(at, tz())}</span>
									<p class="min-w-0">
										<span
											class="text-[15px]"
											classList={{ "text-warn": e.name_source === "coordinates" }}
											style={{ "font-weight": "var(--mc-strong-weight)" }}
										>
											{e.name}
										</span>
										<Show
											when={e.address}
											fallback={<span class="text-muted"> · fills in on the next sync</span>}
										>
											<span class="text-muted"> · {e.address}</span>
										</Show>
									</p>
								</>
							)}
						</For>
					</div>

					<Show when={lateStart()}>
						{(line) => (
							<p
								data-testid="trip-late-start"
								class="mt-3 flex max-w-[70ch] flex-wrap items-baseline gap-x-2.5 text-muted"
							>
								<span>{line()}</span>
								<Show when={t().start_estimate}>
									<button
										type="button"
										data-testid="remove-estimate"
										class="mc-quiet -ml-1 !text-accent"
										disabled={m.busy().has(t().id)}
										onClick={() => void m.removeEstimate(t())}
									>
										Remove estimate
									</button>
								</Show>
							</p>
						)}
					</Show>
					<Show when={m.failure()?.tripId === t().id}>
						<div class="mt-3 overflow-hidden rounded-box border border-solid border-border">
							<SaveFailed />
						</div>
					</Show>
					<SheetDecision
						trip={t()}
						onFiled={props.onFiled}
						onSkip={props.onSkip}
						onSettings={props.onSettings}
						handle={props.handle}
					/>
					<Details trip={t()} onDelete={() => props.setConfirming(true)} />
				</div>
			</div>

			<Show when={props.confirming}>
				<DeleteTrip
					trip={t()}
					when={`${dayWord(t().date, r().today)} ${clock(t().started_at, tz())}`}
					onCancel={() => props.setConfirming(false)}
					onConfirm={() => {
						props.setConfirming(false);
						props.onDelete(t());
					}}
				/>
			</Show>
		</div>
	);
};

/** "Details ›": closed, the one thing worth knowing; open, times, names, the agent, Delete trip. */
const Details: Component<{ trip: MileageTripView; onDelete: () => void }> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const t = () => props.trip;
	const tz = () => r().timezone;
	const gapWords = () => {
		const g = t().gap;
		return g
			? `${Math.max(1, Math.round(g.seconds / 60))} minutes of the drive weren't recorded`
			: "";
	};
	const closed = () =>
		t().gap
			? gapWords()
			: `${clock(t().started_at, tz())} – ${clock(t().ended_at, tz())}, ${t().minutes} min · ${nameSourceWords(endThatMatters(t()))}`;
	const agent = () => {
		const how = agentHow(t());
		if (!how) return "";
		const sources = (t().state === "auto" ? t().auto?.sources : t().proposal?.sources) ?? [];
		const src = sourceList(sources);
		const same =
			t().end.name_source === "agent" && t().end.name_basis?.kind === "calendar"
				? " · it named the place from the same event"
				: "";
		const texts = sources.some((s) => (typeof s === "string" ? s : s.kind) === "texts")
			? " · your texts stay on your Mac; only this reason leaves it"
			: "";
		return src ? `From ${src} · ${how}${same}${texts}` : how;
	};
	const setBy = () => {
		if (t().state !== "filed" && t().state !== "auto") return "";
		const who = t().set_by === "agent" ? "set by the agent" : "set by you";
		const c = m.companyOf(t().company_id);
		return [
			"Company",
			c?.split_reimbursable ? "Reimbursable" : null,
			c && c.treatment !== "personal" ? "Purpose" : null,
		]
			.filter(Boolean)
			.map((f) => `${f} ${who}`)
			.join(" · ");
	};
	const rows = () =>
		[
			[
				"Times",
				`${t().date === r().today ? "Today" : weekdayDate(t().date)} · ${clock(t().started_at, tz())} – ${clock(t().ended_at, tz())} · ${t().minutes} min · ${miles(t().distance_meters)}`,
			],
			[
				"Names",
				`${t().start.name}: ${nameSourceWords(t().start)}\n${t().end.name}: ${nameSourceWords(t().end)}`,
			],
			agent() ? ["The agent", agent()] : null,
			t().gap ? ["Recording", ""] : null,
			setBy() ? ["Set by", setBy()] : null,
		].filter((x): x is [string, string] => !!x);
	return (
		<div
			class="border-0 border-y border-solid border-rule"
			classList={{ "mt-[22px]": !isMobile(), "mt-3.5": isMobile() }}
			data-testid="details"
		>
			<button
				type="button"
				class="mc-disc"
				data-testid="details-toggle"
				aria-expanded={detailsOpen()}
				onClick={() => setDetailsOpen(!detailsOpen())}
			>
				<span class="mc-disc-h">
					Details
					<span class="mc-caret" data-closed={detailsOpen() ? undefined : ""} aria-hidden="true" />
				</span>
				<span class="mc-disc-a" classList={{ "!text-warn": !!t().gap }} data-testid="details-line">
					{closed()}
				</span>
			</button>
			<Show when={detailsOpen()}>
				<div class="pb-3 pt-0.5" data-testid="details-body">
					<For each={rows()}>
						{([label, text]) => (
							<div
								class="grid items-baseline gap-x-3.5 py-[3px]"
								classList={{
									"grid-cols-[104px_minmax(0,1fr)]": !isMobile(),
									"grid-cols-1": isMobile(),
								}}
							>
								<span class="text-muted" classList={{ "text-[13.5px]": isMobile() }}>
									{label}
								</span>
								<span class="whitespace-pre-line">
									<Show when={label === "Recording"} fallback={text}>
										<b class="text-warn" style={{ "font-weight": "var(--mc-strong-weight)" }}>
											{gapWords()}
										</b>{" "}
										({miles(t().gap?.meters ?? 0)}
										{isMobile() ? "" : ", dashed on the whole route"}). The miles follow the roads
										between the parts that were.
									</Show>
								</span>
							</div>
						)}
					</For>
					<div class="mt-2.5 flex flex-wrap items-center gap-2.5">
						<button
							type="button"
							data-testid="trip-delete"
							aria-keyshortcuts="Backspace"
							class="mc-quiet -ml-2 !text-neg"
							onClick={() => props.onDelete()}
						>
							Delete trip
						</button>
						<span class="text-[13px] text-muted">
							Deletes the trip and its full route, with 5 seconds to undo
						</span>
					</div>
				</div>
			</Show>
		</div>
	);
};

/** Names the trip; says what goes and that there are 5 seconds to undo. Cancel has the focus. */
const DeleteTrip: Component<{
	trip: MileageTripView;
	when: string;
	onCancel: () => void;
	onConfirm: () => void;
}> = (props) => {
	let dialog: HTMLDivElement | undefined;
	let cancelButton: HTMLButtonElement | undefined;
	useDialogFocus(() => dialog, { onClose: props.onCancel, initial: () => cancelButton });
	return (
		<Portal>
			<div class="fixed inset-0 z-[110] bg-scrim" aria-hidden="true" />
			<div
				ref={dialog}
				role="alertdialog"
				aria-modal="true"
				aria-label="Delete trip"
				data-testid="delete-dialog"
				class="fixed left-1/2 top-1/2 z-[111] w-[min(460px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-sheet bg-sheet px-6 pb-[22px] pt-5 text-text shadow-float"
			>
				<h2 class="mc-title mb-1 text-[17px]">Delete this trip?</h2>
				<p>
					{props.when}, {props.trip.start.name} → {props.trip.end.name},{" "}
					{miles(props.trip.distance_meters)}.
				</p>
				<p class="mt-3 text-[13.5px] text-muted">
					This deletes the trip and its full GPS route from Grip. You'll have 5 seconds to
					undo.
				</p>
				<div class="mt-[18px] flex justify-end gap-2">
					<button ref={cancelButton} type="button" class="mc-soft" onClick={() => props.onCancel()}>
						Cancel
					</button>
					<button
						type="button"
						data-testid="delete-confirm"
						class="rounded-control bg-neg px-3.5 py-[7px] text-neg-on"
						style={{ "font-weight": "var(--mc-strong-weight)" }}
						onClick={() => props.onConfirm()}
					>
						Delete trip and route
					</button>
				</div>
			</div>
		</Portal>
	);
};

export default TripSheet;
