/**
 * Action notes (v55): the "Needs you" strip on Personal (2026-10-14: deadlines, legal
 * notices and account problems reach the reader as one short note).
 *
 * A note lives on its email (emails.action_note / action_due / action_done_at / action_expires_at).
 * Writers share normalizeActionNote: PUT /api/notes/:email_id (agents), the sorter's results and the
 * literal notes at ingest (invitations, codes), which write only when the email has no note yet.
 * Only a code note expires (v65, src/services/code-note.ts).
 */

/** A note is one short line. */
export const ACTION_NOTE_MAX = 140;
/**
 * An undated note drops off the strip this long after its email arrived; a dated one this long
 * after its due date, so a deadline a year out stays until it is marked done (agent-chosen
 * window, 2026-10-14; a licence renewal can be due a year out).
 */
const OPEN_NOTE_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_OPEN_NOTES = 100;

export interface NormalizedActionNote {
	note: string | null;
	/** Epoch ms at 00:00 UTC of the due day. */
	due: number | null;
	/** Why the input is not acceptable as given; the API rejects, the sorter keeps the rest. */
	error?: string;
}

/** Validate note text and a YYYY-MM-DD due date. An over-long note comes back truncated. */
export function normalizeActionNote(rawNote: unknown, rawDue: unknown): NormalizedActionNote {
	const text = typeof rawNote === "string" ? rawNote.replace(/\s+/g, " ").trim() : "";
	if (!text) return { note: null, due: null };
	const errors: string[] = [];
	let note = text;
	if (note.length > ACTION_NOTE_MAX) {
		errors.push(`note is over ${ACTION_NOTE_MAX} characters`);
		note = `${note.slice(0, ACTION_NOTE_MAX - 1).trimEnd()}…`;
	}
	let due: number | null = null;
	if (rawDue != null && rawDue !== "") {
		due = parseDueDate(rawDue);
		if (due == null) errors.push("due must be a date as YYYY-MM-DD");
	}
	return errors.length > 0 ? { note, due, error: errors.join("; ") } : { note, due };
}

function parseDueDate(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const ms = Date.UTC(year, month - 1, day);
	const back = new Date(ms);
	if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
	return ms;
}

export function formatDueDate(ms: number | null): string | null {
	return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}

function domainClause(domainScope: string[], column: string): { sql: string; params: string[] } {
	if (domainScope.length === 0) return { sql: "", params: [] };
	return {
		sql: ` AND ${column} IN (${domainScope.map(() => "?").join(", ")})`,
		params: domainScope,
	};
}

/**
 * Set (or replace) a note and reopen it. Returns false when the email is not in scope. Reopening
 * a code note (Undo of Done) keeps its expiry; new words are a note that no longer expires.
 */
export async function putActionNote(
	db: D1Database,
	emailId: string,
	note: string,
	due: number | null,
	domainScope: string[],
): Promise<boolean> {
	const scope = domainClause(domainScope, "domain");
	const { meta } = await db
		.prepare(
			`UPDATE emails SET action_note = ?, action_due = ?, action_done_at = NULL,
			   action_expires_at = CASE WHEN action_note IS ? THEN action_expires_at ELSE NULL END
			 WHERE id = ?${scope.sql}`,
		)
		.bind(note, due, note, emailId, ...scope.params)
		.run();
	return (meta?.changes ?? 0) > 0;
}

/** Mark a note done (first time wins). Returns false when there is no note on an email in scope. */
export async function markActionNoteDone(
	db: D1Database,
	emailId: string,
	nowMs: number,
	domainScope: string[],
): Promise<boolean> {
	const scope = domainClause(domainScope, "domain");
	const { meta } = await db
		.prepare(
			`UPDATE emails SET action_done_at = COALESCE(action_done_at, ?)
			 WHERE id = ? AND action_note IS NOT NULL${scope.sql}`,
		)
		.bind(nowMs, emailId, ...scope.params)
		.run();
	return (meta?.changes ?? 0) > 0;
}

export interface OpenActionNote {
	email_id: string;
	thread_id: string | null;
	note: string;
	due: string | null;
	from: { name: string | null; address: string };
	subject: string | null;
	received_at: number;
}

/**
 * Open notes: not done, not expired (codes), email not trashed, not a forwarded-in person's
 * thread (that person's mail is not the owner's), inside the window above. Dated notes first,
 * the soonest due on top, then undated ones newest first.
 */
export async function listOpenActionNotes(
	db: D1Database,
	nowMs: number,
	domainScope: string[],
): Promise<OpenActionNote[]> {
	const scope = domainClause(domainScope, "e.domain");
	const { results } = await db
		.prepare(
			`SELECT e.id, e.thread_id, e.action_note, e.action_due, e.from_name, e.from_address,
			        e.subject, e.received_at
			 FROM emails e
			 LEFT JOIN threads t ON t.id = e.thread_id
			 WHERE e.action_note IS NOT NULL
			   AND e.action_done_at IS NULL
			   AND e.received_at <= ?
			   AND e.mailbox_state != 'trash'
			   AND CASE WHEN e.action_due IS NULL THEN e.received_at ELSE e.action_due END > ?
			   AND (e.action_expires_at IS NULL OR e.action_expires_at > ?)
			   AND t.for_person IS NULL${scope.sql}
			 ORDER BY e.action_due IS NULL, e.action_due ASC, e.received_at DESC
			 LIMIT ${MAX_OPEN_NOTES}`,
		)
		.bind(nowMs, nowMs - OPEN_NOTE_WINDOW_MS, nowMs, ...scope.params)
		.all();
	return ((results ?? []) as Record<string, unknown>[]).map((row) => ({
		email_id: String(row.id),
		thread_id: row.thread_id == null ? null : String(row.thread_id),
		note: String(row.action_note),
		due: formatDueDate(row.action_due == null ? null : Number(row.action_due)),
		from: {
			name: row.from_name == null || row.from_name === "" ? null : String(row.from_name),
			address: String(row.from_address),
		},
		subject: row.subject == null ? null : String(row.subject),
		received_at: Number(row.received_at),
	}));
}
