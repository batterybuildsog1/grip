import {
	type Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { ApiHttpError, api } from "../api/client";
import { buildJobs, daysUntil, dueLabel, type Job } from "../lib/needs-you";
import { useApp } from "../store/app";
import type { ActionNote } from "../types";
import { rowTime } from "../utils/row-format";

/** Open, the most pressing few show in place; the rest wait behind "Show all N" (design-taste A). */
const CAP = 5;

/**
 * Needs you (design r2 §4 S1: a separate strip was in the way, so it is integrated): one quiet
 * line at the top of Personal that opens in place.
 * Collapsed every launch. States: collapsed, open, error (WD-13: a failed load must never look
 * like nothing to do), empty. A list row between rules, not a box (WM6); open, the 5 most pressing
 * and "Show all N", each with "Done" as a word (WM7); one mark per note, Urgent before a due date (X5).
 */
const NeedsYouLine: Component = () => {
	const [state, actions] = useApp();
	// null = the last load failed (a resource error would throw on read).
	const [notes, { mutate, refetch }] = createResource<ActionNote[] | null>(() =>
		api.notes
			.list()
			.then((data) => data.notes)
			.catch(() => null),
	);
	const [open, setOpen] = createSignal(false);
	const [all, setAll] = createSignal(false);
	const jobs = createMemo(() => buildJobs(notes() ?? []));
	const shown = () => (all() ? jobs() : jobs().slice(0, CAP));
	const urgent = () => jobs().filter((job) => job.urgent).length;

	const stateName = () => {
		if (notes.loading && notes() === undefined) return "loading";
		if (notes() === null) return "error";
		if (jobs().length === 0) return "empty";
		return open() ? "open" : "collapsed";
	};

	// Fresh with the rest of the app: back in the foreground, and on the 2-minute refresh.
	const onVisible = () => {
		if (document.visibilityState === "visible") void refetch();
	};
	document.addEventListener("visibilitychange", onVisible);
	onCleanup(() => document.removeEventListener("visibilitychange", onVisible));
	createEffect(
		on(
			() => state.freshnessVersion,
			() => void refetch(),
			{ defer: true },
		),
	);

	const without = (list: ActionNote[] | null | undefined, gone: ActionNote[]) => {
		const ids = new Set(gone.map((note) => note.email_id));
		return (list ?? []).filter((note) => !ids.has(note.email_id));
	};

	const failed = (what: string, error: unknown) =>
		actions.showToast(
			error instanceof ApiHttpError
				? `Couldn't ${what}. Nothing changed.`
				: `Couldn't ${what}: you're offline. Check again once you're online.`,
			"error",
		);

	/** Done for every note of the job; Undo puts each one back (PUT re-opens a note). */
	const done = async (job: Job) => {
		const taken = job.notes;
		mutate((list) => without(list, taken));
		try {
			await Promise.all(taken.map((note) => api.notes.done(note.email_id)));
		} catch (error) {
			failed("mark it done", error);
			void refetch();
			return;
		}
		const label = job.text.length > 48 ? `${job.text.slice(0, 48).trimEnd()}…` : job.text;
		actions.showToast(`Done: ${label}`, "success", () => void undo(taken));
	};

	const undo = async (taken: ActionNote[]) => {
		mutate((list) => [...without(list, taken), ...taken]);
		try {
			await Promise.all(taken.map((note) => api.notes.reopen(note)));
		} catch (error) {
			mutate((list) => without(list, taken));
			failed("put it back", error);
		}
	};

	const openJob = (job: Job) =>
		actions.selectConversation(job.lead.thread_id ?? job.lead.email_id, job.lead.email_id);

	const line =
		"flex w-full items-center gap-2.5 px-3.5 py-[11px] text-left min-h-[48px] md:min-h-0";
	const dueTone = (due: string) => (daysUntil(due) < 0 ? "text-neg" : "text-warn");

	return (
		<section
			aria-label="Needs you"
			data-state={stateName()}
			class="overflow-hidden border-0 border-y border-solid border-rule bg-sheet"
			classList={{ "bg-warn-soft": stateName() === "error" }}
		>
			<Switch>
				<Match when={stateName() === "loading"}>
					<div class={line}>
						<span class="font-semibold">Needs you</span>
					</div>
				</Match>
				<Match when={stateName() === "error"}>
					<div class={line}>
						<span class="font-semibold">Needs you</span>
						<span class="min-w-0 flex-1 font-medium text-warn">
							Couldn't load, so this isn't a clear list
						</span>
						<button
							type="button"
							class="shrink-0 text-[0.93em] font-medium text-accent hover:underline"
							onClick={() => void refetch()}
						>
							Try again
						</button>
					</div>
				</Match>
				<Match when={stateName() === "empty"}>
					<div class={line}>
						<span class="font-semibold">Needs you</span>
						<span class="text-muted">Nothing right now</span>
					</div>
				</Match>
				<Match when={true}>
					<button
						type="button"
						class={`${line} hover:bg-raised`}
						classList={{ "bg-raised": open() }}
						aria-expanded={open()}
						onClick={() => {
							setAll(false);
							setOpen(!open());
						}}
					>
						<span class="min-w-0 flex-1">
							<span class="font-semibold">Needs you</span>{" "}
							<span class="font-medium text-muted">{jobs().length}</span>
							<Show when={urgent() > 0}>
								{" "}
								<span class="text-faint">·</span>{" "}
								<span class="text-[0.9em] font-medium text-neg">{urgent()} urgent</span>
							</Show>
						</span>
						<span class="shrink-0 text-[0.93em] font-medium">{open() ? "Hide" : "Show"}</span>
					</button>
					<Show when={open()}>
						<ul class="list-none border-0 border-t border-solid border-rule">
							<For each={shown()}>
								{(job) => (
									<li
										data-testid="needs-you-job"
										class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-[3px] border-0 border-t border-solid border-rule px-3.5 py-[11px] first:border-t-0"
									>
										<button
											type="button"
											data-part="job-text"
											class="col-start-1 min-w-0 break-words text-left leading-[1.4] hover:text-accent"
											onClick={() => openJob(job)}
										>
											{job.text}
										</button>
										<div
											data-part="job-meta"
											class="mc-job-meta col-start-1 flex flex-wrap gap-x-1.5 text-[0.86em] text-muted"
										>
											<Show
												when={job.urgent}
												fallback={
													<Show when={job.due}>
														{(due) => <span class={dueTone(due())}>{dueLabel(due())}</span>}
													</Show>
												}
											>
												<span class="text-neg">Urgent</span>
											</Show>
											<span>{job.source}</span>
											<span>{rowTime(job.at)}</span>
										</div>
										<button
											type="button"
											aria-label={`Done: ${job.text}`}
											class="mc-word col-start-2 row-span-2 row-start-1 -mr-2.5 font-medium"
											onClick={() => void done(job)}
										>
											{job.notes.length > 1 ? `Done (${job.notes.length})` : "Done"}
										</button>
									</li>
								)}
							</For>
							<Show when={!all() && jobs().length > CAP}>
								<li class="border-0 border-t border-solid border-rule">
									<button
										type="button"
										data-testid="needs-you-all"
										class="w-full px-3.5 py-[11px] text-left font-medium hover:bg-raised"
										onClick={() => setAll(true)}
									>
										Show all {jobs().length}
									</button>
								</li>
							</Show>
						</ul>
					</Show>
				</Match>
			</Switch>
		</section>
	);
};

export default NeedsYouLine;
