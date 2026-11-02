/**
 * Shared sender-name parsing logic.
 * Used by EmailRow and the thread (utils/thread-text.ts) to show human-readable names.
 */

const TLDS = new Set([
	"com",
	"org",
	"net",
	"io",
	"co",
	"dev",
	"app",
	"ai",
	"me",
	"us",
	"uk",
	"ca",
	"au",
	"de",
	"fr",
	"tv",
	"store",
	"info",
	"biz",
	"cc",
	"eu",
	"in",
]);
const JUNK_SUBDOMAINS = new Set([
	"send",
	"mail",
	"email",
	"bounce",
	"bounces",
	"bnc",
	"bulk",
	"content",
	"updates",
	"read",
	"pm-bounces",
	"message",
	"e",
	"eom",
	"notifications",
	"insiders",
	"subscriptions",
	"alerts",
	"sg-email",
	"em",
	"bnc3",
	"k3",
	"s4",
	"pmbounces",
	"identity-reachout",
	"posts-recaps",
	"contact",
	"follow-suggestions",
	"unread-messages",
]);

const FUNCTIONAL_LOCAL_PARTS = new Set([
	"follow-suggestions",
	"posts-recaps",
	"unread-messages",
	"subscriptions",
	"alerts",
	"contact",
	"support",
	"info",
	"hello",
	"team",
	"news",
	"updates",
	"digest",
	"follow",
	"invite",
	"reminder",
	"notification",
]);

const KNOWN_BRANDS: Record<string, string> = {
	openai: "OpenAI",
	github: "GitHub",
	linkedin: "LinkedIn",
	instagram: "Instagram",
	robinhood: "Robinhood",
	youtube: "YouTube",
	stackoverflow: "Stack Overflow",
	deepseek: "DeepSeek",
	mailchimp: "Mailchimp",
};

/** Known email infrastructure / ESP domains → clean brand name */
const INFRA_DOMAINS: Record<string, string> = {
	amazonses: "Amazon",
	sendgrid: "SendGrid",
	mailgun: "Mailgun",
	mandrill: "Mandrill",
	sparkpost: "SparkPost",
	mailchimp: "Mailchimp",
	postmarkapp: "Postmark",
	mailjet: "Mailjet",
	sendinblue: "Brevo",
	brevo: "Brevo",
	constantcontact: "Constant Contact",
	sailthru: "Sailthru",
	klaviyo: "Klaviyo",
	hubspot: "HubSpot",
	intercom: "Intercom",
	zendesk: "Zendesk",
	freshdesk: "Freshdesk",
	customerio: "Customer.io",
	rsgsv: "Mailchimp",
	mcsv: "Mailchimp",
	mcdlv: "Mailchimp",
};

/**
 * Walk domain segments to find the first recognizable brand name.
 * e.g. "em1234.read.booksellers.example" → "Booksellers"
 *      "mg-d1.newsletters.example"      → "Newsletters"
 *      "12345678m.vpnvendor.example"     → "Vpnvendor"
 */
function extractBrandFromDomain(domainFull: string): string {
	const parts = domainFull.toLowerCase().split(".");
	// Check for known infrastructure/ESP domains — but look for a customer brand first
	let infraName: string | null = null;
	for (const part of parts) {
		if (INFRA_DOMAINS[part]) {
			infraName = INFRA_DOMAINS[part];
			break;
		}
	}
	// Remove TLD(s) from the end
	while (parts.length > 1 && TLDS.has(parts[parts.length - 1])) {
		parts.pop();
	}
	// Walk from the END (most specific -> brand is usually second-to-last before TLD)
	// and find the first segment that looks like a real word
	for (let i = parts.length - 1; i >= 0; i--) {
		const seg = parts[i];
		if (JUNK_SUBDOMAINS.has(seg)) continue;
		if (INFRA_DOMAINS[seg]) continue;
		if (seg.length < 3) continue;
		// Skip segments with digits
		if (/\d/.test(seg)) continue;
		// Skip segments with very few vowels (random strings)
		const vowels = (seg.match(/[aeiou]/gi) || []).length;
		if (vowels === 0 && seg.length > 3) continue;
		// Found a good one — check known brands first, then capitalize
		if (KNOWN_BRANDS[seg]) return KNOWN_BRANDS[seg];
		return seg.charAt(0).toUpperCase() + seg.slice(1);
	}
	// If we found an infra domain but no customer brand, return the ESP name
	if (infraName) return infraName;
	// Fallback: use the last non-TLD segment even if ugly
	const fallback = parts[parts.length - 1] || domainFull.split(".")[0] || "System";
	if (KNOWN_BRANDS[fallback]) return KNOWN_BRANDS[fallback];
	return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

const COMPANY = /^(llc|pbc|inc\.?|ltd\.?|co\.?|corp\.?|llp|pllc|n\.a\.|lp)$/i;

/**
 * A person's name as people say it: "Rivera, Sam" reads "Sam Rivera" ("Acme, LLC" stays), and
 * "(via Google Docs)" / "(on behalf of …)" and outer quotes go. The one rule for the list, the
 * rail, the thread and the compose chips (and the reference the Apple apps follow).
 */
export function personName(raw: string): string {
	const name = raw
		.replace(/\s*\((via|on behalf of) [^)]*\)/i, "")
		.replace(/^["']|["']$/g, "")
		.trim();
	if (!name) return raw.trim();
	const flipped = name.match(
		/^([\p{L}'’-]+(?: [\p{L}'’-]+)?),\s*([\p{L}'’-]+(?: [\p{L}.'’-]+)?)$/u,
	);
	return flipped && !COMPANY.test(flipped[2]) ? `${flipped[2]} ${flipped[1]}` : name;
}

/** Parse a human-readable sender name from an email address string. */
export function parseSenderName(raw: string, fromName?: string | null): string {
	if (!raw) return "Unknown";

	// If we have a display name from the email headers, use it
	if (fromName && fromName.trim()) {
		return personName(fromName.trim());
	}

	// Handle "Name <email@example.com>" format
	const angleMatch = raw.match(/^(.+?)\s*<[^>]+>$/);
	if (angleMatch) {
		const name = angleMatch[1].trim().replace(/^["']|["']$/g, "");
		if (name && !name.includes("@")) return name;
	}

	// Handle bare email: extract the part before @
	const atIdx = raw.indexOf("@");
	if (atIdx > 0) {
		const local = raw.split("<").pop()?.split("@")[0] || raw.split("@")[0];
		const domainFull = raw.split("@")[1]?.replace(">", "") || "";

		// System / bounce / noreply addresses → show brand from domain
		if (
			/^(bounce|bounces\+|mailer-daemon|noreply|no-reply|postmaster|pm_bounces|unread-messages|webmaster)/i.test(
				local,
			)
		) {
			return extractBrandFromDomain(domainFull);
		}

		// Functional local parts (e.g. "follow-suggestions", "updates") → show brand from domain
		if (FUNCTIONAL_LOCAL_PARTS.has(local.toLowerCase())) {
			return extractBrandFromDomain(domainFull);
		}

		// Random / machine-generated local parts → show brand from domain
		const digitCount = (local.match(/\d/g) || []).length;
		const digitRatio = digitCount / local.length;
		const hasEquals = local.includes("=");
		const isTooLong = local.length > 30;
		const isTooShort = local.length <= 2;
		const looksHex = /^[0-9a-f]{6,}$/i.test(local);
		const hasDigitsInWords = /[a-z]\d|\d[a-z]/i.test(local) && digitCount >= 2;
		const fewVowels =
			(local.match(/[aeiou]/gi) || []).length / local.length < 0.15 && local.length > 4;

		if (
			digitRatio > 0.3 ||
			isTooLong ||
			isTooShort ||
			hasEquals ||
			looksHex ||
			/\+\d/.test(local) ||
			fewVowels ||
			hasDigitsInWords
		) {
			return extractBrandFromDomain(domainFull);
		}

		// Looks like a real name: turn "robin.example" into "Robin Example"
		return local
			.replace(/[._-]/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase())
			.trim();
	}

	return raw;
}

/** Extract just the email portion from "Name <email>" */
export function parseEmailAddress(raw: string): string {
	const match = raw.match(/<([^>]+)>/);
	return match ? match[1] : raw;
}
