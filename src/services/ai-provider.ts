/** Hosted AI uses the customer's own hub endpoint and seat; the owner's existing path is unchanged. */
import { anthropicMessagesUrl } from "@/agent/anthropic";
import { type BillingConfig, reserveUsage, settleUsage, type UsageKind } from "@/services/ai-usage";

export interface MeteredProviderContext {
	db: D1Database;
	anthropicApiKey?: string;
	anthropicBaseUrl?: string;
	billing?: BillingConfig | null;
	hubUrl?: string;
	hubKey?: string;
	hubSeat?: string;
}
export async function agentAiFetch(
	ctx: MeteredProviderContext,
	body: { model: string; max_tokens: number; stream?: boolean; [k: string]: unknown },
	kind: UsageKind,
): Promise<Response> {
	const cfg = ctx.billing;
	if (cfg && !cfg.unlimited) return hostedAgentFetch(ctx, body, kind, cfg);
	const request = JSON.stringify(body);
	const url = anthropicMessagesUrl(ctx.anthropicBaseUrl);
	const id = crypto.randomUUID();
	if (cfg)
		await reserveUsage(ctx.db, cfg, {
			id,
			kind,
			model: body.model,
			inputBound: new TextEncoder().encode(request).length + 8192,
			outputBound: body.max_tokens,
		});
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"x-api-key": ctx.anthropicApiKey ?? "",
				"anthropic-version": "2023-06-01",
				"Content-Type": "application/json",
			},
			body: request,
		});
	} catch (e) {
		if (cfg) await settleUsage(ctx.db, cfg, id, "unknown");
		throw e;
	}
	if (!cfg) return response;
	if (!response.ok) {
		await settleUsage(
			ctx.db,
			cfg,
			id,
			[400, 401, 403, 404, 422, 429].includes(response.status) ? "failed" : "unknown",
			[400, 401, 403, 404, 422, 429].includes(response.status)
				? { input: 0, cached: 0, output: 0 }
				: undefined,
		);
		return response;
	}
	let complete = false;
	let input = 0,
		cached = 0,
		output = 0,
		seen = false,
		write = 0;
	const take = (v: Record<string, unknown>) => {
		if (v.type === "message_stop") complete = true;
		const message = v.message as { usage?: Record<string, number> } | undefined;
		const u = (v.usage ?? message?.usage) as Record<string, number> | undefined;
		if (!u) return;
		seen = true;
		// Anthropic reports uncached input separately from cache reads/writes.
		input = Math.max(input, u.input_tokens ?? 0);
		cached = Math.max(cached, u.cache_read_input_tokens ?? 0);
		write = Math.max(write, u.cache_creation_input_tokens ?? 0);
		output = Math.max(output, u.output_tokens ?? 0);
	};
	const finish = () =>
		settleUsage(
			ctx.db,
			cfg,
			id,
			seen && write === 0 && (!body.stream || complete) ? "settled" : "unknown",
			seen ? { input: input + cached + write, cached, output } : undefined,
		);
	if (!body.stream) {
		try {
			take((await response.clone().json()) as Record<string, unknown>);
			await finish();
		} catch {
			await settleUsage(ctx.db, cfg, id, "unknown");
		}
		return response;
	}
	const reader = response.body?.getReader();
	if (!reader) {
		await settleUsage(ctx.db, cfg, id, "unknown");
		return response;
	}
	const decoder = new TextDecoder();
	let pending = "";
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					if (pending.startsWith("data:")) {
						try {
							take(JSON.parse(pending.slice(5)));
						} catch {}
					}
					await finish();
					controller.close();
					return;
				}
				pending += decoder.decode(value, { stream: true });
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines)
					if (line.startsWith("data:")) {
						try {
							take(JSON.parse(line.slice(5)));
						} catch {}
					}
				if (pending.length > 1e6) throw new Error("AI stream event too large");
				controller.enqueue(value);
			} catch (e) {
				await settleUsage(
					ctx.db,
					cfg,
					id,
					"unknown",
					seen ? { input: input + cached + write, cached, output } : undefined,
				);
				controller.error(e);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				await settleUsage(
					ctx.db,
					cfg,
					id,
					"unknown",
					seen ? { input: input + cached + write, cached, output } : undefined,
				);
			}
		},
	});
	return new Response(stream, response);
}

/** Adapt the existing internal Messages-shaped callers to the one hosted Responses provider.
 * Buffer the bounded response before emitting chat events so usage settles even if the client leaves.
 * No Anthropic request/credential or second provider is used for a hosted customer.
 */
async function hostedAgentFetch(
	ctx: MeteredProviderContext,
	body: { model: string; max_tokens: number; stream?: boolean; [k: string]: unknown },
	kind: UsageKind,
	cfg: BillingConfig,
): Promise<Response> {
	if (!ctx.hubUrl || !ctx.hubKey || ctx.hubSeat !== `grip-${cfg.instance}`)
		throw new Error("Hosted AI requires its customer-dedicated hub URL, key and seat");
	const url = new URL(ctx.hubUrl);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash ||
		url.pathname.replace(/\/+$/, "") !== "/v1" ||
		!url.hostname.includes(".") ||
		["api.openai.com", "api.anthropic.com"].includes(url.hostname.replace(/\.$/, ""))
	)
		throw new Error("Hosted AI requires an isolated HTTPS hub /v1 endpoint");
	const messages = body.messages as { role: string; content: string }[];
	if (
		!Array.isArray(messages) ||
		messages.some((m) => !["user", "assistant"].includes(m.role) || typeof m.content !== "string")
	)
		throw new Error("Invalid hosted AI messages");
	const request = JSON.stringify({
		model: "gpt-6.1-sol",
		instructions: body.system,
		input: messages,
		max_output_tokens: body.max_tokens,
	});
	const id = crypto.randomUUID();
	await reserveUsage(ctx.db, cfg, {
		id,
		kind,
		model: "gpt-6.1-sol",
		inputBound: new TextEncoder().encode(request).length + 8192,
		outputBound: body.max_tokens,
	});
	let response: Response;
	try {
		response = await fetch(`${ctx.hubUrl.replace(/\/$/, "")}/responses`, {
			method: "POST",
			redirect: "error",
			headers: { Authorization: `Bearer ${ctx.hubKey}`, "Content-Type": "application/json" },
			body: request,
			signal: AbortSignal.timeout(120000),
		});
	} catch {
		await settleUsage(ctx.db, cfg, id, "unknown");
		throw new Error("Hosted AI request interrupted; usage reservation held");
	}
	if (!response.ok) {
		const zero = [400, 401, 403, 404, 422, 429].includes(response.status);
		await settleUsage(
			ctx.db,
			cfg,
			id,
			zero ? "failed" : "unknown",
			zero ? { input: 0, cached: 0, output: 0 } : undefined,
		);
		return new Response(null, { status: response.status });
	}
	let data: {
		output_text?: string;
		output?: { content?: { type: string; text?: string }[] }[];
		usage?: {
			input_tokens: number;
			input_tokens_details?: { cached_tokens?: number };
			output_tokens: number;
		};
	};
	try {
		data = await response.json();
		if (!data.usage) throw new Error("Missing usage");
		await settleUsage(ctx.db, cfg, id, "settled", {
			input: data.usage.input_tokens,
			cached: data.usage.input_tokens_details?.cached_tokens ?? 0,
			output: data.usage.output_tokens,
		});
	} catch {
		await settleUsage(ctx.db, cfg, id, "unknown");
		throw new Error("Hosted AI returned invalid usage; reservation held");
	}
	const text =
		data.output_text ??
		(data.output ?? [])
			.flatMap((o) => o.content ?? [])
			.filter((c) => c.type === "output_text")
			.map((c) => c.text ?? "")
			.join("");
	if (!body.stream) return Response.json({ content: [{ type: "text", text }] });
	const events = [
		{ type: "content_block_delta", delta: { type: "text_delta", text } },
		{ type: "message_stop" },
	];
	return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}
