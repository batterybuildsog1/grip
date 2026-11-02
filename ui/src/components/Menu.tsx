import { type Component, For, type JSX, onCleanup, onMount, Show } from "solid-js";

export interface MenuItem {
	value: string;
	label: string;
	/** A quiet figure on the right (Personal's unread count). */
	hint?: string;
	/** A rule above this item (the views' groups). */
	gapBefore?: boolean;
}

/** One radio group (the accounts, the views). */
export interface MenuSection {
	/** A small heading; none for the first group. */
	label?: string;
	items: MenuItem[];
	/** The checked item. */
	value: string | null;
	onPick: (value: string) => void;
	/** A quiet line under the items ("Changes the account, keeps the view."). */
	note?: string;
}

interface MenuProps {
	/** The menu's accessible name ("Accounts", "Views"). */
	label: string;
	sections: MenuSection[];
	onClose: () => void;
	/** Positioning, from the caller (the menu is absolutely placed under its button). */
	class?: string;
	/** The button that opened the menu: pressing it again is its own toggle, and focus returns to it. */
	anchor?: () => HTMLElement | undefined;
	/** Groups drawn after the sections, from the parts below (the account menu's AI sorting and links). */
	children?: JSX.Element;
}

/** The rule between groups. */
export const MenuRule: Component = () => (
	<div class="mx-1 my-[5px] h-px bg-rule" aria-hidden="true" />
);

/** A group's small heading. */
export const MenuHeading: Component<{ children: JSX.Element }> = (props) => (
	<p class="px-2.5 pb-0.5 pt-2 text-[12px] text-muted" aria-hidden="true">
		{props.children}
	</p>
);

/** A quiet line under a group's items. */
export const MenuNote: Component<{ children: JSX.Element; alert?: boolean }> = (props) => (
	<p
		role={props.alert ? "alert" : undefined}
		class="mt-1 w-0 min-w-full border-0 border-t border-solid border-rule px-2.5 pb-1 pt-[7px] text-[12px] text-muted"
	>
		{props.children}
	</p>
);

const ITEM =
	"flex items-baseline justify-between gap-4 whitespace-nowrap rounded-control px-2.5 py-[7px] text-left hover:bg-raised focus-visible:bg-raised";

/**
 * One choice of a group: the one in force reads without hue or fill alone: strong weight and an ink
 * edge on its leading side (the list cursor's mark, in ink).
 */
export const MenuRadio: Component<{
	value: string;
	label: string;
	hint?: string;
	checked: boolean;
	onPick: () => void;
}> = (props) => (
	<button
		type="button"
		role="menuitemradio"
		data-value={props.value}
		aria-checked={props.checked}
		class={ITEM}
		classList={{ "bg-raised": props.checked }}
		style={
			props.checked
				? {
						"font-weight": "var(--mc-strong-weight)",
						"box-shadow": "inset 2px 0 0 var(--mc-text)",
						"border-top-left-radius": "0",
						"border-bottom-left-radius": "0",
					}
				: undefined
		}
		onClick={() => props.onPick()}
	>
		<span>{props.label}</span>
		<Show when={props.hint}>
			<span class="font-normal text-muted">{props.hint}</span>
		</Show>
	</button>
);

/** A page outside the app (Privacy policy, Support), opened in a new tab so the app stays. */
export const MenuLink: Component<{ href: string; label: string }> = (props) => (
	<a
		role="menuitem"
		href={props.href}
		target="_blank"
		rel="noopener noreferrer"
		class={`${ITEM} text-text no-underline`}
	>
		{props.label}
	</a>
);

/** An action in the menu that is not a choice ("Try again"). */
export const MenuAction: Component<{ label: string; onClick: () => void }> = (props) => (
	<button type="button" role="menuitem" class={ITEM} onClick={() => props.onClick()}>
		{props.label}
	</button>
);

/**
 * A popover of choices: one checked item per group (menuitemradio + aria-checked; drawn in strong
 * weight with an ink edge, never by hue or fill alone), words only. Keyboard: focus starts on the
 * checked item; arrows move, Tab stays inside, Esc closes and returns focus to the button that
 * opened it. A press outside closes it.
 */
const Menu: Component<MenuProps> = (props) => {
	let ref: HTMLDivElement | undefined;

	const items = () => [
		...(ref?.querySelectorAll<HTMLElement>("[role=menuitemradio], [role=menuitem]") ?? []),
	];
	const move = (by: number) => {
		const list = items();
		const at = list.indexOf(document.activeElement as HTMLElement);
		list[(at + by + list.length) % list.length]?.focus();
	};

	const onPointerDown = (e: PointerEvent) => {
		const target = e.target as Node;
		if (ref?.contains(target) || props.anchor?.()?.contains(target)) return;
		props.onClose();
	};
	// Capture on window: these keys belong to the menu, not the thread or the list behind it.
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			props.onClose();
			props.anchor?.()?.focus();
			return;
		}
		if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
			e.preventDefault();
			e.stopPropagation();
			move(e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
			return;
		}
		if (e.key === "Home" || e.key === "End") {
			e.preventDefault();
			e.stopPropagation();
			const list = items();
			list[e.key === "Home" ? 0 : list.length - 1]?.focus();
			return;
		}
		// Mail shortcuts (e, #, j, [) don't act behind an open menu; Enter and Space still press the
		// focused item (their click is the browser's default action, not a listener).
		e.stopPropagation();
	};

	onMount(() => {
		document.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		const list = items();
		(list.find((b) => b.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
	});
	onCleanup(() => {
		document.removeEventListener("pointerdown", onPointerDown, true);
		window.removeEventListener("keydown", onKeyDown, true);
	});

	return (
		<div
			ref={ref}
			role="menu"
			aria-label={props.label}
			class={`absolute z-45 grid max-h-[calc(100dvh-64px)] min-w-[230px] overflow-y-auto rounded-box border border-solid border-border bg-sheet p-1.5 shadow-float ${props.class ?? ""}`}
		>
			<For each={props.sections}>
				{(section, index) => (
					<div role="group" aria-label={section.label ?? props.label} class="grid">
						<Show when={index() > 0}>
							<MenuRule />
						</Show>
						<Show when={section.label}>
							<MenuHeading>{section.label}</MenuHeading>
						</Show>
						<For each={section.items}>
							{(item) => (
								<>
									<Show when={item.gapBefore}>
										<MenuRule />
									</Show>
									<MenuRadio
										value={item.value}
										label={item.label}
										hint={item.hint}
										checked={item.value === section.value}
										onPick={() => section.onPick(item.value)}
									/>
								</>
							)}
						</For>
						<Show when={section.note}>
							<MenuNote>{section.note}</MenuNote>
						</Show>
					</div>
				)}
			</For>
			{props.children}
		</div>
	);
};

export default Menu;
