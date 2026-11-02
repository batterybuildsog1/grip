export interface ComposeDraftContentState {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	/** What goes out: the typed text and the quote under it (composeText). */
	text: string;
	attachmentCount: number;
}

export function normalizeComposeText(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

/**
 * The message text: what was typed, then the quoted original or forwarded message (the
 * composer's "Quoted text"). A quote cleared by hand is left out.
 */
export function composeText(body: string, quote: string | null): string {
	const typed = normalizeComposeText(body);
	const quoted = quote ? normalizeComposeText(quote) : "";
	if (!quoted.trim()) return typed;
	return `${typed.replace(/\s+$/, "")}${quoted.startsWith("\n") ? "" : "\n\n"}${quoted}`;
}

/** Plain text only: the formatting editor was cut (r2 build spec, section 2). */
export function buildComposeBodyPayload(text: string): { text?: string } {
	const normalized = normalizeComposeText(text);
	return { text: normalized.trim() ? normalized : undefined };
}

export function parseComposeRecipients(raw: string): string[] {
	return raw
		.split(/[;,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function hasComposeDraftContent({
	to,
	cc,
	bcc,
	subject,
	text,
	attachmentCount,
}: ComposeDraftContentState): boolean {
	return Boolean(
		to.trim() ||
			cc.trim() ||
			bcc.trim() ||
			subject.trim() ||
			normalizeComposeText(text).trim() ||
			attachmentCount > 0,
	);
}

export function formatComposeSavedAt(value: number | null): string | null {
	if (!value) return null;
	return new Date(value < 1e11 ? value * 1000 : value).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function validateAndDeduplicateReferences(
	referencesStr: string | undefined,
): string | undefined {
	if (!referencesStr) return referencesStr;
	const msgIds = new Set<string>();
	const parts = referencesStr.match(/<[^>]+>/g) || [];
	for (const part of parts) {
		if (/^<[^<>]+>$/.test(part)) {
			msgIds.add(part);
		}
	}
	return msgIds.size > 0 ? Array.from(msgIds).join(" ") : undefined;
}
