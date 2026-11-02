/**
 * Blocked senders (v33) — "Trash all + future" semantics, user-decided.
 *
 * A block entry matches either an exact address or every address at a
 * domain (the part after the last @), case-insensitively. Ingest paths call
 * isBlockedSender() BEFORE classification / unread counts / push fan-out
 * and store matching mail with mailbox_state='trash'. Creating a block also
 * sweeps existing non-trash inbound mail from that sender into Trash.
 *
 * IMPORTANT: blocking is a mailbox_state change only. Nothing here deletes
 * or rewrites email content — hard-delete-all-from-sender was deliberately
 * deferred.
 */
import { isBlockedSendersTableReady, isTrashedAtColumnReady } from "@/database/tables";
import { refreshThreadBatchSafe } from "@/services/threads-loader";
import { now } from "@/utils/helpers";
import { logError } from "@/utils/logging";

export type BlockedSenderPatternType = "address" | "domain";

export interface BlockedSender {
	id: number;
	pattern_type: BlockedSenderPatternType;
	pattern: string;
	note: string | null;
	created_at: number;
}

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Split a from_address into its case-folded match keys. */
export function getSenderMatchKeys(fromAddress: string): { address: string; domain: string } {
	const address = (fromAddress || "").trim().toLowerCase();
	const atIndex = address.lastIndexOf("@");
	const domain = atIndex > 0 && atIndex < address.length - 1 ? address.slice(atIndex + 1) : "";
	return { address, domain };
}

/**
 * Validate + normalize a block pattern. Refuses patterns that target the
 * user's own workspace domains (foot-gun guard: blocking your own domain
 * would trash legitimate inbound mail, including emails-to-self).
 */
export function validateBlockPattern(
	patternType: BlockedSenderPatternType,
	rawPattern: string,
	protectedDomains: string[],
): { ok: true; pattern: string } | { ok: false; reason: string } {
	const pattern = (rawPattern || "").trim().toLowerCase();
	const protectedSet = new Set(
		protectedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
	);

	if (patternType === "address") {
		if (!ADDRESS_PATTERN.test(pattern)) {
			return { ok: false, reason: "Pattern must be a valid email address like sender@example.com" };
		}
		const { domain } = getSenderMatchKeys(pattern);
		if (protectedSet.has(domain)) {
			return {
				ok: false,
				reason: `Refusing to block ${pattern}: ${domain} is one of your own workspace domains`,
			};
		}
		return { ok: true, pattern };
	}

	if (!DOMAIN_PATTERN.test(pattern)) {
		return { ok: false, reason: "Pattern must be a bare domain like example.com" };
	}
	if (protectedSet.has(pattern)) {
		return {
			ok: false,
			reason: `Refusing to block ${pattern}: it is one of your own workspace domains`,
		};
	}
	return { ok: true, pattern };
}

type Row = Record<string, unknown>;

function rowToBlockedSender(row: Row): BlockedSender {
	return {
		id: Number(row.id),
		pattern_type: String(row.pattern_type) as BlockedSenderPatternType,
		pattern: String(row.pattern),
		note: row.note === null || row.note === undefined ? null : String(row.note),
		created_at: Number(row.created_at),
	};
}

export async function listBlockedSenders(
	db: D1Database,
): Promise<{ blocked: BlockedSender[]; error?: Error }> {
	try {
		if (!(await isBlockedSendersTableReady(db))) {
			return { blocked: [] };
		}
		const { results } = await db
			.prepare(
				`SELECT id, pattern_type, pattern, note, created_at
				 FROM blocked_senders
				 ORDER BY created_at DESC, id DESC`,
			)
			.all<Row>();
		return { blocked: (results ?? []).map(rowToBlockedSender) };
	} catch (e: unknown) {
		return { blocked: [], error: e instanceof Error ? e : new Error(String(e)) };
	}
}

export async function createBlockedSender(
	db: D1Database,
	input: { pattern_type: BlockedSenderPatternType; pattern: string; note?: string | null },
): Promise<{ blocked?: BlockedSender; conflict?: boolean; error?: Error }> {
	try {
		const createdAt = now();
		const result = await db
			.prepare(
				"INSERT INTO blocked_senders (pattern_type, pattern, note, created_at) VALUES (?, ?, ?, ?)",
			)
			.bind(input.pattern_type, input.pattern, input.note ?? null, createdAt)
			.run();

		return {
			blocked: {
				id: Number(result.meta?.last_row_id ?? 0),
				pattern_type: input.pattern_type,
				pattern: input.pattern,
				note: input.note ?? null,
				created_at: createdAt,
			},
		};
	} catch (e: unknown) {
		const error = e instanceof Error ? e : new Error(String(e));
		if (/UNIQUE/i.test(error.message)) {
			return { conflict: true, error };
		}
		return { error };
	}
}

export async function deleteBlockedSenderById(
	db: D1Database,
	id: number,
): Promise<{ deleted: boolean; error?: Error }> {
	try {
		const { meta } = await db.prepare("DELETE FROM blocked_senders WHERE id = ?").bind(id).run();
		return { deleted: (meta?.changes ?? 0) > 0 };
	} catch (e: unknown) {
		return { deleted: false, error: e instanceof Error ? e : new Error(String(e)) };
	}
}

/**
 * Ingest-side lookup. Returns false on ANY failure (table missing, D1
 * hiccup) so email delivery is never blocked by the block list itself.
 */
export async function isBlockedSender(db: D1Database, fromAddress: string): Promise<boolean> {
	try {
		if (!(await isBlockedSendersTableReady(db))) return false;
		const { address, domain } = getSenderMatchKeys(fromAddress);
		if (!address) return false;

		// pattern is COLLATE NOCASE and both keys are lowercased, so these
		// equality checks are case-insensitive.
		const row = await db
			.prepare(
				`SELECT 1 FROM blocked_senders
				 WHERE (pattern_type = 'address' AND pattern = ?)
				    OR (pattern_type = 'domain' AND pattern = ?)
				 LIMIT 1`,
			)
			.bind(address, domain)
			.first();
		return row !== null;
	} catch (e: unknown) {
		logError("blocked_sender_lookup_failed", {
			from_address: fromAddress,
			error: e instanceof Error ? e.message : String(e),
		});
		return false;
	}
}

/**
 * Move all existing non-trash inbound mail matching the pattern to Trash
 * (same state change as the 'trash' batch action: mailbox_state + trashed_at
 * when the column exists, then thread aggregate refresh). Content is never
 * deleted. Returns the affected row count.
 */
export async function sweepBlockedSender(
	db: D1Database,
	patternType: BlockedSenderPatternType,
	pattern: string,
): Promise<{ swept: number; error?: Error }> {
	try {
		// Patterns are pre-validated (no LIKE metacharacters in a bare domain),
		// so the '%@' || ? suffix match is safe.
		const matchClause =
			patternType === "address" ? "from_address = ? COLLATE NOCASE" : "from_address LIKE '%@' || ?";
		const where = `direction = 'inbound' AND mailbox_state != 'trash' AND ${matchClause}`;

		const threadRows = await db
			.prepare(`SELECT DISTINCT thread_id FROM emails WHERE ${where} AND thread_id IS NOT NULL`)
			.bind(pattern)
			.all<Row>();

		const trashedAtReady = await isTrashedAtColumnReady(db);
		const setClause = trashedAtReady
			? "mailbox_state = 'trash', trashed_at = ?"
			: "mailbox_state = 'trash'";
		const params = trashedAtReady ? [now(), pattern] : [pattern];

		const { meta } = await db
			.prepare(`UPDATE emails SET ${setClause} WHERE ${where}`)
			.bind(...params)
			.run();
		const swept = meta?.changes ?? 0;

		if (swept > 0) {
			const threadIds = (threadRows.results ?? [])
				.map((row) => row.thread_id)
				.filter((tid): tid is string => typeof tid === "string" && tid.length > 0);
			await refreshThreadBatchSafe(db, threadIds);
		}

		return { swept };
	} catch (e: unknown) {
		return { swept: 0, error: e instanceof Error ? e : new Error(String(e)) };
	}
}
