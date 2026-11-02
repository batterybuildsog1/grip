import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	Match,
	on,
	onCleanup,
	type ParentComponent,
	Show,
	Switch,
} from "solid-js";
import { getConversationRowsCached } from "../lib/cache";
import { isMobile } from "../store/responsive";
import type { ConversationSearchInfo, EmailFilters } from "../types";
import { literalQuery, searchCountLabel } from "../utils/search";

export type SearchStatus = "loading" | "answered" | "offline" | "error" | "rejected";
export type SearchScope = "all" | "view";

interface SearchHeaderProps {
	/** The query as typed: the title. */
	query: string;
	/** What the server says it ran; null until it answered this query. */
	info: ConversationSearchInfo | null;
	status: SearchStatus;
	/** The server's reason it refused the query (400). */
	reason: string | null;
	scope: SearchScope;
	/** The open view's name when it can narrow the search ("Personal"); null from All mail. */
	viewLabel: string | null;
	/** The answer on screen: its rows, and whether the server has more. */
	rows: number;
	hasMore: boolean;
	/** The request whose answer counts the other pill; null when there is no other pill. */
	otherFilters: EmailFilters | null;
	/** "you@example.com", "example.com" or "all accounts". */
	account: string;
	onScope: (scope: SearchScope) => void;
	onSearch: (query: string) => void;
	onRetry: () => void;
	/** Leave the search for the view (the no-match note's way out). */
	onClear: () => void;
}

/**
 * What a search ran and where (r2 S4, option C's text): the query as typed, "Searched
 * [All mail 50+] [Personal 10] in you@example.com", then at most one note. Counts appear only once
 * the server answered; offline or a failed search says so and never shows a count (WD-11/12).
 */
const SearchHeader: Component<SearchHeaderProps> = (props) => {
	// The other pill's count comes from its own request, made once the answer on screen is in.
	const otherKey = createMemo(() =>
		props.status === "answered" && props.otherFilters ? JSON.stringify(props.otherFilters) : null,
	);
	const [otherCount, setOtherCount] = createSignal<{ key: string; label: string } | null>(null);
	createEffect(
		on(otherKey, (key) => {
			if (!key) return;
			let live = true;
			onCleanup(() => {
				live = false;
			});
			getConversationRowsCached(JSON.parse(key) as EmailFilters)
				.then((page) => {
					if (!live) return;
					setOtherCount({
						key,
						label: searchCountLabel(page.emails.length, page.has_more === true),
					});
				})
				// No count is the honest answer when the count itself could not be had.
				.catch(() => undefined);
		}),
	);

	const countFor = (which: SearchScope): string | null => {
		if (props.status !== "answered") return null;
		if (which === props.scope) return searchCountLabel(props.rows, props.hasMore);
		const other = otherCount();
		return other && other.key === otherKey() ? other.label : null;
	};

	const phone = () => isMobile();
	const corrected = () => (props.status === "answered" ? props.info?.corrected_from : undefined);
	const suggestion = () => (props.status === "answered" ? props.info?.suggestion : undefined);

	const linkClass = "text-accent font-medium hover:underline text-left";
	const Pill = (pill: { which: SearchScope; label: string }) => {
		const pressed = () => props.scope === pill.which;
		return (
			<button
				type="button"
				data-testid={`search-pill-${pill.which}`}
				aria-pressed={pressed()}
				class={`rounded-full border border-solid font-medium ${phone() ? "px-[13px] py-1.5" : "px-3 py-1"} ${
					pressed()
						? "bg-primary text-primary-on border-primary"
						: "border-control text-text hover:border-text"
				}`}
				onClick={() => {
					if (!pressed()) props.onScope(pill.which);
				}}
			>
				{pill.label}
				<Show when={countFor(pill.which)}>
					{(count) => (
						<>
							{" "}
							<b
								data-testid="search-count"
								class={`font-semibold ${pressed() ? "opacity-75" : "text-muted"}`}
							>
								{count()}
							</b>
						</>
					)}
				</Show>
			</button>
		);
	};

	return (
		<section
			data-testid="search-header"
			aria-label="Search results"
			class={`text-text ${phone() ? "px-5 pt-2 pb-2.5" : "px-2 pt-[22px] pb-3.5"}`}
		>
			<h1
				data-testid="search-title"
				class={`mc-title [overflow-wrap:anywhere] ${phone() ? "text-[28px] mb-2.5" : "text-[22px] mb-2.5"}`}
			>
				“{props.query}”
			</h1>
			<div class={`flex flex-wrap items-center gap-2 ${phone() ? "text-[15px]" : "text-[13.5px]"}`}>
				<span class="text-muted">Searched</span>
				<Pill which="all" label="All mail" />
				<Show when={props.viewLabel}>{(label) => <Pill which="view" label={label()} />}</Show>
				<span data-testid="search-account" class="text-muted [overflow-wrap:anywhere]">
					in {props.account}
				</span>
			</div>
			<Switch>
				<Match when={props.status === "offline"}>
					<Note warn>
						<span>You're offline, so nothing was searched.</span>
						<button type="button" class={linkClass} onClick={() => props.onRetry()}>
							Try again
						</button>
					</Note>
				</Match>
				<Match when={props.status === "error"}>
					<Note warn>
						<span>Search didn't run: the server returned an error.</span>
						<button type="button" class={linkClass} onClick={() => props.onRetry()}>
							Try again
						</button>
					</Note>
				</Match>
				<Match when={props.status === "rejected"}>
					<Note warn>
						<span>
							Search didn't run: {props.reason ?? "the server could not read this search."}
						</span>
					</Note>
				</Match>
				<Match when={corrected()}>
					{(typed) => (
						<Note>
							<span>
								Showing results for <b>{props.info?.query}</b>.
							</span>
							<button
								type="button"
								class={linkClass}
								onClick={() => props.onSearch(literalQuery(typed(), props.info?.query ?? typed()))}
							>
								Search for “{typed()}” instead
							</button>
						</Note>
					)}
				</Match>
				<Match when={suggestion()}>
					{(fix) => (
						<Note>
							{/* A suggestion also comes with one or two results: only zero is "no mail". */}
							<Show when={props.rows === 0}>
								<span>No mail matches “{props.query}”.</span>
							</Show>
							<button type="button" class={linkClass} onClick={() => props.onSearch(fix())}>
								Did you mean <b>{fix()}</b>?
							</button>
						</Note>
					)}
				</Match>
				{/* No match says where it looked and offers the way out (L3 S4, r1 L3-09). */}
				<Match when={props.status === "answered" && props.rows === 0 && props.scope === "view"}>
					<Note>
						<span>{`No mail in ${props.viewLabel ?? "this view"} matches “${props.query}”.`}</span>
						<button type="button" class={linkClass} onClick={() => props.onScope("all")}>
							Search all mail instead
						</button>
					</Note>
				</Match>
				<Match when={props.status === "answered" && props.rows === 0}>
					<Note>
						<span>{`No mail in ${props.account === "all accounts" ? "any account" : props.account} matches “${props.query}”.`}</span>
						<button type="button" class={linkClass} onClick={() => props.onClear()}>
							Clear search
						</button>
					</Note>
				</Match>
			</Switch>
		</section>
	);
};

const Note: ParentComponent<{ warn?: boolean }> = (props) => (
	<div
		data-testid="search-note"
		role="status"
		class={`mt-3 px-3.5 py-2.5 rounded-box flex flex-wrap gap-x-2 gap-y-1 items-baseline [overflow-wrap:anywhere] ${
			props.warn ? "bg-warn-soft [&>span]:font-medium" : "bg-raised"
		} ${isMobile() ? "text-[15px]" : ""}`}
	>
		{props.children}
	</div>
);

export default SearchHeader;
