import { Hono } from "hono";
import { restrictedPersons } from "@/auth/principal";
import { getCombinedMetaStats } from "@/database/d1";
import { restrictedMeta } from "@/middleware/access";
import type { AppVariables, PlatformMeta } from "@/types";
import { ERR, OK } from "@/utils/http";
import { buildPlatformMeta, getConfiguredDomains } from "@/utils/platform";

const meta = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>();

meta.get("/api/meta", async (c) => {
	const persons = restrictedPersons(c);
	if (persons) return c.json(OK(await restrictedMeta(c, persons)));

	// Scope [] (every domain): a domain filter that spans everything is a no-op the SQLite planner
	// mistakes for selective, forcing a TEMP B-TREE on the category GROUP BY.
	const { stats, conversationStats } = await getCombinedMetaStats(
		c.env.D1,
		getConfiguredDomains(c.env),
		[],
	);

	if (stats.error) {
		return c.json(ERR("D1_ERROR", stats.error.message), 500);
	}

	const payload: PlatformMeta = buildPlatformMeta(c.env, stats, conversationStats);

	return c.json(OK(payload));
});

export default meta;
