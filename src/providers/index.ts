import { getEmailProviderName, getSendMode, getSmtpAccountConfig } from "@/utils/platform";
import { CloudflareProvider } from "./cloudflare";
import { RecordProvider } from "./record";
import { SmtpProvider } from "./smtp";
import { type EmailProvider, EmailProviderError } from "./types";

/**
 * The provider that sends for a sender domain (routing: getEmailProviderName). The ONLY place a
 * real provider is built: every send (new, reply, draft, idempotent retry, unsubscribe mailto,
 * morning report) reaches it through sendAndPersistEmail (src/routes/emails.ts).
 * SEND_MODE=record returns the record provider before any real one exists; an unknown SEND_MODE
 * refuses to send at all, so a typo on the demo can never transmit.
 */
export function createEmailProvider(env: CloudflareBindings, senderDomain: string): EmailProvider {
	const mode = getSendMode(env);
	if (mode === "record") return new RecordProvider(senderDomain);
	if (mode === "invalid") {
		throw new EmailProviderError("SEND_MODE must be unset, live or record", {
			status: 503,
			code: "SEND_MODE_INVALID",
		});
	}
	switch (getEmailProviderName(env, senderDomain)) {
		case "smtp": {
			const config = getSmtpAccountConfig(env, senderDomain);
			if (config) return new SmtpProvider(config);
			break;
		}
		case "cloudflare":
			if (!env.EMAIL) {
				throw new EmailProviderError(
					"Cloudflare EMAIL binding is not configured (add send_email to wrangler.jsonc)",
					{ status: 503, code: "PROVIDER_NOT_CONFIGURED" },
				);
			}
			return new CloudflareProvider(env.EMAIL);
	}
	throw new EmailProviderError(
		`No send provider for ${senderDomain || "this sender"}: add the domain to SMTP_ACCOUNTS_JSON or EMAIL_PROVIDERS_JSON`,
		{ status: 503, code: "PROVIDER_NOT_CONFIGURED" },
	);
}
