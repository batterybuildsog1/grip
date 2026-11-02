/** Per-instance prepaid ledger. All money is integer USD nanodollars (1 USD = 1e9).
 * Admission is one INSERT SELECT, so concurrent requests cannot spend the same funds.
 * A reservation never times out into a refund: an unknown provider outcome is operator work.
 */
import { aiConsent, CONSENT_CURRENT_SQL } from "@/services/ai-consent";

export const AI_PAUSED = "AI sorting paused: allowance used";
export type UsageKind = "classifier" | "chat" | "feedback";
export interface UsageTokens {
	input: number;
	cached: number;
	output: number;
}
export interface BillingConfig {
	instance: string;
	unlimited: boolean;
	allowance: number;
	rate: number;
}
export class AiBudgetError extends Error {}

export function billingConfig(env: Partial<CloudflareBindings>): BillingConfig | null {
	if (!env.AI_BILLING_MODE) return null; // Unset: self-hosted deployments keep unmetered behavior.
	if (!["unlimited", "metered"].includes(env.AI_BILLING_MODE))
		throw new Error("Invalid AI_BILLING_MODE");
	const instance = env.AI_INSTANCE_ID;
	const allowance = Number(env.AI_FREE_NANO ?? 2_234_500_000); // ~100 current-recipe messages.
	const rate = Number(env.AI_RATE_PPM ?? 115919); // Charge per API-equivalent cost, in parts per million (115919 = 11.59%); the operator sets AI_RATE_PPM.
	if (
		!instance ||
		!/^[a-z0-9_-]{1,80}$/.test(instance) ||
		!Number.isSafeInteger(allowance) ||
		allowance < 0 ||
		allowance > 1e12 ||
		(env.AI_BILLING_MODE === "metered" &&
			(!Number.isSafeInteger(rate) || rate < 1 || rate > 2_000_000))
	)
		throw new Error("Invalid AI billing configuration");
	return {
		instance,
		unlimited: env.AI_BILLING_MODE === "unlimited",
		allowance,
		rate: Number.isSafeInteger(rate) && rate > 0 ? rate : 0,
	};
}

export function tokenCost(model: string, t: UsageTokens): number {
	// OpenAI input INCLUDES cached tokens. Anthropic normalized likewise by the adapter.
	if (!["gpt-6.1-sol", "claude-sonnet-5-5"].includes(model)) throw new Error("Unpriced AI model");
	if (
		![t.input, t.cached, t.output].every((n) => Number.isSafeInteger(n) && n >= 0) ||
		t.cached > t.input ||
		t.input > 10_000_000 ||
		t.output > 1_000_000
	)
		throw new Error("Invalid AI usage");
	return (
		(t.input - t.cached) * 2000 +
		t.cached * (model === "gpt-6.1-sol" ? 100 : 200) +
		t.output * 10000
	);
}

export interface UsageRow {
	id: string;
	instance_id: string;
	month: string;
	status: string;
	input_bound: number;
	output_bound: number;
	reserved_nano: number;
	free_nano: number;
	paid_nano: number;
	rate_ppm: number;
	model: string;
	actual_nano: number | null;
}
export async function reserveUsage(
	db: D1Database,
	cfg: BillingConfig,
	call: {
		id: string;
		kind: UsageKind;
		model: string;
		inputBound: number;
		outputBound: number;
		lease?: string;
	},
	at = Date.now(),
): Promise<void> {
	if (
		!/^[a-zA-Z0-9_.:-]{1,160}$/.test(call.id) ||
		!Number.isInteger(call.inputBound) ||
		call.inputBound < 1 ||
		call.inputBound > 120000 ||
		!Number.isInteger(call.outputBound) ||
		call.outputBound < 1 ||
		call.outputBound > 8192
	)
		throw new Error("Invalid AI reservation bounds");
	if (!cfg.unlimited && call.model !== "gpt-6.1-sol")
		throw new Error("Hosted AI requires gpt-6.1-sol");
	const cost = tokenCost(call.model, {
		input: call.inputBound,
		cached: 0,
		output: call.outputBound,
	});
	const consent = await aiConsent(db);
	if (!consent.allowed || consent.epoch === null) throw new Error("AI sorting is off");
	const month = new Date(at).toISOString().slice(0, 7);
	const result = await db
		.prepare(`WITH funds AS (
	 SELECT MAX(0, ?-COALESCE((SELECT SUM(free_nano) FROM ai_usage WHERE instance_id=? AND month=?),0)) AS available,
	 COALESCE((SELECT SUM(amount_nano) FROM ai_credits WHERE instance_id=?),0)-COALESCE((SELECT SUM(paid_nano) FROM ai_usage WHERE instance_id=?),0) AS credit
	), allocation AS (SELECT MIN(?,available) AS free,credit FROM funds)
	INSERT INTO ai_usage(id,instance_id,month,kind,lease_token,model,status,input_bound,output_bound,reserved_nano,free_nano,paid_nano,rate_ppm,created_at)
	SELECT ?,?,?,?,?,?,'reserved',?,?,?,CASE WHEN ?=1 THEN 0 ELSE free END,CASE WHEN ?=1 THEN 0 ELSE CAST(((?-free)*?+999999)/1000000 AS INTEGER) END,?,? FROM allocation
	WHERE (?=1 OR credit>=CAST(((?-free)*?+999999)/1000000 AS INTEGER)) AND ${CONSENT_CURRENT_SQL}
	AND (? IS NULL OR EXISTS(SELECT 1 FROM emails WHERE classify_leased_by=? AND classify_lease_until>?))
	ON CONFLICT(id) DO NOTHING`)
		.bind(
			cfg.allowance,
			cfg.instance,
			month,
			cfg.instance,
			cfg.instance,
			cost,
			call.id,
			cfg.instance,
			month,
			call.kind,
			call.lease ?? null,
			call.model,
			call.inputBound,
			call.outputBound,
			cost,
			// Unlimited still records cost, with zero allowance/credit consumption.
			// Allocation stays inside this atomic statement.
			cfg.unlimited ? 1 : 0,
			cfg.unlimited ? 1 : 0,
			cost,
			cfg.rate,
			cfg.unlimited ? 0 : cfg.rate,
			at,
			cfg.unlimited ? 1 : 0,
			cost,
			cfg.rate,
			consent.epoch,
			call.lease ?? null,
			call.lease ?? null,
			at,
		)
		.run();
	if (!result.meta.changes) {
		const old = await db.prepare("SELECT id FROM ai_usage WHERE id=?").bind(call.id).first();
		if (old) throw new Error("AI_CALL_EXISTS");
		throw new AiBudgetError(AI_PAUSED);
	}
}

export async function settleUsage(
	db: D1Database,
	cfg: BillingConfig,
	id: string,
	outcome: "settled" | "failed" | "unknown",
	tokens?: UsageTokens,
): Promise<void> {
	const row = await db
		.prepare("SELECT * FROM ai_usage WHERE id=? AND instance_id=?")
		.bind(id, cfg.instance)
		.first<UsageRow>();
	if (!row) throw new Error("AI call not found");
	if (row.status !== "reserved" && row.status !== "unknown") return;
	if (outcome === "unknown" || !tokens) {
		if (tokens) {
			const partial = tokenCost(row.model, tokens);
			await db
				.prepare(
					"UPDATE ai_usage SET status='unknown',input_tokens=?,cached_tokens=?,output_tokens=?,actual_nano=? WHERE id=? AND status IN ('reserved','unknown')",
				)
				.bind(tokens.input, tokens.cached, tokens.output, partial, id)
				.run();
		} else
			await db
				.prepare("UPDATE ai_usage SET status='unknown' WHERE id=? AND status='reserved'")
				.bind(id)
				.run();
		return;
	}
	const actual = tokenCost(row.model, tokens),
		free = row.rate_ppm === 0 ? 0 : Math.min(actual, row.free_nano);
	const paid =
		row.rate_ppm === 0 ? 0 : Math.ceil((Math.max(0, actual - free) * row.rate_ppm) / 1e6);
	await db
		.prepare(
			`UPDATE ai_usage SET status=?,input_tokens=?,cached_tokens=?,output_tokens=?,actual_nano=?,free_nano=?,paid_nano=?,settled_at=?,overrun=? WHERE id=? AND status IN ('reserved','unknown')`,
		)
		.bind(
			outcome,
			tokens.input,
			tokens.cached,
			tokens.output,
			actual,
			free,
			paid,
			Date.now(),
			actual > row.reserved_nano ? 1 : 0,
			id,
		)
		.run();
}

export async function usageStatement(
	db: D1Database,
	cfg: BillingConfig,
	month = new Date().toISOString().slice(0, 7),
	includeCalls = true,
) {
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid month; use YYYY-MM");
	const totals = await db
		.prepare(
			`SELECT COALESCE(SUM(free_nano),0) free,COALESCE(SUM(input_tokens),0) input,COALESCE(SUM(cached_tokens),0) cached,COALESCE(SUM(output_tokens),0) output,COALESCE(SUM(actual_nano),0) actual,COALESCE(SUM(paid_nano),0) paid,SUM(CASE WHEN status IN ('reserved','unknown') THEN 1 ELSE 0 END) unresolved FROM ai_usage WHERE instance_id=? AND month=?`,
		)
		.bind(cfg.instance, month)
		.first<Record<string, number>>();
	const calls = includeCalls
		? (
				await db
					.prepare("SELECT * FROM ai_usage WHERE instance_id=? AND month=? ORDER BY created_at,id")
					.bind(cfg.instance, month)
					.all<Record<string, unknown>>()
			).results
		: [];
	const credit = await db
		.prepare(
			"SELECT COALESCE((SELECT SUM(amount_nano) FROM ai_credits WHERE instance_id=?),0)-COALESCE((SELECT SUM(paid_nano) FROM ai_usage WHERE instance_id=?),0) AS balance",
		)
		.bind(cfg.instance, cfg.instance)
		.first<{ balance: number }>();
	const credits = includeCalls
		? (
				await db
					.prepare(
						"SELECT * FROM ai_credits WHERE instance_id=? AND strftime('%Y-%m',created_at/1000,'unixepoch')=? ORDER BY created_at,id",
					)
					.bind(cfg.instance, month)
					.all()
			).results
		: [];
	const freeRemaining = Math.max(0, cfg.allowance - (totals?.free ?? 0)),
		balance = credit?.balance ?? 0;
	return {
		instance_id: cfg.instance,
		month,
		currency: "USD",
		money_unit: "nanodollar",
		unlimited: cfg.unlimited,
		allowance_nano: cfg.allowance,
		free_remaining_nano: freeRemaining,
		credit_balance_nano: balance,
		input_tokens: totals?.input ?? 0,
		cached_tokens: totals?.cached ?? 0,
		output_tokens: totals?.output ?? 0,
		api_equivalent_nano: totals?.actual ?? 0,
		prepaid_spent_or_held_nano: totals?.paid ?? 0,
		unresolved_calls: totals?.unresolved ?? 0,
		ai_sorting_state:
			!cfg.unlimited && freeRemaining <= 0 && balance <= 0 ? "allowance_used" : "active",
		calls,
		credits,
	};
}
