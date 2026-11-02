import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { api } from "../../api/client";
import { useApp } from "../../store/app";
import { isMobile } from "../../store/responsive";
import type { Email, EmailCategory } from "../../types";
import { buildEmailFrame } from "../../utils/email-render";
import { realFiles } from "../../utils/files";
import {
	inferGoogleInviteAccount,
	withGoogleInviteAuthUser,
} from "../../utils/google-invite-links";
import { parseEmailAddress } from "../../utils/sender";
import {
	firstLine,
	fullDate,
	isBulk,
	messageParts,
	messageTime,
	type People,
	recipientsOf,
	shortDate,
	textToHtml,
	tidy,
} from "../../utils/thread-text";
import EmailHtmlFrame from "../EmailHtmlFrame";
import { FileList } from "../FileCard";

interface MessageBoxProps {
	email: Email;
	people: People;
	/** The conversation's category, for messages that carry none of their own. */
	category: EmailCategory | null;
	open: boolean;
	onToggle: () => void;
}

/**
 * Which messages show their original HTML. Kept outside the box so the phone's More sheet can turn it
 * on for the latest message (design-taste WM4: the phone has no "Show original" link in the body).
 */
const [originals, setOriginals] = createSignal<ReadonlySet<string>>(new Set());
export const originalShown = (id: string) => originals().has(id);
export const toggleOriginal = (id: string) =>
	setOriginals((now) => {
		const next = new Set(now);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	});
/** People's mail read as text that also has HTML: "Show original" can show the HTML. */
export const canShowOriginal = (email: Email, category: EmailCategory | null) =>
	!!email.html_content &&
	!isBulk(email, category) &&
	!!messageParts(email).shown &&
	!!tidy(email.text_content);

/** Last measured HTML height per message, so reopening a box doesn't jump. */
const FRAME_HEIGHTS = new Map<string, number>();

/**
 * One message of a thread, in a bordered box. Closed: name · first line · date, one line (two on
 * a phone). Open: name, date and the recipients button; the new text only, with the rest behind
 * "Show trimmed text"; bulk (and HTML-only) mail as its own HTML; people's HTML behind
 * "Show original".
 */
const MessageBox: Component<MessageBoxProps> = (props) => {
	const [state, actions] = useApp();
	const [addresses, setAddresses] = createSignal(false);
	const [trimmed, setTrimmed] = createSignal(false);
	const original = () => originalShown(props.email.id);
	const parts = () => messageParts(props.email);
	const bulk = () => isBulk(props.email, props.category);
	/** People's mail with a text part reads as text; HTML-only mail keeps its HTML. */
	const asText = () => !bulk() && !!parts().shown && !!tidy(props.email.text_content);
	const asHtml = () => !!props.email.html_content && (!asText() || original());
	/** The link is the desktop's; the phone's is in the thread's More sheet. */
	const offerOriginal = () => !!props.email.html_content && asText() && !isMobile();
	/** In the HTML, the blocks the server marked quoted stay hidden until asked (not the original). */
	const htmlTrims = () => asHtml() && !original() && !!props.email.quote?.has_quoted;
	const canTrim = () => (asHtml() ? htmlTrims() : !!parts().hidden);
	/** The sender's HTML in the opaque-origin frame; their own dark CSS applies when the app is dark (S3). */
	const frame = createMemo(() =>
		buildEmailFrame(props.email.html_content ?? "", {
			attachments: props.email.attachments,
			emailId: props.email.id,
			title: props.email.subject || "Email content",
			allowRemoteImages: true,
			rewriteLink: (href) => withGoogleInviteAuthUser(href, inferGoogleInviteAccount(props.email)),
			hideQuotedId: htmlTrims() && !trimmed() ? props.email.id : undefined,
			scheme: state.appearance === "dark" ? "dark" : "light",
		}),
	);
	/** Dark app, light-only mail: "Dim email" tones its white paper down (NI-16), as the reader does. */
	const [dim, setDim] = createSignal(false);
	const offerDim = () => asHtml() && state.appearance === "dark" && !frame().ownDark;
	/** The HTML runs to the box's bottom edge when nothing follows it. */
	const htmlLast = () =>
		asHtml() &&
		!canTrim() &&
		!offerOriginal() &&
		!offerDim() &&
		realFiles(props.email).length === 0;
	const unread = () => props.email.direction === "inbound" && !props.email.read_at;

	return (
		<article
			data-testid="message-box"
			data-email-id={props.email.id}
			data-state={props.open ? "open" : "closed"}
			class="mc-box scroll-mt-20 border border-border rounded-box bg-sheet"
			classList={{ "hover:border-control": !props.open }}
		>
			<Show
				when={props.open}
				fallback={
					<button
						type="button"
						data-testid="message-toggle"
						aria-expanded="false"
						class="w-full grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,170px)_minmax(0,1fr)_auto] gap-x-3.5 gap-y-0.5 items-baseline px-3.5 md:px-4 py-2.75 text-left rounded-box"
						onClick={() => props.onToggle()}
					>
						<span
							class="truncate"
							classList={{ "font-bold": unread(), "font-semibold": !unread() }}
						>
							{props.people.sender(props.email)}
						</span>
						<span class="col-span-2 row-start-2 md:col-span-1 md:row-start-1 md:col-start-2 truncate text-muted">
							{firstLine(props.email)}
						</span>
						<time class="col-start-2 row-start-1 md:col-start-3 whitespace-nowrap text-muted text-[0.88em]">
							{shortDate(messageTime(props.email))}
						</time>
					</button>
				}
			>
				<div class="px-3.5 md:px-5 pt-3.5 md:pt-4 pb-4 md:pb-4.5">
					{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut only; the sender button inside is the keyboard toggle. */}
					<header
						class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-baseline cursor-pointer"
						onClick={(event) => {
							if (!(event.target as Element).closest("button, a")) props.onToggle();
						}}
					>
						<button
							type="button"
							data-testid="message-toggle"
							aria-expanded="true"
							class="justify-self-start text-left font-semibold text-[15px]"
							onClick={() => props.onToggle()}
						>
							{props.people.sender(props.email)}
						</button>
						<time class="whitespace-nowrap text-muted text-[0.88em]">
							{fullDate(messageTime(props.email))}
						</time>
						<button
							type="button"
							data-testid="message-recipients"
							aria-expanded={addresses()}
							class="col-span-2 justify-self-start text-left text-muted text-[0.9em] underline decoration-dotted decoration-control underline-offset-3 hover:text-text"
							onClick={() => setAddresses((on) => !on)}
						>
							{props.people.recipients(props.email)}
						</button>
					</header>

					<Show when={addresses()}>
						<Addresses email={props.email} people={props.people} />
					</Show>

					<Show when={bulk() && props.email.list_unsubscribe}>
						<Unsubscribe
							email={props.email}
							onDone={(text, type) => actions.showToast(text, type)}
						/>
					</Show>

					<Show
						when={!asHtml()}
						fallback={
							<div
								class="mc-paper -mx-3.5 md:-mx-5 mt-3.5 border-t border-rule overflow-hidden"
								classList={{
									"-mb-4 md:-mb-4.5 rounded-b-box": htmlLast(),
									"border-b": !htmlLast(),
								}}
							>
								<EmailHtmlFrame
									srcdoc={frame().srcdoc}
									title={props.email.subject || "Email content"}
									initialHeight={FRAME_HEIGHTS.get(props.email.id)}
									onHeightChange={(height) => FRAME_HEIGHTS.set(props.email.id, height)}
									dark={state.appearance === "dark" && frame().ownDark}
									dim={dim() && offerDim()}
								/>
							</div>
						}
					>
						<div
							data-testid="message-body-text"
							class="mc-text mt-3 text-[16.5px] md:text-[16px]"
							innerHTML={textToHtml(parts().shown || "(No text)")}
						/>
						<Show when={trimmed() && parts().hidden}>
							<div
								data-testid="message-trimmed"
								class="mc-text mc-trimmed mt-3"
								innerHTML={textToHtml(parts().hidden)}
							/>
						</Show>
					</Show>

					<Show when={canTrim() || offerOriginal() || offerDim()}>
						<div class="flex flex-wrap gap-x-4.5 gap-y-1 mt-2.5 text-[0.88em]">
							<Show when={canTrim()}>
								<button
									type="button"
									data-testid="message-trimmed-toggle"
									aria-expanded={trimmed()}
									class="font-medium text-accent hover:underline"
									onClick={() => setTrimmed((on) => !on)}
								>
									{trimmed() ? "Hide trimmed text" : "Show trimmed text"}
								</button>
							</Show>
							<Show when={offerOriginal()}>
								<button
									type="button"
									data-testid="message-original-toggle"
									aria-pressed={original()}
									class="mc-orig font-medium text-accent hover:underline"
									onClick={() => toggleOriginal(props.email.id)}
								>
									{original() ? "Show as text" : "Show original"}
								</button>
							</Show>
							<Show when={offerDim()}>
								<button
									type="button"
									data-testid="message-dim"
									aria-pressed={dim()}
									class="font-medium text-accent hover:underline"
									onClick={() => setDim((on) => !on)}
								>
									Dim email
								</button>
							</Show>
						</div>
					</Show>

					<FileList email={props.email} />
				</div>
			</Show>
		</article>
	);
};

/** From, To, Cc, Reply to with full addresses (WD-06, NM-10, NI-09). */
const Addresses: Component<{ email: Email; people: People }> = (props) => {
	const line = (label: string, list: string[]) => ({ label, list });
	const lines = () =>
		[
			line("From", [props.email.from_address]),
			line("To", recipientsOf(props.email)),
			line("Cc", props.email.cc_addresses),
			line("Reply to", props.email.reply_to_addresses),
		].filter((entry) => entry.list.length > 0);
	const [state] = useApp();
	/** "Me" by the configured sender name (SENDER_NAMES_JSON, via /api/meta), else as the thread names it. */
	const mine = (raw: string) => {
		const key = parseEmailAddress(raw).trim().toLowerCase();
		const names = state.meta?.sender_names ?? {};
		return Object.entries(names).find(([address]) => address.toLowerCase() === key)?.[1];
	};
	const person = (raw: string, given?: string | null) =>
		(props.people.isMe(raw) && mine(raw)) || props.people.name(raw, given);
	return (
		<div
			data-testid="message-addresses"
			class="mt-2.5 px-3 py-2.5 bg-raised rounded-control text-[0.88em] grid gap-1 [overflow-wrap:anywhere]"
		>
			<For each={lines()}>
				{(entry) => (
					<div>
						<span class="inline-block w-16 text-muted">{entry.label}</span>
						<span>
							<For each={entry.list}>
								{(raw, i) => (
									<>
										{person(raw, entry.label === "From" ? props.email.from_name : null)}{" "}
										<span class="text-muted">{parseEmailAddress(raw)}</span>
										{i() < entry.list.length - 1 ? ", " : ""}
									</>
								)}
							</For>
						</span>
					</div>
				)}
			</For>
		</div>
	);
};

/** List mail: the sender's unsubscribe (one-click, mailto, or their page). */
const Unsubscribe: Component<{
	email: Email;
	onDone: (text: string, type: "success" | "error" | "info") => void;
}> = (props) => {
	const [state, setState] = createSignal<"idle" | "pending" | "done">("idle");
	const run = async () => {
		if (state() !== "idle") return;
		setState("pending");
		try {
			const result = await api.emails.unsubscribe(props.email.id);
			if (result.outcome === "link" && result.url) {
				window.open(result.url, "_blank", "noopener,noreferrer");
				props.onDone("Finish unsubscribing on the sender's page.", "info");
			} else {
				props.onDone(
					result.method === "mailto" ? "Unsubscribe request sent." : "Unsubscribed.",
					"success",
				);
			}
			setState("done");
		} catch (error) {
			setState("idle");
			props.onDone(
				error instanceof Error ? error.message : "Unsubscribe failed. Try again.",
				"error",
			);
		}
	};
	return (
		<Show when={state() !== "done"}>
			<button
				type="button"
				class="mt-1.5 text-[0.9em] font-medium text-accent hover:underline disabled:opacity-60"
				disabled={state() === "pending"}
				onClick={run}
			>
				{state() === "pending" ? "Unsubscribing…" : "Unsubscribe"}
			</button>
		</Show>
	);
};

export default MessageBox;
