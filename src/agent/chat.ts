import {
	deleteAgentMemory,
	deleteSenderRule,
	getAgentMemory,
	getAgentMessages,
	getRecentClassificationFeedback,
	getSenderRules,
	insertAgentMessage,
	setAgentMemory,
	upsertSenderRule,
} from "@/database/agent";
import { getEmailById } from "@/database/d1";
import { aiConsent, CONSENT_REQUIRED } from "@/services/ai-consent";
import { agentAiFetch } from "@/services/ai-provider";
import type { BillingConfig } from "@/services/ai-usage";
import type { AgentMemoryEntry, ClassificationFeedbackEntry, SenderRule } from "@/types";
import { logError } from "@/utils/logging";

export interface ChatContext {
	db: D1Database;
	anthropicApiKey: string;
	anthropicBaseUrl?: string;
	billing?: BillingConfig | null;
	hubUrl?: string;
	hubKey?: string;
	workspaceId: string;
	domainScope: string[];
	model: string;
}

function formatFeedbackSummary(entry: ClassificationFeedbackEntry): string {
	return [
		`from ${entry.from_address}`,
		entry.corrected_category ? `-> ${entry.corrected_category}` : "-> unclear",
		entry.resolution_scope ? `scope=${entry.resolution_scope}` : null,
		entry.user_comment ? `comment=${entry.user_comment}` : null,
		entry.agent_summary ? `summary=${entry.agent_summary}` : null,
	]
		.filter(Boolean)
		.join("; ");
}

function buildSystemPrompt(
	rules: SenderRule[],
	memory: AgentMemoryEntry[],
	feedback: ClassificationFeedbackEntry[],
): string {
	const rulesStr =
		rules.length > 0
			? rules
					.slice(0, 50)
					.map((r) => `  ${r.from_pattern} → ${r.category} (confidence: ${r.confidence})`)
					.join("\n")
			: "  (none yet)";

	const memoryStr =
		memory.length > 0
			? memory
					.slice(0, 20)
					.map((m) => `  ${m.key}: ${m.value}`)
					.join("\n")
			: "  (none yet)";

	const feedbackStr =
		feedback.length > 0
			? feedback
					.slice(0, 10)
					.map((entry) => `  ${formatFeedbackSummary(entry)}`)
					.join("\n")
			: "  (none yet)";

	return `You are Grip's email classification assistant. You help the user sort their emails into these categories:

- "personal": Email from a real person the user knows — colleagues, friends, family, business contacts. Requires attention or a response. NOT cold outreach, NOT invoices, NOT automated.
- "billing": Invoices, bills, billing statements, payment confirmations, receipts from services and purchases.
- "agents": Automated messages from your own systems, agents, CI/CD pipelines, GitHub notifications, Cloudflare alerts, Vercel deploys, monitoring services, and bot-to-human communications.
- "notifications": Automated system emails — password resets, account alerts, shipping confirmations, verification emails, service status notifications.
- "newsletters": Content the user intentionally subscribed to — newsletters, digests, curated content, editorial emails.
- "marketing": Promotional emails — cold outreach, product launches, sales pitches, social media notifications, unsolicited promos.
- "spam": Deceptive cold emails, phishing attempts, scams, emails without unsubscribe links pretending to be personal, generic company names.

Current sender rules:
${rulesStr}

Your memory:
${memoryStr}

Recent user feedback to remember:
${feedbackStr}

When the user corrects a classification or asks you to learn a pattern, include action blocks that the system will execute:
<action>{"type":"upsert_rule","from_pattern":"...","category":"...","confidence":1.0}</action>
<action>{"type":"set_memory","key":"...","value":"..."}</action>
<action>{"type":"delete_rule","rule_id":"..."}</action>

Always explain what you learned. Be concise and helpful. Don't wrap actions in code blocks.`;
}

/**
 * Parse <action>...</action> blocks from assistant response and execute them.
 */
async function executeActions(
	db: D1Database,
	workspaceId: string,
	responseText: string,
): Promise<string[]> {
	const actionRegex = /<action>([\s\S]*?)<\/action>/g;
	const results: string[] = [];

	for (const match of responseText.matchAll(actionRegex)) {
		try {
			const action = JSON.parse(match[1]);
			switch (action.type) {
				case "upsert_rule": {
					// The user asked for this correction in chat, so it is a user rule
					// (global across domains, like every other rule).
					await upsertSenderRule(db, {
						from_pattern: action.from_pattern,
						category: action.category,
						confidence: action.confidence ?? 1.0,
					});
					results.push(`Created rule: ${action.from_pattern} → ${action.category}`);
					break;
				}
				case "set_memory": {
					await setAgentMemory(db, workspaceId, action.key, action.value);
					results.push(`Updated memory: ${action.key}`);
					break;
				}
				case "delete_rule": {
					await deleteSenderRule(db, action.rule_id);
					results.push(`Deleted rule: ${action.rule_id}`);
					break;
				}
				case "delete_memory": {
					await deleteAgentMemory(db, workspaceId, action.key);
					results.push(`Deleted memory: ${action.key}`);
					break;
				}
			}
		} catch (err) {
			logError("agent_action_failed", {
				error: err instanceof Error ? err.message : String(err),
				raw: match[1],
			});
		}
	}

	return results;
}

/**
 * Handle a chat message. Returns a ReadableStream of SSE events.
 */
export async function handleAgentChat(
	ctx: ChatContext,
	userMessage: string,
	context: {
		emailId?: string;
		conversationId?: string;
	} = {},
): Promise<ReadableStream> {
	const emailId = context.emailId;
	const conversationId = context.conversationId;

	// Save user message
	await insertAgentMessage(ctx.db, {
		workspace_id: ctx.workspaceId,
		role: "user",
		content: userMessage,
		email_id: emailId || null,
		message_type: "chat",
		metadata:
			emailId || conversationId
				? {
						...(emailId ? { email_id: emailId } : {}),
						...(conversationId ? { conversation_id: conversationId } : {}),
					}
				: null,
	});

	// Build context
	const [history, rules, memory, feedback] = await Promise.all([
		getAgentMessages(ctx.db, ctx.workspaceId, 20),
		getSenderRules(ctx.db),
		getAgentMemory(ctx.db, ctx.workspaceId),
		getRecentClassificationFeedback(ctx.db, ctx.workspaceId, 10),
	]);

	// Build messages array from history (last 20 messages)
	const messages: { role: "user" | "assistant"; content: string }[] = [];
	for (const msg of history) {
		if (msg.role === "user" || msg.role === "assistant") {
			messages.push({ role: msg.role, content: msg.content });
		}
	}

	// If there's an email context, add it to the latest user message
	let enrichedUserMessage = userMessage;
	if (emailId) {
		try {
			const result = await getEmailById(ctx.db, emailId, ctx.domainScope);
			if (result.email) {
				enrichedUserMessage = `[Regarding email from: ${result.email.from_address}, subject: "${result.email.subject || "(no subject)"}", current category: ${result.email.category || "uncategorized"}]\n\n${userMessage}`;
			}
		} catch {
			// Ignore email lookup failures
		}
	}

	// Replace the last user message with enriched version
	if (messages.length > 0 && messages[messages.length - 1].role === "user") {
		messages[messages.length - 1].content = enrichedUserMessage;
	}

	const systemPrompt = buildSystemPrompt(rules, memory, feedback);

	// Create SSE stream
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let fullResponse = "";

	const stream = new ReadableStream({
		async start(controller) {
			try {
				// The last check before history, rules, memory and the mail leave Cloudflare.
				if (!(await aiConsent(ctx.db)).allowed) throw new Error(CONSENT_REQUIRED.message);
				const chatRequestBody = {
					model: ctx.model,
					max_tokens: 500,
					temperature: 0.3,
					stream: true,
					system: systemPrompt,
					messages,
				};

				const response = await agentAiFetch(ctx, chatRequestBody, "chat");

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`AI provider request failed: ${response.status} ${errorText}`);
				}

				const reader = response.body?.getReader();
				if (!reader) {
					throw new Error("No response body from AI provider");
				}

				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });

					const lines = buffer.split("\n");
					// Keep the last incomplete line in the buffer
					buffer = lines.pop() || "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ")) continue;
						// Read the event type from the data itself: an `event:` line and
						// its `data:` line can arrive in different network chunks.
						try {
							const parsed = JSON.parse(trimmed.slice(6)) as {
								type?: string;
								delta?: { type?: string; text?: string };
							};
							if (
								parsed.type === "content_block_delta" &&
								parsed.delta?.type === "text_delta" &&
								parsed.delta.text
							) {
								const token = parsed.delta.text;
								fullResponse += token;
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token })}\n\n`));
							}
						} catch {
							// Skip malformed SSE lines
						}
					}
				}

				// Execute any actions in the response
				const actionResults = await executeActions(ctx.db, ctx.workspaceId, fullResponse);

				// Strip <action> blocks from the stored message
				const cleanResponse = fullResponse.replace(/<action>[\s\S]*?<\/action>/g, "").trim();

				// Save assistant response
				const saved = await insertAgentMessage(ctx.db, {
					workspace_id: ctx.workspaceId,
					role: "assistant",
					content: cleanResponse,
					email_id: emailId || null,
					message_type: "chat",
					metadata:
						emailId || conversationId
							? {
									...(emailId ? { email_id: emailId } : {}),
									...(conversationId ? { conversation_id: conversationId } : {}),
								}
							: null,
				});

				// Send done event
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ done: true, message_id: saved.id, actions: actionResults })}\n\n`,
					),
				);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logError("agent_chat_error", { error: errMsg });
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`));
			} finally {
				controller.close();
			}
		},
	});

	return stream;
}
