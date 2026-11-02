/**
 * Memory map queries (v52): entities, email tags, `about` thread connection, the sorter's tag
 * writes and the daily "Owner writes" refresh. (There is no entity proposal queue: the map
 * changes only through direct edits.)
 * Plan: docs/codebase-design-2026-09-29/memory-map-plan.md. Pure logic: src/services/memory-map.ts.
 *
 * Every function works before v52 is applied: a missing table raises MemoryMapUnavailable,
 * which routes turn into 503 MEMORY_MAP_UNAVAILABLE and the sorter paths log and skip.
 */

import {
	ADDRESS_FIELDS,
	addressMatches,
	checkAlias,
	checkEntityAddress,
	checkName,
	checkNotes,
	computeOwnerThreads,
	containsPhrase,
	ENTITY_ID_RE,
	type Entity,
	type EntityKind,
	type EvidenceSource,
	emailAddressesByField,
	entityIdFor,
	entityPhrases,
	isProblem,
	nameKey,
	normalizeText,
	type Problem,
	parseEnrichment,
	problem,
	type SentRow,
	validateGraph,
	verifyTag,
} from "@/services/memory-map";
import { now } from "@/utils/helpers";

type Row = Record<string, unknown>;

export class MemoryMapUnavailable extends Error {
	constructor(cause: unknown) {
		super(`memory map tables are missing (v52 not applied): ${errorText(cause)}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingTable(error: unknown): boolean {
	return /no such table: (entities|email_entities)/i.test(errorText(error));
}

/** Run a query; a missing v52 table becomes MemoryMapUnavailable. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (isMissingTable(error)) throw new MemoryMapUnavailable(error);
		throw error;
	}
}

function parseList(value: unknown): string[] {
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function rowToEntity(row: Row): Entity {
	return {
		id: String(row.id),
		kind: String(row.kind) as EntityKind,
		name: String(row.name),
		name_key: String(row.name_key),
		aliases: parseList(row.aliases_json),
		addresses: parseList(row.addresses_json),
		parent_id: row.parent_id == null ? null : String(row.parent_id),
		notes: row.notes == null ? null : String(row.notes),
		source: String(row.source) as Entity["source"],
		owner_threads_12m: Number(row.owner_threads_12m ?? 0),
		updated_at: Number(row.updated_at ?? 0),
	};
}

export function publicEntity(entity: Entity) {
	const { name_key: _key, ...rest } = entity;
	return rest;
}

/** The whole map: small by design (people, companies and projects one person tracks). */
export async function loadEntities(db: D1Database): Promise<Entity[]> {
	return guarded(async () => {
		const { results } = await db.prepare("SELECT * FROM entities ORDER BY id").all<Row>();
		return (results ?? []).map(rowToEntity);
	});
}

// ---------------------------------------------------------------------------
// Resolution: "<name|alias|address|id>" -> entity
// ---------------------------------------------------------------------------

/**
 * Candidates for a query, most specific step first: id, exact address, name or alias, @domain
 * owner, then a partial name/alias phrase. One candidate resolves; several are ambiguous.
 */
export function resolveEntityQuery(entities: Entity[], query: string): Entity[] {
	const q = query.trim();
	if (!q) return [];
	const byId = entities.find((e) => e.id === q);
	if (byId) return [byId];
	const lower = q.toLowerCase();
	if (lower.includes("@")) {
		const exact = entities.filter((e) => e.addresses.includes(lower));
		if (exact.length > 0) return exact;
		const owners = entities.filter((e) => e.addresses.some((a) => addressMatches(a, lower)));
		if (owners.length > 0) return owners;
	}
	const key = nameKey(q);
	if (!key) return [];
	const named = entities.filter(
		(e) => e.name_key === key || e.aliases.some((alias) => nameKey(alias) === key),
	);
	if (named.length > 0) return named;
	return entities.filter((e) => entityPhrases(e).some((phrase) => containsPhrase(phrase, key)));
}

// ---------------------------------------------------------------------------
// about: threads connected to an entity and its direct children (plan §4)
// ---------------------------------------------------------------------------

const EMAIL_COLUMNS = `e.id, e.thread_id, e.subject, e.from_address, e.from_name, e.to_address,
	e.to_addresses_json, e.cc_addresses_json, e.reply_to_addresses_json, e.list_unsubscribe,
	e.received_at, e.message_id, e.mailbox_state, e.domain`;
/** Candidate rows per query; every candidate is re-checked in JS. */
const ABOUT_CANDIDATE_LIMIT = 2000;

interface AboutRow {
	id: string;
	thread_id: string | null;
	subject: string | null;
	from_address: string | null;
	to_address: string | null;
	to_addresses_json: string | null;
	cc_addresses_json: string | null;
	reply_to_addresses_json: string | null;
	list_unsubscribe: string | null;
	received_at: number;
	message_id: string | null;
	mailbox_state: string;
	domain: string;
}

function toAboutRow(row: Row): AboutRow {
	const text = (v: unknown) => (v == null ? null : String(v));
	return {
		id: String(row.id),
		thread_id: text(row.thread_id),
		subject: text(row.subject),
		from_address: text(row.from_address),
		to_address: text(row.to_address),
		to_addresses_json: text(row.to_addresses_json),
		cc_addresses_json: text(row.cc_addresses_json),
		reply_to_addresses_json: text(row.reply_to_addresses_json),
		list_unsubscribe: text(row.list_unsubscribe),
		received_at: Number(row.received_at ?? 0),
		message_id: text(row.message_id),
		mailbox_state: String(row.mailbox_state ?? ""),
		domain: String(row.domain ?? ""),
	};
}

export interface ThreadEvidence {
	via: "tag" | "address" | "subject";
	entity_id: string;
	field: string;
	text: string | null;
	source?: "user" | "model";
}

interface Hit extends ThreadEvidence {
	row: AboutRow;
}

const VIA_RANK = { tag: 0, address: 1, subject: 2 } as const;

function threadKey(row: { id: string; thread_id: string | null }): string {
	return row.thread_id ?? `email:${row.id}`;
}

/** An FTS5 phrase from free text; only [a-z0-9] tokens survive, so nothing needs escaping. */
function ftsPhrase(text: string): string | null {
	const tokens = normalizeText(text);
	return tokens ? `"${tokens}"` : null;
}

/** One logical message: its Message-ID, else sender + subject + minute (duplicate copies). */
function messageKeyFor(row: {
	message_id: string | null;
	from_address: string | null;
	subject: string | null;
	received_at: number;
}): string {
	return (
		row.message_id ??
		`${row.from_address}|${normalizeText(row.subject)}|${Math.floor(row.received_at / 60_000)}`
	);
}

/** Thread ids per totals query: with a few domains and `since`, well under D1's 100 parameters. */
const THREAD_CHUNK = 80;

export async function getEntityThreads(
	db: D1Database,
	entity: Entity,
	entities: Entity[],
	options: { limit: number; since: number | null; domains: string[] },
) {
	const members = [entity, ...entities.filter((e) => e.parent_id === entity.id)];
	const since = options.since ?? 0;

	// 1+2. One FTS query: recipient/sender columns for addresses, subject for names (review #:
	// candidates only, each re-checked below).
	const addressPhrases = [
		...new Set(
			members
				.flatMap((m) => m.addresses)
				.map((a) => ftsPhrase(a.startsWith("@") ? a.slice(1) : a))
				.filter(Boolean),
		),
	];
	const namePhrases = [...new Set(members.flatMap((m) => entityPhrases(m)).map((p) => `"${p}"`))];
	const clauses: string[] = [];
	if (addressPhrases.length > 0) {
		clauses.push(
			`({from_address to_address to_addresses_json cc_addresses_json reply_to_addresses_json}: (${addressPhrases.join(" OR ")}))`,
		);
	}
	if (namePhrases.length > 0) clauses.push(`({subject}: (${namePhrases.join(" OR ")}))`);

	const scopeSql =
		options.domains.length > 0
			? ` AND e.domain IN (${options.domains.map(() => "?").join(", ")})`
			: "";
	const ftsRows: AboutRow[] = [];
	if (clauses.length > 0) {
		const { results } = await db
			.prepare(
				`SELECT ${EMAIL_COLUMNS}
				 FROM emails_fts JOIN emails e ON e.rowid = emails_fts.rowid
				 WHERE emails_fts MATCH ?
				   AND e.mailbox_state NOT IN ('draft', 'trash')
				   AND e.received_at >= ?${scopeSql}
				 ORDER BY e.received_at DESC
				 LIMIT ${ABOUT_CANDIDATE_LIMIT}`,
			)
			.bind(clauses.join(" OR "), since, ...options.domains)
			.all<Row>();
		for (const row of results ?? []) ftsRows.push(toAboutRow(row));
	}

	// 3. The user's thread rejections in their own uncapped query, so no limit can drop one, then
	// linked tags newest first. Members by subquery: no D1 bound-parameter limit (100) applies.
	const memberSql = "SELECT id FROM entities WHERE id = ? OR parent_id = ?";
	const [rejectedResult, tagResult] = await guarded(() =>
		db.batch([
			db
				.prepare(
					`SELECT ee.entity_id, e.id, e.thread_id
					 FROM email_entities ee JOIN emails e ON e.id = ee.email_id
					 WHERE ee.entity_id IN (${memberSql}) AND ee.state = 'rejected' AND ee.source = 'user'`,
				)
				.bind(entity.id, entity.id),
			db
				.prepare(
					`SELECT ee.entity_id, ee.source, ee.evidence_field, ee.evidence_text, ${EMAIL_COLUMNS}
					 FROM email_entities ee JOIN emails e ON e.id = ee.email_id
					 WHERE ee.entity_id IN (${memberSql}) AND ee.state = 'linked'
					   AND e.mailbox_state NOT IN ('draft', 'trash')
					   AND e.received_at >= ?${scopeSql}
					 ORDER BY ee.created_at DESC
					 LIMIT ${ABOUT_CANDIDATE_LIMIT}`,
				)
				.bind(entity.id, entity.id, since, ...options.domains),
		]),
	);

	const rejected = new Map<string, Set<string>>();
	for (const raw of (rejectedResult.results ?? []) as Row[]) {
		const entityId = String(raw.entity_id);
		const set = rejected.get(entityId) ?? new Set<string>();
		set.add(
			threadKey({
				id: String(raw.id),
				thread_id: raw.thread_id == null ? null : String(raw.thread_id),
			}),
		);
		rejected.set(entityId, set);
	}
	const hits: Hit[] = [];
	for (const raw of (tagResult.results ?? []) as Row[]) {
		hits.push({
			row: toAboutRow(raw),
			via: "tag",
			entity_id: String(raw.entity_id),
			field: raw.evidence_field == null ? "link" : String(raw.evidence_field),
			text: raw.evidence_text == null ? null : String(raw.evidence_text),
			source: raw.source === "user" ? "user" : "model",
		});
	}

	for (const row of ftsRows) {
		const byField = emailAddressesByField(row);
		const subject = normalizeText(row.subject);
		for (const member of members) {
			let addressHit: Hit | null = null;
			for (const field of ADDRESS_FIELDS) {
				for (const candidate of byField[field]) {
					const owner = member.addresses.find((a) => addressMatches(a, candidate));
					// A domain match on bulk mail (List-Unsubscribe) is a newsletter, not a relationship.
					if (!owner || (owner.startsWith("@") && row.list_unsubscribe)) continue;
					addressHit ??= { row, via: "address", entity_id: member.id, field, text: candidate };
				}
			}
			if (addressHit) hits.push(addressHit);
			const phrase = [member.name, ...member.aliases].find((p) =>
				containsPhrase(subject, normalizeText(p)),
			);
			if (phrase)
				hits.push({ row, via: "subject", entity_id: member.id, field: "subject", text: phrase });
		}
	}

	// Thread-scoped corrections (review #): rejecting X hides the thread from X; a child's
	// own matches are hidden only by a rejection of that child.
	const visible = hits.filter((hit) => {
		const key = threadKey(hit.row);
		return !rejected.get(entity.id)?.has(key) && !rejected.get(hit.entity_id)?.has(key);
	});

	interface ThreadAcc {
		thread_id: string;
		subject: string | null;
		last_at: number;
		latest_email_id: string;
		messageKeys: Set<string>;
		via: Set<string>;
		evidence: ThreadEvidence;
	}
	const threads = new Map<string, ThreadAcc>();
	for (const hit of visible) {
		const key = threadKey(hit.row);
		const messageKey = messageKeyFor(hit.row);
		const { row: _row, ...evidence } = hit;
		let acc = threads.get(key);
		if (!acc) {
			acc = {
				thread_id: key,
				subject: hit.row.subject,
				last_at: hit.row.received_at,
				latest_email_id: hit.row.id,
				messageKeys: new Set(),
				via: new Set(),
				evidence,
			};
			threads.set(key, acc);
		}
		acc.messageKeys.add(messageKey);
		acc.via.add(hit.via);
		if (hit.row.received_at > acc.last_at) {
			acc.last_at = hit.row.received_at;
			acc.subject = hit.row.subject;
			acc.latest_email_id = hit.row.id;
		}
		if (VIA_RANK[hit.via] < VIA_RANK[acc.evidence.via]) acc.evidence = evidence;
	}

	// Thread totals over every message of a connected thread, not only the matching ones: a later
	// reply that names nobody still counts and still moves last_at.
	const keys = [...threads.keys()].filter((key) => !key.startsWith("email:"));
	const chunks: string[][] = [];
	for (let i = 0; i < keys.length; i += THREAD_CHUNK) chunks.push(keys.slice(i, i + THREAD_CHUNK));
	const totals = chunks.length
		? await db.batch(
				chunks.map((chunk) =>
					db
						.prepare(
							`SELECT e.id, e.thread_id, e.subject, e.from_address, e.message_id, e.received_at
							 FROM emails e
							 WHERE e.thread_id IN (${chunk.map(() => "?").join(", ")})
							   AND e.mailbox_state NOT IN ('draft', 'trash')
							   AND e.received_at >= ?${scopeSql}`,
						)
						.bind(...chunk, since, ...options.domains),
				),
			)
		: [];
	for (const result of totals) {
		for (const raw of (result.results ?? []) as Row[]) {
			const acc = threads.get(String(raw.thread_id));
			if (!acc) continue;
			const receivedAt = Number(raw.received_at ?? 0);
			acc.messageKeys.add(
				messageKeyFor({
					message_id: raw.message_id == null ? null : String(raw.message_id),
					from_address: raw.from_address == null ? null : String(raw.from_address),
					subject: raw.subject == null ? null : String(raw.subject),
					received_at: receivedAt,
				}),
			);
			if (receivedAt > acc.last_at) {
				acc.last_at = receivedAt;
				acc.subject = raw.subject == null ? null : String(raw.subject);
				acc.latest_email_id = String(raw.id);
			}
		}
	}

	const sorted = [...threads.values()].sort((a, b) => b.last_at - a.last_at);
	const parent = entity.parent_id ? entities.find((e) => e.id === entity.parent_id) : undefined;
	return {
		entity: publicEntity(entity),
		parent: parent ? { id: parent.id, kind: parent.kind, name: parent.name } : null,
		members: members.slice(1).map((m) => ({ id: m.id, kind: m.kind, name: m.name })),
		latest_activity_at: sorted[0]?.last_at ?? null,
		total_threads: sorted.length,
		candidates_capped:
			ftsRows.length >= ABOUT_CANDIDATE_LIMIT ||
			(tagResult.results ?? []).length >= ABOUT_CANDIDATE_LIMIT,
		threads: sorted.slice(0, options.limit).map((t) => ({
			thread_id: t.thread_id,
			subject: t.subject,
			last_at: t.last_at,
			latest_email_id: t.latest_email_id,
			messages: t.messageKeys.size,
			via: [...t.via].sort((a, b) => VIA_RANK[a as Hit["via"]] - VIA_RANK[b as Hit["via"]]),
			evidence: t.evidence,
		})),
	};
}

// ---------------------------------------------------------------------------
// Writes: set, delete, import (user and seed rows; the sorter never writes entities)
// ---------------------------------------------------------------------------

export interface EntityPatch {
	kind?: EntityKind;
	name?: string;
	aliases_add?: string[];
	aliases_remove?: string[];
	addresses_add?: string[];
	addresses_remove?: string[];
	parent_id?: string | null;
	notes?: string | null;
}

function upsertEntityStatement(db: D1Database, entity: Entity, parentId: string | null) {
	return db
		.prepare(
			`INSERT INTO entities (id, kind, name, name_key, aliases_json, addresses_json, parent_id,
			   notes, source, owner_threads_12m, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
			   name_key = excluded.name_key, aliases_json = excluded.aliases_json,
			   addresses_json = excluded.addresses_json, parent_id = excluded.parent_id,
			   notes = excluded.notes, updated_at = excluded.updated_at`,
		)
		.bind(
			entity.id,
			entity.kind,
			entity.name,
			entity.name_key,
			JSON.stringify(entity.aliases),
			JSON.stringify(entity.addresses),
			parentId,
			entity.notes,
			entity.source,
			entity.owner_threads_12m,
			entity.updated_at,
		);
}

function mergeAliases(
	current: string[],
	add: string[],
	remove: string[],
	name: string,
): { aliases: string[]; added: string[]; removed: string[] } | Problem {
	const removeKeys = new Set(remove.map(nameKey));
	const kept = current.filter((a) => !removeKeys.has(nameKey(a)));
	const removed = current.filter((a) => removeKeys.has(nameKey(a)));
	const keys = new Set([nameKey(name), ...kept.map(nameKey)]);
	const added: string[] = [];
	for (const raw of add) {
		const alias = checkAlias(raw);
		if (isProblem(alias)) return alias;
		if (keys.has(nameKey(alias))) continue;
		keys.add(nameKey(alias));
		added.push(alias);
	}
	return { aliases: [...kept, ...added], added, removed };
}

function mergeAddresses(
	current: string[],
	add: string[],
	remove: string[],
	ownDomains: string[],
): { addresses: string[]; added: string[]; removed: string[] } | Problem {
	const removeSet = new Set(remove.map((a) => a.trim().toLowerCase()));
	const kept = current.filter((a) => !removeSet.has(a));
	const removed = current.filter((a) => removeSet.has(a));
	const added: string[] = [];
	for (const raw of add) {
		const address = checkEntityAddress(raw, ownDomains);
		if (isProblem(address)) return address;
		if (kept.includes(address) || added.includes(address)) continue;
		added.push(address);
	}
	return { addresses: [...kept, ...added], added, removed };
}

/**
 * Guards that make a write batch fail (and roll back) when the map changed after it was read
 * and validated: json() on a non-JSON string raises, aborting the D1 batch. Every guard error is
 * answered with 409 MAP_CHANGED (retry), never a half-applied edit (review #2).
 */
const GUARD_ERROR = /malformed JSON|UNIQUE constraint failed/i;

function guardStatement(db: D1Database, sql: string, ...params: unknown[]) {
	return db.prepare(`SELECT CASE WHEN ${sql} THEN json('map changed') ELSE 1 END`).bind(...params);
}

/** The entity row is exactly as read (updated_at unchanged), or still absent for a create. */
function rowGuard(db: D1Database, id: string, existing: Entity | undefined) {
	return existing
		? guardStatement(
				db,
				"(SELECT updated_at FROM entities WHERE id = ?) IS NOT ?",
				id,
				existing.updated_at,
			)
		: guardStatement(db, "EXISTS (SELECT 1 FROM entities WHERE id = ?)", id);
}

/** No other entity took this address since the read. */
function addressGuard(db: D1Database, address: string, ownerId: string) {
	return guardStatement(
		db,
		`EXISTS (SELECT 1 FROM entities en, json_each(en.addresses_json) j
		         WHERE j.value = ? AND en.id <> ?)`,
		address,
		ownerId,
	);
}

/** The parent still exists, its chain does not reach `childId`, and stays within MAX_DEPTH. */
function parentGuard(db: D1Database, parentId: string, childId: string) {
	return guardStatement(
		db,
		`NOT EXISTS (SELECT 1 FROM entities WHERE id = ?)
		 OR (WITH RECURSIVE up(id, parent_id, depth) AS (
		       SELECT id, parent_id, 1 FROM entities WHERE id = ?
		       UNION ALL
		       SELECT e.id, e.parent_id, up.depth + 1 FROM entities e JOIN up ON e.id = up.parent_id
		       WHERE up.depth < 4)
		     SELECT COUNT(*) > 2 OR SUM(id = ?) > 0 FROM up)`,
		parentId,
		parentId,
		childId,
	);
}

async function commit(db: D1Database, statements: D1PreparedStatement[]): Promise<Problem | null> {
	try {
		await guarded(() => db.batch(statements));
		return null;
	} catch (error) {
		if (error instanceof MemoryMapUnavailable || !GUARD_ERROR.test(errorText(error))) throw error;
		return problem(
			409,
			"MAP_CHANGED",
			"The map changed while this edit was being checked; read it again and retry",
		);
	}
}

interface EntityPlan {
	entity: Entity;
	created: boolean;
	statements: D1PreparedStatement[];
}

/**
 * Validate one create or update against the whole post-write map and build its guarded write
 * statements (not executed). `id` 'new' derives an id from the name; an unknown e_ id creates
 * that id.
 */
function planEntity(
	db: D1Database,
	entities: Entity[],
	id: string,
	patch: EntityPatch,
	ownDomains: string[],
): EntityPlan | Problem {
	const byId = new Map(entities.map((e) => [e.id, e]));
	const existing = id === "new" ? undefined : byId.get(id);
	if (!existing && id !== "new" && !ENTITY_ID_RE.test(id)) {
		return problem(400, "INVALID_ID", "id must be 'new' or match e_[a-z0-9_]+");
	}
	if (!existing && (!patch.kind || patch.name === undefined)) {
		return problem(400, "INVALID_BODY", "a new entity needs kind and name");
	}

	const name = patch.name === undefined ? (existing?.name ?? "") : checkName(patch.name);
	if (isProblem(name)) return name;
	const notes = patch.notes === undefined ? (existing?.notes ?? null) : checkNotes(patch.notes);
	if (isProblem(notes)) return notes;
	const aliases = mergeAliases(
		existing?.aliases ?? [],
		patch.aliases_add ?? [],
		patch.aliases_remove ?? [],
		name,
	);
	if (isProblem(aliases)) return aliases;
	const addresses = mergeAddresses(
		existing?.addresses ?? [],
		patch.addresses_add ?? [],
		patch.addresses_remove ?? [],
		ownDomains,
	);
	if (isProblem(addresses)) return addresses;

	let newId = existing?.id ?? id;
	if (newId === "new") {
		const base = entityIdFor(name);
		newId = base;
		for (let n = 2; byId.has(newId); n++) newId = `${base}_${n}`;
	}
	const at = now();
	const next: Entity = {
		id: newId,
		kind: patch.kind ?? (existing?.kind as EntityKind),
		name,
		name_key: nameKey(name),
		aliases: aliases.aliases,
		addresses: addresses.addresses,
		parent_id: patch.parent_id === undefined ? (existing?.parent_id ?? null) : patch.parent_id,
		notes,
		source: existing?.source ?? "user",
		owner_threads_12m: existing?.owner_threads_12m ?? 0,
		updated_at: Math.max(at, (existing?.updated_at ?? 0) + 1),
	};
	if (next.parent_id === next.id) {
		return problem(400, "PARENT_CYCLE", `${next.id} cannot be its own parent`);
	}
	const graph = [...entities.filter((e) => e.id !== next.id), next];
	const invalid = validateGraph(graph);
	if (invalid) return invalid;

	const statements = [rowGuard(db, next.id, existing)];
	for (const address of addresses.added) statements.push(addressGuard(db, address, next.id));
	if (next.parent_id && next.parent_id !== existing?.parent_id) {
		statements.push(parentGuard(db, next.parent_id, next.id));
	}
	statements.push(upsertEntityStatement(db, next, next.parent_id));
	return { entity: next, created: !existing, statements };
}

/** Create or update one entity (`about set`), atomically against concurrent edits. */
export async function setEntity(
	db: D1Database,
	id: string,
	patch: EntityPatch,
	ownDomains: string[],
): Promise<{ entity: Entity; created: boolean } | Problem> {
	const plan = planEntity(db, await loadEntities(db), id, patch, ownDomains);
	if (isProblem(plan)) return plan;
	const failed = await commit(db, plan.statements);
	return failed ?? { entity: plan.entity, created: plan.created };
}

/** Delete one entity: its children lose the parent, its tags go with it. */
export async function deleteEntity(db: D1Database, id: string): Promise<boolean> {
	const { meta } = await guarded(() =>
		db.prepare("DELETE FROM entities WHERE id = ?").bind(id).run(),
	);
	return (meta?.changes ?? 0) > 0;
}

export interface ImportEntry {
	id: string;
	kind: EntityKind;
	name: string;
	aliases?: string[];
	addresses?: string[];
	parent?: string | null;
	notes?: string | null;
	/** Retired with the proposal queue: an entry that still carries a question is refused. */
	review?: string | null;
	owner_threads_12m?: number;
}

/**
 * The graph-validated seed load (plan §5, review #): every entry loads active (source 'seed').
 * An entry with an open `review` question is refused; answer it, then import. Everything is
 * validated first, then written in one D1 batch: entities with NULL parents, then the parent
 * edges.
 */
export async function importEntities(
	db: D1Database,
	entries: ImportEntry[],
	ownDomains: string[],
	options: { dryRun: boolean },
) {
	const existing = await loadEntities(db);
	const existingIds = new Set(existing.map((e) => e.id));
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!ENTITY_ID_RE.test(entry.id)) {
			return problem(400, "INVALID_ID", `${entry.id}: ids match e_[a-z0-9_]+`);
		}
		if (seen.has(entry.id)) return problem(400, "DUPLICATE_ID", `${entry.id} appears twice`);
		seen.add(entry.id);
		if (existingIds.has(entry.id)) {
			return problem(409, "ENTITY_EXISTS", `${entry.id} already exists; edit it with about set`);
		}
		if (typeof entry.review === "string" && entry.review.trim()) {
			return problem(
				400,
				"REVIEW_NOT_SUPPORTED",
				`${entry.id} has an open review question; answer it and drop "review" before importing`,
			);
		}
	}

	const at = now();
	const active: Entity[] = [];
	for (const entry of entries) {
		const name = checkName(entry.name, `${entry.id} name`);
		if (isProblem(name)) return name;
		const notes = checkNotes(entry.notes);
		if (isProblem(notes)) return notes;
		const aliases = mergeAliases([], entry.aliases ?? [], [], name);
		if (isProblem(aliases)) return { ...aliases, message: `${entry.id}: ${aliases.message}` };
		const addresses = mergeAddresses([], entry.addresses ?? [], [], ownDomains);
		if (isProblem(addresses)) return { ...addresses, message: `${entry.id}: ${addresses.message}` };
		active.push({
			id: entry.id,
			kind: entry.kind,
			name,
			name_key: nameKey(name),
			aliases: aliases.aliases,
			addresses: addresses.addresses,
			parent_id: entry.parent ?? null,
			notes,
			source: "seed",
			owner_threads_12m: Math.max(0, Math.floor(entry.owner_threads_12m ?? 0)),
			updated_at: at,
		});
	}
	const invalid = validateGraph([...existing, ...active]);
	if (invalid) return invalid;

	const summary = { dry_run: options.dryRun, entities: active.map((e) => e.id) };
	if (options.dryRun) return summary;

	const statements: D1PreparedStatement[] = active.map((e) => rowGuard(db, e.id, undefined));
	for (const e of active) {
		for (const address of e.addresses) statements.push(addressGuard(db, address, e.id));
	}
	statements.push(...active.map((e) => upsertEntityStatement(db, e, null)));
	for (const e of active) {
		if (e.parent_id) {
			statements.push(
				db.prepare("UPDATE entities SET parent_id = ? WHERE id = ?").bind(e.parent_id, e.id),
			);
		}
	}
	const failed = statements.length > 0 ? await commit(db, statements) : null;
	return failed ?? summary;
}

// ---------------------------------------------------------------------------
// User corrections: link / unlink (thread-scoped rejections, review #)
// ---------------------------------------------------------------------------

export async function linkEntity(
	db: D1Database,
	entityId: string,
	target: string,
	action: "link" | "unlink",
	domains: string[],
) {
	const entity = await guarded(() =>
		db.prepare("SELECT id FROM entities WHERE id = ?").bind(entityId).first<Row>(),
	);
	if (!entity) return problem(404, "NOT_FOUND", `No entity ${entityId}`);

	const scopeSql =
		domains.length > 0 ? ` AND domain IN (${domains.map(() => "?").join(", ")})` : "";
	const email = await db
		.prepare(`SELECT id, thread_id FROM emails WHERE id = ?${scopeSql}`)
		.bind(target, ...domains)
		.first<Row>();
	const threadId = email ? (email.thread_id == null ? null : String(email.thread_id)) : target;
	let emailIds: string[];
	if (email && (action === "link" || !threadId)) emailIds = [String(email.id)];
	else {
		const { results } = await db
			.prepare(`SELECT id FROM emails WHERE thread_id = ?${scopeSql} LIMIT 500`)
			.bind(threadId, ...domains)
			.all<Row>();
		emailIds = (results ?? []).map((r) => String(r.id));
	}
	if (emailIds.length === 0) {
		return problem(404, "NOT_FOUND", `No email or thread ${target}`);
	}

	const at = now();
	const state = action === "link" ? "linked" : "rejected";
	const statements = emailIds.map((emailId) =>
		db
			.prepare(
				`INSERT INTO email_entities (email_id, entity_id, state, source, evidence_field,
				   evidence_text, created_at)
				 VALUES (?, ?, ?, 'user', NULL, NULL, ?)
				 ON CONFLICT(email_id, entity_id) DO UPDATE SET state = excluded.state,
				   source = 'user', evidence_field = NULL, evidence_text = NULL,
				   created_at = excluded.created_at`,
			)
			.bind(emailId, entityId, state, at),
	);
	if (action === "link" && threadId) {
		// A link overrides an earlier thread rejection, which would otherwise hide it.
		statements.push(
			db
				.prepare(
					`DELETE FROM email_entities
					 WHERE entity_id = ? AND state = 'rejected'
					   AND email_id IN (SELECT id FROM emails WHERE thread_id = ?)`,
				)
				.bind(entityId, threadId),
		);
	}
	await guarded(() => db.batch(statements));
	return { entity_id: entityId, action, thread_id: threadId, email_ids: emailIds };
}

// ---------------------------------------------------------------------------
// Sorter results: anchored tags (plan §3 "Results")
// ---------------------------------------------------------------------------

export interface EnrichmentCounters {
	entity_tags_written: number;
	entity_evidence_rejected: number;
	entity_malformed: number;
	rejected_reasons: Record<string, number>;
}

export function emptyEnrichmentCounters(): EnrichmentCounters {
	return {
		entity_tags_written: 0,
		entity_evidence_rejected: 0,
		entity_malformed: 0,
		rejected_reasons: {},
	};
}

/**
 * Store the sorter's tags for leased results. Runs after the category writes and never affects
 * them. Model rows use INSERT OR IGNORE, so a user row (linked or rejected) wins.
 */
export async function applyEnrichment(
	db: D1Database,
	items: Array<{ email_id: string; entities?: unknown }>,
): Promise<EnrichmentCounters> {
	const counters = emptyEnrichmentCounters();
	const parsed = items
		.map((item) => ({ email_id: item.email_id, ...parseEnrichment(item) }))
		.filter((p) => p.tags.length > 0 || p.malformed > 0);
	for (const p of parsed) counters.entity_malformed += p.malformed;
	const work = parsed.filter((p) => p.tags.length > 0);
	if (work.length === 0) return counters;

	const entities = await loadEntities(db);
	const byId = new Map(entities.map((e) => [e.id, e]));
	const ids = work.map((p) => p.email_id);
	const placeholders = ids.map(() => "?").join(", ");
	const [emailRows, attachmentRows] = await db.batch([
		db
			.prepare(
				`SELECT id, from_name, subject, SUBSTR(text_content, 1, 2000) AS body
				 FROM emails WHERE id IN (${placeholders})`,
			)
			.bind(...ids),
		db
			.prepare(`SELECT email_id, filename FROM attachments WHERE email_id IN (${placeholders})`)
			.bind(...ids),
	]);
	const filenames = new Map<string, string[]>();
	for (const row of (attachmentRows.results ?? []) as Row[]) {
		const list = filenames.get(String(row.email_id)) ?? [];
		if (row.filename != null) list.push(String(row.filename));
		filenames.set(String(row.email_id), list);
	}
	const sources = new Map<string, EvidenceSource>();
	for (const row of (emailRows.results ?? []) as Row[]) {
		const text = (v: unknown) => (v == null ? null : String(v));
		sources.set(String(row.id), {
			from_name: text(row.from_name),
			subject: text(row.subject),
			body: text(row.body),
			attachment: (filenames.get(String(row.id)) ?? []).join("\n") || null,
		});
	}

	const at = now();
	const tagStatements: D1PreparedStatement[] = [];
	const reject = (reason: string) => {
		counters.entity_evidence_rejected += 1;
		counters.rejected_reasons[reason] = (counters.rejected_reasons[reason] ?? 0) + 1;
	};

	for (const item of work) {
		const seen = sources.get(item.email_id);
		const tagged = new Set<string>();
		for (const tag of item.tags) {
			const verdict = verifyTag(tag, byId.get(tag.id), seen);
			if (!verdict.ok) {
				reject(verdict.reason);
				continue;
			}
			if (tagged.has(tag.id)) continue;
			tagged.add(tag.id);
			tagStatements.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO email_entities (email_id, entity_id, state, source,
						   evidence_field, evidence_text, created_at)
						 VALUES (?, ?, 'linked', 'model', ?, ?, ?)`,
					)
					.bind(item.email_id, tag.id, tag.field, verdict.evidence, at),
			);
		}
	}

	if (tagStatements.length > 0) {
		const results = await db.batch(tagStatements);
		counters.entity_tags_written = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
	}
	return counters;
}

// ---------------------------------------------------------------------------
// Daily "Owner writes" refresh (R7). Reads a year of outbound rows in pages; the query plan is
// SEARCH emails USING INDEX idx_emails_direction_received.
// ---------------------------------------------------------------------------

const SENT_PAGE = 5000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export async function refreshOwnerThreads(db: D1Database, ownDomains: string[]) {
	const entities = await loadEntities(db);
	if (entities.length === 0) return { entities: 0, rows: 0, updated: 0 };
	const rows: SentRow[] = [];
	let cursor = Number.MAX_SAFE_INTEGER;
	const cutoff = now() - YEAR_MS;
	for (;;) {
		const { results } = await db
			.prepare(
				`SELECT id, thread_id, from_address, to_address, to_addresses_json, cc_addresses_json,
				        subject, received_at
				 FROM emails
				 WHERE direction = 'outbound' AND received_at > ? AND received_at < ?
				   AND mailbox_state = 'sent'
				 ORDER BY received_at DESC
				 LIMIT ${SENT_PAGE}`,
			)
			.bind(cutoff, cursor)
			.all<Row>();
		const page = results ?? [];
		for (const row of page) {
			const text = (v: unknown) => (v == null ? null : String(v));
			rows.push({
				id: String(row.id),
				thread_id: text(row.thread_id),
				from_address: text(row.from_address),
				to_address: text(row.to_address),
				to_addresses_json: text(row.to_addresses_json),
				cc_addresses_json: text(row.cc_addresses_json),
				subject: text(row.subject),
			});
		}
		if (page.length < SENT_PAGE) break;
		// Rows sharing the boundary millisecond are re-read on the next page; thread sets dedupe.
		const next = Number(page[page.length - 1].received_at) + 1;
		if (next >= cursor || rows.length > 200_000) break;
		cursor = next;
	}
	const counts = computeOwnerThreads(entities, rows, ownDomains);
	const statements = entities
		.filter((e) => (counts.get(e.id) ?? 0) !== e.owner_threads_12m)
		.map((e) =>
			db
				.prepare("UPDATE entities SET owner_threads_12m = ? WHERE id = ?")
				.bind(counts.get(e.id) ?? 0, e.id),
		);
	if (statements.length > 0) await db.batch(statements);
	return { entities: entities.length, rows: rows.length, updated: statements.length };
}
