import { createId } from "@paralleldrive/cuid2";
import type {
	AgentMemoryEntry,
	AgentMessage,
	AgentMessageMetadata,
	AgentMessageType,
	ClassificationFeedbackEntry,
	ClassificationFeedbackScope,
	ClassificationLogEntry,
	EmailCategory,
	SenderRule,
} from "@/types";
import { now } from "@/utils/helpers";

type Row = Record<string, unknown>;

function nullableString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

function parseJsonObject(value: unknown): AgentMessageMetadata {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.trim() === "") return null;

	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function serializeJson(value: AgentMessageMetadata | undefined): string | null {
	if (value === null || value === undefined) return null;
	return JSON.stringify(value);
}

function mapSenderRule(row: Row): SenderRule {
	return {
		id: String(row.id),
		domain: String(row.domain),
		from_pattern: String(row.from_pattern),
		category: String(row.category) as EmailCategory,
		confidence: Number(row.confidence),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

function mapAgentMessage(row: Row): AgentMessage {
	return {
		id: String(row.id),
		workspace_id: String(row.workspace_id),
		role: String(row.role) as AgentMessage["role"],
		content: String(row.content),
		email_id: nullableString(row.email_id),
		message_type: String(row.message_type ?? "chat") as AgentMessageType,
		metadata: parseJsonObject(row.metadata_json),
		created_at: Number(row.created_at),
	};
}

function mapClassificationFeedbackEntry(row: Row): ClassificationFeedbackEntry {
	return {
		id: String(row.id),
		workspace_id: String(row.workspace_id),
		email_id: String(row.email_id),
		from_address: String(row.from_address),
		domain: String(row.domain),
		previous_category: (row.previous_category as EmailCategory | null) ?? null,
		corrected_category: (row.corrected_category as EmailCategory | null) ?? null,
		user_comment: nullableString(row.user_comment),
		resolution_scope: (row.resolution_scope as ClassificationFeedbackScope | null) ?? null,
		agent_summary: nullableString(row.agent_summary),
		follow_up_question: nullableString(row.follow_up_question),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

function mapAgentMemoryEntry(row: Row): AgentMemoryEntry {
	return {
		key: String(row.key),
		workspace_id: String(row.workspace_id),
		value: String(row.value),
		updated_at: Number(row.updated_at),
	};
}

// --- Sender Rules ---
//
// One rule per from_pattern, global across every domain (owner decision, 2026-09-30: a sender
// correction applies in every served domain). `domain` is the sender's domain, kept for
// display only; matching never filters on it. Every rule is the owner's (UI, feedback, or a
// correction asked of chat), so the legacy `source` column is neither read nor
// written; new rows take its default 'user'.

export async function getSenderRules(db: D1Database): Promise<SenderRule[]> {
	const { results } = await db.prepare("SELECT * FROM sender_rules ORDER BY updated_at DESC").all();

	return (results as Row[]).map(mapSenderRule);
}

/** Exact sender first, then `*@<sender domain>` (from_pattern is UNIQUE since v53). */
export async function findSenderRule(
	db: D1Database,
	fromAddress: string,
): Promise<SenderRule | null> {
	const address = fromAddress.toLowerCase();
	const domain = address.split("@").pop() ?? "";

	for (const pattern of [address, `*@${domain}`]) {
		const row = await db
			.prepare("SELECT * FROM sender_rules WHERE from_pattern = ?")
			.bind(pattern)
			.first();
		if (row) return mapSenderRule(row as Row);
	}

	return null;
}

export async function upsertSenderRule(
	db: D1Database,
	rule: {
		from_pattern: string;
		category: EmailCategory;
		confidence: number;
	},
): Promise<{ success: boolean; id: string; error?: Error }> {
	try {
		const normalizedPattern = rule.from_pattern.trim().toLowerCase();
		const senderDomain = normalizedPattern.split("@").pop() ?? "";
		const timestamp = now();
		// One statement against the v53 UNIQUE index: two corrections for the same sender at
		// once both land on one row (the later wins) instead of one failing.
		const row = await db
			.prepare(
				`INSERT INTO sender_rules (id, domain, from_pattern, category, confidence, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(from_pattern) DO UPDATE SET
					 category = excluded.category,
					 confidence = excluded.confidence,
					 updated_at = excluded.updated_at
				 RETURNING id`,
			)
			.bind(
				createId(),
				senderDomain,
				normalizedPattern,
				rule.category,
				rule.confidence,
				timestamp,
				timestamp,
			)
			.first<{ id: string }>();

		if (!row)
			return { success: false, id: "", error: new Error("sender rule upsert returned no row") };
		return { success: true, id: row.id };
	} catch (e: unknown) {
		const id = "";
		return {
			success: false,
			id,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

export async function deleteSenderRule(
	db: D1Database,
	id: string,
): Promise<{ deleted: boolean; error?: Error }> {
	try {
		const result = await db.prepare("DELETE FROM sender_rules WHERE id = ?").bind(id).run();

		return { deleted: result.meta.changes > 0 };
	} catch (e: unknown) {
		return {
			deleted: false,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

// --- Agent Messages ---

export async function getAgentMessages(
	db: D1Database,
	workspaceId: string,
	limit = 50,
): Promise<AgentMessage[]> {
	const { results } = await db
		.prepare(
			`SELECT m.*, d.message_type, d.metadata_json
			 FROM agent_messages m
			 LEFT JOIN agent_message_metadata d ON d.message_id = m.id
			 WHERE m.workspace_id = ?
			 ORDER BY m.created_at DESC
			 LIMIT ?`,
		)
		.bind(workspaceId, limit)
		.all();

	return (results as Row[]).map(mapAgentMessage).reverse();
}

export async function insertAgentMessage(
	db: D1Database,
	msg: {
		workspace_id: string;
		role: "user" | "assistant" | "system";
		content: string;
		email_id?: string | null;
		message_type?: AgentMessageType;
		metadata?: AgentMessageMetadata;
	},
): Promise<{ success: boolean; id: string; error?: Error }> {
	try {
		const id = createId();
		const { success, error } = await db
			.prepare(
				`INSERT INTO agent_messages (id, workspace_id, role, content, email_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(id, msg.workspace_id, msg.role, msg.content, msg.email_id ?? null, now())
			.run();

		if (success) {
			await db
				.prepare(
					`INSERT OR REPLACE INTO agent_message_metadata
					 (message_id, workspace_id, message_type, metadata_json, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.bind(id, msg.workspace_id, msg.message_type || "chat", serializeJson(msg.metadata), now())
				.run();
		}

		return { success, id, error: error ? new Error(String(error)) : undefined };
	} catch (e: unknown) {
		return {
			success: false,
			id: "",
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

export async function clearAgentMessages(
	db: D1Database,
	workspaceId: string,
): Promise<{ success: boolean; error?: Error }> {
	try {
		await db
			.prepare("DELETE FROM agent_message_metadata WHERE workspace_id = ?")
			.bind(workspaceId)
			.run();
		const { success, error } = await db
			.prepare("DELETE FROM agent_messages WHERE workspace_id = ?")
			.bind(workspaceId)
			.run();

		return { success, error: error ? new Error(String(error)) : undefined };
	} catch (e: unknown) {
		return {
			success: false,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

// --- Agent Memory ---

export async function getAgentMemory(
	db: D1Database,
	workspaceId: string,
): Promise<AgentMemoryEntry[]> {
	const { results } = await db
		.prepare("SELECT * FROM agent_memory WHERE workspace_id = ? ORDER BY key")
		.bind(workspaceId)
		.all();

	return (results as Row[]).map(mapAgentMemoryEntry);
}

export async function setAgentMemory(
	db: D1Database,
	workspaceId: string,
	key: string,
	value: string,
): Promise<{ success: boolean; error?: Error }> {
	try {
		const { success, error } = await db
			.prepare(
				"INSERT OR REPLACE INTO agent_memory (key, workspace_id, value, updated_at) VALUES (?, ?, ?, ?)",
			)
			.bind(key, workspaceId, value, now())
			.run();

		return { success, error: error ? new Error(String(error)) : undefined };
	} catch (e: unknown) {
		return {
			success: false,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

export async function deleteAgentMemory(
	db: D1Database,
	workspaceId: string,
	key: string,
): Promise<{ deleted: boolean; error?: Error }> {
	try {
		const result = await db
			.prepare("DELETE FROM agent_memory WHERE key = ? AND workspace_id = ?")
			.bind(key, workspaceId)
			.run();

		return { deleted: result.meta.changes > 0 };
	} catch (e: unknown) {
		return {
			deleted: false,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

// --- Classification Feedback ---

export async function insertClassificationFeedback(
	db: D1Database,
	entry: {
		workspace_id: string;
		email_id: string;
		from_address: string;
		domain: string;
		previous_category: EmailCategory | null;
		corrected_category: EmailCategory | null;
		user_comment: string | null;
		resolution_scope: ClassificationFeedbackScope | null;
		agent_summary: string | null;
		follow_up_question: string | null;
	},
): Promise<{ success: boolean; id: string; error?: Error }> {
	try {
		const id = createId();
		const timestamp = now();
		const { success, error } = await db
			.prepare(
				`INSERT INTO classification_feedback
				 (id, workspace_id, email_id, from_address, domain, previous_category, corrected_category,
				  user_comment, resolution_scope, agent_summary, follow_up_question, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				entry.workspace_id,
				entry.email_id,
				entry.from_address,
				entry.domain,
				entry.previous_category,
				entry.corrected_category,
				entry.user_comment,
				entry.resolution_scope,
				entry.agent_summary,
				entry.follow_up_question,
				timestamp,
				timestamp,
			)
			.run();

		return { success, id, error: error ? new Error(String(error)) : undefined };
	} catch (e: unknown) {
		return {
			success: false,
			id: "",
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

export async function getRecentClassificationFeedback(
	db: D1Database,
	workspaceId: string,
	limit = 10,
): Promise<ClassificationFeedbackEntry[]> {
	const { results } = await db
		.prepare(
			`SELECT *
			 FROM classification_feedback
			 WHERE workspace_id = ?
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.bind(workspaceId, limit)
		.all();

	return (results as Row[]).map(mapClassificationFeedbackEntry);
}

/**
 * Get recent emails where the user set an interest level or left an interest comment.
 * These are formatted as context for the AI classifier so it can see past decisions.
 */
export async function getRecentInterestAnnotations(
	db: D1Database,
	domainScope: string[],
	limit = 15,
): Promise<
	{
		from_address: string;
		category: string | null;
		interest_level: string | null;
		interest_comment: string | null;
	}[]
> {
	const conditions: string[] = ["(interest_level IS NOT NULL OR interest_comment IS NOT NULL)"];
	const params: unknown[] = [];
	if (domainScope.length > 0) {
		conditions.push(`domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}
	params.push(limit);

	const { results } = await db
		.prepare(
			`SELECT from_address, category, interest_level, interest_comment
			 FROM emails
			 WHERE ${conditions.join(" AND ")}
			 ORDER BY received_at DESC
			 LIMIT ?`,
		)
		.bind(...params)
		.all();

	return (results ?? []) as {
		from_address: string;
		category: string | null;
		interest_level: string | null;
		interest_comment: string | null;
	}[];
}

// --- Classification Log ---

export async function insertClassificationLog(
	db: D1Database,
	entry: Omit<ClassificationLogEntry, "id" | "created_at">,
): Promise<{ success: boolean; error?: Error }> {
	try {
		const id = createId();
		const { success, error } = await db
			.prepare(
				`INSERT INTO classification_log (id, email_id, from_address, subject, category, previous_category, method, confidence, haiku_tokens_used, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				entry.email_id,
				entry.from_address,
				entry.subject ?? null,
				entry.category ?? null,
				entry.previous_category ?? null,
				entry.method,
				entry.confidence ?? null,
				entry.ai_tokens_used ?? null,
				now(),
			)
			.run();

		return { success, error: error ? new Error(String(error)) : undefined };
	} catch (e: unknown) {
		return {
			success: false,
			error: e instanceof Error ? e : new Error(String(e)),
		};
	}
}

/**
 * Get related emails the user has explicitly classified (via feedback).
 * Matches same sender first, then same domain. User decisions only.
 */
export async function getRelatedUserClassifiedEmails(
	db: D1Database,
	fromAddress: string,
	domainScope: string[],
	limit = 5,
): Promise<
	{
		from_address: string;
		subject: string | null;
		category: string | null;
		user_comment: string | null;
	}[]
> {
	const domain = fromAddress.split("@").pop() || "";
	const conditions: string[] = ["cf.corrected_category IS NOT NULL"];
	const params: unknown[] = [];
	if (domainScope.length > 0) {
		conditions.push(`cf.domain IN (${domainScope.map(() => "?").join(", ")})`);
		params.push(...domainScope);
	}

	// Prioritize: exact sender match first, then same domain
	const { results } = await db
		.prepare(
			`SELECT cf.from_address, e.subject, cf.corrected_category as category, cf.user_comment
			 FROM classification_feedback cf
			 LEFT JOIN emails e ON e.id = cf.email_id
			 WHERE ${conditions.join(" AND ")}
			   AND (cf.from_address = ? OR cf.domain = ?)
			 ORDER BY
			   CASE WHEN cf.from_address = ? THEN 0 ELSE 1 END,
			   cf.created_at DESC
			 LIMIT ?`,
		)
		.bind(...params, fromAddress, domain, fromAddress, limit)
		.all();

	return (results ?? []) as {
		from_address: string;
		subject: string | null;
		category: string | null;
		user_comment: string | null;
	}[];
}
