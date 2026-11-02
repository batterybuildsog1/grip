/**
 * Answering a trip (CLEAN-SPEC): the card's answers on the month (M1) and the decision in the trip
 * view (M2, M3).
 * - An ask: Name it (when the place has no name), Drive back (when there's a return trip), File as
 *   Personal / Acme / Side Co (the report's companies, in its order), Skip. Personal files at
 *   once; Acme asks reimbursable or not; a business company asks a purpose.
 * - A guess: "The agent's guess: Acme, reimbursable · purpose", its reason, Yes, file it /
 *   Change / Skip. Change opens the fields, each marked as the agent's until changed; a changed guess
 *   files only with File.
 * - A filed trip: "Filed by the agent: …" with Change; every change saves at once with Undo.
 * A failed save stays on screen, not counted, with Retry. Keys (MileageView): y, s, 1 2 3, Enter.
 */
import { type Component, For, type JSX, Show } from "solid-js";
import type { MileageCompany, MileageReport, MileageTripView } from "../../api/mileage";
import { isMobile } from "../../store/responsive";
import {
	backOf,
	changedGuess,
	type Draft,
	draftOf,
	dropDraft,
	hasDraft,
	isChanging,
	missing,
	needsPurpose,
	setChange,
	setDraft,
	unnamed,
	type Who,
} from "./drafts";
import { cents, clock, dayWord, filedAs, known, miles, usd, weekdayDate } from "./format";
import { type Answer, useMileage } from "./store";

export interface AnswerHandle {
	yes: () => void;
	pick: (n: number) => void;
	file: () => void;
}

/** The answer a draft files (the drive back and the name with it). */
function answerOf(t: MileageTripView, d: Draft, c: MileageCompany, r: MileageReport): Answer {
	const back = backOf(r, t);
	return {
		company_id: c.id,
		reimbursable: c.split_reimbursable ? (d.reimbursable ?? undefined) : undefined,
		purpose: needsPurpose(c) ? d.purpose.trim() : undefined,
		proposal_id: d.guess && !changedGuess(d) ? t.proposal?.id : undefined,
		withBack: back && d.withBack && t.state === "ask" ? back.id : null,
		name: unnamed(t) && d.name.trim() ? { text: d.name, save: d.saveAsPlace } : null,
	};
}

/** Files the trip from its draft; says what's missing instead when it can't be filed yet. */
export function useFiling(
	trip: () => MileageTripView,
	/** After a filing; `question` says whether the trip was asking (an ask or a guess) before it. */
	onFiled: (id: string, question: boolean) => void,
) {
	const m = useMileage();
	const d = () => draftOf(trip());
	const company = () => m.companyOf(d().company_id);
	const file = async (words?: string) => {
		const r = m.report();
		const c = company();
		if (!r || !c || missing(c, d())) return false;
		// The trip as it is now: once the report is read again the card may already show the next one.
		const t = trip();
		const question = t.state === "ask" || t.state === "proposal";
		const ok = await m.file(t, answerOf(t, d(), c, r), words);
		if (ok) {
			dropDraft(t.id);
			onFiled(t.id, question);
		}
		return ok;
	};
	/** A company picked on an ask: Personal (nothing more to say) files at once. */
	const pick = (id: string) => {
		setDraft(trip(), { company_id: id });
		const c = m.companyOf(id);
		if (c && !missing(c, d()) && trip().state === "ask" && !unnamed(trip())) void file();
	};
	return { d, company, file, pick };
}

const prov = (who: Who | undefined, guess: boolean, purpose = false) =>
	who === "agent"
		? guess
			? purpose
				? "the agent's"
				: "the agent's guess"
			: "set by the agent"
		: "";

/** A labelled row (Company, Acme, Purpose…). */
const Row: Component<{ label: string; children: JSX.Element; compact?: boolean }> = (props) => (
	<div
		class="grid items-center gap-x-3.5"
		classList={{
			"grid-cols-[104px_minmax(0,1fr)] min-h-[38px]": !props.compact && !isMobile(),
			"grid-cols-[88px_minmax(0,1fr)] min-h-[38px]": !!props.compact && !isMobile(),
			"grid-cols-1 gap-y-1.5": isMobile(),
		}}
	>
		<span class="text-muted">{props.label}</span>
		<div class="flex flex-wrap items-center gap-1.5">{props.children}</div>
	</div>
);

const Prov: Component<{ text: string }> = (props) => (
	<Show when={props.text}>
		<span class="ml-1 whitespace-nowrap text-[12.5px] text-muted" data-testid="prov">
			{props.text}
		</span>
	</Show>
);

/** The fields of a draft: Company, Acme's split, the estimate (filed), Purpose. */
/** A trip's estimate: "$6.08 est.", or for an IRS-estimate company with no rate for its date, "no IRS
 * rate set for Thu, Oct 8" and "Set the IRS rate" (never $0.00). Nothing for other companies. */
const TripEstimate: Component<{ trip: MileageTripView; onSettings?: () => void }> = (props) => {
	const m = useMileage();
	return (
		<Show
			when={known(props.trip.estimate_usd)}
			fallback={
				<Show when={m.companyOf(props.trip.company_id)?.money === "irs-estimate"}>
					<span data-testid="trip-no-rate">
						No IRS rate set for {weekdayDate(props.trip.date)}
						<Show when={props.onSettings}>
							{" "}
							<button
								type="button"
								class="mc-link whitespace-normal"
								onClick={() => props.onSettings?.()}
							>
								Set the IRS rate
							</button>
						</Show>
					</span>
				</Show>
			}
		>
			<span data-testid="trip-estimate">{usd(props.trip.estimate_usd ?? 0)} est.</span>
		</Show>
	);
};

const Fields: Component<{
	trip: MileageTripView;
	compact?: boolean;
	/** A filed trip: commit each complete change at once. */
	onCommit?: () => void;
	addCompany?: () => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const d = () => draftOf(props.trip);
	const c = () => m.companyOf(d().company_id);
	const set = (patch: Partial<Draft>) => {
		setDraft(props.trip, patch);
		props.onCommit?.();
	};
	return (
		<div class="mt-3 flex flex-col gap-1.5" data-testid="answer-fields">
			<Row label="Company" compact={props.compact}>
				<For each={r().companies}>
					{(co) => (
						<button
							type="button"
							class="mc-seg"
							data-testid="field-company"
							data-company={co.id}
							aria-pressed={d().company_id === co.id}
							onClick={() => set({ company_id: co.id })}
						>
							{co.name}
						</button>
					)}
				</For>
				<Show when={props.addCompany}>
					<button type="button" class="mc-seg mc-seg-add" onClick={() => props.addCompany?.()}>
						Add a company
					</button>
				</Show>
				<Prov text={prov(d().who.company, d().guess)} />
			</Row>
			<Show when={c()?.split_reimbursable}>
				<Row label={c()?.name ?? ""} compact={props.compact}>
					<button
						type="button"
						class="mc-seg"
						data-testid="field-reimbursable"
						aria-pressed={d().reimbursable === true}
						onClick={() => set({ reimbursable: true })}
					>
						Reimbursable
					</button>
					<button
						type="button"
						class="mc-seg"
						data-testid="field-not-reimbursable"
						aria-pressed={d().reimbursable === false}
						onClick={() => set({ reimbursable: false })}
					>
						Not reimbursable
					</button>
					<Prov text={d().reimbursable !== null ? prov(d().who.reimbursable, d().guess) : ""} />
				</Row>
			</Show>
			<Show
				when={props.onCommit && c()?.money === "irs-estimate" && props.trip.company_id === c()?.id}
			>
				<Row label="Estimate" compact={props.compact}>
					<Show
						when={known(props.trip.estimate_usd)}
						fallback={<TripEstimate trip={props.trip} onSettings={props.addCompany} />}
					>
						<span>
							<b style={{ "font-weight": "var(--mc-strong-weight)" }}>
								{usd(props.trip.estimate_usd ?? 0)} est.
							</b>{" "}
							<span class="text-muted">
								{miles(props.trip.distance_meters)} at the IRS rate for{" "}
								{weekdayDate(props.trip.date)}, {cents(props.trip.cents_per_mile ?? 0)}
							</span>
						</span>
					</Show>
				</Row>
			</Show>
			<Show when={needsPurpose(c())}>
				<Row label="Purpose" compact={props.compact}>
					<input
						data-testid="field-purpose"
						class="mc-field"
						placeholder="What the trip was for (the IRS log needs it)"
						aria-label="Purpose"
						value={d().purpose}
						onInput={(e) => setDraft(props.trip, { purpose: e.currentTarget.value })}
						onChange={() => props.onCommit?.()}
					/>
					<Prov
						text={
							d().who.purpose === "agent" && d().purpose
								? d().guess
									? "the agent's"
									: "suggested by the agent"
								: ""
						}
					/>
				</Row>
			</Show>
		</div>
	);
};

/** Name it and Drive back, on an ask in the trip view. */
const AskRows: Component<{ trip: MileageTripView }> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const d = () => draftOf(props.trip);
	const back = () => (props.trip.state === "ask" ? backOf(r(), props.trip) : undefined);
	return (
		<>
			<Show when={unnamed(props.trip)}>
				<Row label="Name it">
					<input
						data-testid="answer-name"
						class="mc-field max-w-[340px]"
						placeholder="What you call this place"
						aria-label="Name this place"
						value={d().name}
						onInput={(e) => setDraft(props.trip, { name: e.currentTarget.value })}
					/>
					<label class="ml-2.5 inline-flex items-center gap-2">
						<input
							type="checkbox"
							data-testid="answer-save-place"
							checked={d().saveAsPlace}
							onChange={(e) => setDraft(props.trip, { saveAsPlace: e.currentTarget.checked })}
						/>
						Save it as a place
					</label>
				</Row>
			</Show>
			<Show when={back()}>
				{(b) => (
					<Row label="Drive back">
						<label class="inline-flex items-baseline gap-2">
							<input
								type="checkbox"
								data-testid="answer-with-back"
								class="translate-y-[2px]"
								checked={d().withBack}
								onChange={(e) => setDraft(props.trip, { withBack: e.currentTarget.checked })}
							/>
							<span>
								File the drive back the same way: {dayWord(b().date, r().today)}{" "}
								{clock(b().started_at, r().timezone)}, {b().start.name} → {b().end.name},{" "}
								{miles(b().distance_meters)}
							</span>
						</label>
					</Row>
				)}
			</Show>
		</>
	);
};

/** The failed save, on the card or the trip: kept, not counted, retried on its own, Retry now. */
export const SaveFailed: Component = () => {
	const m = useMileage();
	return (
		<Show when={m.failure()}>
			{(f) => (
				<p
					role="alert"
					data-testid="answer-failed"
					class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-0 border-b border-solid bg-warn-soft px-4 py-2.5"
					style={{ "border-color": "color-mix(in srgb, var(--mc-warn) 35%, var(--mc-border))" }}
				>
					<span>
						<b class="text-warn" style={{ "font-weight": "var(--mc-strong-weight)" }}>
							Your answer for {f().place} didn't reach Grip.
						</b>{" "}
						{f().refused
							? f().refused
							: `${f().answered}: kept here, and not in the totals until it saves. It retries on its own.`}
					</span>
					<button
						type="button"
						data-testid="answer-retry"
						class="mc-link"
						onClick={() => void m.retry()}
					>
						Retry now
					</button>
				</p>
			)}
		</Show>
	);
};

/** Skip; on a phone the trip's Skip is at the top right instead (the bar holds the answers). */
const Skip: Component<{ onSkip: () => void; inBar?: boolean }> = (props) => (
	<button
		type="button"
		class="mc-quiet"
		classList={{ hidden: !!props.inBar && isMobile() }}
		data-testid="answer-skip"
		aria-keyshortcuts="s"
		onClick={() => props.onSkip()}
	>
		Skip
	</button>
);

/** "File as  Personal  Acme  Side Co" */
const Picks: Component<{ trip: MileageTripView; onPick: (id: string) => void; big?: boolean }> = (
	props,
) => {
	const m = useMileage();
	return (
		<For each={m.report()?.companies ?? []}>
			{(c, i) => (
				<button
					type="button"
					class="mc-pick"
					classList={{ "mc-pick-big": !!props.big }}
					data-testid="answer-pick"
					data-company={c.id}
					aria-keyshortcuts={String(i() + 1)}
					disabled={m.busy().has(props.trip.id)}
					onClick={() => props.onPick(c.id)}
				>
					{c.name}
				</button>
			)}
		</For>
	);
};

/** The card's answers (M1). Opening the trip is for naming a place or changing a guess. */
export const CardAnswer: Component<{
	trip: MileageTripView;
	onOpen: (change: boolean) => void;
	onFiled: (id: string) => void;
	onSkip: () => void;
	handle: (h: AnswerHandle) => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const f = useFiling(() => props.trip, props.onFiled);
	const guess = () => props.trip.state === "proposal";
	const chosen = () => !guess() && f.d().company_id !== null && hasDraft(props.trip);
	const busy = () => m.busy().has(props.trip.id);
	props.handle({
		yes: () => {
			if (guess()) void f.file();
		},
		pick: (n) => {
			const c = r().companies[n - 1];
			if (!c) return;
			if (unnamed(props.trip)) {
				setDraft(props.trip, { company_id: c.id });
				props.onOpen(false);
			} else if (!guess()) f.pick(c.id);
		},
		file: () => void f.file(),
	});
	return (
		<div data-testid="answer" data-trip={props.trip.id}>
			<Show when={chosen()}>
				<Fields trip={props.trip} compact />
			</Show>
			<div class="mt-3 flex flex-wrap items-center gap-2">
				<Show
					when={guess()}
					fallback={
						<Show
							when={chosen()}
							fallback={
								<Show
									when={!unnamed(props.trip)}
									fallback={
										<>
											<button type="button" class="mc-soft" onClick={() => props.onOpen(false)}>
												Name it and file it
											</button>
											<Skip onSkip={props.onSkip} />
										</>
									}
								>
									<Show when={!isMobile()}>
										<span class="mr-1 text-muted">File as</span>
									</Show>
									<Picks trip={props.trip} onPick={f.pick} big={isMobile()} />
									<Show when={!isMobile()}>
										<Skip onSkip={props.onSkip} />
									</Show>
								</Show>
							}
						>
							<button
								type="button"
								class="mc-primary"
								data-testid="answer-file"
								disabled={busy()}
								onClick={() => void f.file()}
							>
								File it as {f.company()?.name}
							</button>
							<button type="button" class="mc-quiet" onClick={() => dropDraft(props.trip.id)}>
								Back
							</button>
							<Skip onSkip={props.onSkip} />
							<Show when={missing(f.company(), f.d())}>
								{(why) => <span class="text-[13.5px] text-muted">{why()}</span>}
							</Show>
						</Show>
					}
				>
					<button
						type="button"
						class="mc-primary"
						data-testid="answer-yes"
						aria-keyshortcuts="y"
						disabled={busy()}
						onClick={() => void f.file()}
					>
						Yes
					</button>
					<button
						type="button"
						class="mc-soft"
						data-testid="answer-change"
						onClick={() => props.onOpen(true)}
					>
						Change
					</button>
					<Skip onSkip={props.onSkip} />
				</Show>
			</div>
		</div>
	);
};

/** The decision in the trip view (M2, M3; filed trips too). */
export const SheetDecision: Component<{
	trip: MileageTripView;
	onFiled: (id: string) => void;
	onSkip: () => void;
	onSettings: () => void;
	handle: (h: AnswerHandle) => void;
}> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const t = () => props.trip;
	const f = useFiling(t, (id, question) => {
		setChange(id, false);
		if (question) props.onFiled(id);
	});
	const ask = () => t().state === "ask";
	const guess = () => t().state === "proposal";
	const filed = () => t().state === "filed" || t().state === "auto";
	const editing = () => isChanging(t().id) || (guess() && changedGuess(f.d()));
	const busy = () => m.busy().has(t().id);

	/** A filed trip: a complete change saves at once, with Undo in the toast. */
	const commit = () => {
		if (!filed()) return;
		const c = f.company();
		const d = f.d();
		if (!c || missing(c, d)) return;
		const same =
			c.id === t().company_id &&
			(d.reimbursable ?? null) === (t().reimbursable ?? null) &&
			(needsPurpose(c) ? d.purpose.trim() : "") === (needsPurpose(c) ? (t().purpose ?? "") : "");
		if (same) return;
		const words =
			c.id !== t().company_id
				? `Moved to ${filedAs(r(), { company_id: c.id, reimbursable: d.reimbursable })}`
				: d.reimbursable !== t().reimbursable
					? `Marked ${d.reimbursable ? "reimbursable" : "not reimbursable"}`
					: "Purpose saved";
		void f.file(words);
	};

	props.handle({
		yes: () => {
			if (guess() && !changedGuess(f.d())) void f.file();
		},
		pick: (n) => {
			const c = r().companies[n - 1];
			if (!c) return;
			if (ask()) f.pick(c.id);
			else if (editing() || filed()) {
				setChange(t().id, true);
				setDraft(t(), { company_id: c.id });
				commit();
			}
		},
		file: () => {
			if (filed()) commit();
			else void f.file();
		},
	});

	const shown = () =>
		guess()
			? f.d()
			: { company_id: t().company_id, reimbursable: t().reimbursable, purpose: t().purpose ?? "" };
	const who = () =>
		guess()
			? changedGuess(f.d())
				? "The agent's guess, changed by you"
				: "The agent's guess"
			: t().set_by === "agent"
				? "Filed by the agent"
				: "Filed by you";
	const reason = () => t().reason;

	return (
		<section
			data-testid="decision"
			data-kind={ask() ? "ask" : guess() ? "guess" : "filed"}
			aria-label={ask() ? "Your answer" : who()}
			class="mt-3.5 border-0 border-t border-solid border-border pt-3.5"
		>
			<Show when={!ask()}>
				<p data-testid="decision-line" class="text-[17px] leading-[1.4]">
					<span class="text-muted">{who()}:</span>{" "}
					<b style={{ "font-weight": "var(--mc-strong-weight)" }}>{filedAs(r(), shown())}</b>
					<Show when={!guess() && known(t().estimate_usd)}>
						{" "}
						· <TripEstimate trip={t()} />
					</Show>
					<Show when={needsPurpose(m.companyOf(shown().company_id)) && shown().purpose}>
						{" "}
						· {shown().purpose}
					</Show>
				</p>
				<Show when={reason()}>
					<p class="mt-[3px] max-w-[72ch] text-muted">{reason()}</p>
				</Show>
				{/* A filed trip on a date with no IRS rate: said on its own line, with the way to set it. */}
				<Show
					when={
						!guess() &&
						!known(t().estimate_usd) &&
						m.companyOf(t().company_id)?.money === "irs-estimate"
					}
				>
					<p class="mt-[3px] text-muted">
						<TripEstimate trip={t()} onSettings={props.onSettings} />
					</p>
				</Show>
			</Show>

			<Show when={ask()}>
				<div class="flex flex-col gap-1.5">
					<AskRows trip={t()} />
					<Show when={f.d().company_id !== null && hasDraft(t())}>
						<Fields trip={t()} />
					</Show>
				</div>
			</Show>
			<Show when={!ask() && editing()}>
				<Fields
					trip={t()}
					onCommit={filed() ? commit : undefined}
					addCompany={filed() ? props.onSettings : undefined}
				/>
			</Show>

			{/* Phone: the answers ride in a bar at the foot of the screen, under the thumb. */}
			<div
				class="flex flex-wrap items-center gap-2.5"
				classList={{
					"mt-4": !isMobile(),
					"fixed inset-x-0 bottom-0 z-20 border-0 border-t border-solid border-rule bg-sheet px-4 pt-3 [&>*]:flex-1 [&>span]:hidden":
						isMobile(),
				}}
				style={
					isMobile()
						? { "padding-bottom": "calc(12px + env(safe-area-inset-bottom, 0px))" }
						: undefined
				}
				data-testid="decision-act"
			>
				<Show when={ask()}>
					<Show
						when={f.d().company_id !== null && hasDraft(t())}
						fallback={
							<>
								<span class="mr-1 min-w-[104px] text-muted" classList={{ hidden: isMobile() }}>
									File as
								</span>
								<Picks trip={t()} onPick={f.pick} big={isMobile()} />
								<Skip onSkip={props.onSkip} inBar />
							</>
						}
					>
						<button
							type="button"
							class="mc-primary"
							data-testid="answer-file"
							disabled={busy()}
							onClick={() => void f.file()}
						>
							File it as {f.company()?.name}
						</button>
						<button type="button" class="mc-quiet" onClick={() => dropDraft(t().id)}>
							Back
						</button>
						<Skip onSkip={props.onSkip} />
						<Show when={missing(f.company(), f.d())}>
							{(why) => <span class="text-[13.5px] text-muted">{why()}</span>}
						</Show>
					</Show>
				</Show>
				<Show when={guess()}>
					<button
						type="button"
						class="mc-primary"
						classList={{ "order-2": isMobile() }}
						data-testid={changedGuess(f.d()) ? "answer-file" : "answer-yes"}
						aria-keyshortcuts={changedGuess(f.d()) ? undefined : "y"}
						disabled={busy() || (changedGuess(f.d()) && !!missing(f.company(), f.d()))}
						onClick={() => void f.file()}
					>
						{changedGuess(f.d())
							? `File it as ${f.company()?.name ?? ""}`
							: isMobile()
								? "Yes"
								: "Yes, file it"}
					</button>
					<Show when={!editing()}>
						<button
							type="button"
							class="mc-soft"
							data-testid="answer-change"
							onClick={() => setChange(t().id, true)}
						>
							Change
						</button>
					</Show>
					<Skip onSkip={props.onSkip} inBar />
					<Show when={editing() && missing(f.company(), f.d())}>
						{(why) => <span class="text-[13.5px] text-muted">{why()}</span>}
					</Show>
				</Show>
				<Show when={filed()}>
					<Show
						when={editing()}
						fallback={
							<button
								type="button"
								class="mc-soft"
								data-testid="answer-change"
								onClick={() => setChange(t().id, true)}
							>
								Change
							</button>
						}
					>
						<Show
							when={missing(f.company(), f.d())}
							fallback={
								<span class="text-[13.5px] text-muted">
									Saved as you change it, with Undo. Nothing to approve.
								</span>
							}
						>
							{(why) => (
								<>
									<button type="button" class="mc-primary" disabled>
										Move to {f.company()?.name}
									</button>
									<button type="button" class="mc-quiet" onClick={() => dropDraft(t().id)}>
										Cancel
									</button>
									<span class="text-[13.5px] text-muted">{why()}</span>
								</>
							)}
						</Show>
					</Show>
				</Show>
			</div>
		</section>
	);
};
