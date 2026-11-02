# Instance portability and recovery

`mailclaw export /secure/customer-2026-10-30 --quiesced`

Requires Python 3.9+, the repository's CLI and companion scripts, and the owner's bearer or
API token in the normal CLI configuration. No Cloudflare account credentials are required to
export. The API is `/api/export/{schema,table,objects,object}`; every endpoint requires the
instance owner (`owner_key=all`) or API token. An administrator who is not the owner cannot
export the instance. Output is a new mode-0700 directory; credentials are never passed in argv.

Before passing `--quiesced`, pause **all** writers: external delivery/routing and importers,
interactive edits, senders, classifier/extractors, and scheduled tasks (especially raw retention
and trash purge). Keep them paused through completion. Quiescence is an operator assertion,
not a server lock. Multiple requests cannot give a live atomic D1/R2 snapshot. Take a snapshot
before cutover and keep incoming mail queued upstream. Do not switch a restore into service
until verified. This command does not change any routing, schedule or enabled state itself.

## Archive format

- `Maildir/<account hash>/{INBOX,.Sent,.Drafts,.Trash,.Archive}/{cur,new,tmp}`: generated RFC 822
  MIME containing full current text, HTML, binary attachments, filenames, content IDs and
  disposition. Standard `S`/`D` Maildir flags preserve seen/draft state. Import these Maildirs
  with ordinary mail software, without Grip.
- `messages.jsonl`: real account addresses, original IDs, Maildir paths, read/category/subcategory
  and folder state, plus the linked retained raw object's path. `original_rfc822=false` means
  no retained artifact is linked to this message. Orphaned R2 raw objects are still copied;
  raw bytes already deleted by retention cannot be recovered. The SQL preserves every other
  field, including editor state, provenance, thread projections, sender rules and send guards.
- `restore.sql`: main mail D1 application schema and every row, with original rowids, exact
  SQL-encoded values, AUTOINCREMENT high-water marks and deletion tombstones. Long values
  are assembled in a temporary staging table with statements below D1's 100 KB limit;
  staging is dropped before completion. FTS shadow storage is regenerated from its
  external content. Cloudflare internal metadata is excluded.
- `objects/<SHA-256 of key>` and `objects.jsonl`: **all** ATTACHMENTS R2 keys and exact bytes,
  including HTML, files, retained raw write-aheads (even orphaned ones), HTTP/custom metadata,
  lengths and SHA-256. Hashed local names avoid path traversal through R2 keys.
- `checksums.jsonl` and `manifest.json`: integrity checks and the completion marker. The
  manifest is written last. A directory without it is incomplete and cannot restore.

The snapshot includes users, password hashes, session hashes and account settings; protect
and encrypt it as carefully as the instance. Deployment secrets/vars, Worker code, DNS,
Email Routing and optional **MILEAGE_D1** are outside this mail archive. Keep these separately
in the operator's deployment inventory. Do not publish archives as public signed links.

D1 uses small keyset pages, including compound keys for WITHOUT ROWID tables. R2 lists in
pages of 100; each object downloads as a stream with an ETag precondition. There is no
mailbox-wide Worker buffer or attachment ingestion limit. The client needs disk for SQL,
objects, temporary SQLite and generated MIME, and memory for one generated message. HTTP
429/temporary gateway failures retry with backoff. An interrupted export must be restarted
into a **new directory**; it does not resume. A missing referenced HTML, attachment or retained
raw object fails the archive. A raw artifact absent because retention already removed its row
is recorded as unavailable. The exporter never substitutes empty HTML or attachment bytes.

## Proven local recovery

Use an explicit JSON Wrangler config (not the production JSONC config), with `D1` and
`ATTACHMENTS` bindings, no `remote:true` binding, and a local API token / `SEND_MODE=record`.
The config should point at this repository's `src/index.ts`.

```sh
python3 scripts/instance-archive.py verify /secure/customer-2026-10-30
node scripts/restore-instance.mjs /secure/customer-2026-10-30 \
  --local --config /secure/recovery-local.json --persist-to /secure/NEW-recovery-state
node_modules/.bin/wrangler dev --local --config /secure/recovery-local.json \
  --persist-to /secure/NEW-recovery-state
```

Restore refuses an existing persistence directory, verifies every archive checksum before
writing, imports the **snapshot schema** rather than today's fresh-install schema, then copies
R2 bytes and both metadata classes through Miniflare into Wrangler's local persistence. On
failure discard the isolated partial destination and retry into a new directory. It neither
re-ingests nor sends mail. Restoring twice cannot duplicate deliveries or mix two instances.

Run `bash tests/e2e/export-restore.e2e.sh`. Its artifact includes `before.json`, `after.json`,
`result.json`, MIME verification, the complete synthetic archive and local state. The test
wipes the original persistence directory before recovery, compares every snapshot SQL row,
compares message API reads and attachment hashes, rebuilds/probes FTS, compares R2 payloads
and metadata, and proves a tombstoned delivery still cannot be re-ingested.

## Hosted replacement recovery

The automated restore command is deliberately local-only. For hosted recovery, first prove
that archive with the local procedure above, then provision an **isolated replacement** with
no delivery routes, cron, classifiers, push or live sends. Use the same Worker revision and
configuration inventory as the source. Import `restore.sql` into its new, empty D1 using
`wrangler d1 execute NEW_DATABASE --remote --file ARCHIVE/restore.sql --config NEW_CONFIG`.
Copy each `objects.jsonl` entry's file to its original key in the new R2 bucket using the R2
S3 API's PutObject, including HTTP and custom metadata. Never apply a restore over an active
instance. Verify all key sizes/hashes and mailbox reads before switching routing; preserve the
old instance until the replacement is accepted. Cloudflare's remote D1 import and S3 limits
must be exercised in the isolated hosted staging rehearsal before charging pilots. This
local synthetic proof does **not** claim a production Cloudflare disaster-recovery rehearsal.

## Retirement / compatibility

`GET /api/emails/export` is not a backup: it is the paged message listing with bodies (`/api/emails?full=1`) under its old URL, kept for existing API callers. Use `mailclaw export` for a complete copy.
Filtered content reads used by `search --full` and the classifier use `GET /api/emails?full=1`
through the existing selection engine. They are message queries, not backups. There is one
instance archive format. No schema migration is needed. The current checked-in fresh-install baseline is v66. The E2E retains a
`baseline-friction.txt` receipt (empty when there is no baseline friction); it does not replay
historical migrations or rewrite migration history.
