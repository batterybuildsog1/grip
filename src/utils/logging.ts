import type { Context } from "hono";
import type { AppVariables } from "@/types";

type LogLevel = "info" | "warn" | "error";

function writeLog(level: LogLevel, event: string, fields: Record<string, unknown>) {
	const payload = {
		level,
		event,
		timestamp: new Date().toISOString(),
		...fields,
	};

	const line = JSON.stringify(payload);

	switch (level) {
		case "error":
			console.error(line);
			return;
		case "warn":
			console.warn(line);
			return;
		default:
			console.log(line);
	}
}

export function createRequestId(): string {
	return crypto.randomUUID();
}

export function getRequestContext(
	c: Context<{ Bindings: CloudflareBindings; Variables: AppVariables }>,
) {
	const principal = c.get("principal");

	return {
		request_id: c.get("requestId") || null,
		principal: principal?.kind ?? null,
		user_id: principal?.kind === "user" ? principal.user.id : null,
		method: c.req.method,
		path: c.req.path?.replace(/^(\/api\/public\/attachments\/)[^/]+/, "$1<redacted>"),
	};
}

export function logInfo(event: string, fields: Record<string, unknown>) {
	writeLog("info", event, fields);
}

export function logWarn(event: string, fields: Record<string, unknown>) {
	writeLog("warn", event, fields);
}

export function logError(event: string, fields: Record<string, unknown>) {
	writeLog("error", event, fields);
}
