/**
 * Email Routing entry point. Resolves the recipient, rejects unconfigured
 * domains, then hands the raw bytes to the one ingest path
 * (src/services/ingest.ts) and sends push notifications for new mail.
 *
 * Never throws once the raw copy is in R2 (v40 review 2 X3): a throwing
 * email() handler is retried and then permanently rejected, and the retry used
 * to hit the dedupe and lose the attachments. A failure after the write-ahead
 * is logged with the raw object key (replayable through import-raw).
 */
import { FULL_MAILBOX_OWNER } from "@/auth/principal";
import { ingestRawEmail } from "@/services/ingest";
import { now } from "@/utils/helpers";
import { logError, logInfo } from "@/utils/logging";
import {
	getConfiguredDomains,
	parseRecipientParts,
	resolveForwardedRecipient,
} from "@/utils/platform";
import { notifyWorkspacePush } from "@/utils/push";

export { resolveInboundHeaderAddresses } from "@/services/ingest";

export async function handleEmail(
	message: ForwardableEmailMessage,
	env: CloudflareBindings,
	ctx: ExecutionContext,
) {
	// Resolve forwarded addresses (e.g. relay@example.com → you@example.org, EMAIL_FORWARDING_MAP)
	const recipient = parseRecipientParts(resolveForwardedRecipient(env, message.to));
	const configuredDomains = getConfiguredDomains(env);

	if (configuredDomains.length > 0 && !configuredDomains.includes(recipient.domain)) {
		message.setReject(`Recipient domain ${recipient.domain} is not configured for this worker`);
		return;
	}

	// Before the write-ahead a failure must throw, so Email Routing retries or bounces
	// rather than silently accepting a message nobody stored.
	const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());

	const result = await ingestRawEmail(env, raw, {
		domain: recipient.domain,
		mailbox: recipient.mailbox,
		direction: "inbound",
		folder: "inbox",
		seen: false,
		lane: "live",
		source: "cloudflare-email-routing",
		sourceType: null,
		envelope: { from: message.from, to: recipient.normalizedAddress },
		receivedAt: now(),
		domainScope: configuredDomains,
		matchLegacy: false,
		rawIsOnlyCopy: true,
	});

	if (result.status === "rejected") {
		message.setReject(result.error);
		return;
	}
	if (result.status === "failed") {
		logError("inbound_email_failed", {
			to_address: message.to,
			from_address: message.from,
			stage: result.stage,
			error: result.error,
			raw_object_key: result.rawObjectKey,
		});
		if (!result.rawStored) {
			throw new Error(`Inbound email not stored (${result.stage}): ${result.error}`);
		}
		return;
	}

	logInfo("inbound_email_stored", {
		status: result.status,
		email_id: "emailId" in result ? result.emailId : null,
		from_address: message.from,
		to_address: message.to,
	});

	// Blocked senders go straight to Trash and skip notifications.
	if (
		result.status === "imported" &&
		!result.blockedSender &&
		env.VAPID_PUBLIC_KEY &&
		env.VAPID_PRIVATE_KEY
	) {
		const workspaceId = FULL_MAILBOX_OWNER;
		ctx.waitUntil(
			notifyWorkspacePush(env.D1, workspaceId, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY).catch(
				(err) => {
					logError("push_notify_failed", {
						workspace_id: workspaceId,
						error: err instanceof Error ? err.message : String(err),
					});
				},
			),
		);
	}
}
