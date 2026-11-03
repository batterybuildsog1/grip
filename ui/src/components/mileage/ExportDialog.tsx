/**
 * Export the month (CLEAN-SPEC: a dialog): the period, the figures the file will hold (the report's
 * `confirmed` figures, without the agent's guesses, by default; the report's own with them), what's
 * left out and why, "Include the agent's guesses", PDF or CSV. The owner's whole-month log (type irs)
 * over the report's from/to; the file downloads. A trip `confirmed` leaves out (say, recording started
 * late) is still a row in that log, marked not substantiated; the dialog says so.
 */
import { type Component, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { ApiHttpError } from "../../api/client";
import { type MileageLeftOut, type MileageReport, mileage } from "../../api/mileage";
import { useDialogFocus } from "../../lib/dialog";
import { reportOrder, totalsOf } from "./claim";
import { cents, dayMonthYear, known, miles, monthName, rangeWords, usd } from "./format";
import { useMileage } from "./store";

/** The server's left-out reasons in words (the same words as the Apple export sheet). */
const REASON: Record<string, string> = {
	recording_gap: "part of the drive wasn't recorded",
	no_endpoints: "no start or end recorded",
	unconfirmed: "not confirmed yet",
};
const reasonWords = (x: MileageLeftOut) => REASON[x.reason] ?? x.reason.replaceAll("_", " ");

interface Row {
	label: string;
	trips: number | null;
	meters: number;
	estimate: number | null;
	/** An IRS-estimate company whose estimate the server couldn't make (a date with no rate). */
	noRate?: boolean;
	apart?: boolean;
}

const ExportDialog: Component<{ onClose: () => void }> = (props) => {
	const m = useMileage();
	const r = () => m.report() as MileageReport;
	const [guesses, setGuesses] = createSignal(false);
	const [format, setFormat] = createSignal<"pdf" | "csv">("pdf");
	const [busy, setBusy] = createSignal(false);
	const [failed, setFailed] = createSignal<string | null>(null);
	let dialog: HTMLDivElement | undefined;
	let first: HTMLInputElement | undefined;
	useDialogFocus(() => dialog, { onClose: props.onClose });

	const proposed = () => r().totals.proposed;
	/** The figures the file holds: the report's `confirmed` by default, its own with the guesses. */
	const shownOf = (k: NonNullable<ReturnType<typeof totalsOf>>) =>
		guesses() || !k.confirmed ? k : k.confirmed;
	const rows = (): Row[] => {
		const out: Row[] = [];
		for (const c of reportOrder(r())) {
			const k = totalsOf(r(), c.id);
			if (!k) continue;
			const f = shownOf(k);
			if (c.split_reimbursable) {
				out.push({
					label: `${c.name}, reimbursable`,
					trips: f.reimbursable_trips ?? null,
					meters: f.reimbursable_meters ?? 0,
					estimate: null,
				});
				out.push({
					label: `${c.name}, not reimbursable`,
					trips: f.not_reimbursable_trips ?? null,
					meters: f.not_reimbursable_meters ?? 0,
					estimate: null,
				});
			} else
				out.push({
					label: c.name,
					trips: f.trips,
					meters: f.meters,
					estimate: c.money === "irs-estimate" && known(f.estimate_usd) ? f.estimate_usd : null,
					noRate: c.money === "irs-estimate" && f.trips > 0 && !known(f.estimate_usd),
				});
		}
		if (!guesses() && proposed().trips > 0)
			out.push({
				label: "Waiting for your yes",
				trips: proposed().trips,
				meters: proposed().meters,
				estimate: null,
				apart: true,
			});
		if (r().totals.unassigned.trips > 0)
			out.push({
				label: "Not answered yet",
				trips: r().totals.unassigned.trips,
				meters: r().totals.unassigned.meters,
				estimate: null,
				apart: true,
			});
		return out;
	};

	/** "Acme: 1 trip left out: part of the drive wasn't recorded", from `confirmed.left_out` (box off only:
	 * with the guesses in, the figures are the report's own, which count those trips). */
	const leftOut = () =>
		guesses()
			? []
			: reportOrder(r()).flatMap((c) =>
					(totalsOf(r(), c.id)?.confirmed?.left_out ?? [])
						.filter((x) => x.trips > 0)
						.map(
							(x) =>
								`${c.name}: ${x.trips} trip${x.trips === 1 ? "" : "s"} left out: ${reasonWords(x)}`,
						),
				);

	/** The rate, what waits for a yes, what's listed apart: the file's own warning lines, in words. */
	const note = () => {
		const out: string[] = [];
		for (const c of r().companies) {
			const k = totalsOf(r(), c.id);
			if (!k || c.money !== "irs-estimate" || shownOf(k).trips === 0) continue;
			const used = k.rates_used ?? [];
			out.push(
				known(shownOf(k).estimate_usd)
					? `The ${c.name} estimate is at the IRS rate for each trip's date (${used.map((x) => `${cents(x.cents_per_mile)} from ${dayMonthYear(x.from)}, ${x.source}`).join("; ")}).`
					: `Some ${c.name} trips have no IRS rate for their date, so there's no ${c.name} estimate: set the IRS rate in Settings.`,
			);
		}
		if (proposed().trips > 0) {
			const parts = r()
				.companies.map((c) => ({ c, k: totalsOf(r(), c.id) }))
				.filter((x) => x.k && x.k.proposed_meters > 0)
				.map(
					(x) =>
						`${x.c.name} ${miles(x.k?.proposed_meters ?? 0)}${known(x.k?.proposed_estimate_usd) ? `, ${usd(x.k.proposed_estimate_usd)} est.` : ""}`,
				)
				.join("; ");
			out.push(
				guesses()
					? `It includes ${proposed().trips} trips, ${miles(proposed().meters)}, that wait for your yes (${parts}).`
					: `${proposed().trips} trips, ${miles(proposed().meters)}, wait for your yes and aren't in this export (${parts}).`,
			);
		}
		if (r().totals.unassigned.trips > 0)
			out.push(
				`The ${r().totals.unassigned.trips} trips you haven't answered (${miles(r().totals.unassigned.meters)}) are listed apart, in no company.`,
			);
		return out.join(" ");
	};

	const go = async () => {
		setBusy(true);
		setFailed(null);
		try {
			const q = new URLSearchParams({
				type: "irs",
				format: format(),
				from: String(r().from),
				to: String(r().to),
				include_proposals: guesses() ? "1" : "0",
			});
			const res = await mileage.exportFile(q);
			const blob = await res.blob();
			const name =
				/filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
				`mileage-${r().month}.${format()}`;
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			props.onClose();
		} catch (e) {
			setFailed(
				`The export didn't download${e instanceof ApiHttpError ? `: ${e.message}` : ". Check the connection and try again"}.`,
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Portal>
			<div
				class="fixed inset-0 z-[110] bg-scrim"
				aria-hidden="true"
				onClick={() => props.onClose()}
			/>
			<div
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-label={`Export ${monthName(r().month)}`}
				data-testid="export-dialog"
				class="fixed left-1/2 top-1/2 z-[111] max-h-[calc(100%-48px)] w-[min(600px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-sheet bg-sheet px-6 pb-[22px] pt-5 text-text shadow-float"
			>
				<h2 class="mc-title mb-1 text-[17px]">Export {monthName(r().month)}</h2>
				<p class="mb-3.5 text-muted">
					{rangeWords(r())} · {r().totals.trips} trips
				</p>
				<table class="mc-tbl" data-testid="export-rows">
					<thead>
						<tr>
							<th />
							<th class="num">Trips</th>
							<th class="num">Miles</th>
							<th class="num !pr-0">Estimate</th>
						</tr>
					</thead>
					<tbody>
						<For each={rows()}>
							{(row) => (
								<tr data-kind={row.apart ? "apart" : undefined}>
									<td>{row.label}</td>
									<td class="num">{row.trips ?? ""}</td>
									<td class="num">{miles(row.meters)}</td>
									<td class="num !pr-0">
										{row.estimate !== null ? (
											`${usd(row.estimate)} est.`
										) : row.noRate ? (
											<span class="text-muted">no IRS rate set</span>
										) : (
											<span class="text-faint">—</span>
										)}
									</td>
								</tr>
							)}
						</For>
						<tr data-kind="total">
							<td>All trips</td>
							<td class="num">{r().totals.trips}</td>
							<td class="num">{miles(r().totals.all_meters)}</td>
							<td />
						</tr>
					</tbody>
				</table>
				<Show when={leftOut().length > 0}>
					<div class="mt-3 text-[13.5px]" data-testid="export-left-out">
						<For each={leftOut()}>{(line) => <p>{line}</p>}</For>
						<p class="text-muted">The log still lists them, marked not substantiated.</p>
					</div>
				</Show>
				<p class="mt-3 text-[13.5px] text-muted" data-testid="export-note">
					{note()}
				</p>
				<Show when={proposed().trips > 0}>
					<label class="mt-2.5 inline-flex items-center gap-2">
						<input
							ref={first}
							type="checkbox"
							data-testid="export-guesses"
							checked={guesses()}
							onChange={(e) => setGuesses(e.currentTarget.checked)}
						/>
						Include the agent's guesses ({proposed().trips} trips, {miles(proposed().meters)})
					</label>
				</Show>
				<div class="mt-3 grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3.5">
					<span class="text-muted">Format</span>
					<div class="flex flex-wrap items-center gap-1.5">
						<button
							type="button"
							class="mc-seg"
							data-testid="export-pdf"
							aria-pressed={format() === "pdf"}
							onClick={() => setFormat("pdf")}
						>
							PDF
						</button>
						<button
							type="button"
							class="mc-seg"
							data-testid="export-csv"
							aria-pressed={format() === "csv"}
							onClick={() => setFormat("csv")}
						>
							CSV
						</button>
						<span class="ml-1 text-[13px] text-muted" data-testid="export-holds">
							Every trip with its date, both addresses, purpose and miles
						</span>
					</div>
				</div>
				<Show when={failed()}>
					<p role="alert" class="mt-3 text-[13.5px] text-neg">
						{failed()}
					</p>
				</Show>
				<div class="mt-[18px] flex items-center justify-end gap-2">
					<button type="button" class="mc-quiet" onClick={() => props.onClose()}>
						Cancel
					</button>
					<button
						type="button"
						class="mc-primary"
						data-testid="export-go"
						disabled={busy()}
						onClick={() => void go()}
					>
						{busy() ? "Exporting…" : `Export ${format() === "csv" ? "CSV" : "PDF"}`}
					</button>
				</div>
			</div>
		</Portal>
	);
};

export default ExportDialog;
