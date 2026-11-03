/**
 * One compose window's draft: its fields, the server draft (autosave), the copy kept on this device
 * (lib/db.ts compose_drafts) and sending. The surfaces (InlineComposer under a thread, the New
 * message ComposeWindow, the phone sheet, the dock chip) only draw it, so a reply moving between
 * them (leaving its thread, a reload) never loses text. Moved out of the 2,700-line ComposeWindow
 * for the round-2 redesign (S5); the guarantees are CLAUDE.md's "Compose" paragraph.
 */
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ApiHttpError, api } from "../../api/client";
import { getConversationDetailCached } from "../../lib/cache";
import {
	currentIdentityTag,
	deleteLocalComposeDraft,
	getLocalComposeDraft,
	holdComposeWindow,
	type LocalComposeDraft,
	MAX_LOCAL_ATTACHMENT_BYTES,
	putLocalComposeDraft,
	registerLocalComposeFlush,
	StaleIdentity,
	takeClosedComposeDraft,
} from "../../lib/db";
import { endsComposition } from "../../lib/shortcuts";
import { useApp } from "../../store/app";
import type { ContactSuggestion, Email, SendAttachment } from "../../types";
import {
	buildForwardDraftPayload,
	buildPlainReplyBody,
	buildReplyRecipients,
	withCanonicalSubjectPrefix,
} from "../../utils/reply-format";
import { parseSenderName, personName } from "../../utils/sender";
import {
	buildComposeBodyPayload,
	composeText,
	formatComposeSavedAt,
	hasComposeDraftContent,
	normalizeComposeText,
	parseComposeRecipients,
	validateAndDeduplicateReferences,
} from "./compose-draft";

/** Where a window is drawn (Compose.tsx decides). "none": sending, nothing to show. */
export type ComposePlacement = "inline" | "window" | "sheet" | "dock" | "none";
/** preparing: saving the draft before the send is queued; queued: the 5-second Undo runs. */
export type SendState = "idle" | "preparing" | "queued" | "sending" | "sent" | "failed" | "unknown";
type DraftSaveState = "idle" | "saving" | "saved" | "failed";
type AttachmentLoadState = "idle" | "loading" | "ready" | "failed";
export type RecipientField = "to" | "cc" | "bcc";
/** A field the person can change by hand (a Reply/Forward source never overwrites one). */
type ComposeField = RecipientField | "from" | "subject" | "body" | "quote" | "attachments";
type RecipientToken = { start: number; end: number; query: string };
type DraftConflictState = { latestDraft: Email; latestSavedAt: number | null };

/** How long Send waits for Undo (r2 build spec, S5). The draft is on the server meanwhile. */
export const UNDO_SEND_MS = 5000;
const RECIPIENT_SUGGESTION_DEBOUNCE_MS = 220;
const RECIPIENT_SUGGESTION_MIN_REMOTE_QUERY = 2;
const RECIPIENT_TYPING_IDLE_MS = 450;
const RECIPIENT_SUGGESTION_CACHE = new Map<string, ContactSuggestion[]>();
const MAX_AUTO_SAVE_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];
/** Every edit is written to this device this soon, well before the server autosave. */
const LOCAL_WRITE_MS = 250;

export function getAttachmentByteLength(attachment: SendAttachment): number {
	const normalized = attachment.content_base64.replace(/\s+/g, "");
	const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeRecipientQuery(value: string): string {
	return value.trim().toLowerCase();
}

function scoreCachedRecipientSuggestion(query: string, suggestion: ContactSuggestion): number {
	const normalizedQuery = normalizeRecipientQuery(query);
	if (!normalizedQuery) return 0;
	const address = suggestion.address.toLowerCase();
	const name = suggestion.name?.toLowerCase() ?? "";
	const localPart = address.split("@")[0] ?? "";

	if (address === normalizedQuery || name === normalizedQuery) return 1000;
	if (name.startsWith(normalizedQuery)) return 900;
	if (localPart.startsWith(normalizedQuery)) return 850;
	if (address.startsWith(normalizedQuery)) return 800;
	if (name.includes(normalizedQuery)) return 700;
	if (localPart.includes(normalizedQuery)) return 650;
	if (address.includes(normalizedQuery)) return 600;
	return 0;
}

function filterCachedRecipientSuggestions(
	suggestions: ContactSuggestion[],
	query: string,
	limit = 8,
): ContactSuggestion[] {
	const normalizedQuery = normalizeRecipientQuery(query);
	if (!normalizedQuery) {
		return suggestions.slice(0, Math.max(1, limit));
	}

	return suggestions
		.filter((suggestion) => scoreCachedRecipientSuggestion(normalizedQuery, suggestion) > 0)
		.sort((left, right) => {
			const scoreDiff =
				scoreCachedRecipientSuggestion(normalizedQuery, right) -
				scoreCachedRecipientSuggestion(normalizedQuery, left);
			if (scoreDiff !== 0) return scoreDiff;
			return (right.last_seen_at ?? 0) - (left.last_seen_at ?? 0);
		})
		.slice(0, Math.max(1, limit));
}

function getCachedRecipientSuggestions(query: string, limit = 8): ContactSuggestion[] {
	const normalizedQuery = normalizeRecipientQuery(query);
	const direct = RECIPIENT_SUGGESTION_CACHE.get(normalizedQuery);
	if (direct) {
		return direct.slice(0, Math.max(1, limit));
	}

	let bestKey = "";
	let bestSuggestions: ContactSuggestion[] | null = null;
	for (const [cachedQuery, suggestions] of RECIPIENT_SUGGESTION_CACHE) {
		if (!normalizedQuery.startsWith(cachedQuery) && !cachedQuery.startsWith(normalizedQuery))
			continue;
		if (cachedQuery.length <= bestKey.length) continue;
		bestKey = cachedQuery;
		bestSuggestions = suggestions;
	}

	if (bestSuggestions) {
		return filterCachedRecipientSuggestions(bestSuggestions, normalizedQuery, limit);
	}

	return [];
}

function getRecipientToken(raw: string, caret: number): RecipientToken {
	const boundedCaret = Math.max(0, Math.min(caret, raw.length));
	let start = boundedCaret;
	let end = boundedCaret;

	while (start > 0 && !/[;,]/.test(raw[start - 1])) start--;
	while (end < raw.length && !/[;,]/.test(raw[end])) end++;

	return {
		start,
		end,
		query: raw.slice(start, end).trim(),
	};
}

const getErrorMessage = (value: unknown, fallback: string) =>
	value instanceof Error ? value.message : fallback;

const getApiErrorCode = (value: unknown) =>
	value instanceof ApiHttpError
		? (value.body as { error?: { code?: string } } | undefined)?.error?.code
		: undefined;

/** The saved draft was sent or removed elsewhere and this window held nothing newer. */
class DraftGone extends Error {}

export interface ComposeDraftOptions {
	windowId: string;
	isFocused: () => boolean;
	placement: () => ComposePlacement;
}

export function createComposeDraft(opts: ComposeDraftOptions) {
	const [state, actions] = useApp();
	const windowId = opts.windowId;
	const sendConfigured = () => state.meta?.features.send_configured ?? true;
	const composeWindow = createMemo(
		() => state.composeWindows.find((window) => window.id === windowId) ?? null,
	);
	const editingDraftId = () => composeWindow()?.draftId ?? null;
	const replyTo = () => composeWindow()?.replyTo ?? null;
	const isMinimized = () => composeWindow()?.minimized ?? false;
	const closeRequestKey = () => composeWindow()?.closeRequestKey ?? 0;
	const fieldId = (suffix: string) => `compose-${windowId}-${suffix}`;

	/** The surface currently drawing this window registers its elements here. */
	const refs: {
		root?: HTMLElement;
		to?: HTMLInputElement;
		cc?: HTMLInputElement;
		bcc?: HTMLInputElement;
		body?: HTMLTextAreaElement;
		file?: HTMLInputElement;
	} = {};

	const preferredDomains = () => {
		const configuredDomains = state.meta?.configured_domains ?? [];
		return [...new Set(configuredDomains.map((domain) => domain.toLowerCase()))];
	};

	const sortAddresses = (values: Iterable<string>) => {
		const domainOrder = preferredDomains();
		return [...new Set(values)].filter(Boolean).sort((left, right) => {
			const [leftLocal = "", leftDomain = ""] = left.toLowerCase().split("@");
			const [rightLocal = "", rightDomain = ""] = right.toLowerCase().split("@");
			const leftDomainRank = domainOrder.indexOf(leftDomain);
			const rightDomainRank = domainOrder.indexOf(rightDomain);

			if (leftDomainRank !== rightDomainRank) {
				return (
					(leftDomainRank === -1 ? Number.MAX_SAFE_INTEGER : leftDomainRank) -
					(rightDomainRank === -1 ? Number.MAX_SAFE_INTEGER : rightDomainRank)
				);
			}

			if (leftLocal === "noreply" && rightLocal !== "noreply") return 1;
			if (rightLocal === "noreply" && leftLocal !== "noreply") return -1;

			return left.localeCompare(right);
		});
	};

	const [from, setFrom] = createSignal("");
	const [to, setTo] = createSignal("");
	const [cc, setCc] = createSignal("");
	const [bcc, setBcc] = createSignal("");
	const [subject, setSubject] = createSignal("");
	const [bodyText, setBodyText] = createSignal("");
	/** The quoted original (reply) or forwarded message, sent under the typed text. */
	const [quote, setQuote] = createSignal<string | null>(null);
	const [quoteShown, setQuoteShown] = createSignal(false);
	const [showCcBcc, setShowCcBcc] = createSignal(false);
	/** A reply shows its recipients as chips until "Edit" turns them into fields. */
	const [recipientsAsFields, setRecipientsAsFields] = createSignal(false);
	/** The message being answered or forwarded (names for the chips, the people reply-all adds). */
	const [original, setOriginal] = createSignal<Email | null>(null);
	const [replyOthers, setReplyOthers] = createSignal<string[]>([]);
	const [attachments, setAttachments] = createSignal<SendAttachment[]>([]);
	const [attachmentLoadState, setAttachmentLoadState] = createSignal<AttachmentLoadState>("idle");
	const [expectedAttachmentCount, setExpectedAttachmentCount] = createSignal(0);
	const [sendState, setSendState] = createSignal<SendState>("idle");
	const [draftSaveState, setDraftSaveState] = createSignal<DraftSaveState>("idle");
	const [error, setError] = createSignal("");
	const [draftId, setDraftId] = createSignal<string | null>(null);
	const [draftRevision, setDraftRevision] = createSignal(0);
	const [lastSavedAt, setLastSavedAt] = createSignal<number | null>(null);
	const [draftConflict, setDraftConflict] = createSignal<DraftConflictState | null>(null);
	const [hydratingDraft, setHydratingDraft] = createSignal(false);
	const [hasUserEdits, setHasUserEdits] = createSignal(false);
	/** The fields the person changed: a Reply/Forward source landing later fills only the others. */
	const touched = new Set<ComposeField>();
	const [dirtyAttachments, setDirtyAttachments] = createSignal(false);
	const [inReplyTo, setInReplyTo] = createSignal<string | undefined>();
	const [references, setReferences] = createSignal<string | undefined>();
	const [recipientSuggestions, setRecipientSuggestions] = createSignal<ContactSuggestion[]>([]);
	const [showRecipientSuggestions, setShowRecipientSuggestions] = createSignal(false);
	const [activeRecipientSuggestion, setActiveRecipientSuggestion] = createSignal(0);
	const [activeRecipientField, setActiveRecipientField] = createSignal<RecipientField | null>(null);
	const [recipientTyping, setRecipientTyping] = createSignal(false);
	const [crossTabWarning, setCrossTabWarning] = createSignal(false);
	// The server refused this exact draft (4xx, e.g. "Invalid email address" for a half-typed To):
	// retrying the same body can't succeed, so autosave waits for the next edit (m1-04: it posted
	// it about once a second and said "will retry" forever).
	const [rejectedDraft, setRejectedDraft] = createSignal<{
		snapshot: string;
		message: string;
	} | null>(null);
	let composeChannel: BroadcastChannel | undefined;
	/** Tell this identity's other compose windows and tabs about a draft (never another identity's). */
	const postToWindows = (
		type: "compose-open" | "compose-close" | "compose-done",
		id: string | null,
	) => {
		const identity = currentIdentityTag();
		if (identity) composeChannel?.postMessage({ type, draftId: id, identity });
	};
	let recipientSuggestionToken: RecipientToken | null = null;
	let recipientSuggestionTimer: ReturnType<typeof setTimeout> | undefined;
	let recipientSuggestionHideTimer: ReturnType<typeof setTimeout> | undefined;
	let recipientSuggestionRequest = 0;
	let recipientSuggestionAbortController: AbortController | undefined;
	let recipientTypingTimer: ReturnType<typeof setTimeout> | undefined;
	let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
	// Guard against a debounced / in-flight / close-triggered draft save racing
	// a discard (delete): without it a trailing PATCH lands after the DELETE and
	// 404s in the console. saveDraftNow() bails while this is true.
	let discarding = false;
	let lastSavedDraftSnapshot = "";
	let saveChain: Promise<string | null> = Promise.resolve(null);
	let autoSaveRetryCount = 0;
	let handledComposeCloseRequestKey = 0;
	let attachmentHydrationSource: Email | null = null;
	let attachmentHydrationMarksDirty = false;
	let attachmentHydrationKeepsAdded = false;
	let sendTimer: ReturnType<typeof setTimeout> | undefined;
	let undoToastId: string | null = null;
	/** Set while the 5-second Undo runs; kept on this device so a reload can say it never went out. */
	let sendPendingAt: number | null = null;

	const setComposeBodyText = (value: string) => {
		setBodyText(normalizeComposeText(value));
	};
	/** What goes out: the typed text, then the quote unless it was cleared. */
	const messageText = () => composeText(bodyText(), quote());

	const resetComposeDraftState = () => {
		setDraftId(null);
		setDraftRevision(0);
		setLastSavedAt(null);
		setDraftConflict(null);
		setHasUserEdits(false);
		setDirtyAttachments(false);
		touched.clear();
		lastSavedDraftSnapshot = "";
	};

	const markUserEdited = (field?: ComposeField) => {
		if (!hydratingDraft()) {
			setHasUserEdits(true);
			if (field) touched.add(field);
		}
	};

	// ── Kept on this device (lib/db.ts compose_drafts) ──
	// Every edit is written locally (debounced LOCAL_WRITE_MS, well before the server autosave),
	// so a reload, a crash or an ended Access session never loses the text or new attachments.
	// localKept says whether that is true right now; nothing reloads the page while it is not.
	let localReady = false; // bootstrap done: from here on, edits are written locally
	let localDeleted = false; // sent, discarded or closed: never write again
	/** This tab's hold on the open window (lib/db.ts holdComposeWindow); let go when it closes. */
	let releaseWindow: (() => void) | undefined;
	/** Another tab has this window open: this one leaves it alone and writes nothing. */
	let openElsewhere = false;
	let localServerSavedAt: number | null = null;
	let localWriteTimer: ReturnType<typeof setTimeout> | undefined;
	// The saved draft's files could not be loaded into this window (server unreachable on
	// restore): records keep saying "omitted" and saves leave the server's files alone.
	let localAttachmentsPending = false;
	const [localKept, setLocalKept] = createSignal<"yes" | "no-storage" | "no-files" | "no-identity">(
		"yes",
	);

	const buildLocalDraft = (): LocalComposeDraft => {
		const files = attachments();
		const bytes = files.reduce((sum, file) => sum + getAttachmentByteLength(file), 0);
		const omitted = bytes > MAX_LOCAL_ATTACHMENT_BYTES || localAttachmentsPending;
		const target = replyTo();
		return {
			id: windowId,
			draftId: draftId() ?? editingDraftId(),
			draftRevision: draftRevision(),
			replyTo: target
				? {
						emailId: target.emailId,
						mode: target.mode,
						conversationId: target.conversationId ?? null,
					}
				: null,
			minimized: isMinimized(),
			fields: {
				from: from(),
				to: to(),
				cc: cc(),
				bcc: bcc(),
				subject: subject(),
				text: bodyText(),
				html: null,
				editorStateJson: null,
				inReplyTo: inReplyTo() ?? null,
				references: references() ?? null,
				quote: quote(),
			},
			attachments: omitted ? [] : files.map((file) => ({ ...file })),
			attachmentsOmitted: omitted,
			// Exactly what the server last saved: stamp it with that save, so a reload loads the
			// server copy. Anything newer stays "unsaved" and is pushed again after the reload.
			updatedAt:
				localServerSavedAt != null &&
				getDraftSnapshot() === lastSavedDraftSnapshot &&
				!dirtyAttachments()
					? localServerSavedAt
					: Date.now(),
			serverSavedAt: localServerSavedAt,
			sendPendingAt,
		};
	};

	/** Worth keeping: the user changed something, or it is a saved draft. */
	const shouldKeepLocally = () =>
		hasUserEdits() || dirtyAttachments() || Boolean(draftId() ?? editingDraftId());

	/**
	 * Write the window to this device now. True when a reload would lose nothing: this device
	 * holds the text and the files, or the files it could not keep are already on the server.
	 */
	const writeLocalNow = async (): Promise<boolean> => {
		if (localWriteTimer) clearTimeout(localWriteTimer);
		if (localDeleted || discarding || sendState() === "sent") return true;
		// Still loading (a reply quote, a saved draft): nothing typed yet, a reload loads it again.
		if (!localReady) return !hasUserEdits();
		if (!shouldKeepLocally()) return true;
		try {
			const record = buildLocalDraft();
			await putLocalComposeDraft(record);
			const filesSafe =
				!record.attachmentsOmitted || (Boolean(record.draftId) && !dirtyAttachments());
			setLocalKept(filesSafe ? "yes" : "no-files");
			return filesSafe;
		} catch (error) {
			// Signed out, or someone else signed in: nothing is written under another identity.
			if (error instanceof StaleIdentity) {
				setLocalKept("no-identity");
				return false;
			}
			console.warn("Draft could not be kept on this device:", error);
			setLocalKept("no-storage");
			return false;
		}
	};

	const dropLocalDraft = async () => {
		localDeleted = true;
		if (localWriteTimer) clearTimeout(localWriteTimer);
		await deleteLocalComposeDraft(windowId).catch(() => {});
	};

	/**
	 * Close (Cancel) keeps the words on this device, as the apps' DraftShelf does (BUILD QUESTION 1,
	 * 2026-10-26): the next New message in its account, Reply in its thread or its Drafts row
	 * brings it back (takeClosed) until it is sent or discarded. Nothing typed, or a saved reply
	 * outside any thread (opened from Drafts): only Drafts has it, as before.
	 */
	const keepClosed = async () => {
		const target = replyTo();
		if (!shouldKeepLocally() || (target ? !target.conversationId : inReplyTo())) {
			return dropLocalDraft();
		}
		localDeleted = true;
		if (localWriteTimer) clearTimeout(localWriteTimer);
		const record = { ...buildLocalDraft(), minimized: false, closedAt: Date.now() };
		await putLocalComposeDraft(record).catch(() => {});
	};

	/**
	 * A window just opened takes what was closed for it: a Drafts row its own draft, Reply its
	 * thread's reply (one per thread, as open windows), New the account's newest new message (All
	 * accounts: any). Read before the window fills, so it never lands over typing.
	 */
	const takeClosed = () => {
		const opened = editingDraftId();
		const target = replyTo();
		const domain = state.activeDomain?.toLowerCase();
		return takeClosedComposeDraft(windowId, (kept) => {
			if (opened) return kept.draftId === opened;
			if (target) {
				const thread = target.conversationId;
				return Boolean(
					kept.replyTo &&
						((thread && kept.replyTo.conversationId === thread) ||
							kept.replyTo.emailId === target.emailId),
				);
			}
			return (
				!kept.replyTo &&
				!kept.fields.inReplyTo &&
				(!domain || kept.fields.from.toLowerCase().endsWith(`@${domain}`))
			);
		}).catch(() => undefined);
	};

	/** What New or Reply brought back was sent or deleted elsewhere: a blank window instead. */
	const startOver = () => {
		setHydratingDraft(true);
		setFrom("");
		setTo("");
		setCc("");
		setBcc("");
		setShowCcBcc(false);
		setSubject("");
		setComposeBodyText("");
		setQuote(null);
		setInReplyTo(undefined);
		setReferences(undefined);
		setAttachments([]);
		setExpectedAttachmentCount(0);
		setAttachmentLoadState("idle");
		setError("");
		setHydratingDraft(false);
		resetComposeDraftState();
		localServerSavedAt = null;
		actions.setComposeWindowDraftId(windowId, null);
	};

	/** Recipients' names for the chips: the message's own headers first, then the address. */
	const nameFor = (address: string): string => {
		const key = address.trim().toLowerCase();
		const email = original();
		if (email) {
			if (email.from_address?.toLowerCase() === key && email.from_name?.trim()) {
				return personName(email.from_name.trim());
			}
			const participant = email.thread_participants?.find(
				(entry) => entry.address?.toLowerCase() === key,
			);
			if (participant?.name?.trim()) return personName(participant.name.trim());
		}
		return parseSenderName(address);
	};

	const takeOriginal = (email: Email, mode: string) => {
		setOriginal(email);
		if (mode !== "forward") setReplyOthers(buildReplyRecipients(email, fromOptions()).cc);
	};
	/** The message being answered, for chips and reply-all, when a reopened window lacks it. */
	const loadOriginal = (target: { emailId: string; mode: string }) => {
		void api.emails
			.get(target.emailId)
			.then((email) => takeOriginal(email, target.mode))
			.catch(() => {});
	};
	/**
	 * A saved reply opened from its conversation's row (ux-w-p1-2) knows its thread, not the message
	 * it answers: find that by In-Reply-To in the thread, so the chips name people as Reply's do.
	 */
	const findOriginal = (draft: Email) => {
		const target = replyTo();
		if (!target?.conversationId || !draft.in_reply_to) return;
		void getConversationDetailCached(target.conversationId, { load: "full" })
			.then((detail) => {
				const answered = detail.emails.find((e) => e.message_id === draft.in_reply_to);
				const now = replyTo();
				if (!answered || !now) return;
				takeOriginal(answered, now.mode);
				actions.setComposeReplyTo(windowId, { ...now, emailId: answered.id });
			})
			.catch(() => {});
	};

	/**
	 * Fill the window from what this device kept. The kept fields go in first: a server copy that
	 * cannot be fetched never becomes a blank edit (2026-10-22 review F2). A saved draft is then
	 * checked against the server: sent or removed there closes it (DraftGone) unless this device
	 * holds newer text, which stays as a new draft (F5).
	 */
	const applyLocalDraft = async (local: LocalComposeDraft) => {
		localServerSavedAt = local.serverSavedAt;
		const unsaved = local.serverSavedAt == null || local.updatedAt > local.serverSavedAt;
		setHydratingDraft(true);
		try {
			const f = local.fields;
			if (local.draftId) {
				setDraftId(local.draftId);
				actions.setComposeWindowDraftId(windowId, local.draftId);
			}
			setDraftRevision(local.draftRevision);
			setFrom(f.from || from());
			setTo(f.to);
			setCc(f.cc);
			setBcc(f.bcc);
			setShowCcBcc(Boolean(f.cc || f.bcc));
			setSubject(f.subject);
			setComposeBodyText(f.text);
			setQuote(f.quote ?? null);
			setInReplyTo(f.inReplyTo ?? undefined);
			setReferences(f.references ?? undefined);
			if (!local.attachmentsOmitted) {
				setAttachments(local.attachments);
				setExpectedAttachmentCount(local.attachments.length);
				setAttachmentLoadState("ready");
			}
		} finally {
			setHydratingDraft(false);
		}
		if (local.replyTo) loadOriginal(local.replyTo);
		if (local.sendPendingAt) {
			setError("Not sent: the page closed before it went out. Send it again when you're ready.");
		}
		const keepAsUnsaved = () => {
			// Not on the server yet: the autosave sends it (a newer server copy shows the conflict bar).
			setHasUserEdits(true);
			setDirtyAttachments(!local.attachmentsOmitted);
		};

		if (!local.draftId) {
			if (local.attachmentsOmitted) {
				setAttachmentLoadState("ready");
				setError("Attachments over 20 MB weren't kept on this device. Add them again.");
			}
			keepAsUnsaved();
			return;
		}

		let server: Email;
		try {
			server = await api.emails.get(local.draftId);
		} catch (error) {
			if (error instanceof ApiHttpError && (error.status === 404 || error.status === 403)) {
				if (!unsaved) throw new DraftGone();
				server = { mailbox_state: "gone" } as unknown as Email;
			} else {
				// Server unreachable: keep exactly what this device holds; nothing is lost or blanked.
				if (local.attachmentsOmitted) {
					localAttachmentsPending = true;
					setAttachmentLoadState("failed");
					setError("This draft's attachments couldn't be loaded. Reload when you're back online.");
				}
				if (unsaved) {
					setHasUserEdits(true);
					setDirtyAttachments(!local.attachmentsOmitted);
				} else {
					syncLastSavedSnapshot();
				}
				return;
			}
		}

		if (server.mailbox_state !== "draft") {
			if (!unsaved) throw new DraftGone();
			// Newer text than the server ever saw: keep it, as a new draft.
			setDraftId(null);
			actions.setComposeWindowDraftId(windowId, null);
			setDraftRevision(0);
			localServerSavedAt = null;
			if (local.attachmentsOmitted) setAttachmentLoadState("ready");
			keepAsUnsaved();
			setError(
				"This draft was sent or deleted somewhere else. Your unsaved changes are kept here as a new draft.",
			);
			return;
		}
		if (!unsaved) {
			await applyDraftToCompose(server, {
				text: local.fields.text,
				quote: local.fields.quote ?? null,
			});
			if (local.sendPendingAt) {
				setError("Not sent: the page closed before it went out. Send it again when you're ready.");
			}
			return;
		}
		if (local.attachmentsOmitted) {
			// Too large to keep here: take the saved draft's files.
			await hydrateAttachments(server);
			setHasUserEdits(true);
			return;
		}
		keepAsUnsaved();
	};

	const canApplyInitialFocus = () =>
		opts.isFocused() && !refs.root?.contains(document.activeElement);

	const requestBodyFocus = (delay = 100) => {
		setTimeout(() => {
			if (!canApplyInitialFocus()) return;
			refs.body?.focus();
		}, delay);
	};

	const requestToFocus = () => {
		setTimeout(() => {
			if (canApplyInitialFocus()) refs.to?.focus();
		}, 100);
	};

	const hydrateAttachments = async (
		email: Email,
		options?: { markDirty?: boolean; keepAdded?: boolean },
	) => {
		attachmentHydrationSource = email;
		attachmentHydrationMarksDirty = options?.markDirty ?? false;
		attachmentHydrationKeepsAdded = options?.keepAdded ?? false;
		// keepAdded: files the person attached before the source arrived stay, after its own.
		const added = () => (attachmentHydrationKeepsAdded ? attachments() : []);
		setExpectedAttachmentCount((email.attachments?.length ?? 0) + added().length);
		if (!email.attachments || email.attachments.length === 0) {
			setAttachments(added());
			setAttachmentLoadState("ready");
			setDirtyAttachments(added().length > 0);
			return;
		}

		setAttachmentLoadState("loading");
		try {
			const hydrated = await Promise.all(
				email.attachments.map(async (att): Promise<SendAttachment> => {
					const url = api.emails.attachmentUrl(email.id, att.id);
					const res = await fetch(url, { credentials: "same-origin" });
					if (!res.ok) {
						throw new Error(`Couldn't prepare ${att.filename || "an attachment"} (${res.status})`);
					}
					const buffer = await res.arrayBuffer();
					const bytes = new Uint8Array(buffer);
					let binary = "";
					for (let i = 0; i < bytes.length; i++) {
						binary += String.fromCharCode(bytes[i]);
					}
					return {
						filename: att.filename || "attachment",
						content_type: att.mime_type || "application/octet-stream",
						content_base64: btoa(binary),
						content_id: att.content_id || undefined,
						disposition: (att.disposition as "attachment" | "inline") || "attachment",
					} satisfies SendAttachment;
				}),
			);
			if (hydrated.length !== email.attachments.length) {
				throw new Error("Not every attachment could be prepared");
			}
			const kept = added();
			setAttachments([...hydrated, ...kept]);
			setDirtyAttachments((options?.markDirty ?? false) || kept.length > 0);
			setAttachmentLoadState("ready");
		} catch (error) {
			setAttachmentLoadState("failed");
			throw error;
		}
	};

	const retryAttachmentHydration = async () => {
		if (!attachmentHydrationSource) return;
		setError("");
		try {
			await hydrateAttachments(attachmentHydrationSource, {
				markDirty: attachmentHydrationMarksDirty,
				keepAdded: attachmentHydrationKeepsAdded,
			});
		} catch (error) {
			setError(getErrorMessage(error, "Attachments could not be prepared"));
		}
	};

	const syncLastSavedSnapshot = () => {
		lastSavedDraftSnapshot = getDraftSnapshot();
	};

	const syncComposeBootstrapSnapshot = () => {
		if (!draftId()) {
			lastSavedDraftSnapshot = getDraftSnapshot();
		}
	};

	/**
	 * Fill the window from a server draft. `split`: what this device kept of the same content, so
	 * a reply reopens with its quote still under "Quoted text" instead of inside the typed text.
	 */
	const applyDraftToCompose = async (
		draft: Email,
		split?: { text: string; quote: string | null },
	) => {
		setHydratingDraft(true);
		try {
			setDraftId(draft.id);
			setDraftRevision(draft.draft_revision ?? 0);
			setLastSavedAt(draft.received_at ?? null);
			setFrom(draft.from_address || from());
			setTo(draft.to_addresses.join(", "));
			setCc(draft.cc_addresses.join(", "));
			setBcc(draft.bcc_addresses.join(", "));
			setShowCcBcc(draft.cc_addresses.length > 0 || draft.bcc_addresses.length > 0);
			setSubject(draft.subject || "");
			const serverText = normalizeComposeText(draft.text_content || "");
			if (split && composeText(split.text, split.quote).trim() === serverText.trim()) {
				setComposeBodyText(split.text);
				setQuote(split.quote);
			} else {
				setComposeBodyText(serverText);
				setQuote(null);
			}
			setInReplyTo(draft.in_reply_to || undefined);
			setReferences(validateAndDeduplicateReferences(draft.references_header || undefined));
			let attachmentError: unknown = null;
			try {
				await hydrateAttachments(draft);
			} catch (error) {
				attachmentError = error;
			}
			setDraftConflict(null);
			if (!attachmentError) setError("");
			setDraftSaveState(hasDraftContent() ? "saved" : "idle");
			setHasUserEdits(false);
			syncLastSavedSnapshot();
			syncComposeBootstrapSnapshot();
			localServerSavedAt = Date.now();
			if (attachmentError) throw attachmentError;
		} finally {
			setHydratingDraft(false);
		}
	};

	// Available from addresses — use allowed_senders if configured, otherwise derive from mailboxes
	const fromOptions = () => {
		const allowed = state.meta?.allowed_senders ?? [];
		if (allowed.length > 0) return sortAddresses(allowed);
		const domains = state.meta?.configured_domains ?? [];
		const addresses = new Set<string>();
		for (const d of state.meta?.active_domains ?? []) {
			for (const m of d.mailboxes) {
				addresses.add(m.address);
			}
		}
		for (const d of domains) {
			addresses.add(`noreply@${d}`);
		}
		return sortAddresses(addresses);
	};

	// New mail is From the account in view (a domain view: its first address in the sender
	// list), else the default: the first ALLOWED_SENDERS entry. Replies pick their own below.
	const defaultFrom = (options: string[]) => {
		const domain = state.activeDomain?.toLowerCase();
		const inView = domain
			? options.find((addr) => addr.toLowerCase().endsWith(`@${domain}`))
			: undefined;
		const preferred = state.meta?.allowed_senders?.[0];
		return inView ?? (preferred && options.includes(preferred) ? preferred : options[0]);
	};
	// Also when the sender list lands after the window opened (a phone tapping Compose before
	// /api/meta answered got an empty From that showed, and was read as, the first option).
	createEffect(() => {
		const options = fromOptions();
		if (options.length > 0 && !from()) setFrom(defaultFrom(options));
	});

	const getRecipientValue = (field: RecipientField) =>
		field === "to" ? to() : field === "cc" ? cc() : bcc();

	const setRecipientValue = (field: RecipientField, value: string) => {
		markUserEdited(field);
		if (field === "to") {
			setTo(value);
			return;
		}
		if (field === "cc") {
			setCc(value);
			return;
		}
		setBcc(value);
	};

	const getAllRecipientAddresses = () =>
		[to(), cc(), bcc()].flatMap((value) =>
			parseComposeRecipients(value).map((entry) => entry.toLowerCase()),
		);

	const setRecipientSuggestionsFromSource = (
		query: string,
		contacts: ContactSuggestion[],
		field: RecipientField,
	) => {
		const normalizedQuery = normalizeRecipientQuery(query);
		const existing = new Set(
			getAllRecipientAddresses().filter((value) => value !== normalizedQuery),
		);
		const filtered = contacts.filter((contact) => !existing.has(contact.address.toLowerCase()));
		setActiveRecipientField(field);
		setRecipientSuggestions(filtered);
		setShowRecipientSuggestions(filtered.length > 0);
		setActiveRecipientSuggestion(0);
	};

	const noteRecipientActivity = (settleDelay = RECIPIENT_TYPING_IDLE_MS) => {
		setRecipientTyping(true);
		if (recipientTypingTimer) clearTimeout(recipientTypingTimer);
		recipientTypingTimer = setTimeout(() => {
			setRecipientTyping(false);
		}, settleDelay);
	};

	const settleRecipientActivity = () => {
		if (recipientTypingTimer) clearTimeout(recipientTypingTimer);
		setRecipientTyping(false);
	};

	const clearRecipientSuggestions = () => {
		recipientSuggestionRequest += 1;
		if (recipientSuggestionTimer) clearTimeout(recipientSuggestionTimer);
		if (recipientSuggestionHideTimer) clearTimeout(recipientSuggestionHideTimer);
		recipientSuggestionAbortController?.abort();
		recipientSuggestionAbortController = undefined;
		recipientSuggestionToken = null;
		setRecipientSuggestions([]);
		setShowRecipientSuggestions(false);
		setActiveRecipientSuggestion(0);
		setActiveRecipientField(null);
		settleRecipientActivity();
	};

	const loadRecipientSuggestions = (field: RecipientField, raw: string, caret: number) => {
		const token = getRecipientToken(raw, caret);
		recipientSuggestionToken = token;
		setActiveRecipientField(field);
		noteRecipientActivity();

		if (recipientSuggestionTimer) clearTimeout(recipientSuggestionTimer);
		if (recipientSuggestionHideTimer) clearTimeout(recipientSuggestionHideTimer);
		recipientSuggestionAbortController?.abort();
		recipientSuggestionAbortController = undefined;

		const query = token.query;
		const normalizedQuery = normalizeRecipientQuery(query);
		// Nothing typed, nothing suggested (m1-03, 2026-10-23: a cleared field kept the longest
		// cached list open over Cc/Subject, and the next tap there added that person).
		if (!normalizedQuery) {
			clearRecipientSuggestions();
			return;
		}
		const cachedSuggestions = getCachedRecipientSuggestions(normalizedQuery, 8);
		if (cachedSuggestions.length > 0) {
			setRecipientSuggestionsFromSource(normalizedQuery, cachedSuggestions, field);
		}

		if (normalizedQuery.length < RECIPIENT_SUGGESTION_MIN_REMOTE_QUERY) {
			if (cachedSuggestions.length === 0) {
				setRecipientSuggestions([]);
				setShowRecipientSuggestions(false);
				setActiveRecipientSuggestion(0);
			}
			return;
		}

		recipientSuggestionTimer = setTimeout(async () => {
			const requestId = ++recipientSuggestionRequest;
			const controller = new AbortController();
			recipientSuggestionAbortController = controller;

			try {
				const { contacts } = await api.emails.suggestRecipients(normalizedQuery, 8, {
					signal: controller.signal,
				});
				if (
					requestId !== recipientSuggestionRequest ||
					recipientSuggestionAbortController !== controller
				) {
					return;
				}

				RECIPIENT_SUGGESTION_CACHE.set(normalizedQuery, contacts);
				setRecipientSuggestionsFromSource(normalizedQuery, contacts, field);
			} catch (e) {
				if (controller.signal.aborted) return;
				console.error("Failed to load recipient suggestions:", e);
				if (
					requestId !== recipientSuggestionRequest ||
					recipientSuggestionAbortController !== controller
				) {
					return;
				}
				setRecipientSuggestions([]);
				setShowRecipientSuggestions(false);
			} finally {
				if (recipientSuggestionAbortController === controller) {
					recipientSuggestionAbortController = undefined;
				}
			}
		}, RECIPIENT_SUGGESTION_DEBOUNCE_MS);
	};

	const applyRecipientSuggestion = (field: RecipientField, suggestion: ContactSuggestion) => {
		const inputRef = refs[field];
		const currentToken = recipientSuggestionToken;
		if (!inputRef || !currentToken) return;

		const currentValue = getRecipientValue(field);
		const prefix = currentValue.slice(0, currentToken.start);
		const suffix = currentValue.slice(currentToken.end);
		const nextValue = `${prefix ? `${prefix.trimEnd()} ` : ""}${suggestion.address}${suffix || ", "}`;
		const cursorOffset =
			`${prefix ? `${prefix.trimEnd()} ` : ""}${suggestion.address}`.length + (suffix ? 0 : 2);

		setRecipientValue(field, nextValue);
		clearRecipientSuggestions();
		settleRecipientActivity();

		requestAnimationFrame(() => {
			inputRef?.focus();
			inputRef?.setSelectionRange(cursorOffset, cursorOffset);
		});
	};

	const handleRecipientInput =
		(field: RecipientField) =>
		(e: InputEvent & { currentTarget: HTMLInputElement; target: Element }) => {
			const value = e.currentTarget.value;
			setRecipientValue(field, value);
			loadRecipientSuggestions(field, value, e.currentTarget.selectionStart ?? value.length);
		};

	const handleRecipientKeyDown =
		(field: RecipientField) =>
		(e: KeyboardEvent & { currentTarget: HTMLInputElement; target: Element }) => {
			// A key while an IME composes (Enter, Escape) is the composition's (R3 F3).
			if (endsComposition(e)) return;
			if (
				activeRecipientField() !== field ||
				!showRecipientSuggestions() ||
				recipientSuggestions().length === 0
			) {
				return;
			}

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveRecipientSuggestion((idx) => (idx + 1) % recipientSuggestions().length);
				return;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveRecipientSuggestion(
					(idx) => (idx - 1 + recipientSuggestions().length) % recipientSuggestions().length,
				);
				return;
			}

			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const suggestion = recipientSuggestions()[activeRecipientSuggestion()];
				if (suggestion) applyRecipientSuggestion(field, suggestion);
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				clearRecipientSuggestions();
			}
		};

	const handleRecipientBlur = () => {
		recipientSuggestionHideTimer = setTimeout(() => {
			setShowRecipientSuggestions(false);
			settleRecipientActivity();
		}, 120);
	};

	const sendBusy = () => {
		const s = sendState();
		return s === "preparing" || s === "queued" || s === "sending";
	};

	const canSend = () =>
		sendConfigured() &&
		Boolean(to().trim()) &&
		Boolean(from()) &&
		!sendBusy() &&
		sendState() !== "unknown" &&
		attachmentLoadState() !== "loading" &&
		attachmentLoadState() !== "failed";

	// Keyboard: Cmd/Ctrl+Enter sends, Escape leaves the composer. Only for keys inside it: a
	// second window or the thread around an inline reply has its own keys.
	const handleKeyDown = (e: KeyboardEvent) => {
		const target = e.target as Node | null;
		if (!refs.root || !target || !refs.root.contains(target)) return;
		if (e.key === "Escape") {
			if (e.defaultPrevented) return; // a recipient list closed itself
			// An IME's Escape cancels its candidate text (R3 F3); a held key repeats, and one press
			// closes one composer (F5).
			if (endsComposition(e) || e.repeat) return;
			e.preventDefault();
			// Inline: Escape leaves the field (the next one goes back to the list, as in the
			// thread); a window or the phone sheet closes, keeping the draft.
			if (opts.placement() === "inline") (document.activeElement as HTMLElement | null)?.blur();
			else void closeComposeWithSave();
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			if (canSend()) void handleSend();
			return;
		}
		// Toggle Cc/Bcc fields. Gmail uses ⌘⇧C / ⌘⇧B but Chrome reserves
		// ⌘⇧C for DevTools Inspect — the browser gets the keydown first and
		// the page never sees it. Map to ⌃⇧C / ⌃⇧B (which DO reach the page
		// on macOS) and to ⌘+Shift+Y as a Gmail-ish alias that nothing else
		// uses. Also stop propagation so any parent handler can't swallow it.
		const k = e.key.toLowerCase();
		const modDown = e.metaKey || e.ctrlKey;
		if (
			modDown &&
			e.shiftKey &&
			(k === "y" || (!e.metaKey && e.ctrlKey && (k === "c" || k === "b")))
		) {
			e.preventDefault();
			e.stopPropagation();
			setRecipientsAsFields(true);
			setShowCcBcc(!showCcBcc());
		}
	};

	onMount(async () => {
		document.addEventListener("keydown", handleKeyDown);

		// Every window, restored or new, writes itself to this device when the page hides or goes
		// away, before any asynchronous bootstrap below (review F4), and asks before a reload or
		// close when this device could not keep it or a send is still waiting for its Undo.
		const persistOnHide = () => {
			if (!document.hidden) return;
			void writeLocalNow();
			if (hasPendingDraftSave()) {
				void saveDraftNow({ includeAttachments: dirtyAttachments(), silent: true }).catch(() => {});
			}
		};
		const persistOnPageHide = () => {
			void writeLocalNow();
			if (hasPendingDraftSave()) {
				void saveDraftNow({ includeAttachments: dirtyAttachments(), silent: true }).catch(() => {});
			}
		};
		const warnBeforeUnload = (event: BeforeUnloadEvent) => {
			const sendWaiting = sendState() === "queued" || sendState() === "sending";
			if (!sendWaiting && (localKept() === "yes" || !hasDraftContent() || !hasPendingDraftSave())) {
				return;
			}
			event.preventDefault();
			event.returnValue = "";
		};
		document.addEventListener("visibilitychange", persistOnHide);
		window.addEventListener("pagehide", persistOnPageHide);
		window.addEventListener("beforeunload", warnBeforeUnload);
		onCleanup(() => {
			document.removeEventListener("visibilitychange", persistOnHide);
			window.removeEventListener("pagehide", persistOnPageHide);
			window.removeEventListener("beforeunload", warnBeforeUnload);
		});

		if (typeof BroadcastChannel !== "undefined") {
			composeChannel = new BroadcastChannel("mailclaw-compose");
			composeChannel.onmessage = (e) => {
				const msg = e.data as {
					type: "compose-open" | "compose-close" | "compose-done";
					draftId?: string | null;
					identity?: string | null;
				};
				// Another identity's windows (another account in another tab) are none of this one's.
				if (!msg.identity || msg.identity !== currentIdentityTag()) return;
				const currentDraftId = draftId() ?? editingDraftId();
				const sameDraft = Boolean(msg.draftId && currentDraftId && msg.draftId === currentDraftId);
				// "Sent or discarded in another window": only a hint. Any tab of this browser can post
				// anything here (the identity tag is public), so the server decides (review R1).
				if (msg.type === "compose-done" && sameDraft && !sendBusy()) {
					void checkDoneElsewhere(currentDraftId as string);
					return;
				}
				if (msg.type === "compose-open" && sameDraft) {
					setCrossTabWarning(true);
				}
				if (msg.type === "compose-close" && sameDraft) {
					setCrossTabWarning(false);
				}
			};
		}

		const options = fromOptions();
		let bootstrapStartSnapshot = getDraftSnapshot();
		const isBootstrapPristine = () =>
			!hasUserEdits() && !draftId() && getDraftSnapshot() === bootstrapStartSnapshot;
		const unregisterFlush = registerLocalComposeFlush(windowId, writeLocalNow);
		onCleanup(unregisterFlush);

		// An open window belongs to one live tab (web-r3-01). Two tabs restoring it at once: the one
		// that didn't get it leaves it, writing nothing to the device or the server.
		const release = await holdComposeWindow(windowId);
		if (!release) {
			openElsewhere = true;
			actions.closeCompose(windowId);
			return;
		}
		// Closed while the hold was asked for: nothing to keep.
		if (!composeWindow()) {
			release();
			return;
		}
		releaseWindow = release;

		postToWindows("compose-open", editingDraftId());

		// A window reopened after a reload: what this device kept wins over a fresh bootstrap. Else
		// New, Reply or a Drafts row brings back what was closed there.
		const reopened = await getLocalComposeDraft(windowId).catch(() => undefined);
		const broughtBack = !reopened && !editingDraftId();
		const local = reopened ?? (await takeClosed());
		let gone = false;
		if (local) {
			try {
				await applyLocalDraft(local);
				if (local.replyTo && !reopened) actions.setComposeReplyTo(windowId, local.replyTo);
				requestBodyFocus();
			} catch (e) {
				gone = e instanceof DraftGone;
				if (gone && !broughtBack) {
					// Saved, then sent or deleted elsewhere, and nothing newer here: done.
					await dropLocalDraft();
					actions.showToast("That draft was already sent or deleted", "info");
					actions.closeCompose(windowId);
					return;
				}
				if (!gone) {
					console.error("Failed to restore draft:", e);
					setError(getErrorMessage(e, "Failed to restore draft"));
				}
			}
			if (gone) {
				// New or Reply brought back a draft sent or deleted elsewhere: it never comes back.
				await deleteLocalComposeDraft(windowId).catch(() => {});
				startOver();
				bootstrapStartSnapshot = getDraftSnapshot();
			} else {
				// Shown once: the next write no longer says a send was waiting.
				sendPendingAt = null;
				localReady = true;
				return;
			}
		}

		if (editingDraftId()) {
			try {
				if (!isBootstrapPristine()) return;
				const draft = await api.emails.get(editingDraftId() as string);
				if (!isBootstrapPristine()) return;
				if (draft.mailbox_state !== "draft") {
					actions.showToast("That draft was already sent or deleted", "info");
					actions.closeCompose(windowId);
					return;
				}
				await applyDraftToCompose(draft);
				// Opened as the reply under its thread: the message it answers names the chips and offers
				// Reply all, as a kept reply does. A thread's Draft item names that message; a list row
				// only knows the draft, so the message is found from the draft's In-Reply-To.
				const target = replyTo();
				if (target && target.emailId !== draft.id) loadOriginal(target);
				else findOriginal(draft);
				requestBodyFocus();
			} catch (e) {
				// Auto-recover from dead ?compose=<draftId> deep links (deleted
				// draft, cross-workspace). Close the window — the URL-write
				// effect then strips ?compose= via replaceState.
				if (e instanceof ApiHttpError && (e.status === 404 || e.status === 403)) {
					actions.showToast("That draft is no longer available", "info");
					actions.closeCompose(windowId);
					return;
				}
				console.error("Failed to load draft:", e);
				setError(getErrorMessage(e, "Failed to load draft"));
			} finally {
				localReady = true;
			}
			return;
		}

		// Pre-fill when replying/forwarding an existing email
		const target = replyTo();
		if (target) {
			try {
				const source = await api.emails.get(target.emailId);
				setOriginal(source);
				// Typed before the source arrived: what the person typed wins, and every field they
				// didn't touch is filled from the source, as if they had typed after it loaded (the
				// body is theirs; the quote goes under it). web-r3-01: the whole source was skipped.
				const typed = hasUserEdits();
				const untouched = (field: ComposeField) => !touched.has(field);
				const mode = target.mode;

				// From: our own outbound message keeps the identity it was sent from (matching on
				// recipients would switch to whoever it went to); inbound mail is answered from the
				// account that received it (mail between the owner's own accounts included). A From the
				// person chose stays.
				const ownSender =
					source.direction === "outbound"
						? options.find(
								(addr) => addr.toLowerCase() === (source.from_address || "").toLowerCase(),
							)
						: undefined;
				if (!untouched("from")) {
					// kept as chosen
				} else if (ownSender) {
					setFrom(ownSender);
				} else {
					const sourceRecipients = [
						source.to_address,
						...source.to_addresses,
						...source.cc_addresses,
					].map((a) => a.toLowerCase());
					const matchingFrom = options.find((addr) =>
						sourceRecipients.includes(addr.toLowerCase()),
					);
					if (matchingFrom) setFrom(matchingFrom);
				}

				setHydratingDraft(true);
				try {
					if (mode === "forward") {
						if (untouched("to")) setTo("");
						if (untouched("subject")) {
							setSubject(withCanonicalSubjectPrefix(source.subject, "Fwd"));
						}
						if (untouched("quote")) setQuote(buildForwardDraftPayload(source).text);
						// A forward must not become sendable until every original attachment is
						// present: awaited, so a partial set can never be saved or sent.
						await hydrateAttachments(source, {
							markDirty: true,
							keepAdded: !untouched("attachments"),
						});
					} else {
						const replyRecipients = buildReplyRecipients(source, fromOptions());
						if (untouched("to")) setTo(replyRecipients.to);
						setReplyOthers(replyRecipients.cc);
						if (untouched("subject")) {
							setSubject(withCanonicalSubjectPrefix(source.subject, "Re"));
						}
						if (mode === "reply-all" && replyRecipients.cc.length > 0 && untouched("cc")) {
							setCc(replyRecipients.cc.join(", "));
						}
						if (source.message_id) {
							setInReplyTo(source.message_id);
							const refsHeader = source.references_header
								? `${source.references_header} ${source.message_id}`
								: source.message_id;
							setReferences(validateAndDeduplicateReferences(refsHeader));
						}
						if (untouched("quote")) setQuote(buildPlainReplyBody(source));
					}
				} finally {
					setHydratingDraft(false);
				}
				// Focus stays where the person is typing.
				if (!typed) {
					if (mode === "forward") requestToFocus();
					else requestBodyFocus(150);
				}
				if (isBootstrapPristine()) {
					setHasUserEdits(false);
					syncComposeBootstrapSnapshot();
				}
			} catch (e) {
				console.error("Failed to load reply context:", e);
			}
		} else {
			requestToFocus();
			if (isBootstrapPristine()) {
				setHasUserEdits(false);
				syncComposeBootstrapSnapshot();
			}
		}
		localReady = true;
		if (shouldKeepLocally()) void writeLocalNow();
	});

	onCleanup(() => {
		clearRecipientSuggestions();
		if (recipientTypingTimer) clearTimeout(recipientTypingTimer);
		// A send still waiting for its Undo does not go out once the window is gone (signed out,
		// another identity): this device keeps it, and the next load says it wasn't sent.
		if (sendTimer) clearTimeout(sendTimer);
		releaseWindow?.();
		// D2: flush a pending debounced save on ANY unmount (identity switch, programmatic
		// closeCompose, a state change that drops the window). Can't await in cleanup, but firing
		// the save beats dropping it.
		if (!openElsewhere && hasPendingDraftSave()) {
			void saveDraftNow({ includeAttachments: dirtyAttachments(), silent: true }).catch(() => {});
		}
		if (autosaveTimer) clearTimeout(autosaveTimer);
		if (localWriteTimer) clearTimeout(localWriteTimer);
		document.removeEventListener("keydown", handleKeyDown);
		if (composeChannel) {
			if (!openElsewhere) postToWindows("compose-close", draftId() ?? editingDraftId());
			composeChannel.close();
			composeChannel = undefined;
		}
	});

	createEffect(() => {
		if (!composeWindow()) return;
		if (closeRequestKey() === handledComposeCloseRequestKey) return;
		handledComposeCloseRequestKey = closeRequestKey();
		void closeComposeWithSave();
	});

	// Keep every edit on this device (text, recipients, files, minimized), ahead of the autosave.
	createEffect(() => {
		getDraftSnapshot();
		quote();
		attachments();
		isMinimized();
		draftId();
		if (!composeWindow() || hydratingDraft() || sendState() === "sent") return;
		if (localWriteTimer) clearTimeout(localWriteTimer);
		localWriteTimer = setTimeout(() => void writeLocalNow(), LOCAL_WRITE_MS);
	});

	createEffect(() => {
		if (!composeWindow() || hydratingDraft() || draftConflict()) return;
		if (sendBusy() || sendState() === "sent") return;
		if (recipientTyping() || showRecipientSuggestions()) return;

		const snapshot = getDraftSnapshot();
		const shouldSave = canPersistDraft();
		const needsAttachmentSave = dirtyAttachments();

		if (autosaveTimer) clearTimeout(autosaveTimer);

		if (!shouldSave && !needsAttachmentSave) {
			if (draftSaveState() !== "saving") setDraftSaveState("idle");
			return;
		}

		if (snapshot === lastSavedDraftSnapshot && !needsAttachmentSave) {
			if (draftSaveState() !== "saving") setDraftSaveState("saved");
			return;
		}

		if (rejectedDraft()?.snapshot === snapshot) return;
		setRejectedDraft(null);

		setDraftSaveState("saving");
		autosaveTimer = setTimeout(() => {
			void autoSaveWithRetry(needsAttachmentSave);
		}, 900);
	});

	/** Process a FileList (from file input, drag-drop or paste) into SendAttachments. */
	const ingestFiles = async (files: FileList | File[]) => {
		if (attachmentLoadState() === "loading" || attachmentLoadState() === "failed") {
			setError("Retry the original attachments before adding or removing files.");
			return;
		}
		const newAttachments: SendAttachment[] = [];
		for (const file of files) {
			const base64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = reader.result as string;
					resolve(result.split(",")[1] || "");
				};
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});
			newAttachments.push({
				filename: file.name,
				content_type: file.type || "application/octet-stream",
				content_base64: base64,
			});
		}
		if (newAttachments.length === 0) return;
		markUserEdited("attachments");
		setAttachments((prev) => [...prev, ...newAttachments]);
		setExpectedAttachmentCount((count) => count + newAttachments.length);
		if (attachmentLoadState() === "idle") setAttachmentLoadState("ready");
		setDirtyAttachments(true);
	};

	const removeAttachment = (idx: number) => {
		if (attachmentLoadState() === "loading" || attachmentLoadState() === "failed") {
			setError("Retry the original attachments before adding or removing files.");
			return;
		}
		markUserEdited("attachments");
		setAttachments((prev) => prev.filter((_, i) => i !== idx));
		setExpectedAttachmentCount((count) => Math.max(0, count - 1));
		setDirtyAttachments(true);
	};

	/**
	 * Another window said this draft was sent or discarded. Ask the server, as this tab's own
	 * identity: still a draft (or unreachable) -> nothing changes. Gone -> the window closes and its
	 * local copy goes, unless it holds edits the server never confirmed: those stay, as a new draft.
	 */
	const checkDoneElsewhere = async (id: string) => {
		let gone = false;
		try {
			const server = await api.emails.get(id);
			gone = server.mailbox_state !== "draft";
		} catch (error) {
			if (!(error instanceof ApiHttpError && (error.status === 404 || error.status === 403))) {
				return; // unreachable: keep everything
			}
			gone = true;
		}
		if (!gone || (draftId() ?? editingDraftId()) !== id || sendState() === "sent") return;
		if (hasPendingDraftSave() || localKept() !== "yes") {
			setDraftId(null);
			actions.setComposeWindowDraftId(windowId, null);
			setDraftRevision(0);
			localServerSavedAt = null;
			setHasUserEdits(true);
			setDirtyAttachments(attachments().length > 0);
			setError(
				"This draft was sent or deleted somewhere else. Your unsaved changes are kept here as a new draft.",
			);
			void writeLocalNow();
			return;
		}
		await dropLocalDraft();
		actions.showToast("That draft was sent or discarded in another window", "info");
		actions.closeCompose(windowId);
	};

	/** Other windows and tabs holding this draft re-check it with the server (checkDoneElsewhere). */
	const announceDone = () => {
		const id = draftId() ?? editingDraftId();
		if (id) postToWindows("compose-done", id);
	};

	const finishConfirmedSend = async (message = "Sent", type: "success" | "error" = "success") => {
		setSendState("sent");
		setDraftSaveState("saved");
		sendPendingAt = null;
		actions.refresh();
		actions.showToast(message, type);
		announceDone();
		await dropLocalDraft();
		actions.closeCompose(windowId);
	};

	/** Bring a composer whose send failed back in front of the person (its thread, or the window). */
	const reveal = () => {
		const target = replyTo();
		if (target?.conversationId && opts.placement() !== "inline") {
			actions.selectConversation(target.conversationId, target.emailId);
		}
		if (isMinimized()) actions.restoreCompose(windowId);
		actions.focusCompose(windowId);
		requestBodyFocus();
	};

	const notSent = (message: string, outcome: "failed" | "unknown" = "failed") => {
		setSendState(outcome);
		setError(message);
		sendPendingAt = null;
		void writeLocalNow();
		const what = subject().trim() ? `“${subject().trim().slice(0, 48)}”` : "your message";
		actions.showToast(`Not sent: ${what}`, "error", reveal, "Open");
	};

	/** After the Undo: the server sends the saved draft (its send key row lets it go out once). */
	const dispatchSend = async (id: string) => {
		sendTimer = undefined;
		if (sendState() !== "queued") return;
		if (undoToastId) actions.dismissToast(undoToastId);
		undoToastId = null;
		setSendState("sending");
		try {
			await api.drafts.send(id);
			await finishConfirmedSend();
		} catch (e: unknown) {
			const code = getApiErrorCode(e);
			if (code === "SENT_COPY_SAVE_FAILED" || code === "SENT_ATTACHMENT_SAVE_FAILED") {
				await finishConfirmedSend("Sent, but its sent copy couldn't be saved", "error");
				return;
			}
			if (code === "SEND_IN_PROGRESS") {
				setSendState("idle");
				setError("This message is already being sent. Wait a moment, then check Sent.");
				sendPendingAt = null;
				void writeLocalNow();
				return;
			}
			if (!(e instanceof ApiHttpError) && navigator.onLine === false) {
				notSent("Not sent: you're offline. Your draft is saved; send it again when you're back.");
				return;
			}
			if (code === "SEND_STATUS_UNKNOWN" || !(e instanceof ApiHttpError)) {
				notSent(
					"Couldn't confirm delivery. Don't resend yet: check Sent, then retry only if no sent copy appears.",
					"unknown",
				);
				return;
			}
			const reference = e.requestId ? ` Reference: ${e.requestId}.` : "";
			notSent(`Message not sent. ${getErrorMessage(e, "Please try again.")}${reference}`);
		}
	};

	/** Undo inside the 5 seconds: nothing was sent; the composer is back with everything in it. */
	const undoSend = () => {
		if (sendState() !== "queued") return;
		if (sendTimer) clearTimeout(sendTimer);
		sendTimer = undefined;
		undoToastId = null;
		sendPendingAt = null;
		setSendState("idle");
		void writeLocalNow();
		requestBodyFocus(50);
	};

	/**
	 * Send: the draft is saved (server and this device) first, then the composer goes and a toast
	 * offers Undo for UNDO_SEND_MS; only then does the server send it. A failure brings the
	 * composer back and says so; a reload during the wait reopens it as "Not sent".
	 */
	const handleSend = async () => {
		if (!sendConfigured()) {
			actions.showToast("Sending is not configured", "error");
			return;
		}
		if (!from()) {
			actions.showToast("Please select a sender address", "error");
			return;
		}
		if (!to().trim()) {
			actions.showToast("Please add at least one recipient", "error");
			return;
		}
		if (attachmentLoadState() === "loading") {
			setError("Wait for every attachment to finish preparing before sending.");
			return;
		}
		if (attachmentLoadState() === "failed") {
			setError("Attachments could not be prepared. Retry them before sending.");
			return;
		}
		if (sendBusy()) return;
		setSendState("preparing");
		setError("");

		let id: string | null = null;
		try {
			id = await saveDraftNow({
				// Sending always snapshots a fully hydrated set. The failed/loading guards above
				// ensure this can never replace server rows with a partial browser copy.
				includeAttachments:
					attachmentLoadState() === "ready" &&
					(expectedAttachmentCount() > 0 || dirtyAttachments()),
				silent: true,
				allowBootstrapSave: true,
			});
		} catch (e) {
			setSendState("failed");
			setError(
				!(e instanceof ApiHttpError) && navigator.onLine === false
					? "Not sent: you're offline. It's kept on this device; send it again when you're back."
					: `Not sent: the draft couldn't be saved first. ${getErrorMessage(e, "")}`.trim(),
			);
			return;
		}
		if (!id) {
			setSendState("failed");
			setError("Not sent: the draft couldn't be saved first.");
			return;
		}
		const draft = id;
		setSendState("queued");
		sendPendingAt = Date.now();
		void writeLocalNow();
		undoToastId = actions.showToast(
			replyTo() && replyTo()?.mode !== "forward" ? "Sending reply…" : "Sending…",
			"info",
			undoSend,
			"Undo",
		);
		sendTimer = setTimeout(() => void dispatchSend(draft), UNDO_SEND_MS);
	};

	const buildDraftBody = (includeAttachments = false, includeRevision = true) => {
		const composeBody = buildComposeBodyPayload(messageText());
		const isExistingDraft = Boolean(draftId());
		const bodyCleared = composeBody.text === undefined;

		return {
			from: from(),
			to: isExistingDraft
				? parseComposeRecipients(to())
				: to()
					? parseComposeRecipients(to())
					: undefined,
			subject: isExistingDraft ? subject() : subject() || undefined,
			...composeBody,
			// A cleared body clears the server's copy, including html left by the retired editor.
			...(draftId() && bodyCleared ? { text: null, html: null, editor_state_json: null } : {}),
			cc: isExistingDraft
				? parseComposeRecipients(cc())
				: cc()
					? parseComposeRecipients(cc())
					: undefined,
			bcc: isExistingDraft
				? parseComposeRecipients(bcc())
				: bcc()
					? parseComposeRecipients(bcc())
					: undefined,
			...(includeAttachments ? { attachments: attachments() } : {}),
			in_reply_to: inReplyTo(),
			references: references(),
			...(includeRevision && draftId() ? { draft_revision: draftRevision() } : {}),
		};
	};

	const hasDraftContent = () =>
		hasComposeDraftContent({
			to: to(),
			cc: cc(),
			bcc: bcc(),
			subject: subject(),
			text: messageText(),
			attachmentCount: attachments().length,
		});

	const getDraftSnapshot = () => JSON.stringify(buildDraftBody(false, false));

	const hasPendingDraftSave = () => {
		const snapshot = getDraftSnapshot();
		const bodyChanged = snapshot !== lastSavedDraftSnapshot;
		if (!hasDraftContent()) {
			return Boolean(draftId()) && (hasUserEdits() || bodyChanged);
		}
		return bodyChanged || dirtyAttachments();
	};

	const canPersistDraft = () =>
		!hydratingDraft() &&
		(hasUserEdits() || dirtyAttachments() || !!draftId()) &&
		hasPendingDraftSave();

	const getDraftConflictState = (value: unknown): DraftConflictState | null => {
		if (!(value instanceof ApiHttpError) || value.status !== 409) return null;
		const payload = value.body as
			| {
					error?: { code?: string };
					data?: { latest_draft?: Email; latest_saved_at?: number | null };
			  }
			| undefined;
		if (payload?.error?.code !== "DRAFT_CONFLICT" || !payload.data?.latest_draft) return null;
		return {
			latestDraft: payload.data.latest_draft,
			latestSavedAt: payload.data.latest_saved_at ?? payload.data.latest_draft.received_at ?? null,
		};
	};

	const autoSaveWithRetry = async (includeAttachments: boolean) => {
		try {
			await saveDraftNow({ includeAttachments, silent: true });
			autoSaveRetryCount = 0;
			if (includeAttachments) setDirtyAttachments(false);
		} catch (e: unknown) {
			// Don't retry 409 conflicts — handled by saveDraftNow's conflict logic
			if (e instanceof ApiHttpError && e.status === 409) {
				autoSaveRetryCount = 0;
				return;
			}
			if (
				e instanceof ApiHttpError &&
				e.status >= 400 &&
				e.status < 500 &&
				e.status !== 401 &&
				e.status !== 429
			) {
				autoSaveRetryCount = 0;
				setRejectedDraft({ snapshot: getDraftSnapshot(), message: e.message });
				setDraftSaveState("failed");
				return;
			}
			autoSaveRetryCount++;
			if (autoSaveRetryCount <= MAX_AUTO_SAVE_RETRIES) {
				const delay = RETRY_DELAYS[autoSaveRetryCount - 1] ?? 4000;
				autosaveTimer = setTimeout(() => {
					void autoSaveWithRetry(includeAttachments);
				}, delay);
				setDraftSaveState("saving");
			} else {
				setDraftSaveState("failed");
				autoSaveRetryCount = 0;
			}
		}
	};

	const saveDraftNow = async (options?: {
		includeAttachments?: boolean;
		silent?: boolean;
		force?: boolean;
		allowBootstrapSave?: boolean;
	}): Promise<string | null> => {
		if (autosaveTimer) clearTimeout(autosaveTimer);
		if (discarding) {
			setDraftSaveState("idle");
			return draftId();
		}
		const snapshot = getDraftSnapshot();
		const needsEmptyDraftSave =
			!hasDraftContent() &&
			Boolean(draftId()) &&
			(hasUserEdits() || snapshot !== lastSavedDraftSnapshot);
		if (!hasDraftContent() && !needsEmptyDraftSave) {
			lastSavedDraftSnapshot = "";
			setDraftSaveState("idle");
			return draftId();
		}

		const silent = options?.silent ?? false;
		const force = options?.force ?? false;
		const allowBootstrapSave = options?.allowBootstrapSave ?? false;
		const requestedAttachmentSave = options?.includeAttachments ?? false;
		const includeAttachments =
			requestedAttachmentSave && (dirtyAttachments() || force || allowBootstrapSave);
		if (!draftId() && !allowBootstrapSave && !hasPendingDraftSave()) {
			if (draftSaveState() !== "saving") setDraftSaveState("idle");
			return null;
		}
		if (!force && draftConflict()) {
			if (!silent) {
				setError("A newer draft version exists. Choose how to resolve the conflict.");
			}
			setDraftSaveState("failed");
			throw new Error("Draft conflict");
		}
		if (!includeAttachments && snapshot === lastSavedDraftSnapshot) {
			if (draftSaveState() !== "saved") setDraftSaveState("saved");
			return draftId();
		}

		// This device first: if the server save fails (offline, signed out), the text is kept.
		await writeLocalNow();
		setDraftSaveState("saving");
		const wasFirstSave = !draftId();
		let savedSnapshot = snapshot;
		saveChain = saveChain
			.catch(() => null)
			.then(async () => {
				savedSnapshot = getDraftSnapshot();
				const draft = buildDraftBody(includeAttachments);
				const currentDraftId = draftId();
				if (currentDraftId) {
					const res = await api.drafts.update(currentDraftId, draft);
					setDraftRevision(res.draft.draft_revision ?? draftRevision());
					// D3: the real save moment (the server's saved_at is the creation time).
					setLastSavedAt(Date.now());
					return res.draft.id;
				}
				const res = await api.drafts.create(draft);
				setDraftId(res.draft.id);
				setDraftRevision(res.draft.draft_revision ?? 0);
				setLastSavedAt(Date.now());
				// Mirror the draft id onto the store's compose window so the
				// URL sync can represent which draft is currently being edited.
				actions.setComposeWindowDraftId(windowId, res.draft.id);
				postToWindows("compose-open", res.draft.id);
				return res.draft.id;
			});

		try {
			const savedId = await saveChain;
			// Refresh after first-save so the Drafts folder and counters pick up the draft.
			if (wasFirstSave) {
				actions.refresh();
			}
			lastSavedDraftSnapshot = savedSnapshot;
			setDraftConflict(null);
			if (includeAttachments) setDirtyAttachments(false);
			// The server holds this content now (and the draft id): record that locally.
			localServerSavedAt = Date.now();
			await writeLocalNow();
			setDraftSaveState("saved");
			if (!silent) {
				setError("");
			}
			return savedId;
		} catch (e: unknown) {
			const conflict = getDraftConflictState(e);
			if (conflict) {
				setDraftConflict(conflict);
				setDraftSaveState("failed");
				if (!silent) {
					setError("A newer draft version exists. Choose how to resolve it.");
				}
				throw e;
			}
			setDraftSaveState("failed");
			if (!silent) {
				setError(getErrorMessage(e, "Failed to save draft"));
			}
			throw e;
		}
	};

	const discardPersistedDraft = async () => {
		// Block any racing autosave from PATCHing/creating a draft we're about to delete: flip the
		// guard (new saves bail via saveDraftNow), cancel the debounce, and let any in-flight save
		// settle FIRST so a pending first-save create() can assign draftId before we read it.
		discarding = true;
		if (autosaveTimer) clearTimeout(autosaveTimer);
		await saveChain.catch(() => null);
		try {
			// Re-read AFTER the save chain settles: a freshly typed draft's id is only assigned
			// inside create()'s .then. Fall back to the store id for drafts opened from the list.
			const currentDraftId = draftId() ?? editingDraftId();
			if (!currentDraftId) return; // genuinely nothing persisted server-side
			try {
				await api.emails.delete(currentDraftId);
			} catch (deleteError) {
				// A 404 means the draft is already gone server-side: exactly the goal of a discard.
				if (!(deleteError instanceof ApiHttpError && deleteError.status === 404)) {
					throw deleteError;
				}
			}
		} catch (error) {
			discarding = false; // discard failed — allow saving again
			throw error;
		}
	};

	const closeComposeWithSave = async () => {
		if (sendBusy()) return;
		if (!hasDraftContent()) {
			try {
				await discardPersistedDraft();
			} catch (discardError) {
				setError(getErrorMessage(discardError, "Failed to discard draft"));
				// Still close even if discard failed — don't trap the user
			}
			await dropLocalDraft();
			actions.refresh();
			actions.closeCompose(windowId);
			return;
		}
		if (!hasPendingDraftSave()) {
			await keepClosed();
			actions.closeCompose(windowId);
			return;
		}
		try {
			await saveDraftNow({ includeAttachments: dirtyAttachments() });
		} catch (saveError) {
			// Closing now would lose the text: keep the window open (it is also kept on this device).
			console.warn("Failed to save draft on close:", saveError);
			actions.showToast("Draft could not be saved, so it stays open", "error");
			return;
		}
		// Saved: the Drafts folder has it; a reload no longer reopens the window, New or Reply does.
		await keepClosed();
		actions.refresh();
		actions.closeCompose(windowId);
	};

	const minimizeComposeWithSave = async () => {
		if (hasDraftContent() && hasPendingDraftSave()) {
			try {
				await saveDraftNow({ includeAttachments: dirtyAttachments(), silent: true });
			} catch (saveError) {
				console.warn("Failed to save draft on minimize:", saveError);
			}
		}
		actions.minimizeCompose(windowId);
	};

	const discardCompose = async () => {
		if (sendBusy()) return;
		if (autosaveTimer) clearTimeout(autosaveTimer);
		setDraftSaveState("idle");
		setError("");
		try {
			await discardPersistedDraft();
		} catch (discardError) {
			setError(getErrorMessage(discardError, "Failed to discard draft"));
			return;
		}
		announceDone();
		await dropLocalDraft();
		resetComposeDraftState();
		actions.refresh();
		actions.closeCompose(windowId);
	};

	const reloadLatestDraft = async () => {
		const conflict = draftConflict();
		if (!conflict) return;
		try {
			await applyDraftToCompose(conflict.latestDraft);
		} catch (reloadError) {
			setError(
				getErrorMessage(reloadError, "The latest draft's attachments could not be prepared."),
			);
		}
	};

	const overwriteDraftWithLocalChanges = async () => {
		const conflict = draftConflict();
		if (!conflict) return;
		setDraftRevision(conflict.latestDraft.draft_revision ?? draftRevision());
		setDraftConflict(null);
		try {
			await saveDraftNow({ includeAttachments: dirtyAttachments(), force: true });
		} catch {
			// If the draft changed again, saveDraftNow will recreate the conflict state.
		}
	};

	// ── What the surfaces read ──

	const mode = () => replyTo()?.mode ?? null;
	/** A reply's recipients as chips (name + address); "Edit" or a forward/new message: fields. */
	const showChips = () => Boolean(replyTo()) && mode() !== "forward" && !recipientsAsFields();
	const chips = createMemo(() =>
		(["to", "cc", "bcc"] as const).flatMap((field) =>
			parseComposeRecipients(getRecipientValue(field)).map((address) => ({
				field,
				address,
				name: nameFor(address),
			})),
		),
	);
	/** The people "Reply all" would add that aren't on the reply yet. */
	const replyAllAdds = createMemo(() => {
		if (mode() !== "reply") return [] as string[];
		const present = new Set(getAllRecipientAddresses());
		return replyOthers().filter((address) => !present.has(address.toLowerCase()));
	});
	const switchToReplyAll = () => {
		const adds = replyAllAdds();
		if (adds.length === 0) return;
		markUserEdited("cc");
		setCc([...parseComposeRecipients(cc()), ...adds].join(", "));
		const target = replyTo();
		if (target) actions.setComposeReplyTo(windowId, { ...target, mode: "reply-all" });
	};
	const title = () => {
		const m = mode();
		if (m === "forward") return "Forward";
		if (m === "reply-all") return "Reply all";
		if (m === "reply") return "Reply";
		if (editingDraftId()) return "Draft";
		return "New message";
	};
	const summary = () => {
		const recipients = [to(), cc(), bcc()].find((value) => value.trim().length > 0)?.trim();
		return subject().trim() || recipients || "(no subject)";
	};
	const saveLabel = () => {
		if (!hasDraftContent()) return "";
		switch (draftSaveState()) {
			case "saving":
				return "Saving…";
			case "saved":
				return "Draft saved";
			case "failed":
				if (draftConflict()) return "Newer version exists";
				if (rejectedDraft()) return `Not saved: ${rejectedDraft()?.message}`;
				return "Couldn't save, will retry";
			default:
				return hasUserEdits() ? "Draft" : "";
		}
	};
	const localWarning = () => {
		if (localKept() === "yes" || !hasDraftContent()) return "";
		if (localKept() === "no-storage") return "Not kept on this device (storage full or blocked)";
		if (localKept() === "no-identity") return "Not kept on this device (signed out): copy it";
		return "Files over 20 MB aren't kept on this device until saved";
	};
	/** Nothing to draw while the Undo runs, the server sends, and once it is sent. */
	const hidden = () =>
		sendState() === "queued" || sendState() === "sending" || sendState() === "sent";

	return {
		windowId,
		refs,
		fieldId,
		composeWindow,
		replyTo,
		mode,
		title,
		summary,
		isMinimized,
		editingDraftId,
		// fields
		from,
		setFrom: (value: string) => {
			markUserEdited("from");
			setFrom(value);
		},
		fromOptions,
		to,
		cc,
		bcc,
		subject,
		setSubject: (value: string) => {
			markUserEdited("subject");
			setSubject(value);
		},
		bodyText,
		setBodyText: (value: string) => {
			markUserEdited("body");
			setComposeBodyText(value);
		},
		quote,
		setQuote: (value: string) => {
			markUserEdited("quote");
			setQuote(normalizeComposeText(value));
		},
		quoteShown,
		toggleQuote: () => setQuoteShown((v) => !v),
		showCcBcc,
		toggleCcBcc: () => setShowCcBcc((v) => !v),
		showChips,
		chips,
		editRecipients: () => {
			setRecipientsAsFields(true);
			if (cc() || bcc()) setShowCcBcc(true);
			requestAnimationFrame(() => refs.to?.focus());
		},
		replyAllAdds,
		nameFor,
		switchToReplyAll,
		// recipients
		recipientSuggestions,
		showRecipientSuggestions,
		activeRecipientSuggestion,
		setActiveRecipientSuggestion,
		activeRecipientField,
		loadRecipientSuggestions,
		applyRecipientSuggestion,
		handleRecipientInput,
		handleRecipientKeyDown,
		handleRecipientBlur,
		// attachments
		attachments,
		attachmentLoadState,
		expectedAttachmentCount,
		ingestFiles,
		removeAttachment,
		retryAttachmentHydration,
		// state
		error,
		dismissError: () => {
			setError("");
			if (sendState() !== "unknown") setSendState("idle");
		},
		sendState,
		clearUnknownSend: () => {
			setSendState("idle");
			setError("");
		},
		sendConfigured,
		canSend,
		hidden,
		saveLabel,
		saveFailed: () => draftSaveState() === "failed",
		lastSavedAt: () => formatComposeSavedAt(lastSavedAt()),
		localWarning,
		draftConflict,
		crossTabWarning,
		dismissCrossTabWarning: () => setCrossTabWarning(false),
		// actions
		send: handleSend,
		close: closeComposeWithSave,
		minimize: minimizeComposeWithSave,
		discard: discardCompose,
		reveal,
		reloadLatestDraft,
		overwriteDraftWithLocalChanges,
		requestBodyFocus,
	};
}

export type ComposeDraft = ReturnType<typeof createComposeDraft>;
