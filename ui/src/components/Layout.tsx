import {
	type Component,
	createSignal,
	ErrorBoundary,
	lazy,
	onCleanup,
	Show,
	Suspense,
} from "solid-js";
import { reloadUnlessUnsaved } from "../lib/edge-login";
import { notAShortcut } from "../lib/shortcuts";
import { isReading, useApp } from "../store/app";
import { columnFits, initResponsive, isMobile } from "../store/responsive";
import ConversationList from "./ConversationList";
import SearchField from "./SearchField";
import SettingsView, { AccountSheet, accountSheetOpen } from "./Settings";
import ShortcutHelp from "./ShortcutHelp";
import Sidebar from "./Sidebar";
import Toast from "./Toast";
import TopBar from "./TopBar";

const ThreadView = lazy(() => import("./thread/ThreadView"));
const Compose = lazy(() => import("./Compose"));
// Mileage carries the street-map stack (MapLibre): loaded only when Mileage opens.
const MileageView = lazy(() => import("./mileage/MileageView"));

const ChunkError: Component<{ retry: () => void }> = (props) => (
	<div class="flex flex-1 items-center justify-center p-8">
		<div class="flex flex-col items-center gap-3 text-center">
			<p class="text-muted">Couldn't load this part of Grip.</p>
			<button
				type="button"
				class="font-medium text-accent hover:underline"
				onClick={() => props.retry()}
			>
				Try again
			</button>
		</div>
	</div>
);

/**
 * The window, layout L3 "Rail" (chosen 2026-10-26). Desktop: the top
 * bar (52) on the frame, the left column (240) and one sheet. Browsing, the column holds the views
 * and the sheet the one-line list; reading, the list folds into the column as the rail and the
 * thread takes the sheet in a centred 760 column. Never three regions. "Sidebar" / `[` hides the
 * column in either state. Below 900 px the column folds into the views menu (design-taste WD1).
 * Phone: one region at a time (list, thread, search), with the iPhone's bottom bar (search and the
 * one filled New) under the list and no top bar outside Mileage (WM1).
 */
const Layout: Component = () => {
	const [state, actions] = useApp();
	const [shortcutHelpOpen, setShortcutHelpOpen] = createSignal(false);
	const reading = () => isReading(state);
	/** Mileage V3 has the sheet: its report, or a trip with the queue in the rail. */
	const mileage = () => state.levelView === "mileage";
	/** Settings (WD2) has the sheet, unless a search was run from it. */
	const settings = () => state.levelView === "settings" && !state.searchQuery;
	const columnShown = () => state.sidebarShown && !isMobile() && columnFits();
	/** Phone: the list's bottom bar (search, New); the search field itself opens over it (r2 S4). */
	const phoneBar = () => isMobile() && !mileage() && !settings() && !reading();

	// Closing a thread is "go back one step": pop the entry its opening pushed (so the browser's
	// Back stack stays true), or, after a deep link, just close it.
	const closeCurrentEmail = () => {
		const marker = (window.history.state as { mc?: string } | null)?.mc;
		if (marker === "email-open") window.history.back();
		else actions.selectConversation(null);
	};

	initResponsive();

	const handleGlobalKey = (e: KeyboardEvent) => {
		if (notAShortcut(e)) return;
		if (e.key === "?") {
			e.preventDefault();
			setShortcutHelpOpen((v) => !v);
			return;
		}
		if (e.key === "c") {
			e.preventDefault();
			actions.openCompose();
			return;
		}
		if (e.key === "[" && !isMobile()) {
			e.preventDefault();
			actions.toggleSidebar();
		}
	};
	document.addEventListener("keydown", handleGlobalKey);
	onCleanup(() => document.removeEventListener("keydown", handleGlobalKey));

	return (
		// body already pads the four safe-area insets (index.css).
		<div class="flex h-full flex-col bg-frame text-text">
			<Show
				when={!state.error || state.meta}
				fallback={
					<div class="flex flex-1 items-center justify-center">
						<div class="flex max-w-sm flex-col items-center gap-3 rounded-sheet bg-sheet p-8 text-center">
							<p class="mc-title text-[15px]">Grip couldn't open</p>
							<p class="leading-relaxed text-muted">{state.error}</p>
							<button
								type="button"
								class="mc-primary mt-2"
								onClick={() => void reloadUnlessUnsaved()}
							>
								Try again
							</button>
						</div>
					</div>
				}
			>
				<Show when={!isMobile() || mileage()}>
					<TopBar />
				</Show>
				<div class="relative min-h-0 flex-1">
					<Show when={columnShown()}>
						<Sidebar onShortcuts={() => setShortcutHelpOpen(true)} />
					</Show>
					<main
						data-testid="sheet"
						data-state={reading() ? "reading" : "browsing"}
						class="absolute z-2 overflow-hidden bg-sheet"
						classList={{
							"inset-0": isMobile(),
							"top-0 right-2 bottom-2 rounded-sheet": !isMobile(),
							"left-[240px]": columnShown(),
							"left-2": !isMobile() && !columnShown(),
						}}
					>
						<Show when={mileage()}>
							<div data-testid="mileage-pane" class="absolute inset-0 flex">
								<ErrorBoundary
									fallback={() => <ChunkError retry={() => void reloadUnlessUnsaved()} />}
								>
									<Suspense fallback={<p class="p-8 text-center text-muted">Opening Mileage…</p>}>
										<MileageView />
									</Suspense>
								</ErrorBoundary>
							</div>
						</Show>
						{/* The list stays mounted under the thread: its rows feed the rail, and Back finds its
						    rows and scroll spot as they were. */}
						<Show when={settings()}>
							<div data-testid="settings-pane" class="absolute inset-0 flex">
								<SettingsView />
							</div>
						</Show>
						<Show when={!mileage() && !settings()}>
							<div
								data-testid="list-pane"
								class="absolute inset-0 flex"
								classList={{ "invisible pointer-events-none": reading() }}
								aria-hidden={reading()}
							>
								<ConversationList />
							</div>
						</Show>
						<Show when={!mileage() && Boolean(state.selectedConversationId)}>
							<div
								data-testid="reader"
								class="scroll-contain absolute inset-0 overflow-y-auto overflow-x-hidden"
							>
								<ErrorBoundary
									fallback={() => <ChunkError retry={() => void reloadUnlessUnsaved()} />}
								>
									<Suspense
										fallback={
											// The thread is loading: Back works now, not after the load (m2-09).
											<div class="mx-auto max-w-[824px] px-8">
												<div class="flex h-[60px] items-center border-b border-solid border-0 border-rule">
													<button type="button" class="mc-quiet" onClick={closeCurrentEmail}>
														Back
													</button>
												</div>
												<p class="p-8 text-center text-muted">Opening…</p>
											</div>
										}
									>
										<Show when={state.selectedConversationId}>
											{(conversationId) => (
												<ThreadView
													conversationId={conversationId()}
													emailId={state.selectedEmailId}
													onClose={closeCurrentEmail}
												/>
											)}
										</Show>
									</Suspense>
								</ErrorBoundary>
							</div>
						</Show>
					</main>
				</div>
				{/* The phone's bottom bar, as on the iPhone: search and New, under the thumb. */}
				<Show when={phoneBar()}>
					<div
						data-testid="phone-bar"
						class="flex h-[64px] shrink-0 items-center gap-2.5 border-0 border-t border-solid border-rule bg-sheet px-4"
					>
						<div class="min-w-0 flex-1">
							<SearchField />
						</div>
						<button
							type="button"
							data-testid="new-message"
							aria-label="New message"
							class={`${state.composeWindows.length === 0 ? "mc-primary" : "mc-soft"} h-11 !px-5 text-[16.5px]`}
							onClick={() => actions.openCompose()}
						>
							New
						</button>
					</div>
				</Show>
				<Show when={isMobile() && accountSheetOpen()}>
					<AccountSheet />
				</Show>
			</Show>

			<Show when={state.composeWindows.length > 0}>
				<ErrorBoundary fallback={() => <ChunkError retry={() => void reloadUnlessUnsaved()} />}>
					<Suspense fallback={null}>
						<Compose />
					</Suspense>
				</ErrorBoundary>
			</Show>

			<Toast />

			<Show when={shortcutHelpOpen()}>
				<ShortcutHelp onClose={() => setShortcutHelpOpen(false)} mileage={mileage()} />
			</Show>
		</div>
	);
};

export default Layout;
