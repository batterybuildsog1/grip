/**
 * Codex classify-queue endpoints (Phase 1).
 *
 * The Codex CLI sidecar is the AI classifier of record: it claims
 * unclassified inbox emails, runs the v2 system prompt plus the content-based
 * billing/notifications sub-prompts locally, and posts results back. The
 * Worker owns the queue, the leases, and ALL writes — the sidecar never
 * touches D1 directly.
 *
 * Policy guards baked in here:
 * - The results path NEVER creates sender rules or feedback rows (user
 *   policy: no auto-created sender rules from AI output).
 * - Category writes are guarded by `category IS NULL` — a user correction
 *   that landed while the email was leased always wins.
 *
 * Memory map protocol 3 (v52, docs/codebase-design-2026-09-29/memory-map-plan.md §3):
 * the claim adds `memory_map` (rendered entities, or null when unavailable) and per-email
 * `address_matches`; results may carry `entities` (tags with verbatim evidence). Tags are
 * applied after every category write and never affect one. (`proposal` is ignored: the
 * entity proposal queue was cut 2026-10-22.)
 * A daemon without protocol 3 (or a claim with memory_map null) keeps working unchanged.
 *
 * Action notes (v55, 2026-10-14): a result may carry `action_note` and `action_due`
 * (YYYY-MM-DD); they are written with the category, under the same guard, and never over a
 * note the email already has. Results without them change nothing.
 *
 * AI consent (v64, release 1.0 SPEC §2; src/services/ai-consent.ts): with consent off the claim
 * leases nothing and returns nothing (403 AI_CONSENT_REQUIRED), and results are refused. The lease
 * token carries the consent epoch it was made under (`<epoch>.<uuid>`); a newer decision voids
 * it. The claim re-checks right before answering, and every category write re-checks in SQL.
 */

import { Hono } from "hono";
import { z } from "zod";
import { CLASSIFY_BILLING_SUB_SYSTEM_PROMPT } from "@/agent/prompts/classify_billing_sub_v1";
import { CLASSIFY_NOTIFICATION_SUB_SYSTEM_PROMPT } from "@/agent/prompts/classify_notification_sub_v1";
import {
	CLASSIFIER_PROMPT_VERSION,
	CLASSIFY_SYSTEM_PROMPT_V2,
	formatAsymmetricFeedback,
} from "@/agent/prompts/classify_v2";
import {
	getAgentMemory,
	getRecentClassificationFeedback,
	getRecentInterestAnnotations,
	getRelatedUserClassifiedEmails,
	insertClassificationLog,
	setAgentMemory,
} from "@/database/agent";
import {
	applyCodexClassification,
	type ClaimedQueueEmail,
	claimClassifyQueueEmails,
	clearClassifyLease,
	getClassifyAfterMs,
	getClassifyQueueStats,
	getLeasedEmailsByToken,
	releaseClassifyLeaseToken,
	SIDECAR_WORKSPACE_ID,
} from "@/database/classifier";
import {
	applyEnrichment,
	type EnrichmentCounters,
	emptyEnrichmentCounters,
	loadEntities,
} from "@/database/entities";
import { normalizeActionNote } from "@/database/notes";
import { aiConsent, CONSENT_REQUIRED, epochOfLease, leaseTokenFor } from "@/services/ai-consent";
import {
	AI_PAUSED,
	AiBudgetError,
	billingConfig,
	reserveUsage,
	settleUsage,
	usageStatement,
} from "@/services/ai-usage";
import { isVerificationCode } from "@/services/code-note";
import { invitationNote } from "@/services/invitation-note";
import {
	type AddressMatch,
	batchMatchedEntityIds,
	findAddressMatches,
	memoryMapPresentation,
	renderMemoryMap,
} from "@/services/memory-map";
import { looksLikePerson } from "@/services/people-rule";
import type { AgentMemoryEntry, AppVariables } from "@/types";
import { now } from "@/utils/helpers";
import { ERR, OK } from "@/utils/http";
import { logInfo, logWarn } from "@/utils/logging";
import { getConfiguredDomains } from "@/utils/platform";
import { classifyQueueClaimSchema, classifyQueueResultsSchema } from "@/utils/validation";

const classifier = new Hono<{
	Bindings: CloudflareBindings;
	Variables: AppVariables;
}>();

/** Max distinct senders we run the related-user-classified lookup for per
 * claim — bounds D1 round-trips on a full 25-email batch. */
const MAX_RELATED_SENDER_LOOKUPS = 10;
/** Cap on shared context entries returned to the sidecar. */
const MAX_SHARED_CONTEXT_ENTRIES = 60;

/**
 * The memory map for one claimed batch. Sorting never waits on the map: any failure (v52 not
 * applied, a D1 error) returns null and logs memory_map_unavailable.
 */
async function loadClaimMemoryMap(
	db: D1Database,
	emails: ClaimedQueueEmail[],
	writesLabel: string,
): Promise<{
	memoryMap: string | null;
	matches: Map<string, AddressMatch[]>;
	stats: Record<string, unknown>;
}> {
	const matches = new Map<string, AddressMatch[]>();
	if (emails.length === 0) return { memoryMap: null, matches, stats: {} };
	try {
		const entities = await loadEntities(db);
		if (entities.length === 0) return { memoryMap: null, matches, stats: { entities: 0 } };
		const headerEmails = emails.map((email) => ({
			from_address: email.from_address,
			from_name: email.from_name,
			subject: email.subject,
			body_excerpt: email.body_excerpt,
			...email.address_fields,
		}));
		emails.forEach((email, i) => {
			matches.set(email.id, findAddressMatches(entities, headerEmails[i]));
		});
		const rendered = renderMemoryMap(entities, {
			mustInclude: batchMatchedEntityIds(entities, headerEmails),
			writesLabel,
		});
		return {
			memoryMap: rendered.text,
			matches,
			stats: {
				entities: entities.length,
				map_chars: rendered.chars,
				map_included: rendered.included.length,
				map_omitted: rendered.omitted,
			},
		};
	} catch (error) {
		logWarn("memory_map_unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { memoryMap: null, matches: new Map(), stats: { unavailable: true } };
	}
}

async function touchSidecarLastSeen(db: D1Database, nowMs: number): Promise<void> {
	// Same agent_memory heartbeat pattern as the cron cadence guard
	// (agent/cron.ts shouldRun): INSERT OR REPLACE keyed value under a fixed
	// workspace.
	await setAgentMemory(db, SIDECAR_WORKSPACE_ID, "codex_sidecar_last_seen", String(nowMs));
}

// POST /api/agent/classify-queue/claim — lease a batch of unclassified emails
classifier.post("/api/agent/classify-queue/claim", async (c) => {
	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	const parsed = classifyQueueClaimSchema.safeParse(payload);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}

	// AI consent: off = nothing leased, nothing assembled, nothing returned.
	const consent = await aiConsent(c.env.D1);
	if (!consent.allowed || consent.epoch === null) {
		logInfo("classify_queue_consent_off", { worker_id: parsed.data.worker_id });
		return c.json(ERR(CONSENT_REQUIRED.code, CONSENT_REQUIRED.message), 403);
	}
	const consentEpoch = consent.epoch;
	const billing = billingConfig(c.env);
	if (billing && !billing.unlimited && parsed.data.usage_protocol !== 1)
		return c.json(
			ERR("AI_USAGE_PROTOCOL_REQUIRED", "Update classifier to metering protocol 1"),
			409,
		);
	if (billing && !billing.unlimited) {
		const usage = await usageStatement(c.env.D1, billing, undefined, false);
		if (usage.ai_sorting_state === "allowance_used")
			return c.json(ERR("AI_ALLOWANCE_USED", AI_PAUSED), 402);
	}

	const nowMs = now();
	const domains = getConfiguredDomains(c.env);
	const classifyAfter = await getClassifyAfterMs(c.env.D1);
	const leaseToken = leaseTokenFor(consentEpoch);
	const leaseUntil = nowMs + parsed.data.lease_ms;

	const emails = await claimClassifyQueueEmails(c.env.D1, {
		nowMs,
		leaseMs: parsed.data.lease_ms,
		classifyAfter,
		limit: parsed.data.limit,
		leaseToken,
		consentEpoch,
	});

	await touchSidecarLastSeen(c.env.D1, nowMs);

	// Nothing claimed: no context either (it is private mail too).
	if (emails.length === 0) {
		return c.json(
			OK({
				lease_token: leaseToken,
				lease_until: leaseUntil,
				ai_billing: billing
					? {
							mode: billing.unlimited ? "unlimited" : "metered",
							provider: "subscription_hub",
							instance_id: billing.instance,
							usage_protocol: 1,
						}
					: null,
				system_prompt: CLASSIFY_SYSTEM_PROMPT_V2,
				prompt_version: CLASSIFIER_PROMPT_VERSION,
				billing_sub_prompt: CLASSIFY_BILLING_SUB_SYSTEM_PROMPT,
				notification_sub_prompt: CLASSIFY_NOTIFICATION_SUB_SYSTEM_PROMPT,
				shared_context: [],
				memory_map: null,
				emails: [],
			}),
		);
	}

	// Shared context: agent memory, asymmetric-weighted feedback, interest
	// annotations, and related user-classified emails for the senders in
	// this batch.
	const [agentMemory, feedback, interests] = await Promise.all([
		getAgentMemory(c.env.D1, SIDECAR_WORKSPACE_ID),
		getRecentClassificationFeedback(c.env.D1, SIDECAR_WORKSPACE_ID, 20),
		getRecentInterestAnnotations(c.env.D1, domains, 15),
	]);
	const recentFeedback = formatAsymmetricFeedback(feedback);

	const interestContext: AgentMemoryEntry[] = interests.map((a, i) => ({
		key: `interest_${i + 1}`,
		workspace_id: SIDECAR_WORKSPACE_ID,
		value: [
			`${a.from_address} → ${a.category || "uncategorized"}`,
			a.interest_level ? `interest=${a.interest_level}` : null,
			a.interest_comment ? `note="${a.interest_comment}"` : null,
		]
			.filter(Boolean)
			.join("; "),
		updated_at: 0,
	}));

	const distinctSenders = [...new Set(emails.map((e) => e.from_address))].slice(
		0,
		MAX_RELATED_SENDER_LOOKUPS,
	);
	const relatedBatches = await Promise.all(
		distinctSenders.map((sender) =>
			getRelatedUserClassifiedEmails(c.env.D1, sender, domains, 3).catch(() => []),
		),
	);
	const relatedContext: AgentMemoryEntry[] = relatedBatches.flat().map((r, i) => ({
		key: `related_${i + 1}`,
		workspace_id: SIDECAR_WORKSPACE_ID,
		value: [
			`User classified ${r.from_address}: "${r.subject}" → ${r.category}`,
			r.user_comment ? `reason: "${r.user_comment}"` : null,
		]
			.filter(Boolean)
			.join("; "),
		updated_at: 0,
	}));

	const sharedContext = [...agentMemory, ...recentFeedback, ...interestContext, ...relatedContext]
		.slice(0, MAX_SHARED_CONTEXT_ENTRIES)
		.map((entry) => ({ key: entry.key, value: entry.value }));

	const map = await loadClaimMemoryMap(c.env.D1, emails, memoryMapPresentation(c.env).label);

	// Right before the mail leaves: a withdrawal (or any newer decision) since the lease voids it.
	const still = await aiConsent(c.env.D1);
	if (!still.allowed || still.epoch !== consentEpoch) {
		await releaseClassifyLeaseToken(c.env.D1, leaseToken);
		logInfo("classify_queue_consent_changed", {
			worker_id: parsed.data.worker_id,
			released: emails.length,
		});
		return c.json(ERR(CONSENT_REQUIRED.code, CONSENT_REQUIRED.message), 403);
	}

	logInfo("classify_queue_claimed", {
		worker_id: parsed.data.worker_id,
		claimed: emails.length,
		lease_ms: parsed.data.lease_ms,
		classify_after: classifyAfter,
		memory_map: map.stats,
	});

	return c.json(
		OK({
			lease_token: leaseToken,
			lease_until: leaseUntil,
			ai_billing: billing
				? {
						mode: billing.unlimited ? "unlimited" : "metered",
						provider: "subscription_hub",
						instance_id: billing.instance,
						usage_protocol: 1,
					}
				: null,
			system_prompt: CLASSIFY_SYSTEM_PROMPT_V2,
			prompt_version: CLASSIFIER_PROMPT_VERSION,
			billing_sub_prompt: CLASSIFY_BILLING_SUB_SYSTEM_PROMPT,
			notification_sub_prompt: CLASSIFY_NOTIFICATION_SUB_SYSTEM_PROMPT,
			shared_context: sharedContext,
			memory_map: map.memoryMap,
			emails: emails.map(({ address_fields: _headers, ...email }) => ({
				...email,
				address_matches: map.matches.get(email.id) ?? [],
			})),
		}),
	);
});

// POST /api/agent/classify-queue/results — apply a batch of classifications
classifier.post("/api/agent/classify-queue/results", async (c) => {
	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	const parsed = classifyQueueResultsSchema.safeParse(payload);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}

	// A result counts only under the consent decision its lease was made under, still current.
	const leaseEpoch = epochOfLease(parsed.data.lease_token);
	const consent = await aiConsent(c.env.D1);
	if (!consent.allowed || leaseEpoch === null || consent.epoch !== leaseEpoch) {
		logInfo("classify_queue_results_refused", {
			worker_id: parsed.data.worker_id,
			received: parsed.data.results.length,
			reason: consent.allowed ? "lease_from_older_decision" : "consent_off",
		});
		return c.json(ERR(CONSENT_REQUIRED.code, CONSENT_REQUIRED.message), 403);
	}

	const nowMs = now();
	const leased = await getLeasedEmailsByToken(c.env.D1, parsed.data.lease_token);

	let applied = 0;
	let userWon = 0;
	let abstained = 0;
	let errored = 0;
	let released = 0;
	let stale = 0;
	let actionNotes = 0;
	const enrichment: { email_id: string; entities?: unknown }[] = [];

	for (const result of parsed.data.results) {
		const leasedRow = leased.get(result.email_id);
		if (!leasedRow) {
			// Not leased under this token — lease expired and was re-claimed,
			// or the worker is reporting an email it never held. Ignore.
			stale += 1;
			continue;
		}

		if (result.error === "not_run") {
			// Refused before any provider ran (a reservation refused for funds, a hosted config
			// refused): release the lease and log no attempt, so no cooldown holds the mail and the
			// next claim after a top-up takes it again.
			released += 1;
			await clearClassifyLease(c.env.D1, result.email_id, parsed.data.lease_token);
			continue;
		}

		if (result.error) {
			// Failed attempt: log a codex row with null category so the
			// 6h retry cooldown applies, then release the lease.
			errored += 1;
			await insertClassificationLog(c.env.D1, {
				email_id: result.email_id,
				from_address: leasedRow.from_address,
				subject: leasedRow.subject,
				category: null,
				previous_category: leasedRow.category,
				method: "codex",
				confidence: null,
				ai_tokens_used: result.tokens_used ?? null,
			}).catch(() => {});
			await clearClassifyLease(c.env.D1, result.email_id, parsed.data.lease_token);
			continue;
		}

		// Tags ride on every leased, non-error result, even when the model abstained or the
		// user won the category (plan §3).
		if (result.entities !== undefined) {
			enrichment.push({ email_id: result.email_id, entities: result.entities });
		}

		if (!result.category) {
			// Model abstained: log (sets cooldown) and release the lease.
			abstained += 1;
			await insertClassificationLog(c.env.D1, {
				email_id: result.email_id,
				from_address: leasedRow.from_address,
				subject: leasedRow.subject,
				category: null,
				previous_category: leasedRow.category,
				method: "codex",
				confidence: result.confidence,
				ai_tokens_used: result.tokens_used ?? null,
			}).catch(() => {});
			await clearClassifyLease(c.env.D1, result.email_id, parsed.data.lease_token);
			continue;
		}

		// Uncertain routing: low-confidence non-(personal|spam|home_alerts|
		// tax_documents) predictions carry the classification_uncertain badge.
		// They route to Personal only when the sender looks like a person
		// (2026-10-14: unsure machine mail was filling Personal); otherwise they
		// keep the sorter's category, still marked unsure.
		const uncertain =
			result.confidence < 0.7 &&
			result.category !== "personal" &&
			result.category !== "spam" &&
			result.category !== "home_alerts" &&
			result.category !== "tax_documents";
		const shouldRouteUncertainToPersonal =
			uncertain && looksLikePerson(leasedRow.from_address, leasedRow.list_unsubscribe);
		const finalCategory = shouldRouteUncertainToPersonal ? "personal" : result.category;
		const finalSubCategory = shouldRouteUncertainToPersonal
			? null
			: finalCategory === "billing"
				? (result.billing_sub ?? null)
				: finalCategory === "notifications"
					? (result.notification_sub ?? null)
					: null;
		const finalInterestLevel =
			finalCategory === "marketing" || finalCategory === "newsletters"
				? (result.interest_level ?? null)
				: null;

		// Invitations use literal subject words, with no AI-derived deadline. Codes get their own
		// short-lived note at ingest (src/services/code-note.ts), never the sorter's.
		const invite =
			finalCategory === "notifications"
				? invitationNote(leasedRow.subject, leasedRow.from_address)
				: null;
		const action =
			finalCategory === "personal" ||
			finalCategory === "spam" ||
			isVerificationCode(
				leasedRow.subject,
				leasedRow.text_head,
				!!leasedRow.list_unsubscribe?.trim(),
			)
				? { note: null, due: null }
				: normalizeActionNote(invite ?? result.action_note, invite ? null : result.action_due);

		const { updated, userWon: won } = await applyCodexClassification(c.env.D1, {
			emailId: result.email_id,
			leaseToken: parsed.data.lease_token,
			consentEpoch: leaseEpoch,
			category: finalCategory,
			subCategory: finalSubCategory,
			uncertain,
			interestLevel: finalInterestLevel,
			actionNote: action.note,
			actionDue: action.due,
		});
		if (updated && action.note) actionNotes += 1;

		if (updated) {
			applied += 1;
		} else if (won) {
			// User categorized the email while it was leased — they win.
			userWon += 1;
			await clearClassifyLease(c.env.D1, result.email_id, parsed.data.lease_token);
		} else {
			// The lease or the consent was lost mid-batch (a withdrawal releases every lease):
			// nothing of this result is kept.
			stale += 1;
			continue;
		}

		// Log the prediction either way (cooldown + audit trail). Logged
		// category is the model's prediction, matching the inline pipeline.
		await insertClassificationLog(c.env.D1, {
			email_id: result.email_id,
			from_address: leasedRow.from_address,
			subject: leasedRow.subject,
			category: result.category,
			previous_category: leasedRow.category,
			method: "codex",
			confidence: result.confidence,
			ai_tokens_used: result.tokens_used ?? null,
		}).catch(() => {});
	}

	// After every category write, so the map can never delay or block sorting. Only while the
	// lease's consent decision is still current: a withdrawal mid-batch keeps no tags.
	let entityCounters: EnrichmentCounters = emptyEnrichmentCounters();
	const consentAfter = enrichment.length > 0 ? await aiConsent(c.env.D1) : null;
	if (enrichment.length > 0 && consentAfter?.allowed && consentAfter.epoch === leaseEpoch) {
		try {
			entityCounters = await applyEnrichment(c.env.D1, enrichment);
		} catch (error) {
			logWarn("memory_map_write_failed", {
				error: error instanceof Error ? error.message : String(error),
				results: enrichment.length,
			});
		}
	}

	await touchSidecarLastSeen(c.env.D1, nowMs);

	logInfo("classify_queue_results", {
		worker_id: parsed.data.worker_id,
		model: parsed.data.model,
		reasoning_effort: parsed.data.reasoning_effort ?? null,
		prompt_version: parsed.data.prompt_version ?? null,
		received: parsed.data.results.length,
		applied,
		user_won: userWon,
		abstained,
		errored,
		released,
		stale,
		action_notes_written: actionNotes,
		...entityCounters,
	});

	return c.json(
		OK({
			received: parsed.data.results.length,
			applied,
			user_won: userWon,
			abstained,
			errored,
			released,
			stale,
			action_notes_written: actionNotes,
			...entityCounters,
		}),
	);
});

// GET /api/agent/classify-queue/stats — queue depth + sidecar throughput
classifier.get("/api/agent/classify-queue/stats", async (c) => {
	const nowMs = now();
	const classifyAfter = await getClassifyAfterMs(c.env.D1);
	const stats = await getClassifyQueueStats(c.env.D1, classifyAfter, nowMs);
	const billing = billingConfig(c.env);
	return c.json(
		OK(
			billing
				? { ...stats, ai_usage: await usageStatement(c.env.D1, billing, undefined, false) }
				: stats,
		),
	);
});

const callReserveSchema = z.object({
	call_id: z.string().min(1).max(160),
	lease_token: z.string().min(1).max(200),
	model: z.enum(["gpt-6.1-sol"]),
	input_bound: z.number().int().min(1).max(120000),
	output_bound: z.number().int().min(1).max(8192),
});
const callSettleSchema = z.object({
	call_id: z.string().min(1).max(160),
	outcome: z.enum(["settled", "failed", "unknown"]),
	input: z.number().int().nonnegative().optional(),
	cached: z.number().int().nonnegative().optional(),
	output: z.number().int().nonnegative().optional(),
});
classifier.post("/api/agent/classify-queue/calls/reserve", async (c) => {
	const cfg = billingConfig(c.env);
	if (!cfg) return c.json(ERR("AI_BILLING_DISABLED", "AI ledger is not configured"), 409);
	if (!(await aiConsent(c.env.D1)).allowed)
		return c.json(ERR(CONSENT_REQUIRED.code, CONSENT_REQUIRED.message), 403);
	const p = callReserveSchema.safeParse(await c.req.json().catch(() => null));
	if (!p.success) return c.json(ERR("INVALID_BODY", "Invalid call reservation"), 400);
	try {
		await reserveUsage(c.env.D1, cfg, {
			id: p.data.call_id,
			kind: "classifier",
			lease: p.data.lease_token,
			model: p.data.model,
			inputBound: p.data.input_bound,
			outputBound: p.data.output_bound,
		});
	} catch (e) {
		return c.json(
			ERR(
				e instanceof AiBudgetError ? "AI_ALLOWANCE_USED" : "AI_CALL_CONFLICT",
				e instanceof Error ? e.message : "Reservation failed",
			),
			e instanceof AiBudgetError ? 402 : 409,
		);
	}
	return c.json(OK({ call_id: p.data.call_id, reserved: true }));
});
classifier.post("/api/agent/classify-queue/calls/settle", async (c) => {
	const cfg = billingConfig(c.env);
	if (!cfg) return c.json(ERR("AI_BILLING_DISABLED", "AI ledger is not configured"), 409);
	const p = callSettleSchema.safeParse(await c.req.json().catch(() => null));
	if (!p.success) return c.json(ERR("INVALID_BODY", "Invalid call usage"), 400);
	const { input, cached, output } = p.data;
	if (
		p.data.outcome !== "unknown" &&
		(input === undefined || cached === undefined || output === undefined || cached > input)
	)
		return c.json(ERR("INVALID_BODY", "Complete token usage required"), 400);
	try {
		await settleUsage(
			c.env.D1,
			cfg,
			p.data.call_id,
			p.data.outcome,
			input !== undefined && cached !== undefined && output !== undefined
				? { input, cached, output }
				: undefined,
		);
	} catch {
		return c.json(ERR("AI_USAGE_INVALID", "Call usage could not be reconciled"), 400);
	}
	return c.json(OK({ call_id: p.data.call_id, reconciled: true }));
});
export default classifier;
