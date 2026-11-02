#!/usr/bin/env bun
// Empty databases only. Target selection is explicit; no default remote execution.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
	"bun run db:init (--local | --remote) --config <config> [--database <name-or-binding>] [--persist-to <directory>]";
const values = new Map();
const modes = [];
try {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--local" || arg === "--remote") {
			modes.push(arg);
			continue;
		}
		if (
			!["--config", "--database", "--persist-to"].includes(arg) ||
			values.has(arg) ||
			!args[i + 1] ||
			args[i + 1].startsWith("--")
		)
			throw new Error(usage);
		values.set(arg, args[++i]);
	}
	if (modes.length !== 1 || !values.has("--config")) throw new Error(usage);
	if (modes[0] === "--remote" && values.has("--persist-to"))
		throw new Error("--persist-to is local-only");
	const wrangler = `${root}/node_modules/.bin/wrangler`;
	const target = [
		"d1",
		"execute",
		values.get("--database") ?? "D1",
		modes[0],
		"--config",
		resolve(values.get("--config")),
	];
	if (values.has("--persist-to")) target.push("--persist-to", resolve(values.get("--persist-to")));
	const options = {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		stdio: ["ignore", "pipe", "pipe"],
	};
	const query = (sql) =>
		JSON.parse(execFileSync(wrangler, [...target, "--command", sql, "--json"], options));
	const applicationObjects = query(
		"SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'",
	)[0]?.results;
	if (!Array.isArray(applicationObjects))
		throw new Error("Could not inspect database; nothing installed");
	if (applicationObjects.length)
		throw new Error(
			"Database is not empty. db:init is for fresh installs only; use forward migrations for upgrades. Nothing installed.",
		);
	// D1's file execution aborts on SQL errors. The version is written last, only after all DDL.
	execFileSync(wrangler, [...target, "--file", `${root}/sql/schema.sql`, "--yes"], options);
	const version = query("SELECT version, name FROM schema_migrations ORDER BY version")[0]?.results;
	if (version?.length !== 1 || version[0].version !== 66)
		throw new Error("Baseline version verification failed");
	console.log(
		"Installed mail schema baseline v66 (tables, indexes, FTS5, triggers). No historical migrations needed.",
	);
} catch (error) {
	// Do not dump command environments, Wrangler diagnostics or credentials on failure.
	console.error(
		error.status !== undefined
			? "Database initialization failed in Wrangler. Check your config, authentication and target; inspect the schema and schema_migrations record before retrying."
			: error.message,
	);
	process.exitCode = 1;
}
