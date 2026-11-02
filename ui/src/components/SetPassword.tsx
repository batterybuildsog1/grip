import { type Component, createSignal, type JSX, Show } from "solid-js";
import { ApiHttpError, account } from "../api/client";

/** Shared card, same look as the boot screen in App.tsx. */
const Card: Component<{ title: string; children: JSX.Element }> = (props) => (
	<div class="h-full flex items-center justify-center p-4">
		<div class="w-full max-w-sm bg-sheet rounded-sheet p-8">
			<h1 class="mc-title text-[17px] mb-6 text-center">{props.title}</h1>
			{props.children}
		</div>
	</div>
);

const inputClass =
	"w-full px-3 py-2 rounded-control border border-solid border-control bg-sheet text-text outline-none focus:border-focus";
const labelClass = "block text-[13px] text-muted mb-1";

function errorText(error: unknown, fallback: string): string {
	return error instanceof ApiHttpError ? error.message || fallback : fallback;
}

/**
 * The two password fields and the one filled button. `save` stores the password and returns the
 * addresses the app now signs in as; the parent says so.
 */
const PasswordForm: Component<{
	save: (password: string) => Promise<string[]>;
	initialError?: string | null;
	onDone: (emails: string[]) => void;
}> = (props) => {
	const [password, setPassword] = createSignal("");
	const [confirm, setConfirm] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(props.initialError ?? null);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		if (password() !== confirm()) {
			setError("The two passwords differ.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			props.onDone(await props.save(password()));
		} catch (err) {
			setError(errorText(err, "Couldn't set the password."));
			setBusy(false);
		}
	};

	return (
		<form class="space-y-4" onSubmit={submit}>
			<div>
				<label class={labelClass} for="mc-new-password">
					New password (at least 10 characters)
				</label>
				<input
					id="mc-new-password"
					class={inputClass}
					type="password"
					autocomplete="new-password"
					minLength={10}
					required
					value={password()}
					onInput={(e) => setPassword(e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class={labelClass} for="mc-confirm-password">
					Same password again
				</label>
				<input
					id="mc-confirm-password"
					class={inputClass}
					type="password"
					autocomplete="new-password"
					required
					value={confirm()}
					onInput={(e) => setConfirm(e.currentTarget.value)}
				/>
			</div>
			<Show when={error()}>
				<p class="text-neg">{error()}</p>
			</Show>
			<button
				type="submit"
				class="mc-primary w-full"
				disabled={busy() || props.initialError != null}
			>
				{busy() ? "Saving…" : "Set password"}
			</button>
		</form>
	);
};

/**
 * /set-password#token=…: the one-time link an administrator sends. It sets the password the
 * native app signs in with; the web signs in with Cloudflare Access (ticket 09).
 */
export const SetPassword: Component = () => {
	const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
	// Keep the token out of history and screenshots once read.
	history.replaceState(null, "", "/set-password");
	const [doneEmail, setDoneEmail] = createSignal<string | null>(null);

	return (
		<Card title="Set your password">
			<Show
				when={!doneEmail()}
				fallback={
					<p class="text-center text-muted">
						Password set for {doneEmail()}. Sign in with it in the Grip app.
					</p>
				}
			>
				<PasswordForm
					initialError={token ? null : "This link is incomplete."}
					save={async (password) => [(await account.setPassword(token, password)).email]}
					onDone={(emails) => setDoneEmail(emails[0] ?? "")}
				/>
			</Show>
		</Card>
	);
};

/**
 * /app-password (account menu → App password): the person signed in here through Cloudflare
 * Access sets the password the native app signs in with, with no link. The server picks the
 * addresses (the mailbox owner's goes on each of the owner's addresses) and this names them.
 */
export const AppPassword: Component = () => {
	const [done, setDone] = createSignal<string[] | null>(null);

	return (
		<Card title="App password">
			<Show
				when={done()}
				fallback={
					<>
						<p class="text-muted mb-4">
							The Grip app on your iPhone, iPad or Mac signs in with this password. The web
							keeps signing in as it does now.
						</p>
						<PasswordForm save={async (password) => (await account.setAppPassword(password)).emails} onDone={setDone} />
					</>
				}
			>
				{(emails) => (
					<p class="text-center text-muted">
						Password set. In the Grip app, sign in as {emails().join(" or ")} with it.
					</p>
				)}
			</Show>
			<p class="mt-6 text-center">
				<a href="/" class="text-text">
					Back to mail
				</a>
			</p>
		</Card>
	);
};
