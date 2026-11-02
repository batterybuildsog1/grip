import { memoryMapPresentation, presentMemoryMapResult } from "@/services/memory-map";
/**
 * Memory map routes (v52). Agents and the owner both use these (API token; `source='user'`).
 * Plan: docs/codebase-design-2026-09-29/memory-map-plan.md §4. CLI: `mailclaw about`.
 *
 * GET    /api/entities?kind=&q=            list, or resolve a name/alias/address/id
 * GET    /api/entities/map                 the map exactly as the sorter sees it (no batch)
 * GET    /api/entities/:id/threads         about: threads connected to the entity and children
 * PUT    /api/entities/:id                 create ('new' or an unused e_ id) or edit
 * DELETE /api/entities/:id
 * POST   /api/entities/:id/links           {target: email_id|thread_id, action: link|unlink}
 * POST   /api/entities/import              graph-validated load (the seed), {entities, dry_run}
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { isPrivileged } from "@/auth/principal";
import {
	deleteEntity,
	getEntityThreads,
	importEntities,
	linkEntity,
	loadEntities,
	MemoryMapUnavailable,
	publicEntity,
	resolveEntityQuery,
	setEntity,
} from "@/database/entities";
import { ENTITY_KINDS, isProblem, type Problem, renderMemoryMap } from "@/services/memory-map";
import type { AppVariables } from "@/types";
import { ERR, OK } from "@/utils/http";
import { getRequestContext, logError, logInfo } from "@/utils/logging";
import { ownershipScope } from "@/utils/owner";
import { getConfiguredDomains } from "@/utils/platform";
import { entityImportSchema, entityLinkSchema, entitySetSchema } from "@/utils/validation";

type AppContext = Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>;

const entities = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();
// Existing operators can retain their old counter field without putting it in public defaults.
for (const path of ["/api/entities", "/api/entities/*"])
	entities.use(path, async (c, next) => {
		await next();
		const { field } = memoryMapPresentation(c.env);
		if (
			field === "owner_threads_12m" ||
			!c.res.headers.get("Content-Type")?.includes("application/json")
		)
			return;
		const body = presentMemoryMapResult(await c.res.json(), field);
		c.res = new Response(JSON.stringify(body), { status: c.res.status, headers: c.res.headers });
	});

/** Every configured domain: our own domains are never entity addresses. */
function ownDomains(c: AppContext): string[] {
	return ownershipScope(c.env);
}

function fail(c: AppContext, p: Problem) {
	return c.json(ERR(p.code, p.message), p.status);
}

async function readJson(c: AppContext): Promise<unknown | Response> {
	try {
		return presentMemoryMapResult(
			await c.req.json(),
			"owner_threads_12m",
			memoryMapPresentation(c.env).field,
		);
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}
}

/**
 * API token only (review: workspace tokens are per-domain UI sessions, but the map is global
 * and its links reach any domain's mail). Same rule as import-raw.
 */
async function requireApiToken(c: AppContext, next: () => Promise<void>) {
	if (!isPrivileged(c)) {
		return c.json(
			ERR("FORBIDDEN", "The memory map requires the API token or an administrator"),
			403,
		);
	}
	await next();
}
for (const path of ["/api/entities", "/api/entities/*"]) {
	entities.use(path, requireApiToken);
}

entities.onError((err, c) => {
	if (err instanceof MemoryMapUnavailable) {
		return c.json(ERR("MEMORY_MAP_UNAVAILABLE", err.message), 503);
	}
	logError("unhandled_error", { ...getRequestContext(c), error: err.message });
	return c.json(ERR("INTERNAL_ERROR", err.message), 500);
});

entities.get("/api/entities", async (c) => {
	const kind = c.req.query("kind");
	if (kind && !ENTITY_KINDS.includes(kind as (typeof ENTITY_KINDS)[number])) {
		return c.json(ERR("INVALID_QUERY", `kind must be one of ${ENTITY_KINDS.join(", ")}`), 400);
	}
	const all = await loadEntities(c.env.D1);
	const q = c.req.query("q");
	let list = q ? resolveEntityQuery(all, q) : all;
	if (kind) list = list.filter((e) => e.kind === kind);
	return c.json(OK({ entities: list.map(publicEntity), total: list.length }));
});

entities.get("/api/entities/map", async (c) => {
	const all = await loadEntities(c.env.D1);
	const rendered = renderMemoryMap(all, { writesLabel: memoryMapPresentation(c.env).label });
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rendered.text));
	const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return c.json(OK({ ...rendered, entities_total: all.length, sha256 }));
});

entities.get("/api/entities/:id/threads", async (c) => {
	const all = await loadEntities(c.env.D1);
	const entity = all.find((e) => e.id === c.req.param("id"));
	if (!entity) return c.json(ERR("NOT_FOUND", `No entity ${c.req.param("id")}`), 404);
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 500);
	const sinceRaw = c.req.query("since");
	let since: number | null = null;
	if (sinceRaw) {
		since = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
		if (!Number.isFinite(since)) {
			return c.json(ERR("INVALID_QUERY", "since must be a date or epoch ms"), 400);
		}
	}
	const result = await getEntityThreads(c.env.D1, entity, all, {
		limit,
		since,
		domains: getConfiguredDomains(c.env),
	});
	return c.json(OK(result));
});

entities.put("/api/entities/:id", async (c) => {
	const body = await readJson(c);
	if (body instanceof Response) return body;
	const parsed = entitySetSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}
	const result = await setEntity(c.env.D1, c.req.param("id"), parsed.data, ownDomains(c));
	if (isProblem(result)) return fail(c, result);
	logInfo("entity_set", {
		...getRequestContext(c),
		entity_id: result.entity.id,
		created: result.created,
	});
	return c.json(OK({ entity: publicEntity(result.entity), created: result.created }));
});

entities.delete("/api/entities/:id", async (c) => {
	const deleted = await deleteEntity(c.env.D1, c.req.param("id"));
	if (!deleted) return c.json(ERR("NOT_FOUND", `No entity ${c.req.param("id")}`), 404);
	logInfo("entity_deleted", { ...getRequestContext(c), entity_id: c.req.param("id") });
	return c.json(OK({ id: c.req.param("id"), deleted: true }));
});

entities.post("/api/entities/import", async (c) => {
	const body = await readJson(c);
	if (body instanceof Response) return body;
	const parsed = entityImportSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			ERR(
				"INVALID_BODY",
				parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
			),
			400,
		);
	}
	const result = await importEntities(
		c.env.D1,
		parsed.data.entities.map((e) => ({
			...e,
			owner_threads_12m: e.owner_threads_12m ?? e.measured?.owner_wrote_threads_365d ?? 0,
		})),
		ownDomains(c),
		{ dryRun: parsed.data.dry_run === true },
	);
	if (isProblem(result)) return fail(c, result);
	logInfo("entities_imported", {
		...getRequestContext(c),
		dry_run: result.dry_run,
		entities: result.entities.length,
	});
	return c.json(OK(result));
});

entities.post("/api/entities/:id/links", async (c) => {
	const body = await readJson(c);
	if (body instanceof Response) return body;
	const parsed = entityLinkSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}
	const result = await linkEntity(
		c.env.D1,
		c.req.param("id"),
		parsed.data.target,
		parsed.data.action,
		getConfiguredDomains(c.env),
	);
	if (isProblem(result)) return fail(c, result);
	logInfo("entity_link", {
		...getRequestContext(c),
		entity_id: result.entity_id,
		action: result.action,
		emails: result.email_ids.length,
	});
	return c.json(OK(result));
});

export default entities;
