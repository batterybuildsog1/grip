import type { SendEmailRequest, SendEmailResponse } from "@/types";
import type { EmailProvider } from "./types";

/**
 * SEND_MODE=record (the App Store review instance, SPEC §4): a send is accepted and stored in
 * Sent like any other, and nothing is transmitted. No network, no binding, no SMTP socket. The
 * id is an RFC 5322 Message-ID on the sender's domain, so replies thread as usual.
 */
export class RecordProvider implements EmailProvider {
	readonly name = "record";

	constructor(private readonly senderDomain: string) {}

	async send(_request: SendEmailRequest): Promise<SendEmailResponse> {
		return {
			id: `<${crypto.randomUUID()}@${this.senderDomain || "record.invalid"}>`,
			provider: this.name,
			response: "recorded, not transmitted (SEND_MODE=record)",
		};
	}
}
