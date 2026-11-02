import { MileageError, type MileagePrincipal } from "./auth";
import type { Trip } from "./policy";
import {
	type HistoryTrip,
	type ProposalBody,
	propose,
	type QueueItem,
	queueItems,
} from "./proposals";
import { type Category, digest, requireLogic } from "./store";

type Suggestion = Omit<ProposalBody, "expected_revision" | "idempotency_key">;
interface Part {
	confidence: number;
	fields: Partial<Suggestion>;
	detail: string;
}
const SPLIT_LABEL = "Split point (unmeasured)";
const plural = (n: number, word: string) => `${n} reviewed trip${n === 1 ? "" : "s"} ${word}`;
/**
 * Deterministic, no LLM. Past trips between the same two endpoints (each within 200 m, same direction):
 * two or more agreeing on category, treatment, reimbursable and purpose → 0.95; exactly one → 0.6;
 * any disagreement → nothing. Endpoint names only where the trip has no label and no saved place.
 * Calendar stays with the existing calendar suggestions (no duplicate here).
 */
export function suggest(item: QueueItem, threshold: number): Suggestion | null {
	if (item.pending_proposal) return null;
	const history = item.history,
		parts: Part[] = [];
	if (!item.category_id && history.length) {
		const key = (h: HistoryTrip) =>
			JSON.stringify([h.category_id, h.treatment, h.reimbursable ?? null, h.purpose]);
		const h = history[0];
		// A proposal carries no treatment: a reviewed commute (Personal + commute) would silently become personal.
		if (
			new Set(history.map(key)).size === 1 &&
			h.category_id &&
			h.treatment !== "commute" &&
			h.treatment !== "needs_review"
		)
			parts.push({
				confidence: history.length >= 2 ? 0.95 : 0.6,
				fields: {
					category_id: h.category_id,
					...(h.purpose.trim() ? { purpose: h.purpose } : {}),
					...(h.treatment === "reimbursement" && h.reimbursable !== null
						? { reimbursable: h.reimbursable }
						: {}),
				},
				detail: plural(history.length, "between the same endpoints agree"),
			});
	}
	for (const [field, place] of [
		["origin", item.start_place],
		["destination", item.end_place],
	] as const) {
		if (item[field].trim() || place) continue;
		const labels = history.map((h) => h[field].trim()).filter((v) => v && v !== SPLIT_LABEL);
		if (new Set(labels).size !== 1) continue;
		parts.push({
			confidence: labels.length >= 2 ? 0.9 : 0.6,
			fields: { [field]: labels[0] },
			detail: plural(labels.length, `named this ${field === "origin" ? "start" : "end"}`),
		});
	}
	if (!parts.length) return null;
	const classification = parts.find((x) => x.fields.category_id !== undefined);
	// A strong classification is not held back by a weaker name; the name comes back on a later run.
	const chosen =
		classification && classification.confidence >= threshold
			? parts.filter((x) => x.confidence >= threshold)
			: parts;
	return {
		confidence: Math.min(...chosen.map((x) => x.confidence)),
		basis: chosen.map((x) => ({ kind: "past_trips" as const, detail: x.detail })),
		...Object.assign({}, ...chosen.map((x) => x.fields)),
	};
}
/**
 * Runs over the newest 50 trips awaiting the owner (or the given new captures) through the same proposal
 * path. Stable idempotency keys per trip revision and suggestion make re-runs replay, not churn.
 */
export async function runSuggester(
	db: D1Database,
	p: MileagePrincipal,
	threshold: number,
	builtins: Category[],
	ids?: string[],
) {
	await requireLogic(() => db.prepare("SELECT 1 FROM mileage_proposals LIMIT 1").all());
	const base =
		"SELECT data FROM mileage_trips WHERE owner=? AND json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.human_reviewed')=0";
	const rows = ids
		? await db
				.prepare(`${base} AND id IN (SELECT value FROM json_each(?)) LIMIT 51`)
				.bind(p.owner, JSON.stringify(ids.slice(0, 50)))
				.all<{ data: string }>()
		: await db
				.prepare(`${base} ORDER BY json_extract(data,'$.started_at') DESC,id DESC LIMIT 51`)
				.bind(p.owner)
				.all<{ data: string }>();
	const trips = rows.results.slice(0, 50).map((r) => JSON.parse(r.data) as Trip);
	const items = await queueItems(db, p.owner, trips, []);
	const proposals: { trip_id: string; proposal_id: string; status: string; confidence: number }[] =
		[];
	let skipped = 0;
	for (const item of items) {
		const suggestion = suggest(item, threshold);
		if (!suggestion) {
			skipped++;
			continue;
		}
		const key = `suggest-${(await digest({ trip: item.id, revision: item.revision, suggestion })).slice(0, 48)}`;
		try {
			const result = await propose(
				db,
				p,
				item.id,
				{ ...suggestion, expected_revision: item.revision, idempotency_key: key },
				threshold,
				builtins,
			);
			proposals.push({
				trip_id: item.id,
				proposal_id: result.proposal.id,
				status: result.proposal.status,
				confidence: result.proposal.confidence,
			});
		} catch (error) {
			// The owner, a named agent or a newer capture got there first: leave the trip alone.
			if (error instanceof MileageError && [403, 404, 409].includes(error.status)) skipped++;
			else throw error;
		}
	}
	return { proposals, skipped, has_more: !ids && rows.results.length > 50 };
}
