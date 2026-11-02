/**
 * Where chat and feedback send Anthropic Messages requests. ANTHROPIC_BASE_URL may point at a
 * Messages-compatible gateway (set on the deployed Worker, see .dev.vars.example);
 * ANTHROPIC_API_KEY holds that endpoint's key. Unset means
 * api.anthropic.com.
 */
export function anthropicMessagesUrl(baseUrl: string | undefined): string {
	return `${(baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
}

/** Chat and feedback use one model (the per-owner preference API was cut 2026-10-22). */
export const CHAT_MODEL = "claude-sonnet-5-5";
