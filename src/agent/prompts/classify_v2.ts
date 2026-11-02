import type { AgentMemoryEntry, ClassificationFeedbackEntry, EmailCategory } from "@/types";

/**
 * Classifier prompt version. Bumped when structure changes in a way that
 * would break A/B comparisons against historical logs. Recorded alongside
 * classification_log entries in Phase 2.
 */
// v2.2.0 (2026-10-14): account-at-risk payment mail is billing, not notifications
// (payment problems were being filed as notifications).
// v2.3.0 (2026-10-14): action notes for the "Needs you" strip.
export const CLASSIFIER_PROMPT_VERSION = "v2.3.0";

/**
 * Phase 2.2: static system block (cacheable).
 *
 * Contains category definitions + the priority-pin rule + the asymmetric-risk
 * instruction. This text is stable across every classification and is
 * structured so it can be sent as a cached system message when the
 * underlying provider supports prompt caching (Anthropic `cache_control`:
 * `ephemeral`). A provider without caching just resends it.
 *
 * Do not include per-email data, feedback rows, or thread context here —
 * those change every call and must go in the variable block so caching
 * keeps working.
 */
export const CLASSIFY_SYSTEM_PROMPT_V2 = `You are an email classifier for a personal inbox.

Classify the incoming email into exactly one of these categories:

- "personal": Email from a real person the user knows — colleagues, friends, family, business contacts, vendors they have a direct relationship with. Requires attention or a response. NOT cold outreach, NOT invoices, NOT automated messages.
- "billing": Invoices, bills, statements, payment confirmations, receipts from services and purchases. Includes renewals, payment-failed alerts, and refund notices tied to a specific vendor. Also any notice that one of the user's own accounts is at risk over money: "update your payment method to avoid losing service", "service suspended", "payment missed", an "Action Required" over a negative or past-due balance.
- "agents": Automated messages from infrastructure the user runs — CI/CD pipelines, GitHub notifications, Cloudflare alerts, Vercel deploys, monitoring services, SaaS status pages, bot-to-human operational communications.
- "notifications": Automated account-level emails — password resets, 2FA codes, login alerts, shipping confirmations (without payment), verification emails, platform activity like "someone commented on your document".
- "newsletters": Content the user intentionally subscribed to — newsletters, digests, curated content, editorial emails.
- "marketing": Promotional emails — cold outreach, product launches, sales pitches, drip campaigns, unsolicited promos. Includes onboarding/marketing emails from SaaS domains (hello@, ship@, team@).
- "spam": Deceptive cold emails, phishing attempts, scams, impersonation, clearly malicious bulk mail.
- "home_alerts": IoT / physical-world alarms from sensor systems (leak and temperature sensors, smart-home devices, solar-inverter monitors). These are urgent enough that the user wants them surfaced separately from generic automated notifications.
- "tax_documents": 1099s, W-2s, year-end statements, property-tax bills, IRS correspondence, tax-prep service mailings. These are annual/high-stakes and searched by year, not by vendor.
- null: Only if the email is too ambiguous to place anywhere.

Key distinctions to pay attention to:
- "personal" vs "marketing": Real person the user has corresponded with vs. a stranger trying to sell something.
- "agents" vs "notifications": Infrastructure/CI/CD/bot messages vs. account operations (password resets, shipping).
- "billing" vs "notifications": Financial documents (invoices, receipts) and payment trouble on the user's own accounts vs. account operations (password resets). A payment problem is billing even when it reads like an account alert.
- "newsletters" vs "marketing": User chose to subscribe vs. unsolicited promotional.
- "marketing" vs "spam": Legitimate promotional vs. deceptive/malicious.

ASYMMETRIC-RISK RULE (IMPORTANT):
Missing a personal email is catastrophic — the user cares far more about false negatives on "personal" than false positives. When in doubt between Personal and any other category (especially Marketing, Newsletters, or Notifications), prefer Personal AND lower your confidence. The inbox routes low-confidence results from people to Personal with an "unsure" badge, so you never need to invent confidence you don't have.

ACTION NOTES ("action_note", "action_due"):
Write a note only when the email asks the user to do something by a deadline, or he will lose something, AND it is not a person writing to him (that is "personal") and not a bill or failed payment (that is "billing"). Examples: government, legal or compliance filings; licenses, domains or services about to lapse; account or security problems he must fix; a bounce of his own message. Otherwise null: receipts, promotions, codes, newsletters and routine alerts never get one.
- "action_note": imperative, specific, at most 140 characters, e.g. "File the LLC's annual report with the state before the deadline".
- "action_due": the deadline as YYYY-MM-DD when the email states or implies one (count "within 60 days" from the email's "date"), else null.

Respond with ONLY valid JSON in this exact shape:
{"category": "personal"|"billing"|"agents"|"notifications"|"newsletters"|"marketing"|"spam"|"home_alerts"|"tax_documents"|null, "confidence": 0.0-1.0, "reasoning": "brief explanation", "action_note": string|null, "action_due": "YYYY-MM-DD"|null}`;

/**
 * Phase 2.3: asymmetric feedback formatting.
 *
 * Corrections where the user moved an email FROM a non-personal category
 * INTO personal count 3× — we repeat them in the prompt so the classifier
 * sees them three times, a cheap way to bias the distribution without
 * re-training. The reverse direction (personal → non-personal) counts 1×.
 */
export function formatAsymmetricFeedback(
	entries: ClassificationFeedbackEntry[],
): AgentMemoryEntry[] {
	const out: AgentMemoryEntry[] = [];
	let index = 0;

	for (const entry of entries) {
		const missedPersonal =
			entry.corrected_category === "personal" &&
			entry.previous_category !== "personal" &&
			entry.previous_category !== null;
		const weight = missedPersonal ? 3 : 1;
		for (let i = 0; i < weight; i++) {
			index += 1;
			const pieces = [
				`From ${entry.from_address}`,
				`corrected ${entry.previous_category ?? "null"} -> ${entry.corrected_category ?? "unclear"}`,
				entry.resolution_scope ? `scope=${entry.resolution_scope}` : null,
				entry.user_comment ? `why="${entry.user_comment}"` : null,
				missedPersonal ? "(weighted: missed-personal)" : null,
			]
				.filter(Boolean)
				.join("; ");

			out.push({
				key: `correction_${index}`,
				workspace_id: entry.workspace_id,
				value: pieces,
				updated_at: entry.created_at,
			});
		}
	}

	return out;
}

export interface ThreadConsistencyHint {
	priorityCategory: EmailCategory | null;
	memberMessageCount: number;
}

/**
 * Phase 2.4: per-thread consistency signal.
 *
 * If a thread already has a priority_category, tell the classifier. The
 * priority-pin rule at the aggregate level will prevent a downgrade no
 * matter what the classifier says, but giving the classifier context
 * improves prediction quality.
 */
export function buildThreadConsistencyLine(hint: ThreadConsistencyHint): string | null {
	if (!hint.priorityCategory || hint.memberMessageCount < 1) return null;
	return `This thread already contains ${hint.memberMessageCount} message(s) classified at priority "${hint.priorityCategory}". Replies usually match the thread. Explain in reasoning if you disagree.`;
}
