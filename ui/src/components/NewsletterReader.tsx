import { type Component, createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { ApiHttpError, api } from "../api/client";
import { useApp } from "../store/app";
import type { Email } from "../types";
import { fullDate } from "../utils/date";
import { buildEmailFrame } from "../utils/email-render";
import { inferGoogleInviteAccount, withGoogleInviteAuthUser } from "../utils/google-invite-links";
import { parseSenderName } from "../utils/sender";
import EmailHtmlFrame from "./EmailHtmlFrame";
import { FileList } from "./FileCard";

interface NewsletterReaderProps {
	/** The conversation's one message (bulk: isBulk in utils/thread-text.ts). */
	email: Email;
	subject: string | null;
}

type Unsubscribe =
	| { step: "ready" }
	| { step: "sending" }
	| { step: "done" }
	| { step: "link"; url: string }
	| { step: "failed"; reason: string };

/**
 * A newsletter, receipt or notice (round-2 spec S3, options A and C): subject, one sender line
 * (name, "to me", date, Unsubscribe when the mail has List-Unsubscribe), then the sender's HTML
 * across the whole reading column with no border around it, edge to edge on a phone. In dark mode a
 * sender's own dark CSS applies; a light-only mail can be dimmed (NI-16).
 *
 * Draws its own column: mount it bare, not inside the thread's padded column.
 */
const NewsletterReader: Component<NewsletterReaderProps> = (props) => {
	const [state] = useApp();
	const [dim, setDim] = createSignal(false);
	const [unsub, setUnsub] = createSignal<Unsubscribe>({ step: "ready" });

	const frame = createMemo(() => {
		const e = props.email;
		const inviteAccount = inferGoogleInviteAccount(e);
		return buildEmailFrame(e.html_content ?? "", {
			attachments: e.attachments,
			emailId: e.id,
			title: e.subject || "Email content",
			allowRemoteImages: true,
			rewriteLink: (href) => withGoogleInviteAuthUser(href, inviteAccount),
			scheme: state.appearance === "dark" ? "dark" : "light",
		});
	});
	const drawnDark = () => state.appearance === "dark" && frame().ownDark;
	const offerDim = () => state.appearance === "dark" && !frame().ownDark;

	// Only on the click: the server tries one-click, then mailto, else hands back the sender's page
	// (CLAUDE.md "Manual unsubscribe"). A failure never reads as done.
	const unsubscribe = async () => {
		if (unsub().step === "sending") return;
		setUnsub({ step: "sending" });
		try {
			const result = await api.emails.unsubscribe(props.email.id);
			if (result.outcome === "link" && result.url) {
				setUnsub({ step: "link", url: result.url });
				window.open(result.url, "_blank", "noopener,noreferrer");
			} else {
				setUnsub({ step: "done" });
			}
		} catch (error) {
			setUnsub({
				step: "failed",
				reason:
					error instanceof ApiHttpError
						? error.message
						: "You're offline. Try again once you're back online.",
			});
		}
	};

	const handoffUrl = () => {
		const u = unsub();
		return u.step === "link" ? u.url : null;
	};
	const failure = () => {
		const u = unsub();
		return u.step === "failed" ? u.reason : null;
	};
	const sender = () => parseSenderName(props.email.from_address, props.email.from_name);

	return (
		<article data-testid="newsletter-reader" class="w-full pt-5 text-text md:pt-0">
			<h1 class="mc-title mb-3.5 px-5 text-[24px] leading-tight [overflow-wrap:anywhere] md:mb-[18px] md:px-0 md:text-[26px]">
				{props.subject || props.email.subject || "(no subject)"}
			</h1>
			<div
				data-testid="newsletter-head"
				class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 px-5 md:px-0"
			>
				<span class="min-w-0 text-[15px] font-semibold [overflow-wrap:anywhere]">{sender()}</span>
				<time class="whitespace-nowrap text-[0.88em] text-muted">
					{fullDate(props.email.received_at || props.email.sent_at || 0)}
				</time>
				<span class="text-[0.9em] text-muted">to me</span>
				<span class="flex flex-wrap items-baseline justify-end gap-x-4 text-[0.9em]">
					<Show when={offerDim()}>
						<button
							type="button"
							class="font-medium text-accent hover:underline"
							aria-pressed={dim()}
							onClick={() => setDim(!dim())}
						>
							Dim email
						</button>
					</Show>
					<Show when={props.email.list_unsubscribe}>
						<Switch>
							<Match when={unsub().step === "ready"}>
								<button
									type="button"
									class="font-medium text-accent hover:underline"
									onClick={unsubscribe}
								>
									Unsubscribe
								</button>
							</Match>
							<Match when={unsub().step === "sending"}>
								<span role="status" class="text-muted">
									Unsubscribing…
								</span>
							</Match>
							<Match when={unsub().step === "done"}>
								<span role="status" class="text-muted">
									Unsubscribed
								</span>
							</Match>
							<Match when={handoffUrl()}>
								{(url) => (
									<a
										href={url()}
										target="_blank"
										rel="noopener noreferrer"
										class="font-medium text-accent hover:underline"
									>
										Finish on the unsubscribe page
									</a>
								)}
							</Match>
							<Match when={failure()}>
								{(reason) => (
									<>
										<span role="status" class="text-neg">
											Couldn't unsubscribe. {reason()}
										</span>
										<button
											type="button"
											class="font-medium text-accent hover:underline"
											onClick={unsubscribe}
										>
											Try again
										</button>
									</>
								)}
							</Match>
						</Switch>
					</Show>
				</span>
			</div>
			<div class="mt-3.5 md:border-0 md:border-t md:border-solid md:border-rule">
				<EmailHtmlFrame
					srcdoc={frame().srcdoc}
					title={props.email.subject || "Email content"}
					dark={drawnDark()}
					dim={dim() && offerDim()}
				/>
			</div>
			<div class="px-5 md:px-0">
				<FileList email={props.email} />
			</div>
		</article>
	);
};

export default NewsletterReader;
