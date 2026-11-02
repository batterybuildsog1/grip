/**
 * Mileage V3 "Answer first", cleaned ("Two things", CLEAN-SPEC), in the L3 shell. Browsing: the views
 * column and, in the sheet, the month (its sentence, Report ›, the Needs you card) or Settings. A trip
 * open: the column folds into the rail holding its queue (Needs you, a company, Filed by the agent, a
 * search) and the trip takes the sheet in one column; each answer opens the next. Phone: one region
 * at a time.
 *
 * Keys: y yes · s skip · 1 2 3 file as · Enter file · j k move · u or Esc back · ⌫ delete (5-second
 * Undo); [ and ? are the shell's.
 */
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import "./mileage.css";
import type { MileageTripView } from "../../api/mileage";
import { activatesControl, notAShortcut } from "../../lib/shortcuts";
import { useApp } from "../../store/app";
import { setMileageNeeds } from "../../store/mileage-count";
import { isMobile } from "../../store/responsive";
import { railSlot } from "../Sidebar";
import { totalsOf } from "./claim";
import type { AnswerHandle } from "./Decision";
import { setChange } from "./drafts";
import ExportDialog from "./ExportDialog";
import { monthName, monthShort } from "./format";
import MileageRail, { type Queue, SearchList } from "./MileageRail";
import Report from "./Report";
import Settings from "./Settings";
import { createMileageStore, MileageContext } from "./store";
import TripSheet from "./TripSheet";

const MileageView: Component = () => {
	const [state, actions] = useApp();
	const m = createMileageStore();
	const [answered, setAnswered] = createSignal<ReadonlySet<string>>(new Set());
	/** Needs you as first seen this visit: answered trips keep their place (dimmed) in the rail. */
	const [needsSeen, setNeedsSeen] = createSignal<string[]>([]);
	/** Skipped questions go to the end of the card's order. */
	const [skipped, setSkipped] = createSignal<string[]>([]);
	/** j/k on the month: the question shown in the card. */
	const [cardPick, setCardPick] = createSignal<string | null>(null);
	const [exporting, setExporting] = createSignal(false);
	const [confirming, setConfirming] = createSignal(false);
	let answerHandle: AnswerHandle | null = null;
	let sheet: HTMLDivElement | undefined;

	const nav = () => state.mileage;
	const r = () => m.report();

	createEffect(
		on(
			() => nav().month,
			(month) => void m.load(month),
		),
	);
	createEffect(
		on(
			() => state.freshnessVersion,
			() => void m.reload(),
			{ defer: true },
		),
	);
	// A new month starts the visit over.
	createEffect(
		on(
			() => r()?.month,
			() => {
				setAnswered(new Set<string>());
				setSkipped([]);
				setCardPick(null);
				setNeedsSeen([]);
			},
		),
	);
	createEffect(
		on(
			() => r()?.queue,
			(queue) => {
				if (!queue) return;
				setNeedsSeen((seen) => {
					const out = [...seen];
					for (const id of queue) if (!out.includes(id)) out.push(id);
					return out;
				});
			},
		),
	);

	/** The questions still open, in the server's order. */
	const open = () => m.visible((r()?.queue ?? []).filter((id) => !answered().has(id)));
	/** The card's order: the queue, skipped ones last. */
	const cardOrder = createMemo(() => {
		const ids = open();
		const skip = skipped().filter((id) => ids.includes(id));
		return [...ids.filter((id) => !skip.includes(id)), ...skip];
	});
	const cardId = () => {
		const pick = cardPick();
		return pick && cardOrder().includes(pick) ? pick : (cardOrder()[0] ?? null);
	};
	const cardPosition = () => {
		const id = cardId();
		return id ? { index: open().indexOf(id), count: open().length } : null;
	};

	// ── Search trips: the month's names, addresses and purposes; the results are the rail ──
	const search = () => state.mileageSearch.trim().toLowerCase();
	const matches = createMemo(() => {
		const q = search();
		if (!q) return [];
		return m
			.trips()
			.filter((t) =>
				[t.start.name, t.end.name, t.start.address, t.end.address, t.purpose, t.proposal?.purpose]
					.filter(Boolean)
					.some((s) => (s as string).toLowerCase().includes(q)),
			);
	});
	createEffect(
		on(
			() => [search(), matches().length] as const,
			([q]) => {
				if (!q) {
					if (nav().queue === "search") actions.openTrip(null);
					return;
				}
				const ids = matches().map((t) => t.id);
				if (nav().queue === "search" && nav().trip && ids.includes(nav().trip as string)) return;
				// Phone: the results are a list (SearchList); a tap opens one.
				if (isMobile()) {
					if (nav().trip) actions.openTrip(null);
					return;
				}
				if (ids[0]) actions.openTrip(ids[0], "search");
				else if (nav().queue === "search") actions.openTrip(null);
			},
			{ defer: true },
		),
	);

	const queueIds = (queue: string | null): string[] => {
		if (!r() || !queue) return [];
		if (queue === "needs") return m.visible(needsSeen().length ? needsSeen() : (r()?.queue ?? []));
		if (queue === "spot") return m.visible(r()?.spot_check ?? []);
		if (queue === "search") return matches().map((t) => t.id);
		if (queue.startsWith("company:")) {
			const id = queue.slice("company:".length);
			return m
				.trips()
				.filter((t) => (t.state === "proposal" ? t.proposal?.company_id : t.company_id) === id)
				.map((t) => t.id);
		}
		return [];
	};
	const queues = (): Queue[] => {
		const rep = r();
		if (!rep) return [];
		return [
			{ id: "needs", label: "Needs you", count: `${open().length} left` },
			...rep.companies.map((c) => ({
				id: `company:${c.id}`,
				label: `${c.name} trips`,
				count: String(totalsOf(rep, c.id)?.trips ?? 0),
			})),
			{ id: "spot", label: "Filed by the agent", count: String(rep.totals.agent_filed) },
			...(search()
				? [
						{
							id: "search",
							label: `“${state.mileageSearch.trim()}”`,
							count: String(matches().length),
						},
					]
				: []),
		];
	};

	const openTrip = (id: string, queue: string, change = false) => {
		if (change) setChange(id, true);
		actions.openTrip(id, queue);
		sheet?.scrollTo({ top: 0 });
	};
	const openQueue = (queue: string) => {
		const first = queueIds(queue)[0];
		if (first) openTrip(first, queue);
	};
	// Closing a trip is "go back one step": pop the entry its opening pushed, or just close it.
	const closeTrip = () => {
		// Desktop: the results are the rail, so leaving the trip leaves the search. Phone: back to the list.
		if (nav().queue === "search" && !isMobile()) actions.setMileageSearch("");
		if ((window.history.state as { mc?: string } | null)?.mc === "trip-open") window.history.back();
		else actions.openTrip(null);
	};
	const tripOpen = () => m.trip(nav().trip);
	const railIds = () => queueIds(nav().queue);
	const position = () => {
		const ids = railIds();
		const i = nav().trip ? ids.indexOf(nav().trip as string) : -1;
		return i >= 0 ? { index: i, count: ids.length } : null;
	};
	const hop = (d: number) => {
		const ids = railIds();
		const at = position();
		if (!at) return;
		const next = ids[Math.max(0, Math.min(ids.length - 1, at.index + d))];
		if (next && next !== nav().trip) {
			actions.openTrip(next, nav().queue);
			sheet?.scrollTo({ top: 0 });
		}
	};

	/** After a filing: the next open question in the rail, else back to the month. */
	const filed = (id: string) => {
		setAnswered((prev) => new Set(prev).add(id));
		setCardPick(null);
		if (!nav().trip || nav().queue !== "needs") return;
		const ids = railIds();
		const at = ids.indexOf(id);
		const after = [...ids.slice(at + 1), ...ids.slice(0, Math.max(0, at))];
		const next = after.find((x) => !answered().has(x) && open().includes(x));
		if (next) actions.openTrip(next, "needs");
		else closeTrip();
	};
	const skip = () => {
		const id = nav().trip ?? cardId();
		if (!id) return;
		setSkipped((prev) => [...prev.filter((x) => x !== id), id]);
		setCardPick(null);
		if (nav().trip) hop(1);
	};
	/** Delete with the 5-second hold; the next trip of the queue opens (or the month). */
	const remove = (t: MileageTripView) => {
		const ids = railIds();
		const at = ids.indexOf(t.id);
		const next = ids.slice(at + 1)[0] ?? ids.slice(0, Math.max(0, at)).reverse()[0];
		m.remove(t);
		if (nav().trip === t.id) {
			if (next) actions.openTrip(next, nav().queue);
			else closeTrip();
		}
	};
	const settings = () => {
		actions.openTrip(null);
		actions.setMileagePage("settings");
	};

	// ── Keys ──
	const onKey = (e: KeyboardEvent) => {
		if (notAShortcut(e) || e.defaultPrevented) return;
		if (document.querySelector("[role=alertdialog], [role=dialog], [role=menu]")) return;
		if (nav().page) {
			if (e.key === "u" || e.key === "Escape") {
				e.preventDefault();
				actions.setMileagePage(null);
			}
			return;
		}
		const reading = Boolean(nav().trip);
		const k = e.key;
		if (k === "y") answerHandle?.yes();
		else if (k === "s") skip();
		else if (k === "1" || k === "2" || k === "3") answerHandle?.pick(Number(k));
		else if (k === "Enter") {
			if (activatesControl(e)) return;
			answerHandle?.file();
		} else if (k === "j" || k === "k" || k === "ArrowDown" || k === "ArrowUp") {
			const d = k === "j" || k === "ArrowDown" ? 1 : -1;
			if (reading) hop(d);
			else {
				const ids = cardOrder();
				const at = Math.max(0, ids.indexOf(cardId() ?? ""));
				const next = ids[Math.max(0, Math.min(ids.length - 1, at + d))];
				if (next) setCardPick(next);
			}
		} else if (k === "u" || k === "Escape") {
			if (reading) closeTrip();
			else if (state.mileageSearch) actions.setMileageSearch("");
			else return;
		} else if (k === "Backspace" || k === "Delete") {
			const t = tripOpen();
			if (!reading || !t) return;
			remove(t);
		} else return;
		e.preventDefault();
	};
	onMount(() => document.addEventListener("keydown", onKey));
	onCleanup(() => document.removeEventListener("keydown", onKey));

	createEffect(() => {
		const rep = r();
		if (rep) document.title = `Mileage, ${monthName(rep.month)} - Grip`;
	});
	// The column's "Mileage 6": the questions still open this month.
	createEffect(() => {
		if (r()) setMileageNeeds(open().length);
	});

	return (
		<MileageContext.Provider value={m}>
			<div
				ref={sheet}
				data-testid="mileage"
				data-phone={isMobile() ? "true" : "false"}
				data-month={r()?.month ?? ""}
				class="scroll-contain h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
			>
				<Switch>
					<Match when={!r() && m.loading()}>
						<ReportLoading />
					</Match>
					<Match when={!r() && m.loadError()}>
						<div data-testid="mileage-error" class="px-4 py-14 text-center">
							<p class="font-medium">
								{m.loadError()?.offline
									? "You're offline, so Mileage couldn't load."
									: "Couldn't load Mileage."}
							</p>
							<Show when={m.loadError()?.message}>
								<p class="mt-1.5 text-muted">{m.loadError()?.message}</p>
							</Show>
							<button
								type="button"
								class="mt-4 font-medium text-accent hover:underline"
								onClick={() => void m.load(nav().month)}
							>
								Try again
							</button>
						</div>
					</Match>
					<Match when={nav().trip ? tripOpen() : undefined}>
						{(t) => (
							<TripSheet
								trip={t()}
								position={position()}
								onBack={closeTrip}
								onHop={hop}
								onFiled={filed}
								onSkip={skip}
								onDelete={remove}
								onSettings={settings}
								confirming={confirming()}
								setConfirming={setConfirming}
								handle={(h) => {
									answerHandle = h;
								}}
							/>
						)}
					</Match>
					<Match when={nav().trip && r() && !tripOpen()}>
						<div data-testid="trip-missing" class="px-4 py-14 text-center">
							<p class="font-medium">This trip isn't in {monthName(r()?.month ?? "")}.</p>
							<p class="mt-1.5 text-muted">
								It may have been deleted, or it belongs to another month.
							</p>
							<button
								type="button"
								class="mt-4 font-medium text-accent hover:underline"
								onClick={closeTrip}
							>
								Back to {monthShort(r()?.month ?? "")}
							</button>
						</div>
					</Match>
					<Match when={search() && r() && isMobile() && matches().length > 0}>
						<SearchList
							ids={matches().map((t) => t.id)}
							query={state.mileageSearch.trim()}
							onOpen={(id) => openTrip(id, "search")}
							onClear={() => actions.setMileageSearch("")}
						/>
					</Match>
					<Match when={search() && r()}>
						<div data-testid="search-empty" class="px-8 py-14 text-center">
							<p class="font-medium">
								No trip in {monthName(r()?.month ?? "")} matches “{state.mileageSearch.trim()}”.
							</p>
							<p class="mt-1.5 text-muted">Search looks at place names, addresses and purposes.</p>
							<button
								type="button"
								class="mt-4 font-medium text-accent hover:underline"
								onClick={() => actions.setMileageSearch("")}
							>
								Clear the search
							</button>
						</div>
					</Match>
					<Match when={nav().page === "settings" && r()}>
						<Settings onBack={() => actions.setMileagePage(null)} />
					</Match>
					<Match when={r()}>
						<Show when={m.loadError()}>
							<p class="mx-8 mt-4 flex flex-wrap items-baseline gap-2 rounded-box bg-warn-soft px-3.5 py-2.5">
								<span class="font-medium">
									{m.loadError()?.offline
										? "You're offline, so this may not be up to date."
										: "Couldn't refresh Mileage."}
								</span>
								<button
									type="button"
									class="font-medium text-accent hover:underline"
									onClick={() => void m.reload()}
								>
									Try again
								</button>
							</p>
						</Show>
						<Report
							cardId={cardId()}
							position={cardPosition()}
							onOpenTrip={openTrip}
							onQueue={openQueue}
							onMonth={(month) => actions.setMileageMonth(month)}
							onFiled={filed}
							onSkip={skip}
							onSettings={settings}
							onExport={() => setExporting(true)}
							handle={(h) => {
								answerHandle = h;
							}}
						/>
					</Match>
				</Switch>
			</div>
			<Show when={exporting() && r()}>
				<ExportDialog onClose={() => setExporting(false)} />
			</Show>
			{/* A trip open (desktop): the views column holds its queue as the rail. */}
			<Show when={nav().trip && !isMobile() && r() ? railSlot() : null}>
				{(slot) => (
					<Portal
						mount={slot()}
						ref={(el: HTMLDivElement) => {
							el.style.display = "contents";
						}}
					>
						<MileageRail
							queue={nav().queue ?? "needs"}
							queues={queues()}
							ids={railIds()}
							openId={nav().trip as string}
							answered={answered()}
							onOpen={(id) => {
								actions.openTrip(id, nav().queue);
								sheet?.scrollTo({ top: 0 });
							}}
							onQueue={openQueue}
							onReport={() => {
								actions.setMileageSearch("");
								actions.openTrip(null);
							}}
						/>
					</Portal>
				)}
			</Show>
		</MileageContext.Provider>
	);
};

/** One static loading state: the month's shape, every value a flat bar at its real size. */
const ReportLoading: Component = () => (
	<div
		data-testid="mileage-loading"
		aria-busy="true"
		class="mx-auto w-full"
		classList={{ "max-w-[1192px] px-8": !isMobile(), "px-4": isMobile() }}
	>
		<span class="sr-only">Loading Mileage</span>
		<div class="pb-1 pt-[22px]">
			<span class="mc-skeleton h-[18px] w-[150px]" />
		</div>
		<p class="mc-ans-s flex flex-wrap items-center gap-2 pb-[18px] pt-2 text-muted">
			You can claim <span class="mc-skeleton inline-block h-[26px] w-[110px]" /> and{" "}
			<span class="mc-skeleton inline-block h-[26px] w-[120px]" />
		</p>
		<div class="flex min-h-[42px] items-center gap-3.5 border-0 border-y border-solid border-rule">
			<span style={{ "font-weight": "var(--mc-strong-weight)" }}>Report</span>
			<span class="mc-skeleton w-[420px] max-w-[60%]" />
		</div>
		<div class="mt-5 overflow-hidden rounded-box border border-solid border-border">
			<div class="flex items-center gap-2.5 px-4 py-[11px]">
				<span style={{ "font-weight": "var(--mc-strong-weight)" }}>Needs you</span>
				<span class="mc-skeleton w-[220px]" />
			</div>
			<div class="bg-raised" classList={{ "h-[260px]": !isMobile(), "h-[170px]": isMobile() }} />
			<div class="flex flex-col gap-2.5 px-4 py-3">
				<span class="mc-skeleton w-[180px]" />
				<span class="mc-skeleton w-[420px] max-w-[80%]" />
				<span class="mc-skeleton w-[380px] max-w-[70%]" />
				<span class="mc-skeleton h-[20px] w-[360px] max-w-[70%]" />
			</div>
		</div>
	</div>
);

export default MileageView;
