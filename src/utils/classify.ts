import type { EmailSubCategory } from "@/types";

// Sender patterns that pick a SUB-category once a category is known (the codex sorter, a model,
// picks categories; see src/agent/classify.ts). The sender-pattern category heuristic that used
// to run at ingest was retired in the AI-only cutover (73d01d9, 2026-06-12) and deleted here.

// Phase 4: IoT / physical-world monitoring senders. A sender rule that files mail under
// "home_alerts" gets the per-customer sub_category named for its sender domain here. The labels
// are an operator's customers, so they live in the Worker var HOME_ALERTS_JSON
// ([{"domain":"sensor-vendor.example","label":"Customer — Sensor"}]; a domain matches itself and
// its subdomains), never in source. Unset or invalid = no sub-category (Home Alerts → All).
type HomeAlertSource = { domain: string; label: string };

function parseHomeAlerts(raw: string | undefined): HomeAlertSource[] {
	if (!raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return [];
		return value.flatMap((entry) =>
			entry &&
			typeof entry.domain === "string" &&
			typeof entry.label === "string" &&
			entry.domain.trim() &&
			entry.label.trim()
				? [{ domain: entry.domain.trim().toLowerCase(), label: entry.label.trim() }]
				: [],
		);
	} catch {
		return [];
	}
}

// Phase 4: Agents sub-category heuristics.
const AGENTS_VENDOR_STATUS_PATTERNS = [/@statuspage\.io$/i, /@bounce\.statuspage\./i];

const AGENTS_BROKEN_PATTERNS = [/^security@vercel\.com$/i];

// Anything remaining in Agents falls through to "bot_admin".

/**
 * Phase 4: resolve the per-customer Home Alerts sub-category for a sender from
 * HOME_ALERTS_JSON, or null if the sender's domain is not configured.
 */
export function homeAlertsSubCategory(fromAddress: string, homeAlertsJson?: string): string | null {
	const email = fromAddress.toLowerCase();
	const atIndex = email.lastIndexOf("@");
	if (atIndex === -1) return null;
	const domain = email.slice(atIndex + 1);
	for (const source of parseHomeAlerts(homeAlertsJson)) {
		if (domain === source.domain || domain.endsWith(`.${source.domain}`)) return source.label;
	}
	return null;
}

/**
 * Phase 4: pick an Agents sub-category from the full address. Broken
 * (urgent, push-worthy) > Vendor Status > Bot Admin (default).
 */
export function agentsSubCategory(email: string): EmailSubCategory {
	for (const re of AGENTS_VENDOR_STATUS_PATTERNS) {
		if (re.test(email)) return "vendor_status";
	}
	for (const re of AGENTS_BROKEN_PATTERNS) {
		if (re.test(email)) return "broken";
	}
	return "bot_admin";
}
