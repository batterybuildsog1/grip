import { findSenderRule, insertClassificationLog } from "@/database/agent";
import type { EmailCategory } from "@/types";
import { agentsSubCategory, homeAlertsSubCategory } from "@/utils/classify";
import { logError } from "@/utils/logging";

/**
 * Phase 4: resolve a sub_category for a post-classification email.
 * Called after the AI writes a category, since the v2 classifier prompt
 * returns top-level only. Uses the same sender-pattern heuristics as the
 * inline fast path.
 */
export function resolveSubCategory(
	category: EmailCategory,
	fromAddress: string,
	homeAlertsJson?: string,
): string | null {
	const email = fromAddress.toLowerCase();
	const atIndex = email.lastIndexOf("@");
	if (atIndex === -1) return null;

	switch (category) {
		case "agents":
			return agentsSubCategory(email);
		case "home_alerts":
			// AI may assign home_alerts for a sender that the inline heuristic
			// didn't match (new sensor system we haven't seeded). Look up the
			// customer label if we know the sender; otherwise leave sub_category
			// null so the email lands under Home Alerts → All.
			return homeAlertsSubCategory(fromAddress, homeAlertsJson);
		default:
			// personal, newsletters, marketing, spam, tax_documents don't use
			// sub_category. billing and notifications use CONTENT-based subs
			// assigned by the Codex sidecar (classify-queue results) — sender
			// heuristics can't tell an unpaid invoice from a receipt.
			return null;
	}
}

/**
 * Phase 6 (AI-only cutover): the sender-rule short-circuit, applied directly
 * at ingest. Rules are the owner's explicit corrections and must keep working
 * instantly; they are global, so a correction applies in every domain.
 * Anything without a matching rule inserts with category NULL and is picked up
 * by the Codex sidecar via the classify-queue. Never throws: a rule-lookup
 * failure must not block email delivery.
 */
export async function getUserRuleClassification(
	db: D1Database,
	fromAddress: string,
	homeAlertsJson?: string,
): Promise<{
	category: EmailCategory;
	sub_category: string | null;
	confidence: number;
	rule_id: string;
} | null> {
	try {
		const rule = await findSenderRule(db, fromAddress);
		if (!rule || rule.confidence < 0.7) return null;
		return {
			category: rule.category,
			sub_category: resolveSubCategory(rule.category, fromAddress, homeAlertsJson),
			confidence: rule.confidence,
			rule_id: rule.id,
		};
	} catch (err) {
		logError("user_rule_lookup_failed", {
			from_address: fromAddress,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Audit-trail row for an at-ingest user-rule stamp — the same
 * method='sender_rule' rows the retired delivery-path pipeline wrote.
 * Best-effort: never throws.
 */
export async function logUserRuleClassification(
	db: D1Database,
	emailId: string,
	fromAddress: string,
	subject: string | null,
	rule: { category: EmailCategory; confidence: number },
): Promise<void> {
	await insertClassificationLog(db, {
		email_id: emailId,
		from_address: fromAddress,
		subject,
		category: rule.category,
		previous_category: null,
		method: "sender_rule",
		confidence: rule.confidence,
		ai_tokens_used: null,
	}).catch(() => {});
}
