import { isThreadsTableReady } from "@/database/tables";
import type { ThreadEmail } from "@/services/threads";

export async function resolveThreadIdSafe(
	db: D1Database,
	email: ThreadEmail,
): Promise<string | null> {
	if (!(await isThreadsTableReady(db))) return null;
	const { resolveThreadId } = await import("@/services/threads");
	return resolveThreadId(db, email);
}

export async function refreshThreadSafe(db: D1Database, threadId: string): Promise<void> {
	if (!(await isThreadsTableReady(db))) return;
	try {
		const { refreshThread } = await import("@/services/threads");
		await refreshThread(db, threadId);
	} catch (err) {
		// Refresh failures used to propagate up to callers like deleteEmailById,
		// which wrap everything in a single try/catch and silently swallow —
		// leaving orphan/stale threads rows. Logging them explicitly surfaces
		// them in wrangler tail without blocking the caller's happy path.
		console.error("[refreshThreadSafe] refresh failed", { threadId, err });
	}
}

export async function isThreadMutedSafe(db: D1Database, threadId: string): Promise<boolean> {
	if (!(await isThreadsTableReady(db))) return false;
	const { isThreadMuted } = await import("@/services/threads");
	return isThreadMuted(db, threadId);
}

export async function applyThreadBatchActionSafe(
	db: D1Database,
	threadIds: string[],
	action: string,
	domainScope: string[] = [],
): Promise<{ updated: number }> {
	if (!(await isThreadsTableReady(db))) return { updated: 0 };
	const { applyThreadBatchAction } = await import("@/services/threads");
	return applyThreadBatchAction(db, threadIds, action, domainScope);
}

export async function refreshThreadBatchSafe(db: D1Database, threadIds: string[]): Promise<void> {
	if (!(await isThreadsTableReady(db)) || threadIds.length === 0) return;
	try {
		const { refreshThreadBatch } = await import("@/services/threads");
		await refreshThreadBatch(db, threadIds);
	} catch (err) {
		console.error("[refreshThreadBatchSafe] batch refresh failed", {
			threadCount: threadIds.length,
			err,
		});
	}
}
