/**
 * Fault injection for tests/e2e/send-race.e2e.sh (ticket 08). It makes the send path fail or
 * stall at a named storage boundary, so the E2E can kill a preparer or a dispatcher where a
 * crash would, on production.
 *
 *   X-MailClaw-Test-Fault: POINT=ACTION[,POINT=ACTION]     (POST /api/emails/send only)
 *   ACTION  abort    throw, as a failed D1/R2 call would
 *           stall:N  sleep N seconds (at most 180) and continue
 *           error    POINT=lookup only: the key lookup reports a D1 error
 *   POINT   lookup, prepare.reserved, prepare.body, prepare.object.<i>, prepare.objects,
 *           prepare.rows, prepare.ready, dispatch.begun, dispatch.accepted
 *
 * Honoured only when both hold; otherwise the header is ignored:
 * - the caller authenticated with API_TOKEN itself. The web proxy (ui/functions/api/[[path]].ts)
 *   strips Authorization, so no browser request can arm it. API_TOKEN_PREVIOUS is refused too.
 * - every recipient (to, cc, bcc) is the instance's own test mailbox, e2e@<SEND_TEST_DOMAIN>
 *   or e2e+TAG@<SEND_TEST_DOMAIN>, so a fault can only ever touch test mail.
 */
import type { Context } from "hono";
import type { AppVariables, SendFaultAction } from "@/types";
import { getRequestContext, logWarn } from "@/utils/logging";

type AppContext = Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>;

const TEST_LOCAL_PART = /^e2e(\+[a-z0-9._-]+)?$/i;
const POINT =
	/^(lookup|prepare\.(reserved|body|objects|rows|ready|object\.\d{1,2})|dispatch\.(begun|accepted))$/;
const MAX_STALL_SECONDS = 180;

function parseAction(point: string, value: string): SendFaultAction | null {
	if (value === "abort" && point !== "lookup") return { kind: "abort" };
	if (value === "error" && point === "lookup") return { kind: "error" };
	const stall = /^stall:(\d{1,3})$/.exec(value);
	if (stall && point !== "lookup") {
		return { kind: "stall", seconds: Math.min(Number(stall[1]), MAX_STALL_SECONDS) };
	}
	return null;
}

/** Arm the request's faults if the header is present and allowed for these recipients. */
export function armSendFault(c: AppContext, recipients: string[]): void {
	const header = c.req.header("X-MailClaw-Test-Fault");
	if (!header) return;
	const token = c.get("authToken");
	const apiToken = c.env.API_TOKEN;
	const allowed =
		Boolean(apiToken) &&
		token === apiToken &&
		recipients.length > 0 &&
		Boolean(c.env.SEND_TEST_DOMAIN?.trim()) &&
		recipients.every((address) => {
			const [local, domain] = address.trim().toLowerCase().split("@");
			return TEST_LOCAL_PART.test(local) && domain === c.env.SEND_TEST_DOMAIN?.trim().toLowerCase();
		});
	if (!allowed) {
		logWarn("send_fault_ignored", { ...getRequestContext(c), header: header.slice(0, 200) });
		return;
	}
	const faults = new Map<string, SendFaultAction>();
	for (const part of header.split(",")) {
		const [point = "", value = ""] = part.split("=").map((item) => item.trim());
		const action = POINT.test(point) ? parseAction(point, value) : null;
		if (action) faults.set(point, action);
	}
	if (faults.size === 0) return;
	c.set("sendFault", faults);
	logWarn("send_fault_armed", { ...getRequestContext(c), faults: [...faults.keys()] });
}

/** Run the fault armed at `point`, if any: throws for abort, sleeps for stall. */
export async function sendFault(c: AppContext, point: string): Promise<void> {
	const action = c.get("sendFault")?.get(point);
	if (!action || action.kind === "error") return;
	if (action.kind === "stall") {
		await new Promise((resolve) => setTimeout(resolve, action.seconds * 1000));
		return;
	}
	throw new Error(`test fault injected at ${point}`);
}

/** True when POINT=error is armed (the key lookup must report a failure). */
export function sendFaultFails(c: AppContext, point: string): boolean {
	return c.get("sendFault")?.get(point)?.kind === "error";
}
