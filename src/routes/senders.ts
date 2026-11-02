/**
 * Blocked-sender management (v33). Block = "Trash all + future":
 * POST creates the block AND sweeps existing non-trash mail from the
 * sender into Trash (state change only — content is never deleted).
 * Ingest paths enforce blocks on every new inbound email.
 */
import { Hono } from "hono";
import {
	createBlockedSender,
	deleteBlockedSenderById,
	listBlockedSenders,
	sweepBlockedSender,
	validateBlockPattern,
} from "@/database/blocked-senders";
import type { AppVariables } from "@/types";
import { ERR, OK } from "@/utils/http";
import { getRequestContext, logInfo } from "@/utils/logging";
import { getConfiguredDomains } from "@/utils/platform";
import { blockSenderSchema } from "@/utils/validation";

const senders = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();

/** Protect instance domains and explicitly configured additional domains. */
function getProtectedDomains(env: CloudflareBindings): string[] {
	return [
		...new Set([
			...getConfiguredDomains(env),
			...(env.PROTECTED_SENDER_DOMAINS ?? "")
				.split(",")
				.map((d) => d.trim().toLowerCase())
				.filter(Boolean),
		]),
	];
}

// GET /api/senders/blocked - list all block entries
senders.get("/api/senders/blocked", async (c) => {
	const { blocked, error } = await listBlockedSenders(c.env.D1);
	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	return c.json(OK({ blocked }));
});

// POST /api/senders/block - create a block + sweep existing mail to Trash
senders.post("/api/senders/block", async (c) => {
	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json(ERR("INVALID_BODY", "Request body must be valid JSON"), 400);
	}

	const parsed = blockSenderSchema.safeParse(payload);
	if (!parsed.success) {
		return c.json(ERR("INVALID_BODY", parsed.error.issues.map((i) => i.message).join("; ")), 400);
	}

	const validated = validateBlockPattern(
		parsed.data.pattern_type,
		parsed.data.pattern,
		getProtectedDomains(c.env),
	);
	if (!validated.ok) {
		return c.json(ERR("INVALID_PATTERN", validated.reason), 400);
	}

	const created = await createBlockedSender(c.env.D1, {
		pattern_type: parsed.data.pattern_type,
		pattern: validated.pattern,
		note: parsed.data.note || null,
	});
	if (created.conflict) {
		return c.json(ERR("ALREADY_BLOCKED", "This sender is already blocked"), 409);
	}
	if (created.error || !created.blocked) {
		return c.json(ERR("D1_ERROR", created.error?.message || "Failed to create block"), 500);
	}

	const sweep = await sweepBlockedSender(c.env.D1, parsed.data.pattern_type, validated.pattern);
	if (sweep.error) {
		// The block itself was created and will apply to future mail; surface
		// the sweep failure without rolling that back.
		return c.json(
			ERR("SWEEP_FAILED", `Sender blocked, but sweep failed: ${sweep.error.message}`),
			500,
		);
	}

	logInfo("sender_blocked", {
		...getRequestContext(c),
		pattern_type: parsed.data.pattern_type,
		pattern: validated.pattern,
		swept_count: sweep.swept,
	});

	return c.json(OK({ blocked: created.blocked, swept_count: sweep.swept }));
});

// DELETE /api/senders/block/:id - remove a block (does not restore mail)
senders.delete("/api/senders/block/:id", async (c) => {
	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id) || id <= 0) {
		return c.json(ERR("INVALID_ID", "Block id must be a positive integer"), 400);
	}

	const { deleted, error } = await deleteBlockedSenderById(c.env.D1, id);
	if (error) return c.json(ERR("D1_ERROR", error.message), 500);
	if (!deleted) return c.json(ERR("NOT_FOUND", "Block not found"), 404);

	logInfo("sender_unblocked", { ...getRequestContext(c), block_id: id });
	return c.json(OK({ message: "Sender unblocked" }));
});

export default senders;
