import type { BillingSubCategory } from "@/types";

// 1.2.0 (2026-10-14): account-at-risk notices are failed_payments (Money view).
export const BILLING_SUB_PROMPT_VERSION = "billing-sub-v1.2.0";

/** Alias retained for existing call sites; src/types.ts owns the enum. */
export type BillingContentSubCategory = BillingSubCategory;

export const CLASSIFY_BILLING_SUB_SYSTEM_PROMPT = `You are a sub-folder router for emails already classified as "billing".

Route the email into exactly one of:

- "invoice_conversations": An invoice or bill that is AWAITING OR REQUESTING PAYMENT — an unpaid invoice arriving (from a person or a billing system), a bill with a balance due, a payment request, a human discussing what is owed, asking for payment details, following up on an unpaid bill, or negotiating terms. The defining test: money still needs to move and the user (or their counterparty) must act to pay. A PAID invoice NEVER belongs here, no matter who sent it — paid means "receipts". Attached unpaid-invoice PDFs count.
- "failed_payments": Payment failed, card declined, retry required, subscription suspended due to non-payment, dunning notices, "update your payment method" alerts, bounced payments, insufficient funds, chargebacks. Also any warning that one of the user's own accounts or services is at risk over money: "update your payment method to avoid losing service", "service suspended", "payment missed", an "Action Required" over a negative or past-due balance. Anything where money didn't move and the user needs to act to fix it. HIGH PRIORITY.
- "receipts": Receipts AND paid invoices — any record that money already moved. Automated receipts, "Invoice #123 — PAID" notices, order confirmations with payment, renewal-charge confirmations, refund notices, zero-balance statements. If the email (or its attached invoice) is marked paid, settled, or shows no balance due, it belongs here regardless of sender or template style.
- "other": Billing-adjacent mail that doesn't fit above — statements without action, credit reports, payment method change confirmations, generic account-billing notices, anything ambiguous. The user will read these manually.

Key distinctions:
- "invoice_conversations" vs "receipts": The deciding axis is whether money still needs to move. Unpaid / due / requesting payment → invoice_conversations. Paid / settled / confirming a completed charge → receipts. "INVOICE #INV-0042 | Due 01/15/2026 | Pay now" is invoice_conversations; "We received your payment for invoice #INV-0042" is receipts — even when both come from the same automated system.
- "failed_payments" always wins over "receipts" or "other" when a payment problem is present.
- When truly ambiguous, pick "other" — the user will sort it.

Respond with ONLY valid JSON:
{"sub_category": "invoice_conversations"|"receipts"|"failed_payments"|"other", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

export const BILLING_SUB_CATEGORY_VALUES: BillingContentSubCategory[] = [
	"invoice_conversations",
	"receipts",
	"failed_payments",
	"other",
];
