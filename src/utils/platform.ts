import type { SmtpAccountConfig } from "@/providers/types";
import type { MailboxState, PlatformMeta } from "@/types";

const FALLBACK_ATTACHMENT_NAME = "attachment";

export function normalizeEmailAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function parseRecipientParts(address: string): {
	normalizedAddress: string;
	mailbox: string;
	domain: string;
} {
	const normalizedAddress = normalizeEmailAddress(address);
	const atIndex = normalizedAddress.lastIndexOf("@");

	if (atIndex <= 0 || atIndex === normalizedAddress.length - 1) {
		throw new Error(`Invalid email address: ${address}`);
	}

	return {
		normalizedAddress,
		mailbox: normalizedAddress.slice(0, atIndex),
		domain: normalizedAddress.slice(atIndex + 1),
	};
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function isEnabled(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
		case "":
			return false;
		default:
			return Boolean(value.trim());
	}
}

/** Bearer token comparison whose running time doesn't depend on where the strings differ. */
export function tokensMatch(given: string, expected: string): boolean {
	let diff = given.length ^ expected.length;
	for (let i = 0; i < expected.length; i++) {
		diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
	}
	return diff === 0;
}

/** SEND_MODE (SPEC §4): unset or "live" sends; "record" stores in Sent and transmits nothing. */
export function getSendMode(env: CloudflareBindings): "live" | "record" | "invalid" {
	const mode = (env.SEND_MODE ?? "").trim().toLowerCase();
	if (mode === "" || mode === "live") return "live";
	return mode === "record" ? "record" : "invalid";
}

/**
 * Which provider sends for a sender domain: SMTP_ACCOUNTS_JSON wins, then
 * EMAIL_PROVIDERS_JSON ({"example.com":"cloudflare"}). A domain in neither has no provider and
 * its sends fail with PROVIDER_NOT_CONFIGURED (the Postmark fallback was cut 2026-10-22).
 */
export function getEmailProviderName(
	env: CloudflareBindings,
	senderDomain: string,
): "smtp" | "cloudflare" | "none" {
	if (getSmtpAccountConfig(env, senderDomain)) return "smtp";
	if (env.EMAIL_PROVIDERS_JSON) {
		try {
			const map = JSON.parse(env.EMAIL_PROVIDERS_JSON) as Record<string, string>;
			const match = map[senderDomain.trim().toLowerCase()];
			if (match?.trim().toLowerCase() === "cloudflare") return "cloudflare";
		} catch {
			// a broken map routes nothing
		}
	}
	return "none";
}

/**
 * The display name SENDER_NAMES_JSON gives a sender address, or null. A bad map or
 * name is no name. No header specials or line breaks: the providers quote/encode,
 * but a broken map must not be able to inject a header.
 */
export function senderName(env: CloudflareBindings, address: string): string | null {
	if (!env.SENDER_NAMES_JSON) return null;
	try {
		const map = JSON.parse(env.SENDER_NAMES_JSON) as unknown;
		if (!map || typeof map !== "object" || Array.isArray(map)) return null;
		const key = address.trim().toLowerCase();
		const entry = Object.entries(map).find(([addr]) => addr.trim().toLowerCase() === key);
		const name = typeof entry?.[1] === "string" ? entry[1].trim() : "";
		return /^[^\r\n<>"]{1,78}$/.test(name) ? name : null;
	} catch {
		return null;
	}
}

/**
 * The outgoing From header for a bare sender address: "Name <address>" when
 * SENDER_NAMES_JSON names it, the address unchanged otherwise. A bad map or
 * name never blocks a send; it falls back to the bare address.
 */
export function formatSenderAddress(env: CloudflareBindings, address: string): string {
	const name = senderName(env, address);
	return name ? `${name} <${address.trim()}>` : address;
}

export function getAllowedOrigins(env: CloudflareBindings): string[] {
	if (!env.ALLOWED_ORIGINS) {
		return [];
	}

	return uniqueStrings(
		env.ALLOWED_ORIGINS.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean),
	);
}

/** The domains MailClaw serves (MAIL_DOMAINS, comma separated). Empty means unconfigured. */
export function getConfiguredDomains(env: CloudflareBindings): string[] {
	if (!env.MAIL_DOMAINS) return [];
	return uniqueStrings(
		env.MAIL_DOMAINS.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean),
	);
}

function getSenderDomain(address: string): string {
	return parseRecipientParts(address).domain;
}

export function isSenderDomainAllowed(env: CloudflareBindings, fromAddress: string): boolean {
	const configuredDomains = getConfiguredDomains(env);

	if (configuredDomains.length === 0) {
		return true;
	}

	return configuredDomains.includes(getSenderDomain(fromAddress));
}

export function getAllowedSenders(env: CloudflareBindings): string[] {
	if (!env.ALLOWED_SENDERS) return [];
	return env.ALLOWED_SENDERS.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export function getFeatureFlags(env: CloudflareBindings) {
	const hasSmtp = Boolean(env.SMTP_ACCOUNTS_JSON);
	const hasCloudflare = Boolean(env.EMAIL && env.EMAIL_PROVIDERS_JSON);

	return {
		attachments: Boolean(env.ATTACHMENTS),
		// Always true — reply/forward buttons must never disappear from the UI.
		// The send endpoint returns a proper error if no provider is configured.
		// Use send_configured to show warnings in the Compose modal instead.
		send: true,
		send_configured: getSendMode(env) === "record" || hasSmtp || hasCloudflare,
		spam: false,
		agent: Boolean(env.ANTHROPIC_API_KEY),
		compose_rte_enabled: isEnabled(env.COMPOSE_RTE_ENABLED),
	};
}

export interface PlatformMetaStats {
	domains: Array<{
		domain: string;
		email_count: number;
		latest_received_at: number | null;
		mailboxes: Array<{
			mailbox: string;
			address: string;
			email_count: number;
			latest_received_at: number | null;
		}>;
	}>;
	mailbox_state_counts: Record<MailboxState, number>;
	unread_count: number;
	category_counts: Record<string, number>;
}

export interface ConversationPlatformMetaStats {
	conversation_count: number;
	conversation_mailbox_state_counts: Record<MailboxState, number>;
	conversation_unread_count: number;
	conversation_category_counts: Record<string, number>;
	conversation_category_unread_counts?: Record<string, number>;
	conversation_sub_category_unread_counts?: Record<string, number>;
	conversation_for_person_counts?: Record<string, number>;
	conversation_for_person_unread_counts?: Record<string, number>;
}

export function buildPlatformMeta(
	env: CloudflareBindings,
	stats: PlatformMetaStats,
	conversationStats?: ConversationPlatformMetaStats,
): PlatformMeta {
	return {
		configured_domains: getConfiguredDomains(env),
		active_domains: stats.domains,
		mailbox_state_counts: stats.mailbox_state_counts,
		unread_count: stats.unread_count,
		category_counts: stats.category_counts,
		conversation_count: conversationStats?.conversation_count ?? 0,
		conversation_mailbox_state_counts: conversationStats?.conversation_mailbox_state_counts ?? {
			inbox: 0,
			sent: 0,
			archived: 0,
			trash: 0,
			draft: 0,
		},
		conversation_unread_count: conversationStats?.conversation_unread_count ?? 0,
		conversation_category_counts: conversationStats?.conversation_category_counts ?? {},
		conversation_category_unread_counts:
			conversationStats?.conversation_category_unread_counts ?? {},
		conversation_sub_category_unread_counts:
			conversationStats?.conversation_sub_category_unread_counts ?? {},
		// v54 person lane: threads per forwarded-in person (sidebar entry per person).
		conversation_for_person_counts: conversationStats?.conversation_for_person_counts ?? {},
		conversation_for_person_unread_counts:
			conversationStats?.conversation_for_person_unread_counts ?? {},
		features: getFeatureFlags(env),
		allowed_senders: getAllowedSenders(env),
		sender_names: Object.fromEntries(
			getAllowedSenders(env).flatMap((address) => {
				const name = senderName(env, address);
				return name ? [[address, name]] : [];
			}),
		),
	};
}

function sanitizeFilename(filename: string | null): string {
	const value = (filename || FALLBACK_ATTACHMENT_NAME).trim();
	const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
	return sanitized || FALLBACK_ATTACHMENT_NAME;
}

export function buildAttachmentObjectKey(
	emailId: string,
	index: number,
	filename: string | null,
): string {
	return `emails/${emailId}/${index}-${sanitizeFilename(filename)}`;
}

export function buildDraftAttachmentStagingKey(
	draftId: string,
	replacementId: string,
	index: number,
	filename: string | null,
): string {
	return `emails/${draftId}/draft-attachments/${replacementId}/${index}-${sanitizeFilename(filename)}`;
}

/**
 * R2 key of a keyed send's attachment (ticket 08): fixed by the key, the position and the
 * content, so every attempt with the key writes the same object and no two contents share one.
 */
export function buildSendAttachmentKey(
	keyId: string,
	index: number,
	sha256: string,
	filename: string | null,
): string {
	return `emails/${keyId}/send/${index}-${sha256.slice(0, 16)}-${sanitizeFilename(filename)}`;
}

export function getAttachmentSize(content: ArrayBuffer | Uint8Array | string): number {
	if (typeof content === "string") {
		return new TextEncoder().encode(content).byteLength;
	}

	if (content instanceof Uint8Array) {
		return content.byteLength;
	}

	return content.byteLength;
}

/**
 * Resolve a forwarding address back to its original recipient.
 * e.g. "relay@example.com" → "you@example.org"
 * Returns the original address unchanged if no mapping exists.
 */
export function resolveForwardedRecipient(env: CloudflareBindings, address: string): string {
	if (!env.EMAIL_FORWARDING_MAP) return address;

	try {
		const map = JSON.parse(env.EMAIL_FORWARDING_MAP) as Record<string, string>;
		const normalized = normalizeEmailAddress(address);
		return map[normalized] || address;
	} catch {
		return address;
	}
}

export function getSmtpAccountConfig(
	env: CloudflareBindings,
	domain: string,
): SmtpAccountConfig | null {
	if (!env.SMTP_ACCOUNTS_JSON) return null;

	try {
		const accounts = JSON.parse(env.SMTP_ACCOUNTS_JSON) as Record<string, SmtpAccountConfig>;
		return accounts[domain] || null;
	} catch {
		return null;
	}
}
