/**
 * What an answer has chosen so far, per trip, kept while Mileage is open (fields keep what was typed
 * across re-renders and j/k). Filing reads it. Each field remembers who set it ("agent" until you change
 * or confirm it, lead ruling L4). The rules here only mirror what the server refuses (PURPOSE_REQUIRED,
 * Acme's reimbursable), so the screen asks before it sends.
 */
import { createSignal } from "solid-js";
import type { MileageCompany, MileageReport, MileageTripView } from "../../api/mileage";

export type Who = "agent" | "you";
export interface Draft {
	company_id: string | null;
	reimbursable: boolean | null;
	purpose: string;
	/** What you call the destination ("Name it"). */
	name: string;
	/** Checked: the name becomes a saved place; unchecked: this trip only. */
	saveAsPlace: boolean;
	/** File the drive back the same way (on by default). */
	withBack: boolean;
	who: { company?: Who; reimbursable?: Who; purpose?: Who };
	/** It started as the agent's guess (Yes files the guess unless a field was changed). */
	guess: boolean;
}

const [drafts, setDrafts] = createSignal<Record<string, Draft>>({});
/** Trips whose Change is open (the guess's or a filed trip's fields). */
const [changing, setChanging] = createSignal<ReadonlySet<string>>(new Set());

export function initialDraft(t: MileageTripView): Draft {
	const base = { name: "", saveAsPlace: true, withBack: true };
	if (t.state === "proposal" && t.proposal)
		return {
			...base,
			company_id: t.proposal.company_id,
			reimbursable: t.proposal.reimbursable,
			purpose: t.proposal.purpose ?? "",
			who: { company: "agent", reimbursable: "agent", purpose: "agent" },
			guess: true,
		};
	if (t.state === "filed" || t.state === "auto") {
		const w: Who = t.set_by === "agent" ? "agent" : "you";
		return {
			...base,
			company_id: t.company_id,
			reimbursable: t.reimbursable,
			purpose: t.purpose ?? "",
			who: { company: w, reimbursable: w, purpose: w },
			guess: false,
		};
	}
	return { ...base, company_id: null, reimbursable: null, purpose: "", who: {}, guess: false };
}

export const hasDraft = (t: MileageTripView) => t.id in drafts();
export const draftOf = (t: MileageTripView): Draft => drafts()[t.id] ?? initialDraft(t);

/** Changes a field and marks it yours; choosing a company resets what belonged to the old one. */
export function setDraft(t: MileageTripView, patch: Partial<Draft>) {
	const d = { ...draftOf(t), ...patch, who: { ...draftOf(t).who } };
	if (patch.company_id !== undefined) {
		d.who.company = "you";
		if (patch.company_id !== draftOf(t).company_id && patch.reimbursable === undefined) {
			d.reimbursable = null;
			d.who.reimbursable = undefined;
		}
		// The agent's purpose for this trip (a guess or a hint) fills in when it can.
		const hint = t.proposal?.purpose ?? "";
		if (!d.purpose && hint) {
			d.purpose = hint;
			d.who.purpose = "agent";
		}
	}
	if (patch.reimbursable !== undefined) d.who.reimbursable = "you";
	if (patch.purpose !== undefined) d.who.purpose = "you";
	setDrafts((all) => ({ ...all, [t.id]: d }));
}
export function dropDraft(id: string) {
	setDrafts((all) => {
		const { [id]: _, ...rest } = all;
		return rest;
	});
	setChange(id, false);
}

export const isChanging = (id: string) => changing().has(id);
export function setChange(id: string, on: boolean) {
	setChanging((prev) => {
		const next = new Set(prev);
		if (on) next.add(id);
		else next.delete(id);
		return next;
	});
}

/** The guess was changed by you (it then files only with File, never with a blind Yes). */
export const changedGuess = (d: Draft) =>
	d.guess && (d.who.company === "you" || d.who.reimbursable === "you" || d.who.purpose === "you");

/** Business trips need a purpose (the server's PURPOSE_REQUIRED). */
export const needsPurpose = (c: MileageCompany | undefined) => !!c && c.treatment !== "personal";

/** What the draft still lacks before it can be filed, in words; null when it can be filed. */
export function missing(c: MileageCompany | undefined, d: Draft): string | null {
	if (!c) return "Choose a company";
	if (c.split_reimbursable && d.reimbursable === null)
		return `Choose reimbursable or not to file it as ${c.name}`;
	if (needsPurpose(c) && !d.purpose.trim()) return `${c.name} trips need a purpose for the IRS log`;
	return null;
}

/** The unanswered drive back of this trip, if the report has one. */
export const backOf = (r: MileageReport, t: MileageTripView) =>
	r.trips.find((x) => x.return_of === t.id && (x.state === "ask" || x.state === "proposal"));

/** The destination has no name yet (an address or coordinates): the answer offers "Name it". */
export const unnamed = (t: MileageTripView) =>
	t.end.name_source === "address" || t.end.name_source === "coordinates";
