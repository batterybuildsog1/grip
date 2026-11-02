import type { ConversationSummaryRecord } from "../lib/db";
import type { EmailFilters } from "../types";

/** Ranked search returns at most this many conversations (src/routes/conversations.ts SEARCH_RESULT_CAP). */
export const SEARCH_RESULT_CAP = 50;

/** The filters a search sends that `scope=view` applies and `scope=all` leaves out (the server's VIEW_FILTER_KEYS). */
const VIEW_FILTER_KEYS = [
	"category",
	"sub_category",
	"interest_level",
	"self",
	"for_person",
	"mailbox_state",
	"is_read",
] as const;

/** True when the open view narrows a search: there is a "Personal"-style pill beside All mail. */
export function viewNarrowsSearch(filters: EmailFilters): boolean {
	return VIEW_FILTER_KEYS.some((key) => {
		const value = filters[key];
		return value !== undefined && value !== null && value !== "";
	});
}

/**
 * A scope pill's count: the rows the answer holds, with "+" when the server has more. A ranked search
 * stops at the cap and then reports no more, so a full cap also reads "50+" (it means 50 or more).
 */
export function searchCountLabel(rows: number, hasMore: boolean): string {
	return hasMore || rows >= SEARCH_RESULT_CAP ? `${rows}+` : String(rows);
}

/**
 * Where a search result lives, in the redesign's views. Money needs the conversation's sub-category,
 * which the list API does not return, so billing mail outside Personal reads "All mail".
 */
export function searchWhere(
	row: Pick<ConversationSummaryRecord, "mailbox_state" | "category" | "direction">,
): string {
	if (row.mailbox_state === "trash") return "Trash";
	if (row.mailbox_state === "draft") return "Drafts";
	if (row.category === "spam") return "Spam";
	if (row.category === "personal") return "Personal";
	if (row.direction === "outbound") return "Sent";
	return "All mail";
}

/**
 * The query as typed, with each word the server corrected quoted: the search compiler never corrects
 * a quoted word, so this searches for exactly what was typed ("inovice" -> "\"inovice\"").
 */
export function literalQuery(typed: string, corrected: string): string {
	const mine = typed.trim().split(/(\s+)/);
	const fixed = corrected.trim().split(/(\s+)/);
	if (mine.length !== fixed.length) return `"${typed.trim().replace(/"/g, "")}"`;
	return mine
		.map((word, i) =>
			word !== fixed[i] && word.trim() && !word.includes('"') ? `"${word}"` : word,
		)
		.join("");
}
