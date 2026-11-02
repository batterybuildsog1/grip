/**
 * Opt-in system-mail routing (SYSTEM_MAIL_RULES_JSON): automated mail the instance's own
 * systems send to its own domains is filed under Agents at ingest, ahead of sender and people
 * rules. No AI or sender-rule mutation. Unset = off.
 */
import { getConfiguredDomains } from "@/utils/platform";

interface SystemMailRule {
	recipient_prefix?: string;
	sender_local_parts?: string[];
	subject_words?: string[];
}
function systemMailRules(env: CloudflareBindings): SystemMailRule[] {
	try {
		const rules: unknown = JSON.parse(env.SYSTEM_MAIL_RULES_JSON || "[]");
		if (!Array.isArray(rules)) return [];
		return rules.filter(
			(r) =>
				r &&
				typeof r === "object" &&
				(r.recipient_prefix === undefined || typeof r.recipient_prefix === "string") &&
				[r.sender_local_parts, r.subject_words].every(
					(v) =>
						v === undefined ||
						(Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0)),
				),
		);
	} catch {
		return [];
	}
}
interface SystemMail {
	from_address: string;
	subject: string | null;
	to_address?: string;
	to_addresses: string[];
	cc_addresses: string[];
	bcc_addresses?: string[];
}

export function isSystemMail(
	env: CloudflareBindings,
	mail: SystemMail,
	envelopeTo?: string,
): boolean {
	const domains = getConfiguredDomains(env);
	const rules = systemMailRules(env);
	const recipients = [
		mail.to_address ?? "",
		...mail.to_addresses,
		...mail.cc_addresses,
		...(mail.bcc_addresses ?? []),
		envelopeTo ?? "",
	];
	if (
		recipients.some((address) => {
			const [local, domain] = address.trim().toLowerCase().split("@");
			return (
				domains.includes(domain) &&
				rules.some(
					(r) =>
						r.recipient_prefix &&
						local.startsWith(r.recipient_prefix) &&
						local.length > r.recipient_prefix.length,
				)
			);
		})
	)
		return true;
	// A sender local part alone is not enough (the same automated sender also writes to real
	// customers): every subject word of the rule must be present too.
	const [local, domain] = mail.from_address.trim().toLowerCase().split("@");
	return (
		domains.includes(domain) &&
		rules.some(
			(r) =>
				r.sender_local_parts?.includes(local) &&
				r.subject_words?.length &&
				r.subject_words.every((w) =>
					new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
						mail.subject ?? "",
					),
				),
		)
	);
}
