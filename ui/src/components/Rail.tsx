import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { ConversationSummaryRecord } from "../lib/db";
import { rowTime } from "../utils/row-format";
import { isUnread, rowAt, rowName, rowSubject } from "./ConversationRow";
import Menu, { type MenuItem } from "./Menu";

const timeOfDay = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** "Tue", or "Tue 12:11 PM" when another row has the same name and subject (lead's call 3). */
function railTimes(rows: ConversationSummaryRecord[]): Map<string, string> {
	const seen = new Map<string, number>();
	const key = (r: ConversationSummaryRecord) => `${rowName(r)}\u0000${rowSubject(r)}`.toLowerCase();
	for (const r of rows) seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
	const times = new Map<string, string>();
	for (const r of rows) {
		const at = rowAt(r);
		const day = rowTime(at);
		const clock = at ? timeOfDay.format(at < 1e11 ? at * 1000 : at) : "";
		const twin = (seen.get(key(r)) ?? 0) > 1;
		times.set(r.id, twin && clock && day !== clock ? `${day} ${clock}` : day);
	}
	return times;
}

interface RailProps {
	rows: ConversationSummaryRecord[];
	openId: string | null;
	/** "Personal", or the search as typed in quotes. */
	title: string;
	views: MenuItem[];
	currentView: string | null;
	onView: (view: string) => void;
	onOpen: (row: ConversationSummaryRecord, index: number) => void;
	/** Scrolled near the end: the list loads its next page. */
	onNearEnd: () => void;
}

/**
 * The rail (L3): while a thread is open the list folds into the column as names only. Its title is
 * the views menu ("Personal ▾", Mileage last); a row is the name and time on one line and the
 * subject under it, the open one a tab joined to the sheet. j/k hop rows (ConversationList).
 */
const Rail: Component<RailProps> = (props) => {
	const [menuOpen, setMenuOpen] = createSignal(false);
	const [edges, setEdges] = createSignal({ above: false, below: false });
	const times = createMemo(() => railTimes(props.rows));
	let list: HTMLUListElement | undefined;
	let titleButton: HTMLButtonElement | undefined;

	const measure = () => {
		if (!list) return;
		setEdges({
			above: list.scrollTop > 2,
			below: list.scrollTop + list.clientHeight < list.scrollHeight - 2,
		});
		if (list.scrollTop + list.clientHeight > list.scrollHeight - 400) props.onNearEnd();
	};

	// Keep the open conversation in view: on open, on j/k, and when the rail first appears.
	createEffect(
		on(
			() => [props.openId, props.rows.length] as const,
			([id]) =>
				requestAnimationFrame(() => {
					const row = id
						? list?.querySelector<HTMLElement>(`[data-rail-id="${CSS.escape(id)}"]`)
						: null;
					row?.scrollIntoView({ block: "nearest" });
					measure();
				}),
		),
	);

	return (
		<div
			class="mc-rail relative flex min-h-0 flex-1 flex-col"
			data-testid="rail"
			data-above={edges().above ? "true" : "false"}
			data-below={edges().below ? "true" : "false"}
		>
			<div class="mc-rail-head relative flex h-12 flex-none items-center pl-1 pr-[34px]">
				<button
					ref={titleButton}
					type="button"
					data-testid="rail-title"
					aria-haspopup="menu"
					aria-expanded={menuOpen()}
					aria-label={`${props.title}: switch view`}
					class="mc-rail-title inline-flex max-w-full items-center rounded-control px-2.5 py-1.5 text-[15px]"
					style={{ "font-weight": "var(--mc-strong-weight)" }}
					onClick={() => setMenuOpen(!menuOpen())}
				>
					<span class="truncate">{props.title}</span>
					<span class="mc-caret" aria-hidden="true" />
				</button>
				<Show when={menuOpen()}>
					<Menu
						label="Views"
						class="left-1 top-[46px]"
						anchor={() => titleButton}
						onClose={() => setMenuOpen(false)}
						sections={[
							{
								items: props.views,
								value: props.currentView,
								onPick: (view) => {
									setMenuOpen(false);
									props.onView(view);
								},
							},
						]}
					/>
				</Show>
			</div>
			<ul
				ref={list}
				class="mc-rail-list flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto"
				aria-label={`Conversations in ${props.title}`}
				onScroll={measure}
			>
				<For each={props.rows}>
					{(row, index) => {
						const on = () => row.id === props.openId;
						const unread = () => isUnread(row);
						return (
							<li class="flex">
								<button
									type="button"
									data-testid="rail-row"
									data-rail-id={row.id}
									data-unread={unread() ? "true" : "false"}
									aria-current={on() ? "true" : undefined}
									aria-label={`${rowName(row)}, ${rowSubject(row)}${unread() ? ", unread" : ""}`}
									title={rowSubject(row)}
									class="mc-rail-item grid w-[calc(100%-34px)] grid-cols-[7px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-px pb-2 pl-3.5 pr-3 pt-[7px] text-left text-[13.5px]"
									onClick={() => props.onOpen(row, index())}
								>
									<span
										class="h-[7px] w-[7px] rounded-full"
										classList={{ "bg-accent": unread() }}
										aria-hidden="true"
									/>
									<span
										data-part="name"
										class="min-w-0 truncate"
										style={{ "font-weight": unread() ? "var(--mc-strong-weight)" : undefined }}
									>
										{rowName(row)}
									</span>
									<span
										data-part="time"
										class="whitespace-nowrap text-[12px]"
										classList={{ "text-muted": unread(), "text-faint": !unread() }}
									>
										{times().get(row.id)}
									</span>
									<span
										data-part="subject"
										class="col-span-2 col-start-2 min-w-0 truncate text-[12.5px]"
										classList={{ "text-text": on(), "text-muted": !on() }}
									>
										{rowSubject(row)}
									</span>
								</button>
							</li>
						);
					}}
				</For>
			</ul>
		</div>
	);
};

export default Rail;
