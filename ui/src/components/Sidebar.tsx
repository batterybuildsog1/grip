import { type Component, createSignal, For, onCleanup, Show } from "solid-js";
import { isReading, useApp, type ViewId, viewIdOf, viewTitle } from "../store/app";
import { mileageNeeds } from "../store/mileage-count";
import { isMobile } from "../store/responsive";
import type { MenuItem } from "./Menu";

/**
 * The views (design r2 §3-§4, L3): Personal (the app's one count: its unread), Money, each
 * forwarded-in person, Notifications (design-taste X9: no count, it isn't a queue), then All mail,
 * Sent, Drafts, Trash, then Mileage (V3 "Answer first"). Archive, Spam, the category trees and the
 * theme button are cut. Settings (WD2) sits at the column's foot, not in this list.
 */
export function useViews(): () => ViewId[] {
	const [state] = useApp();
	return () => [
		"personal",
		"money",
		...Object.keys(state.meta?.conversation_for_person_counts ?? {})
			.sort()
			.map((name) => `person:${name}` as ViewId),
		"notifications",
		"all",
		"sent",
		"draft",
		"trash",
		"mileage",
	];
}

/** Personal unread: the one count in the app. */
export function usePersonalUnread(): () => number {
	const [state] = useApp();
	return () => state.meta?.conversation_category_unread_counts?.personal ?? 0;
}

/** A rule before All mail, before Mileage and before Settings, as in the column. */
const gapBefore = (view: ViewId) => view === "all" || view === "mileage" || view === "settings";

/**
 * The views as a menu (the rail's title, the list title with the column hidden, the phone). Without
 * the column its foot's Settings joins the end (WD2); the phone has the Account sheet instead.
 */
export function useViewMenuItems(): () => MenuItem[] {
	const views = useViews();
	const unread = usePersonalUnread();
	return () =>
		[...views(), ...(isMobile() ? [] : (["settings"] as ViewId[]))].map((view) => ({
			value: view,
			label: viewTitle(view),
			hint:
				view === "personal" && unread() > 0
					? String(unread())
					: view === "mileage" && (mileageNeeds() ?? 0) > 0
						? String(mileageNeeds())
						: undefined,
			gapBefore: gapBefore(view),
		}));
}

/** Where ConversationList draws the rail while a thread is open (null: the column shows views). */
const [railSlot, setRailSlot] = createSignal<HTMLElement | null>(null);
export { railSlot };

/**
 * The left column (L3, desktop): 240 wide, running 24px under the sheet so its selected item joins
 * the sheet as a tab. Browsing, the views; reading, the rail (ConversationList portals it into the
 * slot). "Settings · Shortcuts ?" at the foot (WD2: the settings left the account menu).
 */
const Sidebar: Component<{ onShortcuts: () => void }> = (props) => {
	const [state, actions] = useApp();
	const views = useViews();
	const unread = usePersonalUnread();
	const current = () => (state.searchQuery ? null : viewIdOf(state));
	const reading = () => isReading(state);
	onCleanup(() => setRailSlot(null));

	return (
		<aside
			data-testid="column"
			data-state={reading() ? "rail" : "views"}
			class="absolute inset-y-0 left-0 z-1 flex w-[264px] flex-col pb-3 pl-2.5"
		>
			<Show
				when={reading()}
				fallback={
					<nav aria-label="Views" class="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
						<For each={views()}>
							{(view) => (
								<>
									<Show when={gapBefore(view)}>
										<div class="h-3.5 shrink-0" aria-hidden="true" />
									</Show>
									<button
										type="button"
										data-view={view}
										aria-current={current() === view ? "page" : undefined}
										class="mc-nav flex w-[calc(100%-34px)] shrink-0 items-center justify-between gap-2 py-2 pl-3.5 pr-3 text-left"
										style={{
											"font-weight": current() === view ? "var(--mc-strong-weight)" : undefined,
										}}
										onClick={() => actions.setView(view)}
									>
										<span class="truncate">{viewTitle(view)}</span>
										<Show when={view === "personal" && unread() > 0}>
											<span class="text-[13px] font-normal text-muted">{unread()}</span>
										</Show>
										<Show when={view === "mileage" && (mileageNeeds() ?? 0) > 0}>
											<span class="text-[13px] font-normal text-muted" data-testid="mileage-count">
												{mileageNeeds()}
											</span>
										</Show>
									</button>
								</>
							)}
						</For>
					</nav>
				}
			>
				<div
					ref={(el) => {
						setRailSlot(el);
						onCleanup(() => {
							if (railSlot() === el) setRailSlot(null);
						});
					}}
					data-testid="rail-slot"
					class="flex min-h-0 flex-1 flex-col"
				/>
			</Show>
			<div class="flex flex-none items-center gap-0.5 pr-[34px] pt-2.5">
				<button
					type="button"
					data-testid="sidebar-settings"
					aria-current={state.levelView === "settings" ? "page" : undefined}
					class="mc-quiet pl-1.5 text-[13px]"
					classList={{ "!text-text": state.levelView === "settings" }}
					onClick={() => actions.setView("settings")}
				>
					Settings
				</button>
				<span class="text-[13px] text-faint" aria-hidden="true">
					·
				</span>
				<button
					type="button"
					class="mc-quiet inline-flex items-center gap-2 text-[13px]"
					onClick={() => props.onShortcuts()}
				>
					Shortcuts <kbd>?</kbd>
				</button>
			</div>
		</aside>
	);
};

export default Sidebar;
