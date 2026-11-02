import { setAgentMemory } from "@/database/agent";
import {
	type AutoReadSender,
	archiveUncertainAged,
	autoMarkReadAged,
	deleteEmailById,
	getTrashedEmailsForPurge,
	parseAutoReadSenders,
} from "@/database/d1";
import { MemoryMapUnavailable, refreshOwnerThreads } from "@/database/entities";
import { replayRawBacklog } from "@/services/ingest";
import { runMorningReport } from "@/services/morning-report";
import { purgeExpiredRawEmailArtifacts } from "@/services/raw-email";
import { logError, logInfo } from "@/utils/logging";
import { ownershipScope } from "@/utils/owner";

const TWENTY_ONE_DAYS_MS = 21 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 100;
const AUTO_READ_BATCH_SIZE = 500;

// Per-task minimum intervals. The cron fires hourly; each task keeps its own
// cadence. (There is no Worker IMAP poller: Google refuses IMAP logins from
// Cloudflare, so an external sync posts raw mail to /api/emails/import-raw.)
const INTERVAL_50_MIN = 50 * 60 * 1000;
const INTERVAL_10_HOURS = 10 * 60 * 60 * 1000;
const INTERVAL_24_HOURS = 24 * 60 * 60 * 1000;

/**
 * Per-task cadence guard. Returns true if `minIntervalMs` has passed since
 * the task last ran (and updates the timestamp). Uses the `agent_memory`
 * table with `workspace_id='system'` and `key=last_run_at:<taskName>`.
 */
async function shouldRun(
	env: CloudflareBindings,
	taskName: string,
	minIntervalMs: number,
): Promise<boolean> {
	const key = `last_run_at:${taskName}`;
	const row = await env.D1.prepare(
		"SELECT value FROM agent_memory WHERE key = ? AND workspace_id = 'system'",
	)
		.bind(key)
		.first<{ value: string }>();
	const last = row ? Number(row.value) : 0;
	const now = Date.now();
	if (Number.isFinite(last) && now - last < minIntervalMs) return false;
	await setAgentMemory(env.D1, "system", key, String(now));
	return true;
}

async function runIfDue(
	env: CloudflareBindings,
	name: string,
	minIntervalMs: number,
	task: () => Promise<void>,
): Promise<void> {
	if (!(await shouldRun(env, name, minIntervalMs))) return;
	await runScheduledTask(name, task);
}

/**
 * Unified scheduled handler. Cron fires hourly. Batch tasks are gated by
 * `shouldRun` to preserve their ~10-hour cadence; they fire on whichever tick
 * falls after their window.
 */
export async function handleScheduled(
	_event: ScheduledEvent,
	env: CloudflareBindings,
	ctx: ExecutionContext,
): Promise<void> {
	// Replay deliveries whose materialization failed after the raw write-ahead
	// (ingest never throws once the raw is in R2; this is how it recovers).
	await runIfDue(env, "raw_replay", INTERVAL_50_MIN, async () => {
		const { scanned, replayed } = await replayRawBacklog(env, { limit: 10 });
		if (replayed.length > 0) logInfo("cron_raw_replay_done", { scanned, replayed });
	});
	// Hourly so marketing (threshold 0) goes read soon after the sorter files it.
	await runIfDue(env, "auto_mark_read", INTERVAL_50_MIN, () => handleAutoMarkRead(env));
	await runIfDue(env, "uncertain_archive", INTERVAL_10_HOURS, () => handleUncertainArchive(env));
	await runIfDue(env, "trash_purge", INTERVAL_10_HOURS, () => handleTrashPurge(env));
	await runIfDue(env, "raw_email_purge", INTERVAL_10_HOURS, () => handleRawEmailPurge(env));
	await runIfDue(env, "memory_map_interest", INTERVAL_24_HOURS, () => handleMemoryMapInterest(env));
	// Every tick: the report keeps its own once-a-day state (src/services/morning-report.ts).
	await runScheduledTask("morning_report", async () => {
		const run = await runMorningReport(env, ctx);
		if (run.status === "sent" || run.status === "send_failed")
			logInfo("cron_morning_report", { ...run });
	});
}

async function runScheduledTask(name: string, task: () => Promise<void>): Promise<void> {
	try {
		await task();
	} catch (error) {
		logError("cron_task_failed", {
			task: name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Phase 1.4: auto-mark-read inbound email past its category's wait (or a
 * listed sender's or forwarded-in person's, AUTO_READ_SENDERS_JSON) where
 * user_kept_unread = 0. User
 * intentionally pinning unread keeps the email in the unread view; everything
 * else gets cleared so the inbox reflects what the user actually hasn't triaged.
 */
async function handleAutoMarkRead(env: CloudflareBindings): Promise<void> {
	let senders: AutoReadSender[] = [];
	try {
		senders = parseAutoReadSenders(
			env.AUTO_READ_SENDERS_JSON,
			env.AUTO_READ_SENDERS_JSON ? JSON.parse(env.FORWARDED_FOR_JSON || "{}") : {},
		);
	} catch (error) {
		// A bad setting must not stop the category waits.
		logError("cron_auto_read_senders_invalid", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const { marked, threads_refreshed, error } = await autoMarkReadAged(
		env.D1,
		TWENTY_ONE_DAYS_MS,
		AUTO_READ_BATCH_SIZE,
		senders,
	);

	if (error) {
		logError("cron_auto_mark_read_error", { error: error.message });
		return;
	}

	if (marked > 0) {
		logInfo("cron_auto_mark_read_done", { marked, threads_refreshed, senders: senders.length });
	}
}

/**
 * Phase 1.5: archive any email still flagged classification_uncertain after
 * 90 days (was 30 until 2026-09-30). Content is retained
 * (mailbox_state -> 'archived'). Keeps Personal from accumulating stale
 * uncertain predictions.
 */
async function handleUncertainArchive(env: CloudflareBindings): Promise<void> {
	const { archived, threads_refreshed, error } = await archiveUncertainAged(
		env.D1,
		NINETY_DAYS_MS,
		AUTO_READ_BATCH_SIZE,
	);

	if (error) {
		logError("cron_uncertain_archive_error", { error: error.message });
		return;
	}

	if (archived > 0) {
		logInfo("cron_uncertain_archive_done", { archived, threads_refreshed });
	}
}

async function handleTrashPurge(env: CloudflareBindings): Promise<void> {
	const { emails, error } = await getTrashedEmailsForPurge(
		env.D1,
		THIRTY_DAYS_MS,
		PURGE_BATCH_SIZE,
	);

	if (error) {
		logError("cron_trash_purge_error", { error: error.message });
		return;
	}

	if (emails.length === 0) return;

	logInfo("cron_trash_purge_start", { count: emails.length });

	let purged = 0;
	for (const email of emails) {
		if (env.ATTACHMENTS && email.attachmentKeys.length > 0) {
			await Promise.all(email.attachmentKeys.map((key) => env.ATTACHMENTS?.delete(key)));
		}
		const { deleted } = await deleteEmailById(env.D1, email.id);
		if (deleted) purged++;
	}

	logInfo("cron_trash_purge_done", { purged });
}

/**
 * Memory map (v52, R7): refresh each entity's "Owner writes" count, the distinct threads of
 * the owner's own sent mail in 365 days reaching it. Descriptive only: it orders and labels the
 * sorter's map. A no-op until v52 is applied.
 */
async function handleMemoryMapInterest(env: CloudflareBindings): Promise<void> {
	try {
		const result = await refreshOwnerThreads(env.D1, ownershipScope(env));
		logInfo("cron_memory_map_interest_done", result);
	} catch (error) {
		if (error instanceof MemoryMapUnavailable) return;
		throw error;
	}
}

async function handleRawEmailPurge(env: CloudflareBindings): Promise<void> {
	const result = await purgeExpiredRawEmailArtifacts(env.D1, env.ATTACHMENTS, PURGE_BATCH_SIZE);
	if (result.deleted > 0 || result.failed > 0) {
		logInfo("cron_raw_email_purge_done", result);
	}
}
