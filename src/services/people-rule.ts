/**
 * Inbound mail from a known person is Personal regardless of the AI sorter's category.
 * A person has no List-Unsubscribe header or automated local part, is not an owner address,
 * calendar response or forwarded-in identity. Known means a coworker on an owner domain,
 * a participant in a conversation the owner wrote in, or an exact correspondent from the
 * last 365 days. A relay with one Reply-To is judged by that address.
 *
 * At ingest this runs after blocked/system mail and explicit sender rules, before the AI
 * sorter, which claims only uncategorized mail.
 */
import { findSenderRule, insertClassificationLog } from "@/database/agent";
import { isSystemMail } from "@/services/system-mail";
import { refreshThreadSafe } from "@/services/threads-loader";
import type { EmailCategory } from "@/types";
import { isOwnerAddress, ownerAddresses } from "@/utils/owner";
import { getConfiguredDomains } from "@/utils/platform";

const AUTOMATED_LOCAL_PART =
	/no-?reply|do-?not-?reply|notification|notify|alert|mailer-daemon|postmaster|bounce|drive-shares|calendar-server/;
const CALENDAR_REPLY_SUBJECT = /^(accepted|declined|tentative(ly accepted)?)\b[^:]{0,40}:/i;
const CORRESPONDENT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type PeopleRuleReason = "coworker" | "thread" | "correspondent";

export interface PeopleRuleInput {
	from_address: string;
	subject: string | null;
	list_unsubscribe?: string | null;
	to_addresses: string[];
	cc_addresses: string[];
	reply_to_addresses?: string[];
	thread_id?: string | null;
	received_at: number;
}

function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
}

/** Addresses whose mail is forwarded into one of the instance's mailboxes (FORWARDED_FOR_JSON). */
export function forwardedFor(env: CloudflareBindings): Record<string, string> {
	try {
		const map = JSON.parse(env.FORWARDED_FOR_JSON || "{}") as Record<string, string>;
		return Object.fromEntries(Object.entries(map).map(([a, n]) => [a.toLowerCase(), n]));
	} catch {
		return {};
	}
}

/**
 * Mail addressed to a forwarded-in person and to none of the instance's domains is theirs,
 * not the owner's (their payment apps, store receipts and invites).
 * Returns that person's name, or null when the mail is the owner's.
 */
export function forwardedPersonOf(
	env: CloudflareBindings,
	recipients: string[],
	ownDomains = getConfiguredDomains(env),
): string | null {
	const others = forwardedFor(env);
	const lower = recipients.map((a) => a.toLowerCase());
	if (lower.some((a) => ownDomains.includes(domainOf(a)))) return null;
	const theirs = lower.find((a) => a in others);
	return theirs ? others[theirs] : null;
}

export function isForSomeoneElse(
	env: CloudflareBindings,
	recipients: string[],
	ownDomains = getConfiguredDomains(env),
): boolean {
	return forwardedPersonOf(env, recipients, ownDomains) !== null;
}

/**
 * threads.for_person (v54, 2026-10-14: a forwarded-in person's mail gets its own view): the
 * person's name when the thread has inbound mail and every inbound message is theirs; one
 * message to the owner keeps the whole thread the owner's. `inbound` holds each inbound
 * message's [to_addresses_json, cc_addresses_json].
 */
export function threadForPerson(
	env: CloudflareBindings,
	inbound: [string | null, string | null][],
): string | null {
	if (inbound.length === 0) return null;
	const ownDomains = getConfiguredDomains(env);
	let name: string | null = null;
	for (const [to, cc] of inbound) {
		const person = forwardedPersonOf(
			env,
			[...parseAddressList(to), ...parseAddressList(cc)],
			ownDomains,
		);
		if (!person) return null;
		name ??= person;
	}
	return name;
}

/**
 * A sender that looks like a person: no List-Unsubscribe and no automated local part.
 * Also gates the sorter's unsure routing (src/routes/classifier.ts).
 */
export function looksLikePerson(fromAddress: string, listUnsubscribe?: string | null): boolean {
	if (listUnsubscribe) return false;
	const from = fromAddress.trim().toLowerCase();
	return !AUTOMATED_LOCAL_PART.test(from.slice(0, from.lastIndexOf("@")));
}

export async function peopleRuleMatch(
	env: CloudflareBindings,
	r: PeopleRuleInput,
): Promise<PeopleRuleReason | null> {
	if (r.list_unsubscribe || isSystemMail(env, r)) return null;
	// A relay (Drive shares, calendar invites: From drive-shares-dm-noreply@google.com,
	// Reply-To the person) is judged by its one Reply-To person; without one it is a machine.
	let from = r.from_address.trim().toLowerCase();
	if (AUTOMATED_LOCAL_PART.test(from.slice(0, from.lastIndexOf("@")))) {
		const replyTo = r.reply_to_addresses ?? [];
		if (replyTo.length !== 1) return null;
		from = replyTo[0].trim().toLowerCase();
	}
	const at = from.lastIndexOf("@");
	if (at < 1) return null;
	const local = from.slice(0, at);
	const domain = from.slice(at + 1);
	const ownDomains = getConfiguredDomains(env);

	if (AUTOMATED_LOCAL_PART.test(local)) return null;
	if (isOwnerAddress(from, ownerAddresses(env))) {
		return null;
	}
	if (r.subject && CALENDAR_REPLY_SUBJECT.test(r.subject.trim())) return null;
	if (isForSomeoneElse(env, [...r.to_addresses, ...r.cc_addresses], ownDomains)) return null;

	if (ownDomains.includes(domain)) return "coworker";

	const db = env.D1;
	if (r.thread_id) {
		const sent = await db
			.prepare(
				"SELECT 1 FROM emails WHERE thread_id = ? AND direction = 'outbound' AND mailbox_state != 'draft' LIMIT 1",
			)
			.bind(r.thread_id)
			.first();
		if (sent) return "thread";
	}

	// instr, not LIKE: D1 rejects LIKE patterns built from long bounce addresses.
	const quoted = `"${from}"`;
	const wrote = await db
		.prepare(
			`SELECT 1 FROM emails
			 WHERE direction = 'outbound' AND mailbox_state != 'draft' AND received_at > ?
			   AND (lower(to_address) = ?
			        OR instr(lower(to_addresses_json), ?) > 0
			        OR instr(lower(cc_addresses_json), ?) > 0)
			 LIMIT 1`,
		)
		.bind(r.received_at - CORRESPONDENT_WINDOW_MS, from, quoted, quoted)
		.first();
	return wrote ? "correspondent" : null;
}

function parseAddressList(json: string | null): string[] {
	try {
		const list = JSON.parse(json || "[]");
		return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
	} catch {
		return [];
	}
}

export interface PeopleRuleBackfillRow {
	id: string;
	from_address: string;
	subject: string | null;
	previous_category: string | null;
	reason: PeopleRuleReason;
}

/**
 * Applies the people rule to mail that arrived before it existed. Only replaces the AI
 * sorter's verdict (or no verdict): mail the owner filed by hand leaves no classification_log
 * row (email-level actions don't log), so a category without a matching codex/ai row is
 * the owner's. Also skips pinned conversations, senders whose rule says another category, and
 * Spam (hacked real contacts send phishing). One page per call, newest first; pass `next_before` back as `before` until it is null.
 */
export async function backfillPeopleRule(
	env: CloudflareBindings,
	opts: { since: number; before: number | null; limit: number; dryRun: boolean },
): Promise<{
	scanned: number;
	matched: PeopleRuleBackfillRow[];
	applied: number;
	next_before: number | null;
}> {
	const db = env.D1;
	const { results } = await db
		.prepare(
			`SELECT e.id, e.from_address, e.subject, e.category, e.thread_id, e.received_at,
			        e.list_unsubscribe, e.to_addresses_json, e.cc_addresses_json, e.reply_to_addresses_json
			 FROM emails e
			 LEFT JOIN threads t ON t.id = e.thread_id
			 WHERE e.direction = 'inbound' AND e.mailbox_state != 'trash'
			   AND e.received_at >= ? AND e.received_at < ?
			   AND COALESCE(e.category, '') NOT IN ('personal', 'spam')
			   AND t.user_pinned_category IS NULL
			   AND (e.category IS NULL OR EXISTS (
			         SELECT 1 FROM classification_log l
			         WHERE l.email_id = e.id AND l.method IN ('codex', 'ai') AND l.category = e.category))
			 ORDER BY e.received_at DESC
			 LIMIT ?`,
		)
		.bind(opts.since, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit)
		.all<{
			id: string;
			from_address: string;
			subject: string | null;
			category: string | null;
			thread_id: string | null;
			received_at: number;
			list_unsubscribe: string | null;
			to_addresses_json: string | null;
			cc_addresses_json: string | null;
			reply_to_addresses_json: string | null;
		}>();

	const matched: PeopleRuleBackfillRow[] = [];
	let applied = 0;
	for (const row of results) {
		const reason = await peopleRuleMatch(env, {
			...row,
			to_addresses: parseAddressList(row.to_addresses_json),
			cc_addresses: parseAddressList(row.cc_addresses_json),
			reply_to_addresses: parseAddressList(row.reply_to_addresses_json),
		});
		if (!reason) continue;
		// The owner's sender rule wins, unless it agrees (a rule added after the mail arrived).
		const rule = await findSenderRule(db, row.from_address);
		if (rule && rule.category !== "personal") continue;
		matched.push({
			id: row.id,
			from_address: row.from_address,
			subject: row.subject,
			previous_category: row.category as EmailCategory | null,
			reason,
		});
		if (opts.dryRun) continue;
		await db
			.prepare("UPDATE emails SET category = 'personal', sub_category = NULL WHERE id = ?")
			.bind(row.id)
			.run();
		await insertClassificationLog(db, {
			email_id: row.id,
			from_address: row.from_address,
			subject: row.subject,
			category: "personal",
			previous_category: row.category as EmailCategory | null,
			method: "people_rule",
			confidence: 1,
			ai_tokens_used: null,
		});
		if (row.thread_id) await refreshThreadSafe(db, row.thread_id);
		applied++;
	}
	return {
		scanned: results.length,
		matched,
		applied,
		next_before: results.length === opts.limit ? results[results.length - 1].received_at : null,
	};
}
