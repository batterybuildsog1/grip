/**
 * Memory map (v52): pure logic shared by the entity routes, the sorter's claim/results and the
 * daily interest refresh. No D1 here (src/database/entities.ts owns the queries).
 * Plan: docs/codebase-design-2026-09-29/memory-map-plan.md.
 *
 * Text matching is token based: lowercase, accents folded, every run of non-alphanumerics a
 * single space. That mirrors the FTS5 unicode61 tokenizer, so an FTS phrase candidate and the
 * JS check agree, and "art" never matches inside "start".
 */

export const ENTITY_KINDS = ["person", "company", "project", "prospect"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const EVIDENCE_FIELDS = ["from_name", "subject", "body", "attachment"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];
export const ADDRESS_FIELDS = ["from", "reply_to", "to", "cc"] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];

/** Map size cap (question 6, default applied 2026-09-30). */
export const MAP_MAX_ENTITIES = 60;
/** Prompt budget for the rendered map (review #). */
export const MAP_MAX_CHARS = 12_000;
/** The Worker stores at most this many tags per email; extra ones are rejected. */
export const MAX_TAGS_PER_EMAIL = 5;
/** Stored evidence length (a longer verified quote is cut to this). */
export const EVIDENCE_STORE_CHARS = 200;
const EVIDENCE_MAX_CHARS = 400;

export const ENTITY_ID_RE = /^e_[a-z0-9_]{1,60}$/;
export const MAX_NAME_CHARS = 120;
export const MAX_ALIAS_CHARS = 80;
export const MAX_NOTES_CHARS = 600;
export const MAX_DEPTH = 2;

export interface Entity {
	id: string;
	kind: EntityKind;
	name: string;
	name_key: string;
	aliases: string[];
	addresses: string[];
	parent_id: string | null;
	notes: string | null;
	source: "user" | "seed" | "model";
	owner_threads_12m: number;
	updated_at: number;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Token-normalized text: 'Example Home-Supply, Inc.' -> 'example home supply inc'. */
export function normalizeText(value: string | null | undefined): string {
	if (!value) return "";
	return value
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** The key that makes (kind, name) unique. */
export const nameKey = normalizeText;

/** True when `needle` appears in `haystack` on token boundaries (both already normalized). */
export function containsPhrase(haystack: string, needle: string): boolean {
	if (!needle || !haystack) return false;
	return ` ${haystack} `.includes(` ${needle} `);
}

/** Slug id for a new entity: 'Example Supply' -> 'e_example_supply'. */
export function entityIdFor(name: string): string {
	const slug = normalizeText(name).replace(/ /g, "_").slice(0, 50) || "entity";
	return `e_${slug}`;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Freemail domains: an '@domain' entry here would claim every stranger on the service, so the
 * API refuses them (plan §2 "Precedence"). Exact freemail addresses are fine (a contractor's personal Gmail).
 */
export const FREEMAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"ymail.com",
	"hotmail.com",
	"outlook.com",
	"live.com",
	"msn.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"gmx.com",
	"mail.com",
	"comcast.net",
	"att.net",
	"sbcglobal.net",
	"verizon.net",
]);

const EXACT_ADDRESS_RE = /^[a-z0-9._%+'=-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN_ADDRESS_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** 'Robin <Robin@Supply.example>' -> 'robin@supply.example'; '@vendor.example' stays. */
export function normalizeAddress(value: string | null | undefined): string {
	if (!value) return "";
	const trimmed = value.trim();
	const angle = trimmed.match(/<([^>]+)>/);
	return (angle ? angle[1] : trimmed).trim().toLowerCase();
}

export function isValidEntityAddress(address: string): boolean {
	return EXACT_ADDRESS_RE.test(address) || DOMAIN_ADDRESS_RE.test(address);
}

export function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : address.slice(at + 1);
}

/**
 * The owner's own accounts: the configured owner addresses (`ownDomains` holds full addresses).
 * Used to refuse self-matching entries and to count "Owner writes".
 */
export function isOwnerAddress(address: string, ownDomains: string[]): boolean {
	const normalized = normalizeAddress(address);
	const at = normalized.lastIndexOf("@");
	if (at <= 0) return false;
	return ownDomains.includes(normalized);
}

/**
 * Does a real address match an entity address? Exact equality, or for '@domain' the domain or a
 * subdomain of it (review #: 'example-com' and 'example.com.evil' never match '@example.com').
 */
export function addressMatches(entityAddress: string, candidate: string): boolean {
	if (!candidate.includes("@")) return false;
	if (!entityAddress.startsWith("@")) return entityAddress === candidate;
	const domain = entityAddress.slice(1);
	const candidateDomain = domainOf(candidate);
	return candidateDomain === domain || candidateDomain.endsWith(`.${domain}`);
}

/** Addresses in a header value: a JSON array, a comma list, or one 'Name <addr>'. */
export function extractAddresses(value: unknown): string[] {
	if (value == null) return [];
	let items: unknown[] = [];
	if (Array.isArray(value)) items = value;
	else if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return [];
		if (trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed);
				items = Array.isArray(parsed) ? parsed : [trimmed];
			} catch {
				items = [trimmed];
			}
		} else {
			items = trimmed.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
		}
	}
	const out: string[] = [];
	for (const item of items) {
		if (typeof item !== "string") continue;
		const address = normalizeAddress(item);
		if (address.includes("@") && !out.includes(address)) out.push(address);
	}
	return out;
}

export interface EmailAddressFields {
	from_address: string | null;
	reply_to_addresses_json?: string | null;
	to_address?: string | null;
	to_addresses_json?: string | null;
	cc_addresses_json?: string | null;
}

/** The email's addresses per header field (to = to_address plus to_addresses_json). */
export function emailAddressesByField(email: EmailAddressFields): Record<AddressField, string[]> {
	const to = extractAddresses(email.to_addresses_json);
	for (const address of extractAddresses(email.to_address)) {
		if (!to.includes(address)) to.push(address);
	}
	return {
		from: extractAddresses(email.from_address),
		reply_to: extractAddresses(email.reply_to_addresses_json),
		to,
		cc: extractAddresses(email.cc_addresses_json),
	};
}

export interface AddressMatch {
	entity_id: string;
	field: AddressField;
	address: string;
}

/** Structured address matches for one email (review #): context for the sorter only. */
export function findAddressMatches(entities: Entity[], email: EmailAddressFields): AddressMatch[] {
	const byField = emailAddressesByField(email);
	const matches: AddressMatch[] = [];
	for (const entity of entities) {
		for (const field of ADDRESS_FIELDS) {
			for (const candidate of byField[field]) {
				if (entity.addresses.some((a) => addressMatches(a, candidate))) {
					matches.push({ entity_id: entity.id, field, address: candidate });
				}
			}
		}
	}
	return matches;
}

/** Names and aliases, normalized, longest first (used for subject/anchor checks). */
export function entityPhrases(entity: Pick<Entity, "name" | "aliases">): string[] {
	const phrases = [entity.name, ...entity.aliases].map(normalizeText).filter(Boolean);
	return [...new Set(phrases)].sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Validation of entity content and the parent graph
// ---------------------------------------------------------------------------

export interface Problem {
	status: 400 | 404 | 409;
	code: string;
	message: string;
}

export function problem(status: Problem["status"], code: string, message: string): Problem {
	return { status, code, message };
}

export function isProblem(value: unknown): value is Problem {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		"status" in value &&
		"message" in value
	);
}

/** Normalize and check one address for an entity. Returns the stored form or a problem. */
export function checkEntityAddress(raw: string, ownDomains: string[]): string | Problem {
	const address = normalizeAddress(raw);
	if (!isValidEntityAddress(address)) {
		return problem(400, "INVALID_ADDRESS", `'${raw}' is not an address or an @domain`);
	}
	if (address.startsWith("@")) {
		const domain = address.slice(1);
		if (FREEMAIL_DOMAINS.has(domain)) {
			return problem(
				400,
				"FREEMAIL_DOMAIN",
				`${address} is a freemail domain; add the person's exact address instead`,
			);
		}
		if (ownDomains.includes(domain)) {
			return problem(400, "OWN_DOMAIN", `${address} is one of our own domains`);
		}
	} else if (isOwnerAddress(address, ownDomains)) {
		return problem(400, "OWN_ADDRESS", `${address} is an owner address`);
	}
	return address;
}

export function checkName(name: unknown, label = "name"): string | Problem {
	if (typeof name !== "string" || !name.trim()) {
		return problem(400, "INVALID_BODY", `${label} is required`);
	}
	const trimmed = name.trim();
	if (trimmed.length > MAX_NAME_CHARS || !normalizeText(trimmed)) {
		return problem(
			400,
			"INVALID_BODY",
			`${label} must have letters or digits, max ${MAX_NAME_CHARS}`,
		);
	}
	return trimmed;
}

export function checkAlias(alias: string): string | Problem {
	const trimmed = alias.trim();
	if (trimmed.length < 2 || trimmed.length > MAX_ALIAS_CHARS || !normalizeText(trimmed)) {
		return problem(
			400,
			"INVALID_ALIAS",
			`alias '${alias}' must be 2-${MAX_ALIAS_CHARS} characters`,
		);
	}
	return trimmed;
}

export function checkNotes(notes: unknown): string | null | Problem {
	if (notes == null) return null;
	if (typeof notes !== "string") return problem(400, "INVALID_BODY", "notes must be a string");
	const trimmed = notes.trim();
	if (trimmed.length > MAX_NOTES_CHARS) {
		return problem(400, "INVALID_BODY", `notes must be at most ${MAX_NOTES_CHARS} characters`);
	}
	return trimmed || null;
}

/**
 * Validate the whole parent graph (review #): every parent exists, no cycles, at most MAX_DEPTH
 * ancestors, no address on two entities, no two entities with one kind and name. Run on the
 * full post-write set before any write.
 */
export function validateGraph(
	entities: Pick<Entity, "id" | "parent_id" | "addresses" | "kind" | "name_key">[],
): Problem | null {
	const byId = new Map(entities.map((e) => [e.id, e]));
	for (const entity of entities) {
		if (entity.parent_id && !byId.has(entity.parent_id)) {
			return problem(
				400,
				"MISSING_PARENT",
				`${entity.id}: parent ${entity.parent_id} does not exist`,
			);
		}
	}
	for (const entity of entities) {
		const seen = new Set<string>([entity.id]);
		let depth = 0;
		let cursor = entity.parent_id;
		while (cursor) {
			if (seen.has(cursor)) {
				return problem(400, "PARENT_CYCLE", `${entity.id}: parent chain loops through ${cursor}`);
			}
			seen.add(cursor);
			depth += 1;
			if (depth > MAX_DEPTH) {
				return problem(
					400,
					"PARENT_TOO_DEEP",
					`${entity.id}: more than ${MAX_DEPTH} levels of parents`,
				);
			}
			cursor = byId.get(cursor)?.parent_id ?? null;
		}
	}
	const owner = new Map<string, string>();
	for (const entity of entities) {
		for (const address of entity.addresses) {
			const other = owner.get(address);
			if (other && other !== entity.id) {
				return problem(409, "ADDRESS_TAKEN", `${address} already belongs to ${other}`);
			}
			owner.set(address, entity.id);
		}
	}
	const names = new Map<string, string>();
	for (const entity of entities) {
		const key = `${entity.kind}:${entity.name_key}`;
		const other = names.get(key);
		if (other && other !== entity.id) {
			return problem(409, "NAME_TAKEN", `${entity.kind} '${entity.name_key}' is already ${other}`);
		}
		names.set(key, entity.id);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Rendering the map for the sorter (review #)
// ---------------------------------------------------------------------------

export function ownerWritesLabel(threads: number): "often" | "sometimes" | "no" {
	if (threads >= 5) return "often";
	if (threads >= 1) return "sometimes";
	return "no";
}

interface LineParts {
	entity: Entity;
	aliases: string[];
	addresses: string[];
}

function renderLine({ entity, aliases, addresses }: LineParts, label = "Owner writes"): string {
	return [
		entity.id,
		entity.kind,
		entity.name,
		aliases.length > 0 ? `aka ${aliases.join("; ")}` : "aka -",
		addresses.length > 0 ? addresses.join(", ") : "-",
		entity.parent_id ? `parent ${entity.parent_id}` : "parent -",
		`${label}: ${ownerWritesLabel(entity.owner_threads_12m)}`,
		entity.notes ? entity.notes.replace(/\s+/g, " ").trim() : "-",
	].join(" | ");
}

export const MAP_HEADER =
	"id | kind | name | aka (aliases) | addresses (exact, or @domain) | parent | Owner writes | notes";

export interface RenderedMap {
	text: string;
	chars: number;
	included: string[];
	omitted: number;
	trimmed_aliases: number;
	trimmed_addresses: number;
}

/**
 * Render the map within MAP_MAX_ENTITIES and MAP_MAX_CHARS.
 * - Priority: projects, prospects and companies, then people by owner_threads_12m.
 * - `mustInclude` (entities the batch matches) are added even past the cap.
 * - Every included entity's parent chain is included, so no parent id is undefined.
 * - IDs, parents and notes are never cut. Aliases, then addresses, are trimmed first (lowest
 *   priority entities first); only then are whole low-priority entities dropped.
 */
export function renderMemoryMap(
	entities: Entity[],
	options: {
		mustInclude?: Iterable<string>;
		maxEntities?: number;
		maxChars?: number;
		writesLabel?: string;
	} = {},
): RenderedMap {
	const maxEntities = options.maxEntities ?? MAP_MAX_ENTITIES;
	const maxChars = options.maxChars ?? MAP_MAX_CHARS;
	const byId = new Map(entities.map((e) => [e.id, e]));
	const must = new Set([...(options.mustInclude ?? [])].filter((id) => byId.has(id)));

	const rank = (e: Entity) => (e.kind === "person" ? 1 : 0);
	const ordered = [...entities].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			b.owner_threads_12m - a.owner_threads_12m ||
			a.name.localeCompare(b.name) ||
			a.id.localeCompare(b.id),
	);

	const withAncestors = (ids: Iterable<string>): Set<string> => {
		const out = new Set<string>();
		for (const id of ids) {
			let cursor: string | null = id;
			let guard = 0;
			while (cursor && byId.has(cursor) && guard++ <= MAX_DEPTH + 1) {
				out.add(cursor);
				cursor = byId.get(cursor)?.parent_id ?? null;
			}
		}
		return out;
	};

	// 1. Entity cap (must-include and their parents ride on top of it).
	const chosen = ordered.slice(0, maxEntities).map((e) => e.id);
	const included = withAncestors([...chosen, ...must]);

	const build = (parts: LineParts[]) =>
		[
			MAP_HEADER.replace("Owner writes", options.writesLabel ?? "Owner writes"),
			...parts.map((p) => renderLine(p, options.writesLabel)),
		].join("\n") +
		(entities.length > parts.length
			? `\n(${entities.length - parts.length} more entities not shown)`
			: "");

	let parts: LineParts[] = ordered
		.filter((e) => included.has(e.id))
		.map((entity) => ({ entity, aliases: [...entity.aliases], addresses: [...entity.addresses] }));
	let text = build(parts);
	let trimmedAliases = 0;
	let trimmedAddresses = 0;

	// 2. Trim aliases, then addresses, lowest priority first (must-include entities last).
	const trimOrder = () => {
		const reversed = [...parts].reverse();
		return [
			...reversed.filter((p) => !must.has(p.entity.id)),
			...reversed.filter((p) => must.has(p.entity.id)),
		];
	};
	for (const key of ["aliases", "addresses"] as const) {
		for (const part of trimOrder()) {
			while (text.length > maxChars && part[key].length > 0) {
				part[key].pop();
				if (key === "aliases") trimmedAliases += 1;
				else trimmedAddresses += 1;
				text = build(parts);
			}
			if (text.length <= maxChars) break;
		}
		if (text.length <= maxChars) break;
	}

	// 3. Still over: drop whole entities from the bottom, never one a remaining entity names as
	// its parent. The batch's own entities go last, and they go too if they alone overflow: the
	// budget is a hard limit (review #6).
	const keep = withAncestors(must);
	const isParent = (p: LineParts) => parts.some((other) => other.entity.parent_id === p.entity.id);
	while (text.length > maxChars) {
		const reversed = [...parts].reverse();
		const victim =
			reversed.find((p) => !keep.has(p.entity.id) && !isParent(p)) ??
			reversed.find((p) => !isParent(p));
		if (!victim) break;
		parts = parts.filter((p) => p !== victim);
		text = build(parts);
	}

	return {
		text,
		chars: text.length,
		included: parts.map((p) => p.entity.id),
		omitted: entities.length - parts.length,
		trimmed_aliases: trimmedAliases,
		trimmed_addresses: trimmedAddresses,
	};
}

/**
 * Entities an email batch touches: an address match, or a name/alias phrase in the subject,
 * sender name or body excerpt. These are re-added to the map past the cap.
 */
export function batchMatchedEntityIds(
	entities: Entity[],
	emails: Array<
		EmailAddressFields & {
			from_name?: string | null;
			subject?: string | null;
			body_excerpt?: string | null;
		}
	>,
): Set<string> {
	const ids = new Set<string>();
	for (const email of emails) {
		for (const match of findAddressMatches(entities, email)) ids.add(match.entity_id);
		const text = normalizeText(
			[email.subject, email.from_name, email.body_excerpt].filter(Boolean).join(" "),
		);
		if (!text) continue;
		for (const entity of entities) {
			if (entityPhrases(entity).some((phrase) => containsPhrase(text, phrase))) ids.add(entity.id);
		}
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Sorter enrichment: lenient parsing and the anchor rule (review #, #7)
// ---------------------------------------------------------------------------

export interface TagCandidate {
	id: string;
	field: EvidenceField;
	evidence: string;
}

/**
 * Parse one result's tags. Never throws and never fails the category: anything malformed is
 * dropped and counted.
 */
export function parseEnrichment(raw: { entities?: unknown }): {
	tags: TagCandidate[];
	malformed: number;
} {
	let malformed = 0;
	const tags: TagCandidate[] = [];
	if (raw.entities !== undefined && raw.entities !== null) {
		if (!Array.isArray(raw.entities)) malformed += 1;
		else {
			for (const item of raw.entities) {
				const candidate = item as Record<string, unknown> | null;
				if (
					!candidate ||
					typeof candidate !== "object" ||
					typeof candidate.id !== "string" ||
					typeof candidate.evidence !== "string" ||
					!EVIDENCE_FIELDS.includes(candidate.field as EvidenceField) ||
					tags.length >= MAX_TAGS_PER_EMAIL
				) {
					malformed += 1;
					continue;
				}
				tags.push({
					id: candidate.id.trim(),
					field: candidate.field as EvidenceField,
					evidence: candidate.evidence,
				});
			}
		}
	}

	return { tags, malformed };
}

/** What the sorter saw for one email, re-read from D1 (body = SUBSTR(text_content, 1, 2000)). */
export interface EvidenceSource {
	from_name: string | null;
	subject: string | null;
	body: string | null;
	attachment: string | null;
}

/**
 * `needle` (an exact address, or a domain) in `haystack` with nothing glued to either side.
 * Before an exact address no local-part character may precede it ('bad.alice@x' is not
 * 'alice@x'); before a domain, '@' and '.' (subdomains) may.
 */
function hostBoundaryIncludes(
	haystackLower: string,
	needle: string,
	exactAddress: boolean,
): boolean {
	const glued = exactAddress ? /[a-z0-9._%+'=-]/ : /[a-z0-9_-]/;
	let from = 0;
	for (;;) {
		const at = haystackLower.indexOf(needle, from);
		if (at === -1) return false;
		const before = at === 0 ? "" : haystackLower[at - 1];
		const after = haystackLower.slice(at + needle.length, at + needle.length + 2);
		const beforeOk = !before || !glued.test(before);
		const afterOk = !/^[a-z0-9_-]/.test(after) && !/^\.[a-z0-9]/.test(after);
		if (beforeOk && afterOk) return true;
		from = at + 1;
	}
}

/** Does the quote name this entity (its name, an alias or an address)? */
export function quoteAnchorsEntity(
	quote: string,
	entity: Pick<Entity, "name" | "aliases" | "addresses">,
): boolean {
	const normalized = normalizeText(quote);
	if (entityPhrases(entity).some((phrase) => containsPhrase(normalized, phrase))) return true;
	const lower = quote.toLowerCase();
	return entity.addresses.some((address) =>
		address.startsWith("@")
			? hostBoundaryIncludes(lower, address.slice(1), false)
			: hostBoundaryIncludes(lower, address, true),
	);
}

export type TagVerdict =
	| { ok: true; evidence: string }
	| { ok: false; reason: "unknown_entity" | "bad_evidence" | "not_in_field" | "no_anchor" };

/**
 * The anchor rule (review #): store a tag only if the entity exists, the quote is a verbatim
 * (normalized) part of the named field, and the quote itself names the entity.
 */
export function verifyTag(
	tag: TagCandidate,
	entity: Entity | undefined,
	source: EvidenceSource | undefined,
): TagVerdict {
	if (!entity) return { ok: false, reason: "unknown_entity" };
	const quote = tag.evidence.trim();
	const normalizedQuote = normalizeText(quote);
	if (!normalizedQuote || quote.length > EVIDENCE_MAX_CHARS || !source) {
		return { ok: false, reason: "bad_evidence" };
	}
	if (!containsPhrase(normalizeText(source[tag.field]), normalizedQuote)) {
		return { ok: false, reason: "not_in_field" };
	}
	if (!quoteAnchorsEntity(quote, entity)) return { ok: false, reason: "no_anchor" };
	return { ok: true, evidence: quote.slice(0, EVIDENCE_STORE_CHARS) };
}

// ---------------------------------------------------------------------------
// "Owner writes" (R7): distinct threads of the owner's own sent mail in 365 days
// ---------------------------------------------------------------------------

export interface SentRow {
	id: string;
	thread_id: string | null;
	from_address: string | null;
	to_address: string | null;
	to_addresses_json: string | null;
	cc_addresses_json: string | null;
	subject: string | null;
}

/**
 * Per entity: distinct threads of the owner's sent mail reaching the entity's or its direct
 * children's addresses, plus, for projects, threads whose subject names the project. Each
 * thread counts once. Descriptive only: it orders and labels the map, it never routes mail.
 */
export function computeOwnerThreads(
	entities: Entity[],
	rows: SentRow[],
	ownDomains: string[],
): Map<string, number> {
	const childrenOf = new Map<string, Entity[]>();
	for (const entity of entities) {
		if (!entity.parent_id) continue;
		const list = childrenOf.get(entity.parent_id) ?? [];
		list.push(entity);
		childrenOf.set(entity.parent_id, list);
	}
	const threads = new Map<string, Set<string>>(entities.map((e) => [e.id, new Set<string>()]));
	for (const row of rows) {
		if (!row.from_address || !isOwnerAddress(row.from_address, ownDomains)) continue;
		const thread = row.thread_id ?? `email:${row.id}`;
		const recipients = [
			...extractAddresses(row.to_address),
			...extractAddresses(row.to_addresses_json),
			...extractAddresses(row.cc_addresses_json),
		];
		const subject = normalizeText(row.subject);
		for (const entity of entities) {
			const members = [entity, ...(childrenOf.get(entity.id) ?? [])];
			const reached = members.some((member) =>
				member.addresses.some((a) => recipients.some((r) => addressMatches(a, r))),
			);
			const named =
				entity.kind === "project" &&
				entityPhrases(entity).some((phrase) => containsPhrase(subject, phrase));
			if (reached || named) threads.get(entity.id)?.add(thread);
		}
	}
	return new Map([...threads].map(([id, set]) => [id, set.size]));
}

/** Operator compatibility for an existing sorter/API; fresh instances use neutral vocabulary. */
export function memoryMapPresentation(
	env: Pick<CloudflareBindings, "MEMORY_MAP_PRESENTATION_JSON">,
) {
	try {
		const v = JSON.parse(env.MEMORY_MAP_PRESENTATION_JSON || "{}");
		const field =
			typeof v.counter_field === "string" &&
			/^[a-z][a-z0-9_]{0,49}_threads_12m$/.test(v.counter_field) &&
			!["constructor", "prototype"].includes(v.counter_field)
				? v.counter_field
				: "owner_threads_12m";
		const label =
			typeof v.writes_label === "string" && v.writes_label.trim() && v.writes_label.length <= 100
				? v.writes_label.trim()
				: "Owner writes";
		return { field, label };
	} catch {
		return { field: "owner_threads_12m", label: "Owner writes" };
	}
}

export function presentMemoryMapResult(
	value: unknown,
	field: string,
	sourceField = "owner_threads_12m",
): unknown {
	if (Array.isArray(value)) return value.map((v) => presentMemoryMapResult(v, field, sourceField));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([k, v]) => [
			k === sourceField ? field : k,
			presentMemoryMapResult(v, field, sourceField),
		]),
	);
}
