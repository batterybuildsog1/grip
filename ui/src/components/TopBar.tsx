import { type Component, createSignal, Show } from "solid-js";
import { useApp } from "../store/app";
import { columnFits, isMobile, isNarrow } from "../store/responsive";
import type { PlatformMeta } from "../types";
import Menu, { type MenuItem } from "./Menu";
import SearchField from "./SearchField";

/**
 * The accounts in the account menu: one address per domain the signed-in person has, the one
 * they send as (their own local part, as in their default sender; noreply@ never). Values are
 * domains: the list narrows by domain, so mail to the domain's other addresses stays in view.
 */
export function accountsOf(meta: PlatformMeta | null): MenuItem[] {
	if (!meta) return [];
	const senders = (meta.allowed_senders ?? []).filter((a) => !/^no-?reply@/i.test(a));
	const local = senders[0]?.split("@")[0]?.toLowerCase();
	const domains = [
		...new Set([
			...senders.map((a) => a.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d),
			...(meta.configured_domains ?? []).map((d) => d.toLowerCase()),
		]),
	].filter((d) => (meta.configured_domains ?? []).some((c) => c.toLowerCase() === d));
	return domains.map((domain) => {
		const here = senders.filter((a) => a.toLowerCase().endsWith(`@${domain}`));
		const own = here.find((a) => a.split("@")[0].toLowerCase() === local) ?? here[0];
		return { value: domain, label: own ?? domain };
	});
}

/**
 * The top bar on the frame (L3, 52 high): "Sidebar" on the left, the search centred over the
 * sheet, New message and the account menu on the right. The account menu holds only the accounts
 * (design-taste WD2: Theme, Appearance, AI sorting and the links moved to Settings). Below 1000 px
 * the search takes the room between the two ends instead of floating over them, so nothing can
 * overlap (WD1); below 900 there is no column, so no "Sidebar". The phone has no top bar except in
 * Mileage: its bottom bar holds search and New (WM1).
 */
const TopBar: Component = () => {
	const [state, actions] = useApp();
	const [menuOpen, setMenuOpen] = createSignal(false);
	let accountButton: HTMLButtonElement | undefined;

	const accounts = () => accountsOf(state.meta);
	const accountLabel = () => {
		const domain = state.activeDomain;
		if (!domain) return "All accounts";
		return accounts().find((a) => a.value === domain)?.label ?? domain;
	};
	const columnShown = () => state.sidebarShown && !isMobile() && columnFits();
	/** The search floats centred over the sheet only where the ends can't reach it. */
	const floating = () => !isMobile() && !isNarrow();
	// One filled button per screen: New message only while browsing with no composer open (L3).
	// Mileage has its own filled button (Yes, file it), or none.
	const newFilled = () =>
		!state.selectedConversationId &&
		state.composeWindows.length === 0 &&
		state.levelView !== "mileage";

	return (
		<header data-testid="topbar" class="relative flex h-[52px] shrink-0 items-center gap-2 px-3">
			<Show when={!isMobile() && columnFits()}>
				<div class="flex-none" classList={{ "w-[228px]": floating() }}>
					<button
						type="button"
						data-toggle="sidebar"
						aria-pressed={state.sidebarShown}
						aria-keyshortcuts="["
						class="rounded-control px-2.5 py-[5px] text-[13px] hover:text-text"
						classList={{
							"text-muted": !state.sidebarShown,
							"text-text": state.sidebarShown,
						}}
						style={{
							background: state.sidebarShown
								? "color-mix(in srgb, var(--mc-sheet) 55%, var(--mc-frame))"
								: undefined,
						}}
						title="Show or hide the sidebar ([)"
						onClick={() => actions.toggleSidebar()}
					>
						Sidebar
					</button>
				</div>
			</Show>

			{/* Desktop: centred over the sheet (240 + half of what is right of it), 480 wide. */}
			<div
				class="min-w-0"
				classList={{
					"flex-1": !floating(),
					"max-w-[480px] mx-auto": !floating() && !isMobile(),
					"absolute top-2 w-[480px] max-w-[calc(100%-560px)] -translate-x-1/2": floating(),
				}}
				style={
					floating()
						? { left: columnShown() ? "calc(240px + (100% - 248px) / 2)" : "50%" }
						: undefined
				}
			>
				<SearchField />
			</div>

			<div class="relative flex flex-none items-center gap-2" classList={{ "ml-auto": floating() }}>
				<button
					type="button"
					data-testid="new-message"
					aria-label="New message"
					class={newFilled() ? "mc-primary" : "mc-soft"}
					onClick={() => actions.openCompose()}
					title="New message (c)"
				>
					{isMobile() ? "New" : "New message"}
				</button>
				<button
					ref={accountButton}
					type="button"
					data-testid="account-button"
					aria-haspopup="menu"
					aria-expanded={menuOpen()}
					class="mc-on-frame inline-flex min-w-0 max-w-[40vw] items-center rounded-control px-2.5 py-[7px] md:max-w-none"
					onClick={() => setMenuOpen(!menuOpen())}
				>
					<span class="truncate">{accountLabel()}</span>
					<span class="mc-caret" aria-hidden="true" />
				</button>
				<Show when={menuOpen()}>
					<Menu
						label="Accounts"
						class="right-0 top-[44px]"
						anchor={() => accountButton}
						onClose={() => setMenuOpen(false)}
						sections={[
							{
								label: undefined,
								items: [{ value: "all", label: "All accounts" }, ...accounts()],
								value: state.activeDomain ?? "all",
								onPick: (value) => {
									setMenuOpen(false);
									accountButton?.focus();
									actions.setActiveDomain(value === "all" ? null : value);
								},
							},
						]}
					/>
				</Show>
			</div>
		</header>
	);
};

export default TopBar;
