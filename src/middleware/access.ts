/**
 * What a signed-in user may reach (ticket 09). API_TOKEN callers pass through unchanged.
 *
 * - Operator routes need is_admin.
 * - A user with an `all` grant reaches every other route with the full domain scope, the same
 *   scope API_TOKEN has.
 * - A user restricted to for_person threads reaches only the routes listed in
 *   `restrictedRoute` below; everything else is 403. Deny by default keeps the leak surface to
 *   this file and the two routes that scope by person (meta, conversation list).
 *   They see a thread only when it is theirs and holds no draft: a draft is the owner's unsent text,
 *   and the thread row's snippet and counts would carry it.
 * - A user with no grants reaches nothing but /api/auth/* and /api/account/*.
 */
import type { Context, Next } from "hono";
import { getUser, isPrivileged, restrictedPersons } from "@/auth/principal";
import type { AppVariables, MailboxState, PlatformMeta } from "@/types";
import { ERR } from "@/utils/http";
import { buildPlatformMeta } from "@/utils/platform";

type AppContext = Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>;

const OPERATOR_ROUTES = [
	/^\/api\/admin\//,
	/^\/api\/entities(\/|$)/,
	/^\/api\/emails\/import(-raw)?$/,
	/^\/api\/agent\/classify-queue\//,
];

/** SQL: thread t is one of the persons' and holds no draft. */
function visibleThreadSql(persons: string[]): string {
	return `t.for_person IN (${persons.map(() => "?").join(", ")})
		AND NOT EXISTS (SELECT 1 FROM emails d WHERE d.thread_id = t.id AND d.mailbox_state = 'draft')`;
}

/** Same rule as a conversation-list condition (src/routes/conversations.ts). */
export function restrictedThreadCondition(persons: string[]): { sql: string; params: string[] } {
	return { sql: visibleThreadSql(persons), params: persons };
}

async function visibleEmailCount(c: AppContext, persons: string[], ids: string[]) {
	if (ids.length === 0) return 0;
	const row = await c.env.D1.prepare(
		`SELECT COUNT(*) AS n FROM emails e JOIN threads t ON t.id = e.thread_id
		 WHERE e.id IN (${ids.map(() => "?").join(", ")}) AND ${visibleThreadSql(persons)}`,
	)
		.bind(...ids, ...persons)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

async function visibleThreadCount(c: AppContext, persons: string[], ids: string[]) {
	if (ids.length === 0) return 0;
	const row = await c.env.D1.prepare(
		`SELECT COUNT(*) AS n FROM threads t
		 WHERE t.id IN (${ids.map(() => "?").join(", ")}) AND ${visibleThreadSql(persons)}`,
	)
		.bind(...ids, ...persons)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

const emailVisible = async (c: AppContext, persons: string[], id: string) =>
	(await visibleEmailCount(c, persons, [id])) === 1;

type Verdict = { ok: true } | { ok: false; status: 403 | 404; code: string; message: string };
const OK_VERDICT: Verdict = { ok: true };
const NOT_FOUND: Verdict = { ok: false, status: 404, code: "NOT_FOUND", message: "Not found" };
const FORBIDDEN: Verdict = {
	ok: false,
	status: 403,
	code: "FORBIDDEN",
	message: "Your account cannot use this",
};
// D1 binds at most 100 parameters per statement.
const MAX_BULK_IDS = 80;

/** One path segment as Hono decodes route params; null when malformed (then nothing matches). */
function segment(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

async function restrictedRoute(c: AppContext, persons: string[]): Promise<Verdict> {
	const method = c.req.method;
	const path = c.req.path;
	let m: RegExpMatchArray | null;

	if (method === "GET") {
		if (path === "/api/meta" || path === "/api/conversations") {
			return OK_VERDICT;
		}
		m = path.match(/^\/api\/conversations\/([^/]+)$/);
		if (m) {
			const id = segment(m[1]);
			if (id === null) return NOT_FOUND;
			const visible =
				(await visibleThreadCount(c, persons, [id])) === 1 || (await emailVisible(c, persons, id));
			if (!visible) return NOT_FOUND;
			const emailId = c.req.query("email_id")?.trim();
			if (emailId && !(await emailVisible(c, persons, emailId))) return NOT_FOUND;
			return OK_VERDICT;
		}
		m = path.match(/^\/api\/emails\/([^/]+)(\/thread|\/attachments\/[^/]+)?$/);
		if (m && m[1] === "contacts") return FORBIDDEN;
		if (m) {
			const id = segment(m[1]);
			return id !== null && (await emailVisible(c, persons, id)) ? OK_VERDICT : NOT_FOUND;
		}
		return FORBIDDEN;
	}

	if (method === "PATCH") {
		m = path.match(/^\/api\/emails\/([^/]+)$/);
		if (!m) return FORBIDDEN;
		const id = segment(m[1]);
		if (id === null || !(await emailVisible(c, persons, id))) return NOT_FOUND;
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const keys = body && typeof body === "object" ? Object.keys(body) : [];
		return keys.length > 0 && keys.every((key) => key === "is_read") ? OK_VERDICT : FORBIDDEN;
	}

	if (method === "POST" && path === "/api/emails/actions") {
		const body = (await c.req.json().catch(() => null)) as {
			action?: unknown;
			ids?: unknown;
			thread_ids?: unknown;
		} | null;
		if (body?.action !== "mark_read" && body?.action !== "mark_unread") return FORBIDDEN;
		const strings = (value: unknown) =>
			Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()))] : [];
		const ids = strings(body.ids);
		const threadIds = strings(body.thread_ids);
		if (ids.length + threadIds.length === 0 || ids.length > MAX_BULK_IDS) return FORBIDDEN;
		if (threadIds.length > MAX_BULK_IDS) return FORBIDDEN;
		if ((await visibleEmailCount(c, persons, ids)) !== ids.length) return FORBIDDEN;
		if ((await visibleThreadCount(c, persons, threadIds)) !== threadIds.length) return FORBIDDEN;
		return OK_VERDICT;
	}

	return FORBIDDEN;
}

export async function accessMiddleware(c: AppContext, next: Next) {
	const user = getUser(c);
	// Their own sign-in, devices and account (AI consent, deletion) whatever their grants.
	if (
		!user ||
		c.req.path.startsWith("/api/auth/") ||
		c.req.path.startsWith("/api/account/") ||
		c.req.path === "/api/devices"
	) {
		await next();
		return;
	}

	if (OPERATOR_ROUTES.some((route) => route.test(c.req.path))) {
		if (!isPrivileged(c)) {
			return c.json(ERR("FORBIDDEN", "This needs an administrator"), 403);
		}
		await next();
		return;
	}

	const persons = restrictedPersons(c);
	if (persons === null) {
		await next();
		return;
	}
	if (persons.length === 0) {
		return c.json(ERR("NO_ACCESS", "Your account has no mail access yet"), 403);
	}

	const verdict = await restrictedRoute(c, persons);
	if (!verdict.ok) return c.json(ERR(verdict.code, verdict.message), verdict.status);
	await next();
}

/**
 * /api/meta for a restricted user: counts from their threads only. No domains,
 * mailboxes, categories or allowed senders, which would describe the owner's mail.
 */
export async function restrictedMeta(c: AppContext, persons: string[]): Promise<PlatformMeta> {
	const { results } = await c.env.D1.prepare(
		`SELECT t.mailbox_state AS state, t.for_person AS person, COUNT(*) AS n,
			COALESCE(SUM(t.unread_count), 0) AS unread
		 FROM threads t WHERE ${visibleThreadSql(persons)}
		 GROUP BY t.mailbox_state, t.for_person`,
	)
		.bind(...persons)
		.all<{ state: MailboxState; person: string; n: number; unread: number }>();

	const states: Record<MailboxState, number> = {
		inbox: 0,
		sent: 0,
		archived: 0,
		trash: 0,
		draft: 0,
	};
	const personCounts: Record<string, number> = {};
	const personUnread: Record<string, number> = {};
	let total = 0;
	let unread = 0;
	for (const row of results) {
		const n = Number(row.n);
		const u = Number(row.unread);
		if (row.state in states) states[row.state] += n;
		personCounts[row.person] = (personCounts[row.person] ?? 0) + n;
		personUnread[row.person] = (personUnread[row.person] ?? 0) + u;
		total += n;
		unread += u;
	}
	const meta = buildPlatformMeta(
		c.env,
		{ domains: [], mailbox_state_counts: { ...states }, unread_count: unread, category_counts: {} },
		{
			conversation_count: total,
			conversation_mailbox_state_counts: states,
			conversation_unread_count: unread,
			conversation_category_counts: {},
			conversation_for_person_counts: personCounts,
			conversation_for_person_unread_counts: personUnread,
		},
	);
	return { ...meta, configured_domains: [], allowed_senders: [], sender_names: {} };
}
