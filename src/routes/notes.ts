/**
 * Action notes API (v55): the one write path for agents, and the list behind Personal's
 * "Needs you" strip (src/database/notes.ts). Scoped to the caller's
 * workspace domains like /api/conversations.
 */

import { Hono } from "hono";
import {
	formatDueDate,
	listOpenActionNotes,
	markActionNoteDone,
	normalizeActionNote,
	putActionNote,
} from "@/database/notes";
import type { AppVariables } from "@/types";
import { now } from "@/utils/helpers";
import { ERR, OK } from "@/utils/http";
import { getConfiguredDomains } from "@/utils/platform";

const notes = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();

// GET /api/notes — open notes, dated first (soonest due on top), then newest received
notes.get("/api/notes", async (c) => {
	const domainScope = getConfiguredDomains(c.env);
	const list = await listOpenActionNotes(c.env.D1, now(), domainScope);
	return c.json(OK({ notes: list }));
});

// PUT /api/notes/:email_id {note, due?: "YYYY-MM-DD" | null} — set the note and reopen it
notes.put("/api/notes/:email_id", async (c) => {
	let body: Record<string, unknown>;
	try {
		const parsed = await c.req.json();
		body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}
	const { note, due, error } = normalizeActionNote(body.note, body.due);
	if (!note) return c.json(ERR("INVALID_BODY", "note is required"), 400);
	if (error) return c.json(ERR("INVALID_BODY", error), 400);

	const domainScope = getConfiguredDomains(c.env);
	const emailId = c.req.param("email_id");
	if (!(await putActionNote(c.env.D1, emailId, note, due, domainScope))) {
		return c.json(ERR("NOT_FOUND", "Email not found"), 404);
	}
	return c.json(OK({ email_id: emailId, note, due: formatDueDate(due) }));
});

// POST /api/notes/:email_id/done — take the note off the strip
notes.post("/api/notes/:email_id/done", async (c) => {
	const domainScope = getConfiguredDomains(c.env);
	const emailId = c.req.param("email_id");
	if (!(await markActionNoteDone(c.env.D1, emailId, now(), domainScope))) {
		return c.json(ERR("NOT_FOUND", "No note on this email"), 404);
	}
	return c.json(OK({ email_id: emailId, done: true }));
});

export default notes;
