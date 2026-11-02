import type { ContactSuggestion } from "@/types";
import { normalizeEmailAddress } from "@/utils/platform";

interface ContactAccumulator {
	address: string;
	name: string | null;
	last_seen_at: number;
	match_score: number;
	activity_score: number;
}

export interface ContactSuggestionSourceRow {
	direction?: string;
	account?: string;
	from_address?: string | null;
	from_name?: string | null;
	to_address?: string | null;
	to_addresses?: string[];
	cc_addresses?: string[];
	bcc_addresses?: string[];
	reply_to_addresses?: string[];
	last_seen_at?: number | null;
}

function normalizeContactName(name: string | null | undefined): string | null {
	if (!name) {
		return null;
	}

	const normalized = name.trim();
	return normalized ? normalized : null;
}

export function scoreContactSuggestion(
	query: string,
	address: string,
	name?: string | null,
): number {
	const normalizedQuery = query.trim().toLowerCase();
	const normalizedAddress = normalizeEmailAddress(address);
	const normalizedName = normalizeContactName(name)?.toLowerCase() ?? "";
	const localPart = normalizedAddress.split("@")[0] ?? "";

	if (!normalizedQuery || !normalizedAddress) {
		return 0;
	}

	if (normalizedAddress === normalizedQuery || normalizedName === normalizedQuery) return 1000;
	if (normalizedName.startsWith(normalizedQuery)) return 900;
	if (localPart.startsWith(normalizedQuery)) return 850;
	if (normalizedAddress.startsWith(normalizedQuery)) return 800;
	if (normalizedName.split(/\s+/).some((word) => word.startsWith(normalizedQuery))) return 700;
	if (localPart.split(/[._+-]/).some((word) => word.startsWith(normalizedQuery))) return 650;
	if ((normalizedAddress.split("@")[1] ?? "").startsWith(normalizedQuery)) return 600;
	return 0;
}

function upsertContact(
	accumulator: Map<string, ContactAccumulator>,
	query: string,
	address: string | null | undefined,
	name: string | null | undefined,
	lastSeenAt: number,
	activityScore = 0,
) {
	if (!address) {
		return;
	}

	const normalizedAddress = normalizeEmailAddress(address);
	if (
		!normalizedAddress.includes("@") ||
		/^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?)(?:[+._-]|$)/i.test(
			normalizedAddress.split("@")[0],
		)
	) {
		return;
	}

	const matchScore = scoreContactSuggestion(query, normalizedAddress, name);
	if (matchScore === 0) {
		return;
	}

	const normalizedName = normalizeContactName(name);
	const existing = accumulator.get(normalizedAddress);

	if (!existing) {
		accumulator.set(normalizedAddress, {
			address: normalizedAddress,
			name: normalizedName,
			last_seen_at: lastSeenAt,
			match_score: matchScore,
			activity_score: activityScore,
		});
		return;
	}

	existing.match_score = Math.max(existing.match_score, matchScore);
	existing.last_seen_at = Math.max(existing.last_seen_at, lastSeenAt);
	existing.activity_score = Math.max(existing.activity_score, activityScore);
	if (!existing.name && normalizedName) {
		existing.name = normalizedName;
	}
}

export function buildContactSuggestions(
	rows: ContactSuggestionSourceRow[],
	query: string,
	limit = 8,
): ContactSuggestion[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return [];
	}

	const contacts = new Map<string, ContactAccumulator>();

	for (const row of rows) {
		const lastSeenAt = Number(row.last_seen_at ?? 0);

		const outbound = row.direction === "outbound" ? 1 : 0;
		const own = row.account?.toLowerCase();
		const address = (value: string | null | undefined) =>
			value?.toLowerCase() === own ? null : value;
		upsertContact(contacts, normalizedQuery, address(row.from_address), row.from_name, lastSeenAt);
		upsertContact(contacts, normalizedQuery, address(row.to_address), null, lastSeenAt, outbound);
		for (const recipient of row.to_addresses ?? []) {
			upsertContact(contacts, normalizedQuery, address(recipient), null, lastSeenAt, outbound);
		}
		for (const recipient of row.cc_addresses ?? []) {
			upsertContact(contacts, normalizedQuery, address(recipient), null, lastSeenAt, outbound);
		}
		for (const recipient of row.bcc_addresses ?? []) {
			upsertContact(contacts, normalizedQuery, address(recipient), null, lastSeenAt, outbound);
		}
		for (const recipient of row.reply_to_addresses ?? []) {
			upsertContact(contacts, normalizedQuery, address(recipient), null, lastSeenAt, outbound);
		}
	}

	return [...contacts.values()]
		.sort((left, right) => {
			if (left.activity_score !== right.activity_score)
				return right.activity_score - left.activity_score;
			if (left.match_score !== right.match_score) {
				return right.match_score - left.match_score;
			}
			if (left.last_seen_at !== right.last_seen_at) {
				return right.last_seen_at - left.last_seen_at;
			}
			return left.address.localeCompare(right.address);
		})
		.slice(0, Math.max(1, limit))
		.map(({ address, name, last_seen_at }) => ({
			address,
			name,
			last_seen_at,
		}));
}
