import { type Context, Hono } from "hono";
import { CHAT_MODEL } from "@/agent/anthropic";
import { handleAgentChat } from "@/agent/chat";
import { handleFeedback } from "@/agent/feedback";
import { ownerKey } from "@/auth/principal";
import {
	clearAgentMessages,
	deleteSenderRule,
	getAgentMessages,
	getSenderRules,
	upsertSenderRule,
} from "@/database/agent";
import { getConversationByThreadId } from "@/database/d1";
import { aiConsent, CONSENT_REQUIRED } from "@/services/ai-consent";
import { AI_PAUSED, billingConfig, usageStatement } from "@/services/ai-usage";
import type { AppVariables } from "@/types";
import { ERR, OK } from "@/utils/http";
import { getConfiguredDomains } from "@/utils/platform";
import { agentChatSchema, agentFeedbackSchema, senderRuleSchema } from "@/utils/validation";

const agent = new Hono<{
	Bindings: CloudflareBindings;
	Variables: AppVariables;
}>();

function getWorkspaceContext(
	c: Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>,
) {
	// Agent memory/history belong to the caller's owner key (src/auth/principal.ts).
	const workspaceId = ownerKey(c);
	const domains = getConfiguredDomains(c.env);
	return { workspaceId, domains };
}

// POST /api/agent/chat - Streaming chat with the classification agent
agent.post("/api/agent/chat", async (c) => {
	if (!c.env.ANTHROPIC_API_KEY && !c.env.AI_HUB_KEY) {
		return c.json(ERR("NOT_CONFIGURED", "Agent chat requires its configured AI credential"), 503);
	}
	// AI consent (SPEC §2): chat sends history, rules, memory and the selected mail to the AI provider.
	// Checked here (nothing stored, nothing assembled) and again right before the fetch.
	if (!(await aiConsent(c.env.D1)).allowed) {
		return c.json(ERR(CONSENT_REQUIRED.code, CONSENT_REQUIRED.message), 403);
	}

	const billing = billingConfig(c.env);
	if (
		billing &&
		!billing.unlimited &&
		(await usageStatement(c.env.D1, billing, undefined, false)).ai_sorting_state ===
			"allowance_used"
	)
		return c.json(ERR("AI_ALLOWANCE_USED", AI_PAUSED), 402);

	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	const parsed = agentChatSchema.safeParse(payload);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}

	const { workspaceId, domains } = getWorkspaceContext(c);
	let contextEmailId = parsed.data.email_id;
	if (!contextEmailId && parsed.data.conversation_id) {
		const { conversation, emails, error } = await getConversationByThreadId(
			c.env.D1,
			parsed.data.conversation_id,
			domains,
		);
		if (error) {
			return c.json(ERR("D1_ERROR", error.message), 500);
		}
		if (!conversation && emails.length === 0) {
			return c.json(ERR("NOT_FOUND", "Conversation not found"), 404);
		}
		contextEmailId = conversation?.id ?? emails[emails.length - 1]?.id;
	}

	const stream = await handleAgentChat(
		{
			db: c.env.D1,
			anthropicApiKey: c.env.ANTHROPIC_API_KEY ?? "",
			hubUrl: c.env.AI_HUB_URL,
			hubKey: c.env.AI_HUB_KEY,
			anthropicBaseUrl: c.env.ANTHROPIC_BASE_URL,
			billing: billingConfig(c.env),
			workspaceId,
			domainScope: domains,
			model: CHAT_MODEL,
		},
		parsed.data.message,
		{
			emailId: contextEmailId,
			conversationId: parsed.data.conversation_id,
		},
	);

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Connection: "keep-alive",
		},
	});
});

// GET /api/agent/messages - Get chat history
agent.get("/api/agent/messages", async (c) => {
	const { workspaceId } = getWorkspaceContext(c);
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);

	const messages = await getAgentMessages(c.env.D1, workspaceId, limit);
	return c.json(OK({ messages }));
});

// DELETE /api/agent/messages - Clear chat history
agent.delete("/api/agent/messages", async (c) => {
	const { workspaceId } = getWorkspaceContext(c);
	const result = await clearAgentMessages(c.env.D1, workspaceId);

	if (result.error) {
		return c.json(ERR("D1_ERROR", result.error.message), 500);
	}

	return c.json(OK({ message: "Chat history cleared" }));
});

// GET /api/agent/rules - List sender rules
agent.get("/api/agent/rules", async (c) => {
	const rules = await getSenderRules(c.env.D1);
	return c.json(OK({ rules }));
});

// PUT /api/agent/rules - Create or update a sender rule
agent.put("/api/agent/rules", async (c) => {
	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	const parsed = senderRuleSchema.safeParse(payload);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}

	const result = await upsertSenderRule(c.env.D1, {
		from_pattern: parsed.data.from_pattern,
		category: parsed.data.category,
		confidence: parsed.data.confidence,
	});

	if (result.error) {
		return c.json(ERR("D1_ERROR", result.error.message), 500);
	}

	return c.json(OK({ id: result.id }));
});

// DELETE /api/agent/rules/:id - Delete a sender rule
agent.delete("/api/agent/rules/:id", async (c) => {
	const result = await deleteSenderRule(c.env.D1, c.req.param("id"));

	if (result.error) {
		return c.json(ERR("D1_ERROR", result.error.message), 500);
	}

	if (!result.deleted) {
		return c.json(ERR("NOT_FOUND", "Rule not found"), 404);
	}

	return c.json(OK({ message: "Rule deleted" }));
});

// POST /api/agent/feedback - User corrects a classification
agent.post("/api/agent/feedback", async (c) => {
	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	const parsed = agentFeedbackSchema.safeParse(payload);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}

	const { workspaceId, domains } = getWorkspaceContext(c);

	try {
		const result = await handleFeedback(
			{
				db: c.env.D1,
				anthropicApiKey: c.env.ANTHROPIC_API_KEY ?? "",
				hubUrl: c.env.AI_HUB_URL,
				hubKey: c.env.AI_HUB_KEY,
				anthropicBaseUrl: c.env.ANTHROPIC_BASE_URL,
				billing: billingConfig(c.env),
				workspaceId,
				domainScope: domains,
				model: CHAT_MODEL,
			},
			parsed.data.email_id,
			parsed.data.category,
			parsed.data.comment ?? null,
			parsed.data.sub_category,
		);

		return c.json(OK(result));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message === "Email not found") {
			return c.json(ERR("NOT_FOUND", message), 404);
		}
		return c.json(ERR("FEEDBACK_FAILED", message), 500);
	}
});

export default agent;
