import type { SendEmailRequest, SendEmailResponse } from "@/types";

export interface EmailProvider {
	readonly name: string;
	send(request: SendEmailRequest): Promise<SendEmailResponse>;
}

export class EmailProviderError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	/**
	 * Whether the message certainly did not go out. Defaults to `status < 500`;
	 * a provider that knows better (SMTP: any failure before the end of DATA)
	 * says so, because the send key never retries an uncertain outcome.
	 */
	readonly definite: boolean;

	constructor(
		message: string,
		options?: { status?: number; code?: string; details?: unknown; definite?: boolean },
	) {
		super(message);
		this.name = "EmailProviderError";
		this.status = options?.status ?? 500;
		this.code = options?.code ?? "EMAIL_PROVIDER_ERROR";
		this.details = options?.details;
		this.definite = options?.definite ?? this.status < 500;
	}
}

export interface SmtpAccountConfig {
	host: string;
	port: number;
	username: string;
	password: string;
}
