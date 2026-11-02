# Grip

Grip is mail for people and agents: an inbox, search, sending, a web app, native Apple apps,
and a scriptable CLI. Self-host it on Cloudflare Workers with D1 and R2. Internal package names
and the CLI remain `mailclaw`.

Copyright (c) 2026 Alan Knudson. Licensed under AGPL-3.0-only (see LICENSE): if you run a
modified Grip as a service for others, publish your changes. Based on
[Vincent Yang’s MailClaw](https://github.com/missuo/mailclaw), whose MIT notice is kept in
`licenses/MailClaw-MIT.txt`; keep it and the third-party notices with redistributions.

## Self-host

Requires Bun, Node 22+, a Cloudflare account and a domain you control. For a local trial:

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
# Edit .dev.vars: invent your API_TOKEN; set MAIL_DOMAINS=example.org and SEND_MODE=record.
# Initialize an empty database, including tables, indexes, FTS and triggers, in one command:
bun run db:init --local --config wrangler.jsonc
bunx wrangler dev --local
```

The initializer refuses any existing application schema. For a new remote instance create your
own D1 database and R2 bucket, replace the placeholders in `wrangler.jsonc`, then run the same
`db:init` command with `--remote`. Later schema changes will ship as forward migrations. Mileage
is optional and has a separate database/schema in `sql/mileage/` (apply `001` to `006` in order);
it must never share the mail D1.

Create the first owner through the CLI (with `MAILCLAW_HOST` and `MAILCLAW_API_TOKEN` set):

```sh
bin/mailclaw admin user create you@example.org --grant all --owner-key all --admin
```

The returned one-time password link is private. Set `UI_ORIGIN` to your web origin before
creating users; configure Cloudflare Access (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) on both the
Worker and Pages and restrict invitations to your users. The public example is closed to Access
until those values are supplied. Configure `ALLOWED_SENDERS` and `SENDER_NAMES_JSON` for your
addresses. Receiving requires Cloudflare Email Routing pointed at your Worker. Live sending
requires explicit per-domain SMTP or Cloudflare Email Service configuration; `record` mode
stores Sent messages without transmitting. `.dev.vars.example` documents settings and secrets.
No business companies, personal automation, report identity or push topic are assumed.

Build the web with `cd ui && bun install --frozen-lockfile && bun run build`. Set `WORKER_URL`
and the API service binding in `ui/wrangler.jsonc` to your own Worker. Set `UI_ORIGIN` on Pages
if you want Pages preview addresses to redirect to your custom hostname. `bun run deploy`
(root or `ui/`) uses your local ignored `wrangler.production.private.jsonc` when present,
otherwise the checked-in example configuration. These commands deploy; review configuration first.

## Apple source build

On macOS with Xcode/Swift 6.2 or newer and the macOS 27 SDK, build the shared native package:

```sh
(cd apple/MailClawKit && swift build)
```

The SwiftUI app additionally needs XcodeGen (`cd apple && xcodegen generate`) and your own
signing and distribution metadata in the ignored Config overlays. A package build alone does
not verify the iPhone, iPad or Mac app UI or distribution signing.

## App discovery

Apps have no server field. Publish this over HTTPS at
`https://example.org/.well-known/grip.json` (use your actual email domain):

```json
{"version":1,"domain":"example.org","api_origin":"https://your-worker.example.org"}
```

The app tries that file first, then a signed directory only if your build configures one
(`GripDirectoryURL` and its public verification pin, both empty in this source; the directory
service is not part of this release). Addresses on domains you don't control, such as Gmail,
therefore need a build with your own directory. Saved sessions retain their server during
discovery outages.

## Optional features and operation

Morning reports are off without `MORNING_REPORT_JSON`; set an explicit timezone/hour. Sender
rules and full-mailbox owner key `all` apply to one isolated instance, not to multiple unrelated
people. Use a separate Worker/D1/R2 and credentials per instance. For backup/restore
(`mailclaw export`) see `docs/hosted/export-restore.md`.

Web privacy/support URLs use `VITE_PRIVACY_URL` / `VITE_SUPPORT_URL` (default `/privacy` and
`/support`); publish your own pages there. Apple equivalents are Info.plist `GripPrivacyURL` /
`GripSupportURL`; configure them before distribution. Maps are off without operator-supplied
`VITE_MILEAGE_TILES` (PMTiles), `VITE_MILEAGE_GLYPHS` and dataset attribution
`VITE_MILEAGE_ATTRIBUTION`. No geographic dataset ships.

After the root install, run `(cd ui && bun install --frozen-lockfile)` before `bun run test`:
the backend tests also import shared web helpers. `bun run tsc`, `bun run check`, `bun run test`,
and `(cd ui && bun run build)` validate the source.
