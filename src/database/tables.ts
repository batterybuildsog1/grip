let threadsReady: boolean | null = null;
let composeDraftColumnsReady: boolean | null = null;
let listUnsubscribeColumnReady: boolean | null = null;
let listUnsubscribePostColumnReady: boolean | null = null;
let trashedAtColumnReady: boolean | null = null;
let htmlOffloadColumnsReady: boolean | null = null;
let subCategoryColumnReady: boolean | null = null;
let attachmentNamesColumnReady: boolean | null = null;
let attachmentSearchTextColumnReady: boolean | null = null;
let attachmentExtractStatusColumnReady: boolean | null = null;
let rawEmailArtifactsTableReady: boolean | null = null;
let emailFidelityChecksTableReady: boolean | null = null;
let blockedSendersTableReady: boolean | null = null;

export async function isThreadsTableReady(db: D1Database): Promise<boolean> {
	if (threadsReady !== null) return threadsReady;
	try {
		const row = await db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'")
			.first();
		threadsReady = row !== null;
	} catch {
		threadsReady = false;
	}
	return threadsReady;
}

export async function areComposeDraftColumnsReady(db: D1Database): Promise<boolean> {
	if (composeDraftColumnsReady !== null) return composeDraftColumnsReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(emails)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		composeDraftColumnsReady =
			columnNames.has("draft_revision") && columnNames.has("editor_state_json");
	} catch {
		composeDraftColumnsReady = false;
	}
	return composeDraftColumnsReady;
}

export async function isListUnsubscribeColumnReady(db: D1Database): Promise<boolean> {
	if (listUnsubscribeColumnReady !== null) return listUnsubscribeColumnReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(emails)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		listUnsubscribeColumnReady = columnNames.has("list_unsubscribe");
	} catch {
		listUnsubscribeColumnReady = false;
	}
	return listUnsubscribeColumnReady;
}

/** v58 is optional: retained raw headers provide the pre-migration read path. */
export async function isListUnsubscribePostColumnReady(db: D1Database): Promise<boolean> {
	if (listUnsubscribePostColumnReady !== null) return listUnsubscribePostColumnReady;
	const row = await db
		.prepare(
			"SELECT name FROM pragma_table_info('emails') WHERE name = 'list_unsubscribe_post' LIMIT 1",
		)
		.first();
	listUnsubscribePostColumnReady = row !== null;
	return listUnsubscribePostColumnReady;
}

export async function isTrashedAtColumnReady(db: D1Database): Promise<boolean> {
	if (trashedAtColumnReady !== null) return trashedAtColumnReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(emails)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		trashedAtColumnReady = columnNames.has("trashed_at");
	} catch {
		trashedAtColumnReady = false;
	}
	return trashedAtColumnReady;
}

/**
 * Whether migrate-v27 has been applied: emails.sub_category.
 */
export async function isSubCategoryColumnReady(db: D1Database): Promise<boolean> {
	if (subCategoryColumnReady !== null) return subCategoryColumnReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(emails)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		subCategoryColumnReady = columnNames.has("sub_category");
	} catch {
		subCategoryColumnReady = false;
	}
	return subCategoryColumnReady;
}

/**
 * Whether migrate-v31 has been applied: emails.attachment_names.
 */
export async function isAttachmentNamesColumnReady(db: D1Database): Promise<boolean> {
	if (attachmentNamesColumnReady !== null) return attachmentNamesColumnReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(emails)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		attachmentNamesColumnReady = columnNames.has("attachment_names");
	} catch {
		attachmentNamesColumnReady = false;
	}
	return attachmentNamesColumnReady;
}

/**
 * Whether migrate-v34 has been applied: emails.attachment_search_text.
 */
export async function isAttachmentSearchTextColumnReady(db: D1Database): Promise<boolean> {
	if (attachmentSearchTextColumnReady !== null) return attachmentSearchTextColumnReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(emails)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		attachmentSearchTextColumnReady = columnNames.has("attachment_search_text");
	} catch {
		attachmentSearchTextColumnReady = false;
	}
	return attachmentSearchTextColumnReady;
}

/**
 * Whether migrate-v34 has been applied: attachments.extract_status (+
 * text_extracted_at). Gating ingest writes keeps a worker deployed before
 * the migration from crashing on attachment inserts.
 */
export async function isAttachmentExtractStatusColumnReady(db: D1Database): Promise<boolean> {
	if (attachmentExtractStatusColumnReady !== null) return attachmentExtractStatusColumnReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(attachments)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		attachmentExtractStatusColumnReady = columnNames.has("extract_status");
	} catch {
		attachmentExtractStatusColumnReady = false;
	}
	return attachmentExtractStatusColumnReady;
}

/**
 * Whether migrate-v23 has been applied: emails.html_in_r2 and emails.r2_html_key.
 * Gating writes on this lets the worker deploy safely before/after the
 * migration without crashing.
 */
export async function isHtmlOffloadColumnsReady(db: D1Database): Promise<boolean> {
	if (htmlOffloadColumnsReady !== null) return htmlOffloadColumnsReady;
	try {
		const rows = await db.prepare("PRAGMA table_info(emails)").all<{
			name: string;
		}>();
		const columnNames = new Set((rows.results ?? []).map((row) => String(row.name)));
		htmlOffloadColumnsReady = columnNames.has("html_in_r2") && columnNames.has("r2_html_key");
	} catch {
		htmlOffloadColumnsReady = false;
	}
	return htmlOffloadColumnsReady;
}

export async function isRawEmailArtifactsTableReady(db: D1Database): Promise<boolean> {
	if (rawEmailArtifactsTableReady !== null) return rawEmailArtifactsTableReady;
	try {
		const row = await db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raw_email_artifacts'")
			.first();
		rawEmailArtifactsTableReady = row !== null;
	} catch {
		rawEmailArtifactsTableReady = false;
	}
	return rawEmailArtifactsTableReady;
}

export async function isEmailFidelityChecksTableReady(db: D1Database): Promise<boolean> {
	if (emailFidelityChecksTableReady !== null) return emailFidelityChecksTableReady;
	try {
		const row = await db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_fidelity_checks'")
			.first();
		emailFidelityChecksTableReady = row !== null;
	} catch {
		emailFidelityChecksTableReady = false;
	}
	return emailFidelityChecksTableReady;
}

/**
 * Whether migrate-v33 has been applied: blocked_senders. Ingest paths use
 * this so a worker deployed before the migration never throws on the
 * blocked-sender lookup.
 */
export async function isBlockedSendersTableReady(db: D1Database): Promise<boolean> {
	if (blockedSendersTableReady !== null) return blockedSendersTableReady;
	try {
		const row = await db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blocked_senders'")
			.first();
		blockedSendersTableReady = row !== null;
	} catch {
		blockedSendersTableReady = false;
	}
	return blockedSendersTableReady;
}

/**
 * Whether migrate-v44 has been applied: purged_deliveries (tombstones). Only a
 * positive answer is cached, so ingest starts honoring tombstones as soon as
 * v44 lands (the code deploys first, S11). `forgetPurgedDeliveries` drops the
 * cached answer when a statement reports the table missing (rollback-v44).
 */
let purgedDeliveriesTableReady = false;

export async function isPurgedDeliveriesTableReady(db: D1Database): Promise<boolean> {
	if (purgedDeliveriesTableReady) return true;
	try {
		const row = await db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purged_deliveries'")
			.first();
		purgedDeliveriesTableReady = row !== null;
	} catch {
		purgedDeliveriesTableReady = false;
	}
	return purgedDeliveriesTableReady;
}

export function forgetPurgedDeliveries(): void {
	purgedDeliveriesTableReady = false;
}

// Reset cache (useful if migration runs mid-flight)
export function resetTableCache(): void {
	purgedDeliveriesTableReady = false;
	threadsReady = null;
	composeDraftColumnsReady = null;
	listUnsubscribeColumnReady = null;
	listUnsubscribePostColumnReady = null;
	trashedAtColumnReady = null;
	htmlOffloadColumnsReady = null;
	subCategoryColumnReady = null;
	attachmentNamesColumnReady = null;
	attachmentSearchTextColumnReady = null;
	attachmentExtractStatusColumnReady = null;
	rawEmailArtifactsTableReady = null;
	emailFidelityChecksTableReady = null;
	blockedSendersTableReady = null;
}
