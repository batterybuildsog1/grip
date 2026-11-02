/**
 * The one Message-ID normalizer. Production stores Message-IDs verbatim with
 * angle brackets (`<id@host>`), but transports disagree: PostalMime returns
 * whatever the header holds, and some importers stored the bare form. Every
 * write path stores `canonical`; every lookup (dedupe, tombstones) matches
 * both `forms`, so `<id>` and `id` are one delivery. The v44 tombstone trigger
 * copies `emails.message_id` verbatim, so legacy bare rows are still matched.
 */
export interface MessageIdForms {
	canonical: string;
	forms: [string, string];
}

export function messageIdForms(raw: string | null | undefined): MessageIdForms | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	const bare = trimmed.replace(/^<+/, "").replace(/>+$/, "").trim();
	if (!bare) return null;
	const canonical = `<${bare}>`;
	return { canonical, forms: [canonical, bare] };
}
