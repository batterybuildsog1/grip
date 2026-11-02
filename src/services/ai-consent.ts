/**
 * AI consent (release 1.0, SPEC §2; v64 `ai_consent_decisions`).
 *
 * One mail owner per instance: the users rows with owner_key 'all'. Their newest decision is the
 * instance's, regardless of version. No row means ON (owner decision, 2026-10-30); a declined row
 * stays OFF. A missing table or D1 error fails closed. The default is not an inserted decision.
 *
 * Every path that sends mail or trip data outside Cloudflare asks `aiConsent()` right before the
 * data leaves: the classifier claim/results (src/routes/classifier.ts), chat (src/agent/chat.ts),
 * AI feedback analysis (src/agent/feedback.ts) and named Mileage agents (src/mileage/routes.ts).
 * The newest row's id is the consent epoch: a classifier lease carries the epoch it was made
 * under, and any newer decision (a withdrawal, or a withdrawal then a re-grant) voids it.
 */
import { FULL_MAILBOX_OWNER, type SessionUser } from "@/auth/principal";
import { logWarn } from "@/utils/logging";

/**
 * Settings API version retained for older clients. Versions never invalidate stored decisions.
 * PUT accepts any integer client version; stored decisions use this server version.
 */
export const CONSENT_VERSION = 1;

export type ConsentState = "allowed" | "declined";

export interface ConsentDecision {
	epoch: number;
	state: "allowed" | "declined";
	version: number;
	decided_at: number;
	user_id: string;
	user_email: string;
}

/** The newest decision, or null when there is none. Throws when D1 or the table fails. */
export async function latestDecision(db: D1Database): Promise<ConsentDecision | null> {
	const row = await db
		.prepare(
			`SELECT id, state, version, decided_at, user_id, user_email
			 FROM ai_consent_decisions ORDER BY id DESC LIMIT 1`,
		)
		.first<Record<string, unknown>>();
	if (!row) return null;
	const state = row.state === "allowed" ? "allowed" : "declined";
	return {
		epoch: Number(row.id),
		state,
		version: Number(row.version),
		decided_at: Number(row.decided_at),
		user_id: String(row.user_id),
		user_email: String(row.user_email),
	};
}

/** The owner's latest switch setting, or the default On when no decision exists. */
export function consentState(decision: ConsentDecision | null): ConsentState {
	return decision?.state ?? "allowed";
}

/**
 * The gate. No row is allowed at epoch 0; otherwise the newest decision wins at any version.
 * Anything unreadable is off. `epoch` is null when off. A first decision fences epoch-0 leases.
 */
export async function aiConsent(
	db: D1Database,
): Promise<{ allowed: boolean; epoch: number | null }> {
	try {
		const decision = await latestDecision(db);
		return consentState(decision) === "allowed"
			? { allowed: true, epoch: decision?.epoch ?? 0 }
			: { allowed: false, epoch: null };
	} catch (error) {
		logWarn("ai_consent_unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { allowed: false, epoch: null };
	}
}

/** SQL fence: epoch 0 only while no decision exists; otherwise the latest row must allow. Binds 1. */
export const CONSENT_CURRENT_SQL = `(? = COALESCE((SELECT MAX(id) FROM ai_consent_decisions), 0)
	AND COALESCE((SELECT state FROM ai_consent_decisions ORDER BY id DESC LIMIT 1), 'allowed') = 'allowed')`;
export const consentCurrentParams = (epoch: number) => [epoch];

/** Only the mailbox owner's rows decide (SPEC §2). */
export function canDecide(user: SessionUser | null): boolean {
	return user?.owner_key === FULL_MAILBOX_OWNER;
}

/**
 * Statements that record a decision. A withdrawal also releases every classifier lease in the
 * same batch, so no batch leased under the old grant can write.
 */
export function decisionStatements(
	db: D1Database,
	input: {
		allow: boolean;
		userId: string;
		email: string;
		source: "owner" | "account_deletion";
		now: number;
	},
): D1PreparedStatement[] {
	const statements = [
		db
			.prepare(
				`INSERT INTO ai_consent_decisions (state, version, decided_at, user_id, user_email, source)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.allow ? "allowed" : "declined",
				CONSENT_VERSION,
				input.now,
				input.userId,
				input.email,
				input.source,
			),
	];
	if (!input.allow) statements.push(releaseAllLeases(db));
	return statements;
}

/** Every outstanding classifier lease ends (partial index v51 keeps this small). */
export function releaseAllLeases(db: D1Database): D1PreparedStatement {
	return db.prepare(
		`UPDATE emails SET classify_lease_until = NULL, classify_leased_by = NULL
		 WHERE classify_leased_by IS NOT NULL`,
	);
}

/** The 403 every gated path answers while consent is off. */
export const CONSENT_REQUIRED = {
	code: "AI_CONSENT_REQUIRED",
	message: "AI sorting is off",
} as const;

/** Lease tokens carry their epoch: `<epoch>.<uuid>`. */
export function leaseTokenFor(epoch: number): string {
	return `${epoch}.${crypto.randomUUID()}`;
}

export function epochOfLease(token: string): number | null {
	const match = /^(\d+)\./.exec(token);
	return match ? Number(match[1]) : null;
}
