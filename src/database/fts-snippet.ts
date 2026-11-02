/**
 * Shared FTS5 snippet SQL builders for the two search paths
 * (database/d1.ts email search, routes/conversations.ts ranked thread search).
 *
 * D1 LESSON (commit bfd000c): FTS5 aux functions like snippet() are only legal
 * where the query planner drives the FTS index directly. D1's planner
 * flattens/reorders joined CTEs and throws "unable to use function snippet in
 * the requested context" (plain bun:sqlite accepts the inline form). A
 * rowid-constrained correlated subquery with its own MATCH is always a direct
 * FTS query, so it works everywhere. Each generated subquery binds ONE extra
 * fts match param at its textual position in the SQL.
 *
 * MARK-AWARENESS: snippet() on a column that contains no matched term still
 * returns the leading tokens of that column (without <mark>), so a plain
 * COALESCE over snippet(1..N) always stops at the first non-empty column —
 * the body — no matter where the match landed. To surface attachment hits
 * (cols 9/10), entries first prefer snippets that actually contain <mark>,
 * then fall back to the legacy unmarked body/sender/subject chain.
 */

/** Column order of emails_fts after migrate-v34 (11 columns). */
export const FTS_SNIPPET_PRIMARY_COLUMNS = [1, 3, 0, 2] as const; // text_content, from_name, subject, from_address
export const FTS_SNIPPET_ATTACHMENT_COLUMNS = [9, 10] as const; // attachment_names, attachment_search_text

function snippetCall(column: number): string {
	return `snippet(emails_fts, ${column}, '<mark>', '</mark>', '…', 16)`;
}

function markedSnippetEntry(column: number): string {
	return `CASE WHEN INSTR(${snippetCall(column)}, '<mark>') > 0 THEN ${snippetCall(column)} END`;
}

function markedSnippetTest(column: number): string {
	return `INSTR(${snippetCall(column)}, '<mark>') > 0`;
}

/**
 * Correlated subquery returning the best display snippet for one matched
 * email row. `rowidExpr` must reference the outer query's emails rowid
 * (e.g. `e.rowid` or `matched.match_rowid`). Binds one fts match param.
 */
export function buildMatchSnippetSubquery(rowidExpr: string): string {
	const marked = [...FTS_SNIPPET_PRIMARY_COLUMNS, ...FTS_SNIPPET_ATTACHMENT_COLUMNS]
		.map(markedSnippetEntry)
		.join(",\n\t\t\t\t");
	const fallback = FTS_SNIPPET_PRIMARY_COLUMNS.map(
		(column) => `NULLIF(${snippetCall(column)}, '')`,
	).join(",\n\t\t\t\t");
	return `(
			SELECT COALESCE(
				${marked},
				${fallback}
			)
			FROM emails_fts
			WHERE emails_fts.rowid = ${rowidExpr} AND emails_fts MATCH ?
		)`;
}

/**
 * Correlated subquery returning 'attachment' when the match was found ONLY in
 * the attachment columns (9: attachment_names, 10: attachment_search_text),
 * NULL otherwise. Lets the UI prefix "in attachment:" on the snippet.
 * Binds one fts match param.
 */
export function buildMatchSnippetSourceSubquery(rowidExpr: string): string {
	const primaryMarked = FTS_SNIPPET_PRIMARY_COLUMNS.map(markedSnippetTest).join(" OR ");
	const attachmentMarked = FTS_SNIPPET_ATTACHMENT_COLUMNS.map(markedSnippetTest).join(" OR ");
	return `(
			SELECT CASE
				WHEN ${primaryMarked} THEN NULL
				WHEN ${attachmentMarked} THEN 'attachment'
				ELSE NULL
			END
			FROM emails_fts
			WHERE emails_fts.rowid = ${rowidExpr} AND emails_fts MATCH ?
		)`;
}

/**
 * Snippet and match source as ONE expression over the current emails_fts row:
 * 'a' or '-' then the snippet, where 'a' means the match was only in the
 * attachment columns. Use it in a statement that MATCHes once for many rows:
 * every correlated MATCH re-expands each prefix term ("the*" ~70 ms each).
 * Split with splitSnippetAndSource.
 */
export function buildMatchSnippetAndSourceExpr(): string {
	const marked = [...FTS_SNIPPET_PRIMARY_COLUMNS, ...FTS_SNIPPET_ATTACHMENT_COLUMNS]
		.map(markedSnippetEntry)
		.join(",\n\t\t\t\t");
	const fallback = FTS_SNIPPET_PRIMARY_COLUMNS.map(
		(column) => `NULLIF(${snippetCall(column)}, '')`,
	).join(",\n\t\t\t\t");
	const primaryMarked = FTS_SNIPPET_PRIMARY_COLUMNS.map(markedSnippetTest).join(" OR ");
	const attachmentMarked = FTS_SNIPPET_ATTACHMENT_COLUMNS.map(markedSnippetTest).join(" OR ");
	return `CASE WHEN NOT (${primaryMarked}) AND (${attachmentMarked}) THEN 'a' ELSE '-' END
		|| COALESCE(${marked}, ${fallback}, '')`;
}

export function splitSnippetAndSource(value: unknown): {
	snippet: string | null;
	source: "attachment" | null;
} {
	if (typeof value !== "string" || value.length === 0) return { snippet: null, source: null };
	const snippet = value.slice(1);
	return {
		snippet: snippet.length > 0 ? snippet : null,
		source: value[0] === "a" ? "attachment" : null,
	};
}
