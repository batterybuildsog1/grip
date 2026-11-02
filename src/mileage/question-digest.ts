/** Disconnected optional channel: no scheduler, env flag, fetch or outbound transport by default. */
export interface QuestionDigestMarker {
	day: string;
	questionIds: string[];
}
export interface QuestionDigestInput {
	enabled?: boolean;
	owner: string;
	appUrl: string;
	now: number;
	/** IANA zone for the 18:00 cutoff and the local day: pass env.INSTANCE_TIME_ZONE. Unset = UTC. */
	timeZone?: string;
	/** Current pending question IDs, across all pages; no trip text needed. */
	questions: { id: string }[];
	lastSent: QuestionDigestMarker | null;
}
export interface QuestionDigest extends QuestionDigestMarker {
	owner: string;
	key: string;
	subject: string;
	body: string;
}
export interface QuestionNotifier {
	/** Resolves only on confirmed provider acceptance. Throws on unknown/in-flight/failed delivery. */
	send(digest: QuestionDigest): Promise<void>;
}
export const nullQuestionNotifier: QuestionNotifier | null = null;

/** Pure plan: new pending questions only; at/after 18:00 in `timeZone`, at most one digest per local day. */
export async function buildQuestionDigest(
	input: QuestionDigestInput,
): Promise<QuestionDigest | null> {
	if (input.enabled !== true) return null;
	if (!Number.isFinite(input.now) || !/^[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+$/.test(input.owner))
		throw new Error("Invalid digest owner/time");
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: input.timeZone || "UTC",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(input.now);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	const day = `${part("year")}-${part("month")}-${part("day")}`;
	if (Number(part("hour")) < 18 || (input.lastSent && input.lastSent.day >= day)) return null;
	const questionIds = [...new Set(input.questions.map((q) => q.id))].sort();
	if (questionIds.some((id) => !/^[A-Za-z0-9_-]+:[0-9]+$/.test(id)))
		throw new Error("Invalid question ID");
	const seen = new Set(input.lastSent?.questionIds ?? []);
	const fresh = questionIds.filter((id) => !seen.has(id));
	if (!fresh.length) return null;
	const link = new URL(input.appUrl);
	if (
		(link.protocol !== "https:" &&
			!(
				link.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(link.hostname)
			)) ||
		link.username ||
		link.password ||
		link.search ||
		link.hash
	)
		throw new Error("Digest needs an app URL without credentials, query or fragment");
	link.search = new URLSearchParams({ view: "mileage", filter: "questions" }).toString();
	const ownerHash = [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.owner.toLowerCase())),
		),
	]
		.map((n) => n.toString(16).padStart(2, "0"))
		.join("");
	return {
		owner: input.owner,
		day,
		questionIds,
		key: `mileage-questions:${ownerHash}:${day}`,
		subject: "Mileage questions",
		body: `${fresh.length} mileage ${fresh.length === 1 ? "question needs" : "questions need"} review.\n${link.href}`,
	};
}

/** Inject a CLI runner, never a second email API. No subprocess is started by this module. */
export function mailclawSelfEmailNotifier(
	run: (args: string[]) => Promise<{ state: string }>,
): QuestionNotifier {
	return {
		async send(message) {
			const result = await run([
				"send",
				"--from",
				message.owner,
				"--to",
				message.owner,
				"--subject",
				message.subject,
				"--body",
				message.body,
				"--key",
				message.key,
			]);
			if (result.state !== "sent")
				throw new Error(
					`Digest delivery ${result.state}; retain original payload/key and inspect MailClaw before retry`,
				);
		},
	};
}

/** Caller must persist returned marker. Stable MailClaw owner/day key guards duplicate attempts.
 * Freeze plan+key durably before a real send; on an error retain them for inspection/same-key retry.
 * This optional function is not connected to a route, cron, scheduled job or runtime configuration.
 */
export async function deliverQuestionDigest(
	input: QuestionDigestInput,
	notifier: QuestionNotifier | null = nullQuestionNotifier,
): Promise<QuestionDigestMarker | null> {
	if (!notifier || input.enabled !== true) return null;
	const message = await buildQuestionDigest(input);
	if (!message) return null;
	await notifier.send(message);
	return { day: message.day, questionIds: message.questionIds };
}
