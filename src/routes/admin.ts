/**
 * Admin-only endpoints for infrastructure maintenance.
 *
 * Mounted under /api/admin/*, so inherits the standard auth middleware.
 * These operations are safe to expose to a workspace owner but should be
 * treated as "batch utilities" — they run on-demand and return progress
 * that the caller should iterate until exhaustion.
 */

import { Hono } from "hono";
import { isPrivileged } from "@/auth/principal";
import {
	getClassifyAfterMs,
	getClassifyQueueStats,
	getCodexSidecarLastSeen,
} from "@/database/classifier";
import { listAttachmentsByExtractStatus, updateAttachmentExtractStatus } from "@/database/d1";
import { isAttachmentExtractStatusColumnReady, isHtmlOffloadColumnsReady } from "@/database/tables";
import { aiConsent } from "@/services/ai-consent";
import { billingConfig, usageStatement } from "@/services/ai-usage";
import { replayRawBacklog } from "@/services/ingest";
import {
	collectMorningReport,
	getMorningReportConfig,
	localClock,
	renderMorningReport,
	runMorningReport,
} from "@/services/morning-report";
import { backfillPeopleRule } from "@/services/people-rule";
import { listEmailFidelityChecks, purgeExpiredRawEmailArtifacts } from "@/services/raw-email";
import {
	recomputeThreadsPage,
	repairDraftThreadsPage,
	repairMissingThreadIds,
	repairSplitThreadsPage,
} from "@/services/threads";
import type { AppVariables } from "@/types";
import {
	HTML_OFFLOAD_AGE_MS,
	HTML_OFFLOAD_SIZE_THRESHOLD,
	putEmailBodyToR2,
	shouldOffloadHtml,
} from "@/utils/html-offload";
import { ERR, OK } from "@/utils/http";
import { logInfo } from "@/utils/logging";
import { getConfiguredDomains, getEmailProviderName, getFeatureFlags } from "@/utils/platform";
import { updateAttachmentExtractStatusSchema } from "@/utils/validation";

const admin = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();
const DEFAULT_HEALTH_WINDOW_HOURS = 24;
const DEFAULT_INBOUND_WARN_AFTER_HOURS = 168;
// Classifier check thresholds: the codex sidecar should keep fresh backlog
// near zero and check in (claim or results) at least daily.
const CLASSIFIER_WARN_PENDING_FRESH = 50;
const CLASSIFIER_WARN_OLDEST_FRESH_AGE_MS = 2 * 60 * 60 * 1000;
const CLASSIFIER_FAIL_SIDECAR_SILENCE_MS = 24 * 60 * 60 * 1000;

interface Candidate {
	id: string;
	html_content: string;
	received_at: number;
}

type HealthStatus = "ok" | "warn" | "fail";
type HealthRow = Record<string, unknown>;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
	if (value == null) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function statusRank(status: HealthStatus): number {
	return status === "fail" ? 2 : status === "warn" ? 1 : 0;
}

function maxStatus(...statuses: HealthStatus[]): HealthStatus {
	return statuses.reduce<HealthStatus>(
		(current, next) => (statusRank(next) > statusRank(current) ? next : current),
		"ok",
	);
}

function scopedDomainWhere(domainScope: string[], alias?: string): string {
	if (domainScope.length === 0) return "";
	const column = alias ? `${alias}.domain` : "domain";
	return ` AND ${column} IN (${domainScope.map(() => "?").join(", ")})`;
}

function numberValue(value: unknown): number {
	const numeric = Number(value ?? 0);
	return Number.isFinite(numeric) ? numeric : 0;
}

function nullableNumberValue(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function latestAgeMs(latest: number | null, nowMs: number): number | null {
	return latest ? Math.max(0, nowMs - latest) : null;
}

function parseDryRun(value: string | undefined): boolean {
	if (value == null) return true;
	const normalized = value.trim().toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Offload HTML bodies from D1 to R2 for emails that meet the size/age
 * thresholds. Processes a batch (default 50) per call and returns progress
 * so the caller can loop until `remaining == 0`.
 *
 * Query params:
 *   ?batch=N      — how many to process this call (default 50, max 200)
 *   ?dry_run=1    — select candidates but don't write
 */
admin.post("/api/admin/offload-html", async (c) => {
	if (!c.env.ATTACHMENTS) {
		return c.json(ERR("NO_BUCKET", "ATTACHMENTS R2 binding is not configured"), 500);
	}
	if (!(await isHtmlOffloadColumnsReady(c.env.D1))) {
		return c.json(ERR("NEEDS_MIGRATION", "migrate-v23-html-offload.sql has not been applied"), 412);
	}

	const batchParam = Number.parseInt(c.req.query("batch") ?? "50", 10);
	const batchSize = Math.max(1, Math.min(200, Number.isFinite(batchParam) ? batchParam : 50));
	const dryRun = c.req.query("dry_run") === "1";

	const ageCutoffMs = Date.now() - HTML_OFFLOAD_AGE_MS;
	const sizeThreshold = HTML_OFFLOAD_SIZE_THRESHOLD;

	// Find candidates: html_in_r2=0 AND html_content is non-empty AND
	// (size > threshold OR older than cutoff).
	const candidatesResult = await c.env.D1.prepare(
		`SELECT id, html_content, received_at
		   FROM emails
		  WHERE html_in_r2 = 0
		    AND html_content IS NOT NULL
		    AND LENGTH(html_content) > 0
		    AND (LENGTH(html_content) > ? OR received_at < ?)
		  ORDER BY LENGTH(html_content) DESC
		  LIMIT ?`,
	)
		.bind(sizeThreshold, ageCutoffMs, batchSize)
		.all<{ id: string; html_content: string; received_at: number }>();

	const candidates: Candidate[] = (candidatesResult.results ?? []).map((row) => ({
		id: String(row.id),
		html_content: String(row.html_content),
		received_at: Number(row.received_at),
	}));

	// Count total remaining (for progress tracking).
	const remainingResult = await c.env.D1.prepare(
		`SELECT COUNT(*) as total
		   FROM emails
		  WHERE html_in_r2 = 0
		    AND html_content IS NOT NULL
		    AND LENGTH(html_content) > 0
		    AND (LENGTH(html_content) > ? OR received_at < ?)`,
	)
		.bind(sizeThreshold, ageCutoffMs)
		.first<{ total: number }>();
	const totalRemaining = Number(remainingResult?.total ?? 0);

	if (dryRun) {
		return c.json(
			OK({
				dry_run: true,
				batch_size: batchSize,
				selected: candidates.length,
				total_remaining: totalRemaining,
				sample: candidates.slice(0, 5).map((c) => ({
					id: c.id,
					size: c.html_content.length,
					received_at: c.received_at,
				})),
			}),
		);
	}

	let processed = 0;
	let bytesMoved = 0;
	const failures: Array<{ id: string; error: string }> = [];

	for (const candidate of candidates) {
		const decision = shouldOffloadHtml({
			html_content: candidate.html_content,
			received_at: candidate.received_at,
		});
		if (!decision.offload) continue;

		try {
			const key = await putEmailBodyToR2(c.env.ATTACHMENTS, candidate.id, candidate.html_content);
			await c.env.D1.prepare(
				"UPDATE emails SET html_in_r2 = 1, r2_html_key = ?, html_content = NULL WHERE id = ?",
			)
				.bind(key, candidate.id)
				.run();
			processed += 1;
			bytesMoved += candidate.html_content.length;
		} catch (err) {
			failures.push({
				id: candidate.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	logInfo("html_offload_batch_complete", {
		batch_size: batchSize,
		processed,
		failed: failures.length,
		bytes_moved: bytesMoved,
		total_remaining_before_batch: totalRemaining,
	});

	return c.json(
		OK({
			processed,
			failed: failures.length,
			bytes_moved: bytesMoved,
			total_remaining: Math.max(totalRemaining - processed, 0),
			failures: failures.slice(0, 10),
		}),
	);
});

// People rule over mail that predates it (src/services/people-rule.ts). Dry run unless
// dry_run=0. since: YYYY-MM-DD; before: epoch ms from the previous page's next_before.
admin.post("/api/admin/people-rule/backfill", async (c) => {
	const since = Date.parse(c.req.query("since") ?? "");
	if (!Number.isFinite(since)) {
		return c.json(ERR("INVALID_QUERY", "since must be a date, e.g. 2026-08-30"), 400);
	}
	const beforeParam = Number.parseInt(c.req.query("before") ?? "", 10);
	const limitParam = Number.parseInt(c.req.query("limit") ?? "200", 10);
	const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 500)) : 200;
	try {
		const result = await backfillPeopleRule(c.env, {
			since,
			before: Number.isFinite(beforeParam) ? beforeParam : null,
			limit,
			dryRun: parseDryRun(c.req.query("dry_run")),
		});
		return c.json(OK(result));
	} catch (err) {
		return c.json(
			ERR("PEOPLE_RULE_BACKFILL_FAILED", err instanceof Error ? err.message : String(err)),
			500,
		);
	}
});

// Re-run the thread refresh where stored priority_category / for_person is stale
// (src/services/threads.ts recomputeThreadsPage; inbox levels, 2026-10-14). Dry run
// unless dry_run=0. after: thread id from the previous page's next_after; since: epoch ms.
// repair_missing=1 instead threads up to `limit` (max 200) emails stored with no thread_id (the one
// operator path for that since POST /api/conversations/rebuild was cut, 2026-10-22).
admin.post("/api/admin/threads/recompute", async (c) => {
	const limitParam = Number.parseInt(c.req.query("limit") ?? "1000", 10);
	const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 2000)) : 1000;
	const sinceParam = Number.parseInt(c.req.query("since") ?? "0", 10);
	const dryRun = parseDryRun(c.req.query("dry_run"));
	try {
		if (c.req.query("repair_splits") === "1") {
			return c.json(
				OK(
					await repairSplitThreadsPage(c.env.D1, {
						after: c.req.query("after")?.trim() || null,
						threadId: c.req.query("thread_id")?.trim() || null,
						limit: c.req.query("limit") ? limit : 10,
						dryRun,
					}),
				),
			);
		}
		if (c.req.query("repair_missing") === "1") {
			if (dryRun) {
				const row = await c.env.D1.prepare(
					"SELECT COUNT(*) AS n FROM emails WHERE thread_id IS NULL",
				).first<{ n: number }>();
				return c.json(OK({ dry_run: true, missing_thread_id: Number(row?.n ?? 0) }));
			}
			// Several queries per email: keep each call well under the subrequest limit.
			const repaired = await repairMissingThreadIds(c.env.D1, Math.min(limit, 200));
			return c.json(OK({ dry_run: false, ...repaired }));
		}
		const result = await recomputeThreadsPage(c.env.D1, {
			after: c.req.query("after")?.trim() || null,
			since: Number.isFinite(sinceParam) ? sinceParam : 0,
			limit,
			dryRun,
		});
		return c.json(OK(result));
	} catch (err) {
		return c.json(
			ERR("THREAD_RECOMPUTE_FAILED", err instanceof Error ? err.message : String(err)),
			500,
		);
	}
});

admin.post("/api/admin/drafts/thread-repair", async (c) => {
	const limitParam = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 500)) : 100;
	const cursor = c.req.query("cursor")?.trim() || null;
	const dryRun = parseDryRun(c.req.query("dry_run"));
	const domainScope = getConfiguredDomains(c.env);

	try {
		const result = await repairDraftThreadsPage(c.env.D1, {
			domainScope,
			limit,
			cursor,
			dryRun,
		});
		return c.json(OK(result));
	} catch (err) {
		return c.json(
			ERR("DRAFT_THREAD_REPAIR_FAILED", err instanceof Error ? err.message : String(err)),
			500,
		);
	}
});

admin.get("/api/admin/health", async (c) => {
	const domainScope = getConfiguredDomains(c.env);
	const nowMs = Date.now();
	const windowHours = parsePositiveNumber(c.req.query("window_hours"), DEFAULT_HEALTH_WINDOW_HOURS);
	const inboundWarnAfterHours = parsePositiveNumber(
		c.req.query("max_inbound_age_hours"),
		DEFAULT_INBOUND_WARN_AFTER_HOURS,
	);
	const windowCutoff = nowMs - windowHours * 60 * 60 * 1000;
	const fidelityCutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
	const domainWhere = scopedDomainWhere(domainScope);
	const emailDomainWhere = scopedDomainWhere(domainScope, "e");
	const features = getFeatureFlags(c.env);

	try {
		const [
			inboundByDomainResult,
			outboundResult,
			attachmentResult,
			rawResult,
			fidelityResult,
			missingAttachmentRowsResult,
			recentInboundWithoutRawResult,
		] = await c.env.D1.batch([
			c.env.D1.prepare(
				`SELECT domain,
				        COUNT(*) AS total,
				        SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS recent,
				        MAX(received_at) AS latest
				   FROM emails
				  WHERE direction = 'inbound'${domainWhere}
				  GROUP BY domain
				  ORDER BY latest DESC`,
			).bind(windowCutoff, ...domainScope),
			c.env.D1.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN COALESCE(sent_at, received_at) >= ? THEN 1 ELSE 0 END) AS recent,
				        MAX(COALESCE(sent_at, received_at)) AS latest
				   FROM emails
				  WHERE direction = 'outbound'
				    AND mailbox_state = 'sent'${domainWhere}`,
			).bind(windowCutoff, ...domainScope),
			c.env.D1.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN a.created_at >= ? THEN 1 ELSE 0 END) AS recent,
				        MAX(a.created_at) AS latest
				   FROM attachments a
				   INNER JOIN emails e ON e.id = a.email_id
				  WHERE 1 = 1${emailDomainWhere}`,
			).bind(windowCutoff, ...domainScope),
			c.env.D1.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN stored_at >= ? THEN 1 ELSE 0 END) AS recent,
				        SUM(CASE WHEN parse_status != 'parsed' THEN 1 ELSE 0 END) AS parse_issues,
				        MAX(stored_at) AS latest
				   FROM raw_email_artifacts
				  WHERE 1 = 1${domainWhere}`,
			).bind(windowCutoff, ...domainScope),
			c.env.D1.prepare(
				`SELECT f.status AS status,
				        COUNT(*) AS count,
				        MAX(f.checked_at) AS latest
				   FROM email_fidelity_checks f
				   INNER JOIN emails e ON e.id = f.email_id
				  WHERE f.checked_at >= ?${emailDomainWhere}
				  GROUP BY f.status`,
			).bind(fidelityCutoff, ...domainScope),
			c.env.D1.prepare(
				`SELECT COUNT(*) AS count
				   FROM emails e
				  WHERE e.has_attachments = 1
				    AND COALESCE(e.sent_at, e.received_at) >= ?
				    AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)${emailDomainWhere}`,
			).bind(windowCutoff, ...domainScope),
			c.env.D1.prepare(
				`SELECT COUNT(*) AS count
				   FROM emails e
				  WHERE e.direction = 'inbound'
				    AND e.received_at >= ?
				    AND e.source_type IS NULL
				    AND NOT EXISTS (SELECT 1 FROM raw_email_artifacts r WHERE r.email_id = e.id)${emailDomainWhere}`,
			).bind(windowCutoff, ...domainScope),
		]);

		const inboundRows = ((inboundByDomainResult.results ?? []) as HealthRow[]).map((row) => ({
			domain: String(row.domain),
			total: numberValue(row.total),
			recent: numberValue(row.recent),
			latest: nullableNumberValue(row.latest),
			latest_age_ms: latestAgeMs(nullableNumberValue(row.latest), nowMs),
		}));
		const inboundByDomain = new Map(inboundRows.map((row) => [row.domain, row]));
		for (const domain of domainScope) {
			if (!inboundByDomain.has(domain)) {
				inboundRows.push({
					domain,
					total: 0,
					recent: 0,
					latest: null,
					latest_age_ms: null,
				});
			}
		}

		const outbound = ((outboundResult.results ?? []) as HealthRow[])[0] ?? {};
		const attachments = ((attachmentResult.results ?? []) as HealthRow[])[0] ?? {};
		const raw = ((rawResult.results ?? []) as HealthRow[])[0] ?? {};
		const fidelityRows = (fidelityResult.results ?? []) as HealthRow[];
		const fidelity = {
			pass: 0,
			warn: 0,
			fail: 0,
			latest: null as number | null,
		};
		for (const row of fidelityRows) {
			const status = String(row.status) as keyof Omit<typeof fidelity, "latest">;
			if (status === "pass" || status === "warn" || status === "fail") {
				fidelity[status] = numberValue(row.count);
			}
			const latest = nullableNumberValue(row.latest);
			if (latest && (!fidelity.latest || latest > fidelity.latest)) {
				fidelity.latest = latest;
			}
		}

		// Classifier queue health: warn on fresh backlog, fail when the codex
		// sidecar has gone silent while fresh work is pending.
		const classifyAfter = await getClassifyAfterMs(c.env.D1);
		const [queueStats, sidecarLastSeen, consent] = await Promise.all([
			getClassifyQueueStats(c.env.D1, classifyAfter, nowMs),
			getCodexSidecarLastSeen(c.env.D1),
			aiConsent(c.env.D1),
		]);
		const oldestFreshPendingAgeMs = latestAgeMs(queueStats.oldest_fresh_pending_at, nowMs);
		// With AI consent off (v64) nothing is sorted on purpose: neither a warning nor a failure.
		const classifierWarn =
			consent.allowed &&
			(queueStats.pending_fresh_48h > CLASSIFIER_WARN_PENDING_FRESH ||
				(oldestFreshPendingAgeMs !== null &&
					oldestFreshPendingAgeMs > CLASSIFIER_WARN_OLDEST_FRESH_AGE_MS));
		const classifierFail =
			consent.allowed &&
			queueStats.pending_fresh_48h > 0 &&
			(sidecarLastSeen === null || nowMs - sidecarLastSeen > CLASSIFIER_FAIL_SIDECAR_SILENCE_MS);

		const missingAttachmentRows = numberValue(
			((missingAttachmentRowsResult.results ?? []) as HealthRow[])[0]?.count,
		);
		const recentInboundWithoutRaw = numberValue(
			((recentInboundWithoutRawResult.results ?? []) as HealthRow[])[0]?.count,
		);
		const staleDomains =
			inboundWarnAfterHours > 0
				? inboundRows.filter((row) => {
						if (!row.latest_age_ms) return true;
						return row.latest_age_ms > inboundWarnAfterHours * 60 * 60 * 1000;
					})
				: [];

		const checks = {
			d1: { status: "ok" as HealthStatus },
			attachments: {
				status: (features.attachments && missingAttachmentRows === 0
					? "ok"
					: "fail") as HealthStatus,
				bucket_configured: features.attachments,
				total: numberValue(attachments.total),
				recent: numberValue(attachments.recent),
				latest: nullableNumberValue(attachments.latest),
				recent_missing_rows_for_flagged_messages: missingAttachmentRows,
			},
			receive: {
				status: (staleDomains.length > 0 ? "warn" : "ok") as HealthStatus,
				window_hours: windowHours,
				max_inbound_age_hours: inboundWarnAfterHours,
				domains: inboundRows,
				stale_or_empty_domains: staleDomains.map((row) => row.domain),
			},
			send: {
				status: (features.send_configured ? "ok" : "fail") as HealthStatus,
				providers: Object.fromEntries(
					getConfiguredDomains(c.env).map((domain) => [
						domain,
						getEmailProviderName(c.env, domain),
					]),
				),
				configured: features.send_configured,
				total_sent: numberValue(outbound.total),
				recent_sent: numberValue(outbound.recent),
				latest_sent: nullableNumberValue(outbound.latest),
			},
			raw_backup: {
				status: (recentInboundWithoutRaw === 0 && numberValue(raw.parse_issues) === 0
					? "ok"
					: "fail") as HealthStatus,
				total: numberValue(raw.total),
				recent: numberValue(raw.recent),
				latest: nullableNumberValue(raw.latest),
				parse_issues: numberValue(raw.parse_issues),
				recent_cloudflare_inbound_without_raw: recentInboundWithoutRaw,
			},
			fidelity: {
				status: (fidelity.fail > 0 ? "fail" : fidelity.warn > 0 ? "warn" : "ok") as HealthStatus,
				window_days: 7,
				...fidelity,
			},
			classifier: {
				status: (classifierFail ? "fail" : classifierWarn ? "warn" : "ok") as HealthStatus,
				ai_consent: consent.allowed ? "allowed" : "off",
				...queueStats,
				oldest_fresh_pending_age_ms: oldestFreshPendingAgeMs,
				sidecar_last_seen: sidecarLastSeen,
				sidecar_last_seen_age_ms: latestAgeMs(sidecarLastSeen, nowMs),
			},
		};
		const status = maxStatus(
			checks.d1.status,
			checks.attachments.status,
			checks.receive.status,
			checks.send.status,
			checks.raw_backup.status,
			checks.fidelity.status,
			checks.classifier.status,
		);

		return c.json(
			OK({
				status,
				timestamp: nowMs,
				configured_domains: domainScope,
				checks,
			}),
			status === "fail" ? 503 : 200,
		);
	} catch (err) {
		return c.json(
			ERR("HEALTH_CHECK_FAILED", err instanceof Error ? err.message : String(err)),
			500,
		);
	}
});

admin.get("/api/admin/raw-email/audit", async (c) => {
	const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const status = c.req.query("status") ?? "fail";
	const domainScope = getConfiguredDomains(c.env);
	const { checks, error } = await listEmailFidelityChecks(c.env.D1, {
		domainScope,
		status,
		limit: Number.isFinite(limitParam) ? limitParam : 50,
	});

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	return c.json(OK({ status, count: checks.length, checks }));
});

/**
 * v34 attachment-extraction queue: list attachment rows by extract_status for
 * the local text-extraction sidecar (scripts/sidecar/extract-attachment-text.mjs).
 * `extract_status=unset` selects rows that were never stamped (pre-v34
 * ingests) so backfills can triage them into pending/skipped.
 *
 * Query params:
 *   ?extract_status=<status|unset>  — default 'pending'
 *   ?limit=N                        — default 20, max 100
 */
admin.get("/api/admin/attachments", async (c) => {
	if (!(await isAttachmentExtractStatusColumnReady(c.env.D1))) {
		return c.json(
			ERR("NEEDS_MIGRATION", "migrate-v34-attachment-search-text.sql has not been applied"),
			412,
		);
	}

	const statusParam = c.req.query("extract_status") ?? "pending";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "20", 10);
	const limit = Math.max(1, Math.min(100, Number.isFinite(limitParam) ? limitParam : 20));
	const domainScope = getConfiguredDomains(c.env);

	const { attachments, error } = await listAttachmentsByExtractStatus(
		c.env.D1,
		statusParam === "unset" ? null : statusParam,
		limit,
		domainScope,
	);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	return c.json(OK({ extract_status: statusParam, count: attachments.length, attachments }));
});

/**
 * Worklist for the attachment-repair backfill: emails flagged has_attachments
 * but with NO attachment rows (the missing-binary set), constrained to a
 * non-null message_id so the driver can match them to a source .eml in a
 * local mailbox backup. Keyset-paginated by id (stable even as the backfill
 * removes rows from the set). The driver fetches the full worklist once, builds
 * a message_id->id map, then POSTs binaries to /api/emails/:id/attachments.
 */
admin.get("/api/admin/attachment-worklist", async (c) => {
	const domainScope = getConfiguredDomains(c.env);
	const limitParam = Number.parseInt(c.req.query("limit") ?? "500", 10);
	const limit = Math.max(1, Math.min(2000, Number.isFinite(limitParam) ? limitParam : 500));
	const after = c.req.query("after") ?? "";

	const conditions = [
		"e.has_attachments = 1",
		"e.message_id IS NOT NULL",
		"NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)",
	];
	const params: unknown[] = [];
	if (after) {
		conditions.push("e.id > ?");
		params.push(after);
	}
	if (domainScope.length > 0) {
		conditions.push(`e.domain IN (${domainScope.map(() => "?").join(",")})`);
		params.push(...domainScope);
	}
	params.push(limit);

	try {
		const result = await c.env.D1.prepare(
			`SELECT e.id, e.message_id, e.domain, e.attachment_count
			   FROM emails e
			  WHERE ${conditions.join(" AND ")}
			  ORDER BY e.id
			  LIMIT ?`,
		)
			.bind(...params)
			.all();
		const items = (result.results ?? []) as {
			id: string;
			message_id: string;
			domain: string;
			attachment_count: number;
		}[];
		const nextCursor = items.length === limit ? items[items.length - 1].id : null;
		return c.json(OK({ count: items.length, next_cursor: nextCursor, items }));
	} catch (e) {
		return c.json(ERR("D1_ERROR", e instanceof Error ? e.message : String(e)), 500);
	}
});

/**
 * Flip one attachment row's extract_status (sidecar bookkeeping). Body:
 * { extract_status: "pending" | "done" | "failed" | "skipped:<reason>" }.
 * Never touches email content — extracted text goes through the hydrate API.
 */
admin.patch("/api/admin/attachments/:id", async (c) => {
	if (!(await isAttachmentExtractStatusColumnReady(c.env.D1))) {
		return c.json(
			ERR("NEEDS_MIGRATION", "migrate-v34-attachment-search-text.sql has not been applied"),
			412,
		);
	}

	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}
	const parsed = updateAttachmentExtractStatusSchema.safeParse(payload);
	if (!parsed.success) {
		return c.json(
			ERR("INVALID_BODY", parsed.error.issues.map((issue) => issue.message).join("; ")),
			400,
		);
	}

	const domainScope = getConfiguredDomains(c.env);
	const { updated, error } = await updateAttachmentExtractStatus(
		c.env.D1,
		c.req.param("id"),
		parsed.data.extract_status,
		domainScope,
	);

	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!updated) return c.json(ERR("NOT_FOUND", "Attachment not found"), 404);
	return c.json(OK({ message: "Attachment updated" }));
});

admin.post("/api/admin/raw-email/purge", async (c) => {
	if (!c.env.ATTACHMENTS) {
		return c.json(ERR("NO_BUCKET", "ATTACHMENTS R2 binding is not configured"), 500);
	}

	const limitParam = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const dryRun = c.req.query("dry_run") === "1";

	const result = await purgeExpiredRawEmailArtifacts(
		c.env.D1,
		c.env.ATTACHMENTS,
		Number.isFinite(limitParam) ? limitParam : 100,
		{ dryRun },
	);

	return c.json(OK({ dry_run: dryRun, ...result }));
});

/**
 * Replay raw write-ahead objects (today/yesterday) that never got an artifact
 * row: deliveries whose materialization failed after the write-ahead. The
 * raw_replay cron runs the same sweep hourly; this is the manual trigger.
 * API token only (it crosses workspaces).
 */
admin.post("/api/admin/raw-email/replay", async (c) => {
	if (!isPrivileged(c)) {
		return c.json(ERR("FORBIDDEN", "Requires the API token or an administrator"), 403);
	}
	const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);
	const minAge = Number.parseInt(c.req.query("min_age_minutes") ?? "15", 10);
	const result = await replayRawBacklog(c.env, {
		limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 50)) : 10,
		// Never younger than 5 minutes: an object that young may still be in flight.
		minAgeMs: (Number.isFinite(minAge) ? Math.max(5, minAge) : 15) * 60_000,
	});
	return c.json(OK(result));
});

/**
 * Morning report test hook (API token or an administrator). Never takes a recipient: a tick sends only to
 * MORNING_REPORT_JSON's own `to`.
 *   ?since=MS&until=MS          dry run (default): {subject, html, text, data} for that window
 *                               (default: the last 24 hours), nothing written
 *   ?at=MS                      adds {clock: {local_date, hour, due}} for that instant (DST checks)
 *   ?tick=1&ns=e2e_TAG[&at=MS]  one scheduler tick under its own state namespace and key
 *   ?reset=1&ns=e2e_TAG         delete that namespace's state (&only=last_date: just that key)
 */
admin.post("/api/admin/morning-report", async (c) => {
	if (!isPrivileged(c)) {
		return c.json(ERR("FORBIDDEN", "Requires the API token or an administrator"), 403);
	}
	const config = getMorningReportConfig(c.env);
	if (!config) return c.json(ERR("NOT_CONFIGURED", "MORNING_REPORT_JSON is not set"), 412);
	const nowMs = Date.now();
	const at = Number(c.req.query("at") ?? nowMs);
	if (!Number.isFinite(at)) return c.json(ERR("INVALID_QUERY", "at must be epoch ms"), 400);

	const ns = c.req.query("ns");
	if (c.req.query("tick") === "1" || c.req.query("reset") === "1") {
		if (!ns || !/^e2e_[a-z0-9_]{1,40}$/.test(ns)) {
			return c.json(ERR("INVALID_QUERY", "ns must look like e2e_TAG"), 400);
		}
		if (c.req.query("reset") === "1") {
			// only=last_date simulates bookkeeping lost after the provider accepted the send.
			const keys =
				c.req.query("only") === "last_date"
					? [`${ns}:last_date`]
					: [`${ns}:last_date`, `${ns}:last_sent_at`, `${ns}:pending`];
			const { meta } = await c.env.D1.prepare(
				`DELETE FROM agent_memory WHERE workspace_id = 'system' AND key IN (${keys.map(() => "?").join(", ")})`,
			)
				.bind(...keys)
				.run();
			return c.json(OK({ ns, deleted: meta?.changes ?? 0 }));
		}
		return c.json(OK(await runMorningReport(c.env, c.executionCtx, { nowMs: at, ns, config })));
	}

	const until = Number(c.req.query("until") ?? nowMs);
	const since = Number(c.req.query("since") ?? until - 24 * 60 * 60 * 1000);
	if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
		return c.json(ERR("INVALID_QUERY", "since and until must be epoch ms with since < until"), 400);
	}
	const clock = localClock(at, config.time_zone);
	const data = await collectMorningReport(c.env, { since, until, localDate: clock.date });
	const rendered = renderMorningReport(data, {
		uiOrigin: c.env.UI_ORIGIN?.replace(/\/+$/, "") || null,
		timeZone: config.time_zone,
	});
	return c.json(
		OK({
			...rendered,
			data,
			clock: { ...clock, due: clock.hour >= config.hour, time_zone: config.time_zone },
		}),
	);
});

// Operator statement/top-ups only; no processor and no automatic overage charges.
admin.get("/api/admin/usage", async (c) => {
	const cfg = billingConfig(c.env);
	if (!cfg) return c.json(OK({ unlimited: true, calls: [] }));
	try {
		return c.json(OK(await usageStatement(c.env.D1, cfg, c.req.query("month"))));
	} catch {
		return c.json(ERR("INVALID_MONTH", "Use --month YYYY-MM"), 400);
	}
});
admin.post("/api/admin/usage/credit", async (c) => {
	const cfg = billingConfig(c.env);
	if (!cfg) return c.json(ERR("AI_BILLING_DISABLED", "AI ledger is not configured"), 409);
	const p = await c.req.json().catch(() => null);
	if (
		!p ||
		typeof p.key !== "string" ||
		!/^[a-zA-Z0-9_.:-]{1,160}$/.test(p.key) ||
		!Number.isSafeInteger(p.amount_microusd) ||
		p.amount_microusd <= 0 ||
		p.amount_microusd > 1e9 ||
		typeof p.note !== "string" ||
		p.note.length > 500
	)
		return c.json(ERR("INVALID_BODY", "Positive amount_microusd, key and note required"), 400);
	await c.env.D1.prepare(
		"INSERT INTO ai_credits(id,instance_id,amount_nano,note,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
	)
		.bind(p.key, cfg.instance, p.amount_microusd * 1000, p.note, Date.now())
		.run();
	const old = await c.env.D1.prepare("SELECT * FROM ai_credits WHERE id=?")
		.bind(p.key)
		.first<{ instance_id: string; amount_nano: number; note: string }>();
	if (
		old?.instance_id !== cfg.instance ||
		old?.amount_nano !== p.amount_microusd * 1000 ||
		old?.note !== p.note
	)
		return c.json(ERR("CREDIT_KEY_REUSED", "Credit key was used with different details"), 409);
	return c.json(OK({ key: p.key, amount_microusd: p.amount_microusd }));
});
export default admin;
