/**
 * Mileage's data on this screen: the month's report (one read), the writes, and their Undo. Every
 * figure, prompt and name shown comes from the latest report; after a write the report is read again,
 * so the totals on screen are always the server's. Deleting holds the trip off screen for 5 seconds
 * ("Deleted · Undo") before the DELETE goes out; a page closed inside the 5 seconds deletes nothing.
 */
import { batch, createContext, createSignal, onCleanup, useContext } from "solid-js";
import { ApiHttpError, ApiNetworkError } from "../../api/client";
import {
	key,
	type MileageCompany,
	type MileageFiling,
	type MileageReport,
	type MileageTripView,
	mileage,
} from "../../api/mileage";
import { useApp } from "../../store/app";
import { companyOf, filedAs } from "./format";

export type LoadError = { offline: boolean; message: string | null };

/** What an answer chooses. The drive back is filed with it when `withBack` holds its id. */
export interface Answer {
	company_id: string;
	reimbursable?: boolean;
	purpose?: string;
	proposal_id?: string;
	/** The drive back (its trip id), filed in the same batch. */
	withBack?: string | null;
	/** "Name it": the destination's name, for this trip only or saved as a place. */
	name?: { text: string; save: boolean } | null;
}

/** An answer that didn't save: kept on screen with Retry (and retried on its own), never counted. */
export interface SaveFailure {
	tripId: string;
	/** The trip's place, for "Your answer for Hardware Store didn't reach Grip." */
	place: string;
	/** What was answered, in words ("Side Co, supplies run"). */
	answered: string;
	/** The server's reason when it refused (a 4xx), else null (offline or a server failure). */
	refused: string | null;
	answer: Answer;
	words?: string;
}

const RETRY_MS = 20_000;

const HOLD_MS = 5000;

const errorOf = (e: unknown): LoadError => ({
	offline: e instanceof ApiNetworkError || !navigator.onLine,
	message: e instanceof ApiHttpError ? e.message : null,
});

/** The latest report's companies, for the key list ("?"), which is drawn outside MileageView. */
const [shownCompanies, setShownCompanies] = createSignal<MileageCompany[] | null>(null);
export { shownCompanies };

export function createMileageStore() {
	const [state, actions] = useApp();
	const [report, setReport] = createSignal<MileageReport | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [loadError, setLoadError] = createSignal<LoadError | null>(null);
	const [held, setHeld] = createSignal<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
	const [failure, setFailure] = createSignal<SaveFailure | null>(null);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let reading: AbortController | null = null;
	let loadedMonth: string | null = null;
	// Leaving Mileage (or signing out) leaves no companies behind for the key list.
	onCleanup(() => setShownCompanies(null));

	/** Reads the month again. `quiet` keeps what's on screen while it loads (a refresh). */
	const load = async (month: string | null, quiet = false) => {
		reading?.abort();
		const ctrl = new AbortController();
		reading = ctrl;
		if (!quiet || loadedMonth !== month) setLoading(true);
		try {
			const next = await mileage.report(month, ctrl.signal);
			if (ctrl.signal.aborted) return;
			batch(() => {
				setReport(next);
				setShownCompanies(next.companies);
				setLoadError(null);
				setLoading(false);
			});
			loadedMonth = month;
		} catch (e) {
			if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
			batch(() => {
				setLoadError(errorOf(e));
				setLoading(false);
			});
		}
	};
	const reload = () => load(state.mileage.month, true);

	/** The trip as the latest report has it, unless it is held for deletion. */
	const trip = (id: string | null | undefined): MileageTripView | undefined =>
		id && !held().has(id) ? report()?.trips.find((t) => t.id === id) : undefined;
	/** The month's trips on screen (newest first), without any held for deletion. */
	const trips = () => (report()?.trips ?? []).filter((t) => !held().has(t.id));
	const visible = (ids: string[]) => ids.filter((id) => !held().has(id));

	const mark = (set: typeof setBusy, id: string, on: boolean) =>
		set((prev) => {
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});

	/** Undo of the owner's last change to a trip (and its batch); the server refuses if it moved. */
	const undo = async (id: string, words: string) => {
		const t = report()?.trips.find((x) => x.id === id);
		if (!t) return;
		try {
			await mileage.undo(id, { expected_revision: t.revision, idempotency_key: key() });
			await reload();
			actions.showToast(`Undone: ${words}`, "info");
		} catch (e) {
			await reload();
			actions.showToast(
				e instanceof ApiHttpError && e.status === 409
					? "Couldn't undo: the trip changed since."
					: "Couldn't undo. Try again.",
				"error",
			);
		}
	};

	/**
	 * Files a trip: an answer, Yes to the agent's guess, or a change to a filed trip. On success the
	 * report is read again and the toast offers Undo. On failure the answer stays on screen, unfiled,
	 * with Retry ("didn't save").
	 */
	const file = async (t: MileageTripView, answer: Answer, words?: string): Promise<boolean> => {
		const r = report();
		if (!r || busy().has(t.id)) return false;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		const back = answer.withBack ? r.trips.find((x) => x.id === answer.withBack) : undefined;
		const body: MileageFiling = {
			expected_revision: t.revision,
			category_id: answer.company_id,
			idempotency_key: key(),
		};
		if (answer.reimbursable !== undefined) body.reimbursable = answer.reimbursable;
		if (answer.purpose !== undefined) body.purpose = answer.purpose;
		if (answer.proposal_id) body.proposal_id = answer.proposal_id;
		if (back) body.also = [{ trip_id: back.id, expected_revision: back.revision }];
		const name = answer.name?.text.trim() ? answer.name : null;
		if (name && !name.save) body.destination = name.text.trim();
		mark(setBusy, t.id, true);
		setFailure(null);
		try {
			await mileage.file(t.id, body);
			if (name?.save) {
				try {
					await mileage.namePlace({
						name: name.text.trim(),
						trip_id: t.id,
						end: "end",
						idempotency_key: key(),
					});
				} catch {
					actions.showToast(`Filed, but "${name.text.trim()}" wasn't saved as a place.`, "error");
				}
			}
			await reload();
			const as = filedAs(r, {
				company_id: answer.company_id,
				reimbursable: answer.reimbursable ?? null,
			});
			const said = words ?? (back ? `Filed both trips as ${as}` : `Filed as ${as}`);
			actions.showToast(said, "success", () => void undo(t.id, said));
			return true;
		} catch (e) {
			const refused =
				e instanceof ApiHttpError && e.status >= 400 && e.status < 500
					? e.status === 409
						? "The trip changed on another device. Check it and answer again."
						: e.message
					: null;
			const as = filedAs(r, {
				company_id: answer.company_id,
				reimbursable: answer.reimbursable ?? null,
			});
			setFailure({
				tripId: t.id,
				place: t.end.name,
				answered: answer.purpose
					? `${as}, ${answer.purpose.charAt(0).toLowerCase()}${answer.purpose.slice(1)}`
					: as,
				refused,
				answer,
				words,
			});
			if (e instanceof ApiHttpError && e.status === 409) void reload();
			// Offline or a server failure: it retries on its own (and when the browser is back online).
			if (!refused) retryTimer = setTimeout(() => void retry(), RETRY_MS);
			return false;
		} finally {
			mark(setBusy, t.id, false);
		}
	};

	/** LATE-START §4: removes the phone's estimated start leg; the toast offers Undo (the server restores it). */
	const removeEstimate = async (t: MileageTripView) => {
		if (busy().has(t.id)) return;
		mark(setBusy, t.id, true);
		try {
			await mileage.removeEstimate(t.id, { expected_revision: t.revision, idempotency_key: key() });
			await reload();
			actions.showToast("Estimate removed", "success", () => void undo(t.id, "estimate removed"));
		} catch (e) {
			const moved = e instanceof ApiHttpError && e.status === 409;
			if (moved) void reload();
			actions.showToast(
				moved
					? "Couldn't remove the estimate: the trip changed since."
					: "Couldn't remove the estimate. Try again.",
				"error",
			);
		} finally {
			mark(setBusy, t.id, false);
		}
	};

	/** Files the answer that didn't save, again. */
	const retry = async () => {
		const f = failure();
		const t = f ? report()?.trips.find((x) => x.id === f.tripId) : undefined;
		if (!f || !t) return false;
		return file(t, f.answer, f.words);
	};
	const onOnline = () => {
		if (failure() && !failure()?.refused) void retry();
	};
	window.addEventListener("online", onOnline);
	onCleanup(() => {
		window.removeEventListener("online", onOnline);
		if (retryTimer) clearTimeout(retryTimer);
	});

	/** Delete with the 5-second hold: off screen now, DELETE after 5 s unless Undo. */
	const remove = (t: MileageTripView) => {
		mark(setHeld, t.id, true);
		let toastId = "";
		const cancel = () => {
			const timer = timers.get(t.id);
			if (timer) clearTimeout(timer);
			timers.delete(t.id);
			mark(setHeld, t.id, false);
		};
		toastId = actions.showToast("Deleted", "info", cancel);
		timers.set(
			t.id,
			setTimeout(async () => {
				timers.delete(t.id);
				actions.dismissToast(toastId);
				try {
					await mileage.remove(t.id, { expected_revision: t.revision, idempotency_key: key() });
					await reload();
				} catch (e) {
					actions.showToast(
						`Couldn't delete the trip${e instanceof ApiHttpError ? `: ${e.message}` : ""}. It's back.`,
						"error",
					);
				} finally {
					mark(setHeld, t.id, false);
				}
			}, HOLD_MS),
		);
	};

	/** A change that isn't a filing (rates, companies, places): runs, then reads the report again. */
	const change = async (
		run: () => Promise<unknown>,
		done: string,
		undoRun?: () => Promise<unknown>,
	) => {
		try {
			await run();
			await reload();
			actions.showToast(
				done,
				"success",
				undoRun
					? () =>
							void undoRun()
								.then(reload)
								.catch(() => actions.showToast("Couldn't undo. Try again.", "error"))
					: undefined,
			);
			return true;
		} catch (e) {
			actions.showToast(
				`${done.replace(/\.$/, "")} didn't save${e instanceof ApiHttpError ? `: ${e.message}` : ""}.`,
				"error",
			);
			return false;
		}
	};

	return {
		report,
		loading,
		loadError,
		load,
		reload,
		trip,
		trips,
		visible,
		busy,
		failure,
		clearFailure: () => setFailure(null),
		file,
		retry,
		undo,
		remove,
		removeEstimate,
		change,
		companyOf: (id: string | null) => {
			const r = report();
			return r ? companyOf(r, id) : undefined;
		},
	};
}

export type MileageStore = ReturnType<typeof createMileageStore>;
export const MileageContext = createContext<MileageStore>();
export function useMileage(): MileageStore {
	const ctx = useContext(MileageContext);
	if (!ctx) throw new Error("useMileage outside MileageView");
	return ctx;
}
