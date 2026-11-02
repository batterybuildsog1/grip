import { type Component, createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { endsComposition, notAShortcut } from "../lib/shortcuts";
import { useApp } from "../store/app";
import { isMobile } from "../store/responsive";

/**
 * The one search field (r2 S4). Desktop: centered in the top bar; "/" or ⌘K focuses it. Phone: the top
 * bar holds a "Search all mail" button that opens the field pinned to the bottom with Cancel, as on
 * the iPhone. Enter runs the search and always shows the results (WP-09); typing alone never searches,
 * so the header's title is what ran. Esc in the field, or Cancel, returns to the view.
 * In Mileage it is "Search trips": it filters the month's trips on this device as you type.
 */
const SearchField: Component = () => {
	const [state, actions] = useApp();
	const [draft, setDraft] = createSignal(state.searchQuery);
	const trips = () => state.levelView === "mileage";
	const label = () => (trips() ? "Search trips" : "Search all mail");
	const value = () => (trips() ? state.mileageSearch : draft());
	const typed = (v: string) => (trips() ? actions.setMileageSearch(v) : setDraft(v));
	const ran = () => (trips() ? state.mileageSearch : state.searchQuery);
	// What the phone's keyboard covers: iOS Safari keeps the layout viewport, so a field fixed to the
	// bottom would sit under the keyboard (the compose window's fix, ComposeWindow.tsx).
	const [keyboardInset, setKeyboardInset] = createSignal(0);
	// The field on screen (desktop's, or the phone's while open).
	let input: HTMLInputElement | undefined;
	const fieldRef = (el: HTMLInputElement) => {
		input = el;
		onCleanup(() => {
			if (input === el) input = undefined;
		});
	};

	// The field shows what ran: a suggestion taken, a link opened, a view chosen.
	createEffect(
		on(
			() => state.searchQuery,
			(q) => setDraft(q),
		),
	);

	const phoneBar = () =>
		isMobile() &&
		(state.searchOpen || Boolean(ran())) &&
		!state.selectedConversationId &&
		!state.mileage.trip;

	const focusField = () => {
		if (isMobile() && !phoneBar()) {
			// On a phone, searching from a thread leaves it: the results get the screen (WP-09).
			if (state.selectedConversationId) actions.selectConversation(null);
			actions.setSearchOpen(true);
		}
		if (input) input.focus();
		else queueMicrotask(() => input?.focus());
	};

	const submit = (e: Event) => {
		e.preventDefault();
		if (trips()) {
			actions.setMileageSearch(state.mileageSearch.trim());
			input?.blur();
			return;
		}
		const q = draft().trim();
		actions.setSearch(q);
		// The keyboard goes down so the results have the screen.
		if (q) input?.blur();
	};

	const leave = () => {
		setDraft("");
		if (trips()) actions.setMileageSearch("");
		else actions.setSearch("");
		actions.setSearchOpen(false);
		input?.blur();
	};

	const onFieldKey = (e: KeyboardEvent) => {
		// An IME's Escape cancels its candidate text, not the search (R3 F3); a held key repeats (F5).
		if (e.key !== "Escape" || endsComposition(e) || e.repeat) return;
		e.preventDefault();
		e.stopPropagation();
		if (ran() || isMobile()) leave();
		else {
			setDraft("");
			input?.blur();
		}
	};

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const typing =
				target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
			// ⌘K in a message is the editor's link key, not search.
			if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k" && !typing) {
				e.preventDefault();
				focusField();
				return;
			}
			if (e.key === "/" && !notAShortcut(e)) {
				e.preventDefault();
				focusField();
			}
		};
		document.addEventListener("keydown", onKey);
		onCleanup(() => document.removeEventListener("keydown", onKey));

		const vv = window.visualViewport;
		if (!vv) return;
		const update = () =>
			setKeyboardInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		onCleanup(() => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		});
	});

	return (
		<Show
			when={isMobile()}
			fallback={
				<form role="search" class="relative w-full" onSubmit={submit}>
					<input
						ref={fieldRef}
						id="q"
						type="search"
						aria-label={label()}
						placeholder={label()}
						autocomplete="off"
						spellcheck={false}
						enterkeyhint="search"
						class="w-full h-9 rounded-control border border-solid border-border bg-sheet text-text text-[14px] pl-3.5 pr-10 outline-none focus:border-focus"
						value={value()}
						onInput={(e) => typed(e.currentTarget.value)}
						onKeyDown={onFieldKey}
					/>
					<kbd aria-hidden="true" class="pointer-events-none absolute right-[9px] top-[9px]">
						/
					</kbd>
				</form>
			}
		>
			<Show when={!phoneBar()}>
				<button
					type="button"
					aria-label={label()}
					class="w-full h-10 rounded-control bg-raised px-3.5 text-left text-muted text-[16.5px]"
					onClick={focusField}
				>
					{label()}
				</button>
			</Show>
			<Show when={phoneBar()}>
				<form
					role="search"
					class="fixed inset-x-0 z-40 flex items-center gap-2.5 px-4 pt-2 border-0 border-t border-solid border-rule bg-sheet"
					style={{
						bottom: `${keyboardInset()}px`,
						"padding-bottom":
							keyboardInset() > 0 ? "8px" : "calc(8px + env(safe-area-inset-bottom, 0px))",
					}}
					onSubmit={submit}
				>
					<input
						ref={fieldRef}
						type="search"
						aria-label={label()}
						placeholder={label()}
						autocomplete="off"
						spellcheck={false}
						enterkeyhint="search"
						class="flex-1 min-w-0 h-10 rounded-control border-[1.5px] border-solid border-focus bg-sheet text-text px-3.5 text-[16.5px] outline-none"
						value={value()}
						onInput={(e) => typed(e.currentTarget.value)}
						onKeyDown={onFieldKey}
					/>
					<button
						type="button"
						class="shrink-0 text-accent text-[17px] py-2 px-0.5"
						onClick={leave}
					>
						Cancel
					</button>
				</form>
			</Show>
		</Show>
	);
};

export default SearchField;
