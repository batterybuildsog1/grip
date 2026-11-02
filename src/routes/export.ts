/** Instance snapshot reads. No archive is built or buffered in a Worker. */
import { Hono } from "hono";
import { getPrincipal } from "@/auth/principal";
import type { AppVariables } from "@/types";
import { ERR, OK } from "@/utils/http";

const routes = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();
// D1 limits expression depth to 100; a left-deep concatenation of a wide row exceeds it.
function concatenate(parts: string[]): string {
	if (parts.length === 1) return parts[0];
	const middle = Math.floor(parts.length / 2);
	return `(${concatenate(parts.slice(0, middle))} || ${concatenate(parts.slice(middle))})`;
}
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Table = { name: string; sql: string; type: string; wr: number };
type Column = { name: string; pk: number };

async function schema(db: D1Database) {
	// table_list distinguishes virtual tables' shadow storage from ordinary tables.
	const tables = await db.prepare("PRAGMA table_list").all<Table>();
	const definitions = await db
		.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
		.all<{ type: string; name: string; sql: string }>();
	const ordinary = tables.results.filter(
		(t) => t.type === "table" && !/^(sqlite_|_cf_|_grip_|d1_)/.test(t.name),
	);
	const names = new Set(ordinary.map((t) => t.name));
	const virtual = tables.results.filter((t) => t.type === "virtual");
	return {
		format: "grip-instance-v1",
		sequences: tables.results.some((t) => t.name === "sqlite_sequence")
			? (
					await db
						.prepare("SELECT name, CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name")
						.all<{ name: string; seq: string }>()
				).results
			: [],
		tables: ordinary.map((t) => ({ name: t.name, withoutRowid: Boolean(t.wr) })),
		definitions: definitions.results.filter(
			(d) =>
				names.has(d.name) ||
				virtual.some((t) => t.name === d.name) ||
				(d.type !== "table" && !/^(sqlite_|_cf_|d1_)/.test(d.name)),
		),
	};
}

routes.use("/api/export/*", async (c, next) => {
	const p = getPrincipal(c);
	if (p?.kind !== "api" && !(p?.kind === "user" && p.user.owner_key === "all")) {
		return c.json(ERR("EXPORT_OWNER_ONLY", "Instance export needs the owner or API token"), 403);
	}
	await next();
});

routes.get("/api/export/schema", async (c) => c.json(OK(await schema(c.env.D1))));
routes.get("/api/export/table", async (c) => {
	const snapshot = await schema(c.env.D1);
	const table = snapshot.tables.find((t) => t.name === c.req.query("name"));
	if (!table) return c.json(ERR("INVALID_TABLE", "Unknown snapshot table"), 400);
	const { results: columns } = await c.env.D1.prepare(
		`PRAGMA table_info(${identifier(table.name)})`,
	).all<Column>();
	const keys = table.withoutRowid
		? columns
				.filter((col) => col.pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map((col) => col.name)
		: ["rowid"];
	let after: unknown;
	try {
		after = JSON.parse(c.req.query("after") || "null");
	} catch {
		return c.json(ERR("INVALID_CURSOR", "Invalid snapshot cursor"), 400);
	}
	if (
		after !== null &&
		(!Array.isArray(after) ||
			after.length !== keys.length ||
			after.some((v) => typeof v !== "string" && typeof v !== "number"))
	) {
		return c.json(ERR("INVALID_CURSOR", "Invalid snapshot cursor"), 400);
	}
	const fields = [...(table.withoutRowid ? [] : ["rowid"]), ...columns.map((col) => col.name)];
	// SQLite itself quotes values: preserves BLOBs and integers beyond JS's exact range in SQL.
	const prefix = `INSERT INTO ${identifier(table.name)} (${fields.map(identifier).join(",")}) VALUES (`;
	const valueSql = (name: string) => {
		const col = identifier(name);
		return `CASE WHEN typeof(${col}) = 'text' THEN 'CAST(X''' || hex(${col}) || ''' AS TEXT)' ELSE quote(${col}) END`;
	};
	const values = fields.flatMap((f, i) => (i ? ["','", valueSql(f)] : [valueSql(f)]));
	const literal = concatenate([`'${prefix.replaceAll("'", "''")}'`, ...values, "');'"]);
	const where = after ? `WHERE (${keys.map(identifier)}) > (${keys.map(() => "?")})` : "";
	const result = await c.env.D1.prepare(
		`SELECT ${keys.map((key, i) => `CAST(${identifier(key)} AS TEXT) AS "__grip_key_${i}"`).join(",")}, ${literal} AS "__grip_sql"
		 FROM ${identifier(table.name)} ${where} ORDER BY ${keys.map(identifier)} LIMIT 4`,
	)
		.bind(...((after as (string | number)[] | null) ?? []))
		.all<Record<string, unknown>>();
	const last = result.results.at(-1);
	return c.json(
		OK({
			rows: result.results,
			next: last ? keys.map((_, i) => last[`__grip_key_${i}`]) : null,
		}),
	);
});
routes.get("/api/export/objects", async (c) => {
	if (!c.env.ATTACHMENTS) return c.json(ERR("R2_UNAVAILABLE", "R2 binding is required"), 503);
	const page = await c.env.ATTACHMENTS.list({
		limit: 100,
		cursor: c.req.query("cursor"),
		include: ["httpMetadata", "customMetadata"],
	});
	return c.json(
		OK({
			objects: page.objects.map((o) => ({
				key: o.key,
				size: o.size,
				etag: o.etag,
				httpMetadata: o.httpMetadata,
				customMetadata: o.customMetadata,
			})),
			next: page.truncated ? page.cursor : null,
		}),
	);
});
routes.get("/api/export/object", async (c) => {
	const key = c.req.query("key");
	const etag = c.req.query("etag");
	if (!key || !etag) return c.json(ERR("INVALID_OBJECT", "key and etag are required"), 400);
	if (!c.env.ATTACHMENTS) return c.json(ERR("R2_UNAVAILABLE", "R2 binding is required"), 503);
	const object = await c.env.ATTACHMENTS.get(key, { onlyIf: { etagMatches: etag } });
	if (!object) return c.json(ERR("MISSING_OBJECT", "Snapshot object is missing"), 409);
	if (!("body" in object)) {
		return c.json(ERR("OBJECT_CHANGED", "Object changed; pause writers and restart export"), 409);
	}
	return new Response(object.body, {
		headers: { "Content-Type": "application/octet-stream", "Content-Length": String(object.size) },
	});
});
export default routes;
