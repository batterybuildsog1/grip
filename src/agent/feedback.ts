import {
	insertAgentMessage,
	insertClassificationFeedback,
	insertClassificationLog,
	setAgentMemory,
	upsertSenderRule,
} from "@/database/agent";
import { getEmailById, updateEmailById } from "@/database/d1";
import { aiConsent } from "@/services/ai-consent";
import { agentAiFetch } from "@/services/ai-provider";
import type { BillingConfig } from "@/services/ai-usage";
import { AiBudgetError } from "@/services/ai-usage";
import { refreshThreadBatchSafe, refreshThreadSafe } from "@/services/threads-loader";
import type { ClassificationFeedbackScope, EmailCategory } from "@/types";
import { now } from "@/utils/helpers";
import { logInfo } from "@/utils/logging";

const RECLASSIFY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
// Capped at 80 so the subsequent UPDATE ... WHERE id IN (?..) stays under
// D1's ~100 bind-parameter limit. Rare that a single sender sends more than
// 80 mis-categorized emails in 30 days; if so, the next correction cleans
// the rest up.
const RECLASSIFY_MAX_ROWS = 80;

/**
 * Phase 2.6: when a user correction fixes a "missed-personal" classification
 * (non-personal → personal), sweep the last 30 days of emails from the same
 * sender that are still mis-categorized and flip them to personal in bulk.
 *
 * This is deliberately non-LLM: the correction already tells us this sender
 * writes personal mail, so running the classifier again would be wasted
 * tokens. We just align the existing rows with the new ground truth.
 */
async function reclassifyRecentMissedPersonal(
	db: D1Database,
	opts: { fromAddress: string; previousCategory: EmailCategory; domainScope: string[] },
): Promise<{ updated: number; threads_refreshed: number }> {
	const cutoff = now() - RECLASSIFY_LOOKBACK_MS;
	const domainFilter =
		opts.domainScope.length > 0
			? `AND domain IN (${opts.domainScope.map(() => "?").join(", ")})`
			: "";

	const { results: targets } = await db
		.prepare(
			`SELECT id, thread_id FROM emails
			 WHERE from_address = ?
				 AND category = ?
				 AND received_at >= ?
				 ${domainFilter}
			 LIMIT ?`,
		)
		.bind(opts.fromAddress, opts.previousCategory, cutoff, ...opts.domainScope, RECLASSIFY_MAX_ROWS)
		.all<{ id: string; thread_id: string | null }>();

	const rows = targets ?? [];
	if (rows.length === 0) return { updated: 0, threads_refreshed: 0 };

	const ids = rows.map((r) => r.id);
	const placeholders = ids.map(() => "?").join(", ");
	const { meta } = await db
		.prepare(
			`UPDATE emails
			 SET category = 'personal',
			     sub_category = NULL,
			     classification_uncertain = 0
			 WHERE id IN (${placeholders}) AND category = ?`,
		)
		.bind(...ids, opts.previousCategory)
		.run();

	const threadIds = [...new Set(rows.map((r) => r.thread_id).filter((id): id is string => !!id))];
	if (threadIds.length > 0) {
		await refreshThreadBatchSafe(db, threadIds);
	}

	logInfo("reclassify_missed_personal_done", {
		from_address: opts.fromAddress,
		previous_category: opts.previousCategory,
		updated: meta?.changes ?? 0,
		threads_refreshed: threadIds.length,
	});

	return { updated: meta?.changes ?? 0, threads_refreshed: threadIds.length };
}

export interface FeedbackContext {
	db: D1Database;
	anthropicApiKey?: string;
	anthropicBaseUrl?: string;
	billing?: BillingConfig | null;
	hubUrl?: string;
	hubKey?: string;
	workspaceId: string;
	domainScope: string[];
	model: string;
}

export interface FeedbackResult {
	rule_id: string;
	agent_message?: string;
	feedback_id?: string;
	follow_up_question?: string;
	no_op?: boolean;
}

interface FeedbackAnalysis {
	summary: string;
	resolved_category: EmailCategory | null;
	resolution_scope: ClassificationFeedbackScope | null;
	learned_rule: {
		from_pattern: string;
		category: EmailCategory;
		confidence?: number;
	} | null;
	memory_update: {
		key: string;
		value: string;
	} | null;
	follow_up_question: string | null;
}

const MAJOR_PROVIDERS = new Set([
	"gmail.com",
	"outlook.com",
	"hotmail.com",
	"yahoo.com",
	"icloud.com",
	"protonmail.com",
	"aol.com",
	"me.com",
	"live.com",
]);

function parseJsonObject<T>(text: string): T | null {
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;

	try {
		const parsed = JSON.parse(jsonMatch[0]) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as T;
		}
		return null;
	} catch {
		return null;
	}
}

function buildFallbackAnalysis(
	fromAddress: string,
	newCategory: EmailCategory | null | undefined,
	comment: string | null,
): FeedbackAnalysis {
	const category = newCategory ?? null;
	return {
		summary: comment
			? comment
			: `Learned: emails from ${fromAddress} are "${category ?? "unclear"}".`,
		resolved_category: category,
		resolution_scope: category ? "sender" : "email",
		learned_rule: category ? { from_pattern: fromAddress, category, confidence: 1.0 } : null,
		memory_update: null,
		follow_up_question: null,
	};
}

async function analyzeFeedbackWithAi(
	ctx: FeedbackContext,
	input: {
		fromAddress: string;
		domain: string;
		subject: string | null;
		previousCategory: EmailCategory | null;
		newCategory: EmailCategory | null;
		comment: string | null;
	},
): Promise<FeedbackAnalysis | null> {
	if (!ctx.anthropicApiKey && !ctx.hubKey) return null;
	// AI consent off (SPEC §2): no call; the correction is saved as a plain sender rule
	// (buildFallbackAnalysis).
	if (!(await aiConsent(ctx.db)).allowed) return null;

	const systemPrompt = `You are Grip's feedback learning assistant.
You resolve user corrections into durable learning. Return ONLY valid JSON:
{"summary":"brief summary","resolved_category":"home_alerts|personal|tax_documents|billing|agents|notifications|newsletters|marketing|spam|null","resolution_scope":"email|sender|domain|workspace|null","learned_rule":{"from_pattern":"...","category":"home_alerts|personal|tax_documents|billing|agents|notifications|newsletters|marketing|spam","confidence":0.0-1.0}|null,"memory_update":{"key":"...","value":"..."}|null,"follow_up_question":"..."|null}

Guidelines:
- Prefer the safest narrow scope that still helps future items.
- Use "sender" for one sender, "domain" only when the rule clearly applies to the whole domain, and "workspace" for a general preference.
- For major providers like Gmail, Outlook, Yahoo, iCloud, ProtonMail, AOL, Me.com, and Live.com, avoid domain-wide rules.
- If the user comment is ambiguous, ask a follow-up question rather than guessing.
- Keep summary concise.`;

	const userContent = [
		`From: ${input.fromAddress}`,
		`Domain: ${input.domain}`,
		`Subject: ${input.subject || "(no subject)"}`,
		`Previous category: ${input.previousCategory ?? "uncategorized"}`,
		`User correction: ${input.newCategory ?? "not provided"}`,
		`User comment: ${input.comment || "(none)"}`,
	].join("\n");

	const requestBody = {
		model: ctx.model,
		max_tokens: 250,
		temperature: 0,
		system: systemPrompt,
		messages: [{ role: "user", content: userContent }],
	};

	let response: Response;
	try {
		response = await agentAiFetch(ctx, requestBody, "feedback");
	} catch (error) {
		if (error instanceof AiBudgetError) return null;
		throw error;
	}

	if (!response.ok) {
		return null;
	}

	const data = (await response.json()) as {
		content?: Array<{ type?: string; text?: string }>;
	};

	const content = data.content?.[0]?.text ?? "";
	const parsed = parseJsonObject<FeedbackAnalysis>(content);
	if (!parsed) return null;

	return {
		summary: typeof parsed.summary === "string" ? parsed.summary : "",
		resolved_category:
			parsed.resolved_category &&
			[
				"personal",
				"billing",
				"agents",
				"notifications",
				"newsletters",
				"marketing",
				"spam",
				"home_alerts",
				"tax_documents",
			].includes(parsed.resolved_category)
				? (parsed.resolved_category as EmailCategory)
				: null,
		resolution_scope:
			parsed.resolution_scope &&
			["email", "sender", "domain", "workspace"].includes(parsed.resolution_scope)
				? (parsed.resolution_scope as ClassificationFeedbackScope)
				: null,
		learned_rule:
			parsed.learned_rule &&
			typeof parsed.learned_rule === "object" &&
			!Array.isArray(parsed.learned_rule) &&
			typeof parsed.learned_rule.from_pattern === "string" &&
			typeof parsed.learned_rule.category === "string" &&
			[
				"personal",
				"billing",
				"agents",
				"notifications",
				"newsletters",
				"marketing",
				"spam",
				"home_alerts",
				"tax_documents",
			].includes(parsed.learned_rule.category)
				? {
						from_pattern: parsed.learned_rule.from_pattern,
						category: parsed.learned_rule.category as EmailCategory,
						confidence:
							typeof parsed.learned_rule.confidence === "number"
								? parsed.learned_rule.confidence
								: 1.0,
					}
				: null,
		memory_update:
			parsed.memory_update &&
			typeof parsed.memory_update === "object" &&
			!Array.isArray(parsed.memory_update) &&
			typeof parsed.memory_update.key === "string" &&
			typeof parsed.memory_update.value === "string"
				? {
						key: parsed.memory_update.key,
						value: parsed.memory_update.value,
					}
				: null,
		follow_up_question:
			typeof parsed.follow_up_question === "string" ? parsed.follow_up_question : null,
	};
}

export async function handleFeedback(
	ctx: FeedbackContext,
	emailId: string,
	newCategory: EmailCategory | null | undefined,
	comment: string | null = null,
	// Codex phase: corrections can carry a sub-category (content-based
	// billing/notifications values, agents subs, or a Home Alerts customer
	// label). undefined = not provided; null = explicit clear.
	newSubCategory: string | null | undefined = undefined,
): Promise<FeedbackResult> {
	// Load email
	const result = await getEmailById(ctx.db, emailId, ctx.domainScope);
	if (!result.email) throw new Error("Email not found");

	const email = result.email;
	const previousCategory = email.category ?? null;
	const trimmedComment = comment?.trim() || null;
	if (
		newCategory !== undefined &&
		newCategory === previousCategory &&
		!trimmedComment &&
		newSubCategory === undefined
	) {
		return { rule_id: "", no_op: true };
	}

	const fromAddress = email.from_address;
	const domain = fromAddress.split("@").pop() || "";

	const analysis =
		(await analyzeFeedbackWithAi(ctx, {
			fromAddress,
			domain,
			subject: email.subject,
			previousCategory,
			newCategory: newCategory ?? null,
			comment: trimmedComment,
		})) || buildFallbackAnalysis(fromAddress, newCategory, trimmedComment);

	const effectiveCategory =
		analysis.resolved_category ?? (newCategory === undefined ? previousCategory : newCategory);
	const resolutionScope = analysis.resolution_scope ?? (effectiveCategory ? "sender" : "email");
	const hasCategoryCorrection = newCategory !== undefined || analysis.resolved_category !== null;

	if (hasCategoryCorrection) {
		// Update the email and clear stale classifier-only metadata. A manual
		// correction is ground truth; it should not keep an old sub-folder or
		// uncertain flag from the previous classifier pass. When the
		// correction carries its own sub-category (e.g. billing →
		// failed_payments), write that instead of clearing.
		await updateEmailById(ctx.db, emailId, {
			category: effectiveCategory,
			sub_category: newSubCategory !== undefined ? newSubCategory : null,
			classification_uncertain: false,
		});

		if (email.thread_id) {
			await ctx.db
				.prepare(
					`UPDATE threads
					 SET user_pinned_category = ?,
					     priority_category = ?,
					     priority_sub_category = ?,
					     updated_at = ?
					 WHERE id = ?`,
				)
				.bind(
					effectiveCategory,
					effectiveCategory,
					newSubCategory !== undefined ? newSubCategory : null,
					now(),
					email.thread_id,
				)
				.run();
			await refreshThreadSafe(ctx.db, email.thread_id);
		}
	} else if (newSubCategory !== undefined) {
		// Sub-category-only correction: re-file inside the current category
		// without touching the top-level classification.
		await updateEmailById(ctx.db, emailId, { sub_category: newSubCategory });
	}

	// Log the correction
	await insertClassificationLog(ctx.db, {
		email_id: emailId,
		from_address: fromAddress,
		subject: email.subject,
		category: effectiveCategory,
		previous_category: previousCategory,
		method: "user_feedback",
		confidence: 1.0,
		ai_tokens_used: null,
	});

	let ruleId = "";
	let agentMessage: string | undefined;

	if (
		effectiveCategory &&
		!analysis.follow_up_question &&
		(resolutionScope === "sender" || resolutionScope === "domain")
	) {
		const shouldUseDomainRule = resolutionScope === "domain" && !MAJOR_PROVIDERS.has(domain);
		const learnedRule = shouldUseDomainRule
			? analysis.learned_rule || {
					from_pattern: `*@${domain}`,
					category: effectiveCategory,
					confidence: 0.8,
				}
			: {
					from_pattern: fromAddress,
					category: effectiveCategory,
					confidence: 1.0,
				};

		const ruleResult = await upsertSenderRule(ctx.db, {
			from_pattern: learnedRule.from_pattern,
			category: learnedRule.category,
			confidence: learnedRule.confidence ?? 1.0,
		});
		ruleId = ruleResult.id;

		logInfo("feedback_rule_created", {
			email_id: emailId,
			from_address: fromAddress,
			category: effectiveCategory,
			rule_id: ruleId,
		});
	}

	if (analysis.memory_update) {
		await setAgentMemory(
			ctx.db,
			ctx.workspaceId,
			analysis.memory_update.key,
			analysis.memory_update.value,
		);
	}

	agentMessage =
		analysis.follow_up_question ||
		(analysis.summary
			? `Learned: ${analysis.summary}`
			: `Learned: emails from ${fromAddress} are "${effectiveCategory ?? "unclear"}".`);

	const feedbackResult = await insertClassificationFeedback(ctx.db, {
		workspace_id: ctx.workspaceId,
		email_id: emailId,
		from_address: fromAddress,
		domain,
		previous_category: previousCategory,
		corrected_category: effectiveCategory,
		user_comment: trimmedComment,
		resolution_scope: resolutionScope,
		agent_summary: analysis.summary || null,
		follow_up_question: analysis.follow_up_question,
	});

	// Phase 2.6: if the correction fixed a missed-personal mistake, sweep
	// recent (last 30d) inbox emails from the same sender that are still
	// mis-categorized and flip them to Personal too. One correction then
	// cleans up the whole sender in bulk instead of requiring one-by-one
	// taps. Only fires for non-personal -> personal corrections (the
	// asymmetric-risk direction); the reverse direction doesn't sweep.
	if (
		effectiveCategory === "personal" &&
		previousCategory !== "personal" &&
		previousCategory !== null
	) {
		await reclassifyRecentMissedPersonal(ctx.db, {
			fromAddress,
			previousCategory,
			domainScope: ctx.domainScope,
		}).catch((err) => {
			logInfo("reclassify_missed_personal_skipped", {
				email_id: emailId,
				from_address: fromAddress,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	// Save agent message if generated
	if (agentMessage) {
		await insertAgentMessage(ctx.db, {
			workspace_id: ctx.workspaceId,
			role: "assistant",
			content: agentMessage,
			email_id: emailId,
			message_type: analysis.follow_up_question ? "feedback_follow_up" : "chat",
			metadata: {
				email_id: emailId,
				feedback_id: feedbackResult.id,
				from_address: fromAddress,
				category: effectiveCategory,
				resolution_scope: resolutionScope,
				has_follow_up: Boolean(analysis.follow_up_question),
			},
		});
	}

	return {
		rule_id: ruleId,
		agent_message: agentMessage,
		feedback_id: feedbackResult.id,
		follow_up_question: analysis.follow_up_question || undefined,
	};
}
