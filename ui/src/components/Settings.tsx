import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { leaveForAccessLogout } from "../lib/account";
import {
	consent,
	decide,
	PRIVACY_URL,
	readConsent,
	readFailed,
	STALE,
	SUPPORT_URL,
} from "../lib/ai-consent";
import { useDialogFocus } from "../lib/dialog";
import { APPEARANCES, type Appearance } from "../lib/theme";
import { useApp } from "../store/app";
import { columnFits, isMobile } from "../store/responsive";
import { accountsOf } from "./TopBar";
import ViewTitle from "./ViewTitle";

/** The phone's Account sheet, opened from "All accounts ⌄" under the title (design-taste WM3). */
const [accountSheetOpen, setAccountSheetOpen] = createSignal(false);
export { accountSheetOpen, setAccountSheetOpen };

/** One choice of a few, side by side (Appearance): the chosen one in the sheet colour. */
const Segmented: Component<{
	label: string;
	items: { value: string; label: string }[];
	value: string;
	onPick: (value: string) => void;
}> = (props) => (
	<section aria-label={props.label} class="grid gap-2">
		<h2 class="mc-set-head">{props.label}</h2>
		<div role="radiogroup" aria-label={props.label} class="mc-seg">
			<For each={props.items}>
				{(item) => (
					<button
						type="button"
						role="radio"
						data-value={item.value}
						aria-checked={item.value === props.value}
						onClick={() => props.onPick(item.value)}
					>
						{item.label}
					</button>
				)}
			</For>
		</div>
	</section>
);

/**
 * AI sorting (the owner only): a switch showing the server's last answer, read again as it appears;
 * a change moves it only on the server's acknowledgement, and a failure says why and what is still in
 * force (lib/ai-consent.ts).
 */
const AiSortingSetting: Component = () => {
	const [pending, setPending] = createSignal<boolean | null>(null);
	const [failure, setFailure] = createSignal<string | null>(null);
	onMount(() => void readConsent());

	const owner = () => consent()?.can_decide === true;
	const on = () => consent()?.state === "allowed";
	const pick = async (allow: boolean) => {
		if (pending() !== null || consent()?.state === (allow ? "allowed" : "declined")) return;
		setFailure(null);
		setPending(allow);
		const why = await decide(allow);
		setPending(null);
		if (why && why !== STALE) {
			setFailure(`Not changed. ${why} AI sorting is still ${on() ? "on" : "off"}.`);
		}
	};
	const note = () => {
		const p = pending();
		if (p !== null) return p ? "Turning on…" : "Turning off…";
		return failure() ?? "When on, parts of each new message go to OpenAI to sort it.";
	};

	return (
		<Show when={owner() || (readFailed() && !consent())}>
			<section aria-label="AI sorting" data-testid="ai-sorting-setting" class="grid gap-1.5">
				<h2 class="mc-set-head">AI sorting</h2>
				<Show
					when={!readFailed() && consent()}
					fallback={
						<p role="alert" class="text-muted">
							Grip couldn't read this setting.{" "}
							<button
								type="button"
								class="font-medium text-accent hover:underline"
								onClick={() => void readConsent()}
							>
								Try again
							</button>
						</p>
					}
				>
					<div class="flex min-h-11 items-center gap-4">
						<span id="ai-sorting-label" class="min-w-0 flex-1">
							Sort new mail into Personal, Money and the other views
						</span>
						<button
							type="button"
							role="switch"
							aria-labelledby="ai-sorting-label"
							aria-checked={on()}
							disabled={pending() !== null}
							class="mc-switch"
							onClick={() => void pick(!on())}
						/>
					</div>
					<p role={failure() !== null ? "alert" : undefined} class="text-[13px] text-muted">
						{note()}
					</p>
				</Show>
			</section>
		</Show>
	);
};

/**
 * What used to crowd the account menu (design-taste WD2/WM3): Appearance, AI sorting (the owner),
 * the app password, then Privacy policy · Support · Sign out. The desktop's Settings view and the
 * phone's Account sheet draw the same parts. One theme, Grip: no Theme choice.
 */
const SettingsBody: Component = () => {
	const [state, actions] = useApp();
	return (
		<div class="grid gap-7">
			<Segmented
				label="Appearance"
				items={APPEARANCES}
				value={state.appearance}
				onPick={(value) => actions.setAppearance(value as Appearance)}
			/>
			<AiSortingSetting />
			<section aria-label="Phone and Mac apps" class="grid gap-1">
				<h2 class="mc-set-head">Phone and Mac apps</h2>
				<a
					href="/app-password"
					data-testid="settings-app-password"
					class="flex min-h-11 items-center justify-between gap-4 text-text no-underline hover:text-accent"
				>
					<span>App password</span>
					<span
						class="mc-chevron text-muted"
						style={{ transform: "rotate(225deg)" }}
						aria-hidden="true"
					/>
				</a>
				<p class="text-[13px] text-muted">The password the iPhone, iPad and Mac apps sign in with.</p>
			</section>
			<nav aria-label="Grip" class="mc-set-foot">
				<a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
					Privacy policy
				</a>
				<a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
					Support
				</a>
				<button type="button" onClick={() => void leaveForAccessLogout()}>
					Sign out
				</button>
			</nav>
		</div>
	);
};

/** Settings in the sheet (desktop, from the column's foot or the views menu). */
const SettingsView: Component = () => {
	const [state] = useApp();
	const asMenu = () => !state.sidebarShown || !columnFits() || isMobile();
	return (
		<div data-testid="settings-view" class="h-full w-full overflow-y-auto">
			<div class="mx-auto max-w-[560px] px-6 pb-16 md:px-8">
				<div class="relative pb-5 pt-[22px] text-[22px]">
					<ViewTitle title="Settings" asMenu={asMenu()} current="settings" large={isMobile()} />
				</div>
				<SettingsBody />
			</div>
		</div>
	);
};

/**
 * The phone's Account sheet, as on the iPhone (`AccountSheet.swift`): "Show mail from" (All
 * accounts and each address, the one in force marked "Showing"), then the settings. Done closes it;
 * picking an account narrows the list and closes it.
 */
export const AccountSheet: Component = () => {
	const [state, actions] = useApp();
	let root: HTMLDivElement | undefined;
	const close = () => setAccountSheetOpen(false);
	useDialogFocus(() => root, { onClose: close });
	const accounts = () => [
		{ value: "all", label: "All accounts" },
		...accountsOf(state.meta).map((a) => ({ value: a.value, label: a.label })),
	];
	const current = () => state.activeDomain ?? "all";

	return (
		<div class="fixed inset-0 z-[60]" data-testid="account-sheet-layer">
			<button
				type="button"
				tabindex="-1"
				aria-label="Close"
				class="absolute inset-0 h-full w-full bg-scrim"
				onClick={close}
			/>
			<div
				ref={root}
				role="dialog"
				aria-modal="true"
				aria-labelledby="account-sheet-title"
				data-testid="account-sheet"
				class="absolute inset-x-0 bottom-0 top-10 flex flex-col overflow-hidden rounded-t-sheet bg-sheet text-text shadow-float"
			>
				<div class="flex h-14 shrink-0 items-center justify-between px-5">
					<h2 id="account-sheet-title" class="mc-title text-[17px]">
						Account
					</h2>
					<button type="button" class="-mr-2 px-2 font-semibold" onClick={close}>
						Done
					</button>
				</div>
				<div
					class="min-h-0 flex-1 overflow-y-auto px-5"
					style={{ "padding-bottom": "calc(28px + env(safe-area-inset-bottom, 0px))" }}
				>
					<section aria-label="Show mail from" class="mb-7">
						<h2 class="mc-set-head pb-1">Show mail from</h2>
						<ul class="list-none">
							<For each={accounts()}>
								{(account) => (
									<li class="border-0 border-b border-solid border-rule last:border-b-0">
										<button
											type="button"
											data-value={account.value}
											aria-pressed={account.value === current()}
											class="flex min-h-[52px] w-full items-center justify-between gap-3 text-left"
											style={{
												"font-weight":
													account.value === current() ? "var(--mc-strong-weight)" : undefined,
											}}
											onClick={() => {
												actions.setActiveDomain(account.value === "all" ? null : account.value);
												close();
											}}
										>
											<span class="min-w-0 truncate">{account.label}</span>
											<Show when={account.value === current()}>
												<span class="shrink-0 font-normal text-muted">Showing</span>
											</Show>
										</button>
									</li>
								)}
							</For>
						</ul>
					</section>
					<SettingsBody />
				</div>
			</div>
		</div>
	);
};

export default SettingsView;
