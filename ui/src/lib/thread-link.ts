/**
 * The earlier half of a conversation the server split in two (audit WD-04: a long conversation's
 * older messages were invisible from its newer thread). Until server-side thread linking
 * lands (build spec S2), the client joins them as the prototype did: the thread's first
 * message answers one this thread doesn't hold, and an older conversation with the same subject
 * shares a person with it. One search per thread open that has such a gap; none otherwise.
 */
import { api } from "../api/client";
import type { ConversationDetailResponse, Email } from "../types";
import { normalizeSubject, People } from "../utils/thread-text";
import { getConversationDetailCached } from "./cache";

const found = new Map<string, Promise<Email[]>>();

/** Message-ids the first message replies to that are not in this thread. */
function answersMissingMessage(emails: Email[]): boolean {
	const first = emails[0];
	if (!first) return false;
	const here = new Set(emails.map((e) => e.message_id).filter(Boolean));
	const refs =
		`${first.in_reply_to ?? ""} ${first.references_header ?? ""}`.match(/<[^>\s]+>/g) ?? [];
	return refs.some((id) => !here.has(id));
}

/** The split-off earlier conversation's messages, oldest first; [] when there is none. */
export function earlierConversation(
	detail: ConversationDetailResponse,
	own: string[],
): Promise<Email[]> {
	const id = detail.conversation.id;
	const known = found.get(id);
	if (known) return known;
	const search = lookUp(detail, own).catch(() => {
		found.delete(id); // offline or a server error: asked again on the next open
		return [] as Email[];
	});
	found.set(id, search);
	return search;
}

async function lookUp(detail: ConversationDetailResponse, own: string[]): Promise<Email[]> {
	const emails = [...detail.emails].sort((a, b) => a.received_at - b.received_at);
	const subject = normalizeSubject(detail.conversation.subject ?? emails[0]?.subject);
	if (!subject || !answersMissingMessage(emails)) return [];

	const people = new People(emails, own);
	const theirs = new Set(
		emails
			.flatMap((e) => [e.from_address, ...e.to_addresses, ...e.cc_addresses])
			.filter((a) => !people.isMe(a))
			.map((a) => a.toLowerCase()),
	);
	const startedAt = detail.conversation.started_at || emails[0]?.received_at || 0;

	// One quoted phrase (a token may hold 200 characters); a quote mark inside would end it.
	const phrase = (subject.length > 150 ? subject.slice(0, 150).replace(/\s+\S*$/, "") : subject)
		.replace(/"/g, " ")
		.trim();
	const list = await api.conversations.list({ q: `subject:"${phrase}"`, limit: 10 });
	const candidate = list.conversations
		.filter(
			(c) =>
				c.id !== detail.conversation.id &&
				normalizeSubject(c.subject) === subject &&
				c.latest_message_at < startedAt &&
				c.participants.some((p) => theirs.has(p.address.toLowerCase())),
		)
		.sort((a, b) => b.latest_message_at - a.latest_message_at)[0];
	if (!candidate) return [];
	const earlier = await getConversationDetailCached(candidate.id, { load: "full" });
	return [...earlier.emails].sort((a, b) => a.received_at - b.received_at);
}
