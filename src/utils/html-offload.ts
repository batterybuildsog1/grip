/**
 * HTML content offload to R2.
 *
 * Large or old email HTML bodies are stored in the ATTACHMENTS R2 bucket
 * under the `email-bodies/` prefix, gzipped. The `emails` row carries a
 * flag (`html_in_r2`) and the R2 key, and the D1 `html_content` column is
 * nulled. Read-path helpers transparently hydrate from R2.
 *
 * Design rationale: see sql/migrate-v23-html-offload.sql
 */

// -- Thresholds ---------------------------------------------------------

/**
 * Anything above this length (bytes of the HTML string) gets offloaded
 * regardless of age. D1 enforces a ~1 MB per-row/per-param limit; this gives
 * us 5x safety margin and also removes most bloated newsletters from D1.
 */
export const HTML_OFFLOAD_SIZE_THRESHOLD = 200_000;

/**
 * Emails older than this (ms) get offloaded even if small. Keeps the D1
 * working set focused on recent mail, where latency matters.
 */
export const HTML_OFFLOAD_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * R2 key prefix for offloaded email bodies.
 */
export const EMAIL_BODY_R2_PREFIX = "email-bodies";

// -- Decision -----------------------------------------------------------

export function buildEmailBodyKey(emailId: string): string {
	return `${EMAIL_BODY_R2_PREFIX}/${emailId}.html.gz`;
}

export interface OffloadDecisionInput {
	html_content: string | null | undefined;
	received_at?: number | null;
	now_ms?: number;
}

export interface OffloadDecision {
	/** Should the HTML be stored in R2 instead of D1? */
	offload: boolean;
	/** Human-readable reason for logging/debugging. */
	reason: "no_content" | "size" | "age" | "inline";
}

export function shouldOffloadHtml(input: OffloadDecisionInput): OffloadDecision {
	const html = input.html_content;
	if (html == null || html.length === 0) {
		return { offload: false, reason: "no_content" };
	}
	if (html.length > HTML_OFFLOAD_SIZE_THRESHOLD) {
		return { offload: true, reason: "size" };
	}
	if (typeof input.received_at === "number" && input.received_at > 0) {
		const now = input.now_ms ?? Date.now();
		if (now - input.received_at > HTML_OFFLOAD_AGE_MS) {
			return { offload: true, reason: "age" };
		}
	}
	return { offload: false, reason: "inline" };
}

// -- R2 writes ----------------------------------------------------------

/**
 * Gzip a UTF-8 string. Workers provides native CompressionStream.
 */
async function gzipString(input: string): Promise<Uint8Array> {
	const bytes = new TextEncoder().encode(input);
	const stream = new Response(bytes).body?.pipeThrough(new CompressionStream("gzip"));
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

async function gunzipToString(bytes: Uint8Array): Promise<string> {
	const stream = new Response(bytes).body?.pipeThrough(new DecompressionStream("gzip"));
	return await new Response(stream).text();
}

/**
 * Write HTML to R2 under the email-bodies prefix. Returns the R2 key.
 * Callers should null-out the D1 html_content column and set
 * html_in_r2=1, r2_html_key=<returned key> after this succeeds.
 */
export async function putEmailBodyToR2(
	bucket: R2Bucket,
	emailId: string,
	html: string,
): Promise<string> {
	const key = buildEmailBodyKey(emailId);
	const gzipped = await gzipString(html);
	await bucket.put(key, gzipped, {
		httpMetadata: {
			contentType: "text/html; charset=utf-8",
			contentEncoding: "gzip",
		},
		customMetadata: {
			email_id: emailId,
			original_size: String(html.length),
			compressed_size: String(gzipped.byteLength),
		},
	});
	return key;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * R2 key of a keyed send's prepared HTML (ticket 08). Named by its content, so attempts
 * that composed different HTML (a reply whose original changed in between) never share an
 * object, and never by the sent copy's key, which finalization writes (it may add the
 * hosted-attachment links).
 */
export function buildPreparedEmailBodyKey(emailId: string, htmlSha256: string): string {
	return `${EMAIL_BODY_R2_PREFIX}/${emailId}.prepared-${htmlSha256.slice(0, 16)}.html.gz`;
}

/**
 * Create-only write of a keyed send's prepared HTML. Safe to repeat and to race: an
 * object already at the key must carry this HTML's hash, or the write fails. Bodies are
 * never deleted (no delete path removes email-bodies/ objects).
 */
export async function putPreparedEmailBody(
	bucket: R2Bucket,
	emailId: string,
	html: string,
): Promise<string> {
	const sha = await sha256Hex(html);
	const key = buildPreparedEmailBodyKey(emailId, sha);
	const gzipped = await gzipString(html);
	const written = await bucket.put(key, gzipped, {
		onlyIf: new Headers({ "If-None-Match": "*" }),
		httpMetadata: { contentType: "text/html; charset=utf-8", contentEncoding: "gzip" },
		customMetadata: {
			email_id: emailId,
			html_sha256: sha,
			original_size: String(html.length),
			compressed_size: String(gzipped.byteLength),
		},
	});
	if (written) return key;
	// null: the precondition failed, an earlier or concurrent attempt wrote it first.
	const existing = await bucket.head(key);
	if (existing?.customMetadata?.html_sha256 !== sha) {
		throw new Error(`prepared body ${key} does not hold this HTML`);
	}
	return key;
}

// -- R2 reads -----------------------------------------------------------

/**
 * Fetch and gunzip an offloaded HTML body. Returns null if the object
 * is missing (which indicates a data integrity issue worth logging, but
 * should not crash the caller).
 */
export async function getEmailBodyFromR2(bucket: R2Bucket, key: string): Promise<string | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	const buffer = await obj.arrayBuffer();
	return await gunzipToString(new Uint8Array(buffer));
}

// -- Batch read helper --------------------------------------------------

export interface HtmlHydrationTarget {
	id: string;
	html_in_r2?: boolean | number;
	r2_html_key?: string | null;
	html_content?: string | null;
}

/**
 * Hydrate html_content for a batch of rows in parallel. Mutates the input
 * rows' `html_content` field in-place when offloaded content is loaded.
 * Rows that aren't offloaded (html_in_r2=0) are skipped.
 */
export async function hydrateHtmlFromR2<T extends HtmlHydrationTarget>(
	bucket: R2Bucket | undefined,
	rows: T[],
): Promise<void> {
	if (!bucket) return;
	const targets = rows.filter((r) => Boolean(r.html_in_r2) && r.r2_html_key);
	if (targets.length === 0) return;

	await Promise.all(
		targets.map(async (row) => {
			try {
				const html = await getEmailBodyFromR2(bucket, row.r2_html_key!);
				row.html_content = html;
			} catch {
				// Surface as null — UI shows "couldn't load content".
				row.html_content = null;
			}
		}),
	);
}
