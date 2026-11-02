#!/usr/bin/env node
/**
 * MailClaw attachment text-extraction sidecar (Phase 5).
 *
 * Drains the Worker's v34 extraction queue: polls
 * GET /api/admin/attachments?extract_status=pending, downloads each payload
 * via GET /api/emails/:id/attachments/:attachmentId, extracts text locally
 * (pdftotext for PDFs, textutil for docx/doc/rtf, plain read for txt/csv),
 * aggregates per email under "Attachment: <name>" headers, then PATCHes
 * /api/emails/:id/hydrate with { attachment_search_text } ONLY — email body
 * content is never sent and never modified. Row bookkeeping goes through
 * PATCH /api/admin/attachments/:id (done / failed / skipped:*).
 *
 * Each invocation drains the queue and exits. Operators may schedule it with
 * their own process supervisor and explicit instance configuration.
 *
 * Usage:
 *   node scripts/sidecar/extract-attachment-text.mjs [--dry-run] [--limit N] [--batch N]
 *   node scripts/sidecar/extract-attachment-text.mjs --mark-unset [--dry-run]
 *
 * --mark-unset (backfill 3C): triages attachment rows whose extract_status
 * was never stamped (pre-v34 ingests) into pending/skipped:type, mirroring
 * the Worker's resolveAttachmentExtractStatus, so the normal drain loop picks
 * the extractable ones up.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MAX_ATTACHMENT_TEXT_CHARS = 20000;
const MAX_TOTAL_TEXT_CHARS = 60000;
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 45000;

function loadLocalConfig() {
	const path = join(homedir(), ".mailclaw", "config.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

const localConfig = loadLocalConfig();
const baseUrl = process.env.MAILCLAW_BASE_URL || localConfig?.host;
const apiToken =
	process.env.MAILCLAW_API_TOKEN || process.env.MAILCLAW_TOKEN || localConfig?.api_token;

const args = process.argv.slice(2);
let dryRun = false;
let markUnset = false;
let limitTotal = Number.POSITIVE_INFINITY;
let batchSize = 20;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--dry-run") {
		dryRun = true;
	} else if (arg === "--mark-unset") {
		markUnset = true;
	} else if (arg === "--limit" && args[i + 1]) {
		limitTotal = Number.parseInt(args[++i], 10);
	} else if (arg === "--batch" && args[i + 1]) {
		batchSize = Math.max(1, Math.min(100, Number.parseInt(args[++i], 10) || 20));
	} else if (arg === "--help" || arg === "-h") {
		console.log(`Usage: node scripts/sidecar/extract-attachment-text.mjs [options]

Options:
  --dry-run     Extract and print, but do not PATCH anything.
  --limit N     Stop after processing N attachment rows.
  --batch N     Queue page size (default 20, max 100).
  --mark-unset  Triage rows with no extract_status into pending/skipped:type.
  --help        Show this help.`);
		process.exit(0);
	}
}

if (!baseUrl || !apiToken) {
	console.error(
		"MAILCLAW_BASE_URL + MAILCLAW_API_TOKEN (or ~/.mailclaw/config.json host/api_token) are required",
	);
	process.exit(1);
}

function log(message) {
	console.log(`${new Date().toISOString()} ${message}`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with 429 handling: the Worker allows 120 requests/min per token, so
 * back off for Retry-After (default 30s) and try again instead of failing
 * rows. Other errors throw after the attempts run out.
 */
async function fetchWithRetry(url, init = {}, attempts = 5) {
	let lastError = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const response = await fetch(url, init);
		if (response.status !== 429) return response;
		const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
		const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30) * 1000;
		lastError = new Error(`rate limited (429), retry ${attempt + 1}/${attempts}`);
		log(`rate limited; sleeping ${waitMs}ms`);
		await sleep(waitMs);
	}
	throw lastError ?? new Error("rate limited (429)");
}

async function api(path, init = {}) {
	const response = await fetchWithRetry(new URL(path, baseUrl), {
		...init,
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json",
			...(init.headers || {}),
		},
	});
	const text = await response.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!response.ok) {
		const message = body?.error?.message || (typeof body === "string" ? body : "unknown error");
		throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${message}`);
	}
	return body?.data ?? null;
}

// ─── Extraction type triage (mirrors src/utils/attachments.ts) ──────────────

const MIME_TO_KIND = new Map([
	["application/pdf", "pdf"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "textutil"],
	["application/msword", "textutil"],
	["application/rtf", "textutil"],
	["text/rtf", "textutil"],
	["text/plain", "text"],
	["text/csv", "text"],
	["application/csv", "text"],
]);

const EXTENSION_TO_KIND = new Map([
	["pdf", "pdf"],
	["docx", "textutil"],
	["doc", "textutil"],
	["rtf", "textutil"],
	["txt", "text"],
	["csv", "text"],
]);

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

function fileExtension(filename) {
	return (filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? null;
}

/** "pdf" | "textutil" | "text" for extractable attachments, null otherwise. */
function extractionKind(mimeType, filename) {
	const mime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
	if (MIME_TO_KIND.has(mime)) return MIME_TO_KIND.get(mime);
	if (GENERIC_MIME_TYPES.has(mime)) {
		const extension = fileExtension(filename);
		if (extension && EXTENSION_TO_KIND.has(extension)) return EXTENSION_TO_KIND.get(extension);
	}
	return null;
}

const MIME_TO_EXTENSION = new Map([
	["application/pdf", "pdf"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
	["application/msword", "doc"],
	["application/rtf", "rtf"],
	["text/rtf", "rtf"],
	["text/plain", "txt"],
	["text/csv", "csv"],
	["application/csv", "csv"],
]);

/** textutil/pdftotext sniff by extension — give the temp file a sane one. */
function tempExtension(mimeType, filename) {
	const fromName = fileExtension(filename);
	if (fromName && EXTENSION_TO_KIND.has(fromName)) return fromName;
	const mime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
	return MIME_TO_EXTENSION.get(mime) ?? "bin";
}

function runTool(command, commandArgs) {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			commandArgs,
			{ timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 128 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(
						new Error(
							error.killed ? `${command} timed out after ${EXTRACT_TIMEOUT_MS}ms` : error.message,
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/**
 * Extract text from one downloaded payload.
 * Returns { status: "done" | "failed" | "skipped:no-text-layer", text }.
 */
async function extractText(kind, bytes, mimeType, filename) {
	if (kind === "text") {
		return { status: "done", text: Buffer.from(bytes).toString("utf8").trim() };
	}

	const dir = await mkdtemp(join(tmpdir(), "mailclaw-extract-"));
	const path = join(dir, `attachment.${tempExtension(mimeType, filename)}`);
	try {
		await writeFile(path, Buffer.from(bytes));
		if (kind === "pdf") {
			const text = (await runTool("pdftotext", [path, "-"])).trim();
			// Image-only/scanned PDFs come back empty — record why, don't retry.
			if (!text) return { status: "skipped:no-text-layer", text: "" };
			return { status: "done", text };
		}
		const text = (await runTool("textutil", ["-convert", "txt", "-stdout", path])).trim();
		if (!text) return { status: "skipped:no-text", text: "" };
		return { status: "done", text };
	} catch (err) {
		return { status: "failed", text: "", error: err.message };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function downloadAttachment(emailId, attachmentId) {
	const response = await fetchWithRetry(
		new URL(
			`/api/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
			baseUrl,
		),
		{ headers: { Authorization: `Bearer ${apiToken}` } },
	);
	if (!response.ok) {
		throw new Error(`attachment download failed (${response.status})`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * Process every attachment of one email and return per-row outcomes plus the
 * aggregated search text. Rebuilding from ALL extractable attachments (not
 * just the pending batch rows) keeps the hydrated aggregate complete even
 * when an email's rows straddle queue pages or get re-queued later.
 */
async function processEmail(emailId) {
	const email = await api(`/api/emails/${encodeURIComponent(emailId)}`);
	const attachments = email?.attachments ?? [];
	const outcomes = [];
	const parts = [];

	for (const attachment of attachments) {
		const name = attachment.filename || "attachment";
		const kind = extractionKind(attachment.mime_type, attachment.filename);
		if (!kind) {
			outcomes.push({ id: attachment.id, name, status: "skipped:type" });
			continue;
		}
		if (Number(attachment.size ?? 0) > MAX_PAYLOAD_BYTES) {
			outcomes.push({ id: attachment.id, name, status: "skipped:size" });
			continue;
		}

		try {
			const bytes = await downloadAttachment(emailId, attachment.id);
			const result = await extractText(kind, bytes, attachment.mime_type, attachment.filename);
			outcomes.push({ id: attachment.id, name, status: result.status, error: result.error });
			if (result.text) {
				parts.push(`Attachment: ${name}\n${result.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}`);
			}
		} catch (err) {
			outcomes.push({ id: attachment.id, name, status: "failed", error: err.message });
		}
	}

	return { outcomes, searchText: parts.join("\n\n").slice(0, MAX_TOTAL_TEXT_CHARS) };
}

async function markStatus(attachmentId, status) {
	await api(`/api/admin/attachments/${encodeURIComponent(attachmentId)}`, {
		method: "PATCH",
		body: JSON.stringify({ extract_status: status }),
	});
}

async function drainPendingQueue() {
	const attempted = new Set();
	let processedRows = 0;
	let hydratedEmails = 0;
	let failedRows = 0;

	while (processedRows < limitTotal) {
		const page = await api(`/api/admin/attachments?extract_status=pending&limit=${batchSize}`);
		const rows = (page?.attachments ?? []).filter((row) => !attempted.has(row.id));
		if (rows.length === 0) break;

		const emailIds = [...new Set(rows.map((row) => row.email_id))];
		for (const emailId of emailIds) {
			if (processedRows >= limitTotal) break;
			let result;
			try {
				result = await processEmail(emailId);
			} catch (err) {
				// Leave the rows pending for the next run, but don't spin on them
				// within this one.
				log(`email ${emailId}: processing failed: ${err.message}`);
				for (const row of rows.filter((r) => r.email_id === emailId)) attempted.add(row.id);
				failedRows += 1;
				continue;
			}

			for (const outcome of result.outcomes) attempted.add(outcome.id);
			processedRows += result.outcomes.length;

			const summary = result.outcomes
				.map((outcome) => `${outcome.name}=${outcome.status}`)
				.join(", ");
			if (dryRun) {
				log(
					`[dry-run] email ${emailId}: ${summary}; would hydrate ${result.searchText.length} chars`,
				);
				continue;
			}

			try {
				// Hydrate FIRST so a failure leaves rows pending for retry.
				if (result.searchText) {
					await api(`/api/emails/${encodeURIComponent(emailId)}/hydrate`, {
						method: "PATCH",
						body: JSON.stringify({ attachment_search_text: result.searchText }),
					});
					hydratedEmails += 1;
				}
				for (const outcome of result.outcomes) {
					await markStatus(outcome.id, outcome.status);
					if (outcome.status === "failed") failedRows += 1;
					await sleep(250);
				}
				log(`email ${emailId}: ${summary}; hydrated ${result.searchText.length} chars`);
			} catch (err) {
				log(`email ${emailId}: hydrate/mark failed: ${err.message}`);
				failedRows += 1;
			}
			// Stay well inside the Worker's 120 req/min budget — this queue is
			// not latency-sensitive.
			await sleep(1000);
		}
	}

	log(
		`extract pass complete: rows=${processedRows} hydrated_emails=${hydratedEmails} failures=${failedRows} dry_run=${dryRun}`,
	);
}

async function markUnsetRows() {
	const attempted = new Set();
	let pending = 0;
	let skipped = 0;

	while (pending + skipped < limitTotal) {
		const page = await api(`/api/admin/attachments?extract_status=unset&limit=100`);
		const rows = (page?.attachments ?? []).filter((row) => !attempted.has(row.id));
		if (rows.length === 0) break;

		for (const row of rows) {
			attempted.add(row.id);
			const status = extractionKind(row.mime_type, row.filename) ? "pending" : "skipped:type";
			if (dryRun) {
				log(`[dry-run] ${row.id} ${row.filename ?? "(unnamed)"} (${row.mime_type}) -> ${status}`);
			} else {
				await markStatus(row.id, status);
				await sleep(550);
			}
			if (status === "pending") pending += 1;
			else skipped += 1;
		}
		if (dryRun) break; // statuses don't change in dry-run; one page is enough
	}

	log(`mark-unset complete: pending=${pending} skipped_type=${skipped} dry_run=${dryRun}`);
}

if (markUnset) {
	await markUnsetRows();
} else {
	await drainPendingQueue();
}
