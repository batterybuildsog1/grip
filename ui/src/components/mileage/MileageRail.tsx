/**
 * The rail while a trip is open (L3: the views column folds into the queue that holds it). Its title is
 * the queue menu (Needs you, each company's trips, Filed by the agent, then the month's report); a row
 * is the place and the time on one line and the question (or how it was filed) under it; the open one
 * is a tab joined to the sheet. Answered rows stay, dimmed, so the queue reads as done.
 */
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js";
import type { MileageReport, MileageTripView } from "../../api/mileage";
import Menu from "../Menu";
import { clock, dayWord, monthName } from "./format";
import { useMileage } from "./store";

export interface Queue {
	id: string;
	label: string;
	count: string;
}

/** A trip's row words, the rail's and the phone search list's: its name, when, and its line (the
 * server's `rail_prompt` in every queue: the question, or "Filed: Acme, reimbursable"). */
export function rowWords(rep: MileageReport, t: MileageTripView, o: { needs: boolean }) {
	const name = o.needs
		? t.end.name_source === "saved" && t.start.name_source !== "saved"
			? `${t.end.name}, from ${t.start.name}`
			: t.end.name
		: `${t.start.name} → ${t.end.name}`;
	const when =
		t.date === rep.today ? clock(t.started_at, rep.timezone) : dayWord(t.date, rep.today);
	return { name, when, line: t.rail_prompt };
}

/** Phone: Search trips' results as a list (the iPhone design); a tap opens the trip, Back returns. */
export const SearchList: Component<{
	ids: string[];
	query: string;
	onOpen: (id: string) => void;
	onClear: () => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	return (
		<section data-testid="search-results" aria-label="Search results" class="px-4 pb-24 pt-3">
			<p class="text-[14px] text-muted">
				{props.ids.length} {props.ids.length === 1 ? "trip" : "trips"} in {monthName(r().month)}{" "}
				{props.ids.length === 1 ? "matches" : "match"} “{props.query}”
			</p>
			<ul class="mt-2 list-none">
				<For each={props.ids}>
					{(id) => (
						<Show when={m.trip(id)}>
							{(t) => {
								const w = () => rowWords(r(), t(), { needs: false });
								return (
									<li>
										<button
											type="button"
											data-testid="search-result"
											data-trip-id={id}
											class="grid min-h-[52px] w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-0 border-t border-solid border-rule py-2.5 text-left"
											onClick={() => props.onOpen(id)}
										>
											<span style={{ "font-weight": "var(--mc-strong-weight)" }}>{w().name}</span>
											<span class="whitespace-nowrap text-[13px] text-faint">{w().when}</span>
											<span class="col-span-2 text-[14px] text-muted">{w().line}</span>
										</button>
									</li>
								);
							}}
						</Show>
					)}
				</For>
			</ul>
			<button type="button" class="mc-link mt-4" onClick={() => props.onClear()}>
				Clear the search
			</button>
		</section>
	);
};

const MileageRail: Component<{
	queue: string;
	queues: Queue[];
	ids: string[];
	openId: string;
	/** Rows answered in this visit (shown dimmed, "Filed: …"). */
	answered: ReadonlySet<string>;
	onOpen: (id: string) => void;
	onQueue: (queue: string) => void;
	onReport: () => void;
}> = (props) => {
	const m = useMileage();
	const [menuOpen, setMenuOpen] = createSignal(false);
	let list: HTMLUListElement | undefined;
	let titleButton: HTMLButtonElement | undefined;
	const r = () => m.report();
	const title = () => props.queues.find((q) => q.id === props.queue)?.label ?? "Trips";
	const count = () => props.queues.find((q) => q.id === props.queue)?.count ?? "";
	const needs = () => props.queue === "needs";

	createEffect(
		on(
			() => props.openId,
			(id) =>
				requestAnimationFrame(() =>
					list
						?.querySelector<HTMLElement>(`[data-rail-id="${CSS.escape(id)}"]`)
						?.scrollIntoView({ block: "nearest" }),
				),
		),
	);

	const words = (t: MileageTripView) => {
		const rep = r();
		return rep ? rowWords(rep, t, { needs: needs() }) : { name: "", when: "", line: "" };
	};
	const name = (t: MileageTripView) => words(t).name;
	const when = (t: MileageTripView) => words(t).when;
	const line = (t: MileageTripView) => words(t).line;

	return (
		<div
			class="mc-rail relative flex min-h-0 flex-1 flex-col"
			data-testid="mileage-rail"
			data-queue={props.queue}
		>
			<div class="mc-rail-head relative flex h-12 flex-none items-center gap-2 pl-1 pr-[34px]">
				<button
					ref={titleButton}
					type="button"
					data-testid="rail-title"
					aria-haspopup="menu"
					aria-expanded={menuOpen()}
					aria-label={`${title()}: switch queue`}
					class="mc-rail-title inline-flex max-w-full items-center rounded-control px-2.5 py-1.5 text-[15px]"
					style={{ "font-weight": "var(--mc-strong-weight)" }}
					onClick={() => setMenuOpen(!menuOpen())}
				>
					<span class="truncate">{title()}</span>
					<span class="mc-caret" aria-hidden="true" />
				</button>
				<span class="text-[13px] text-muted">{count()}</span>
				<Show when={menuOpen()}>
					<Menu
						label="Queues"
						class="left-1 top-[46px]"
						anchor={() => titleButton}
						onClose={() => setMenuOpen(false)}
						sections={[
							{
								items: [
									...props.queues.map((q) => ({ value: q.id, label: q.label, hint: q.count })),
									{
										value: "report",
										label: `${r() ? monthName(r()?.month ?? "") : "The"} report`,
										gapBefore: true,
									},
								],
								value: props.queue,
								onPick: (v) => {
									setMenuOpen(false);
									if (v === "report") props.onReport();
									else props.onQueue(v);
								},
							},
						]}
					/>
				</Show>
			</div>
			<ul
				ref={list}
				class="mc-rail-list flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto"
				aria-label={title()}
			>
				<For each={props.ids}>
					{(id) => {
						const t = () => m.trip(id);
						return (
							<Show when={t()}>
								{(trip) => {
									const on = () => id === props.openId;
									const done = () =>
										needs() &&
										(props.answered.has(id) || trip().state === "filed" || trip().state === "auto");
									return (
										<li class="flex">
											<button
												type="button"
												data-testid="mileage-rail-row"
												data-rail-id={id}
												data-done={done() ? "true" : "false"}
												aria-current={on() ? "true" : undefined}
												class="mc-rail-item grid w-[calc(100%-34px)] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-px pb-2 pl-3.5 pr-3 pt-[7px] text-left text-[13.5px]"
												onClick={() => props.onOpen(id)}
											>
												<span
													class="min-w-0 truncate"
													classList={{ "text-muted": done() }}
													style={{ "font-weight": done() ? undefined : "var(--mc-strong-weight)" }}
												>
													{name(trip())}
												</span>
												<span class="whitespace-nowrap text-[12px] text-faint">{when(trip())}</span>
												<span
													class="col-span-2 min-w-0 truncate text-[12.5px]"
													classList={{
														"text-text": on() && !done(),
														"text-muted": !on() || done(),
													}}
												>
													{line(trip())}
												</span>
											</button>
										</li>
									);
								}}
							</Show>
						);
					}}
				</For>
				<Show when={props.queue === "spot"}>
					<li class="pl-3.5 pr-[46px] pt-4 text-[13px] leading-relaxed text-muted">
						Least sure first. Nothing here needs a yes.
					</li>
				</Show>
			</ul>
		</div>
	);
};

export default MileageRail;
