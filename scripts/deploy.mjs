import { copyFileSync, existsSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ui = process.argv.includes("--ui");
const forwarded = process.argv.slice(2).filter((arg) => arg !== "--ui");
const PRIVATE = "wrangler.production.private.jsonc";
const config = existsSync(PRIVATE) ? PRIVATE : "wrangler.jsonc";
const configArgs = forwarded.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="))
  ? [] : ["--config", config];

function run(command, args) {
  const p = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (p.error) throw p.error;
  return p.status ?? 1;
}

if (!ui) process.exit(run("bunx", ["wrangler", "deploy", "--minify", ...configArgs, ...forwarded]));

// Pages takes no --config: it reads ./wrangler.jsonc. With a private config, stand it in for the
// tracked placeholder during the deploy only, and always put the tracked file back.
if (run("bun", ["run", "build"]) !== 0) process.exit(1);
const swap = config === PRIVATE;
const SAVED = "wrangler.jsonc.public-during-deploy";
if (swap) {
  if (existsSync(SAVED)) throw new Error(`${SAVED} exists: an earlier deploy was interrupted; restore it first`);
  renameSync("wrangler.jsonc", SAVED);
  copyFileSync(PRIVATE, "wrangler.jsonc");
}
let status = 1;
try {
  status = run("bunx", ["wrangler", "pages", "deploy", "dist", "--project-name", "mailclaw-ui", "--branch", "main", ...forwarded]);
} finally {
  if (swap) renameSync(SAVED, "wrangler.jsonc");
}
process.exit(status);
