// Extend CloudflareBindings with secrets not in wrangler.jsonc
interface CloudflareBindings {
	AI_HUB_URL?: string; // customer-isolated Responses /v1 endpoint
	AI_HUB_KEY?: string; // the customer's own hub credential
	AI_HUB_SEAT?: string; // grip-<AI_INSTANCE_ID>; the customer's own seat, never the operator's
	AI_BILLING_MODE?: string; // unset legacy unlimited; explicit unlimited/metered
	AI_INSTANCE_ID?: string;
	AI_RATE_PPM?: string; // metered price as a multiple of provider cost, in millionths (1-2,000,000)
	AI_FREE_NANO?: string; // monthly free API-equivalent USD nanodollars

	SEND_TEST_DOMAIN?: string; // explicit e2e mailbox domain for API-token fault injection; unset = off
	INSTANCE_TIME_ZONE?: string; // morning-report fallback / empty mileage report timezone; unset = UTC
	MEMORY_MAP_PRESENTATION_JSON?: string; // {counter_field, writes_label}; neutral defaults
	OWNER_LOCAL_PARTS?: string; // CSV explicit owner aliases on MAIL_DOMAINS; unset = none
	MORNING_REPORT_IDENTITY_JSON?: string; // {names, attention_names, excluded_local_parts, support_addresses}: string[] fields
	PROTECTED_SENDER_DOMAINS?: string; // CSV additional domains; MAIL_DOMAINS always protected
	SYSTEM_MAIL_RULES_JSON?: string; // optional automation rules; unset = off
	MILEAGE_D1?: D1Database; // dedicated optional mileage store, never mail D1
	MILEAGE_OWNER_EMAILS?: string; // exact normalized human owner emails, CSV; unset fails closed
	MILEAGE_GOOGLE_CALENDAR_ALLOWLIST_JSON?: string; // owner email -> explicit Google allowlist array
	MILEAGE_GOOGLE_CALENDAR_SOURCES_JSON?: string; // owner email -> approved sources/site policies
	MILEAGE_GOOGLE_CALENDAR_CREDENTIALS_JSON?: string; // owner email -> dedicated read-only OAuth credentials
	MILEAGE_CALENDAR_ALLOWLIST?: string; // approved calendar IDs, CSV; unset rejects ingest
	MILEAGE_AGENT_AUTO_CONFIDENCE?: string; // agent proposals at or above this auto-apply (default 0.9)
	MILEAGE_RATE_LIMIT?: string; // mileage requests a minute per owner (default 240; local fixtures raise it)
	MILEAGE_TODAY?: string; // local fixtures only: the report's "today" (YYYY-MM-DD) instead of the clock
	MILEAGE_SUGGEST_ON_CAPTURE?: string; // "0"/"off" stops the built-in suggester after capture (default on)
	APNS_KEY_P8?: string; // PKCS#8 signing key, secret binding only
	APNS_KEY_ID?: string;
	APNS_TEAM_ID?: string; // your Apple Developer team ID when provisioned; unset = push disabled
	APNS_TOPIC?: string; // operator bundle ID; unset = push disabled

	API_TOKEN?: string;
	API_TOKEN_PREVIOUS?: string; // accepted only during a rotation grace period
	ANTHROPIC_BASE_URL?: string; // Anthropic Messages endpoint base; unset = api.anthropic.com
	EMAIL_PROVIDERS_JSON?: string; // per-domain override: { "example.com": "cloudflare" }
	SENDER_NAMES_JSON?: string; // From display name per address: { "you@example.com": "Your Name" }
	HOME_ALERTS_JSON?: string; // Home Alerts sub-folders: [{ "domain": "sensor-vendor.example", "label": "Customer — Sensor" }]
	FORWARDED_FOR_JSON?: string; // forwarded-in Gmail owner per address: { "someone@example.com": "Name" }
	MORNING_REPORT_JSON?: string; // daily report: { from, to, time_zone, hour }; unset = off
	AUTO_READ_SENDERS_JSON?: string; // [{ from | for, days }]: mail from / forwarded in for an address goes read after days
	SEND_MODE?: string; // unset/"live" = send; "record" = store in Sent, transmit nothing (demo)
	MILEAGE_COMPANIES_JSON?: string; // built-in trip companies [{id,name,treatment}]; unset = Personal only
	ALLOWED_ORIGINS?: string; // CSV list of allowed browser origins for CORS
	MAIL_DOMAINS?: string; // CSV: the domains MailClaw serves (inbound, From check, meta, scope)
	// Cloudflare Access in front of the web UI (ticket 09): the web's identity is the Access JWT.
	ACCESS_TEAM_DOMAIN?: string; // https://<team>.cloudflareaccess.com
	ACCESS_AUD?: string; // the Access application's AUD tag; unset = Access JWTs refused
	// {"<service token client id>": "<users.email>"}: only these service tokens act as a person
	ACCESS_SERVICE_TOKENS_JSON?: string;
	ATTACHMENTS?: R2Bucket;
	// HMAC key for signed, expiring attachment download links (v34 attachment
	// search tier). Set via `wrangler secret put ATTACHMENT_LINK_SECRET`
	// (openssl rand -hex 32). Rotating it only invalidates outstanding signed
	// links — it is NOT part of the API_TOKEN auth model.
	ATTACHMENT_LINK_SECRET?: string;
	UI_ORIGIN?: string;
	SMTP_ACCOUNTS_JSON?: string; // JSON: { "domain.com": { host, port, username, password } }
	EMAIL_FORWARDING_MAP?: string; // JSON: { "forwarding-addr@example.com": "real-addr@example.com" }
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	ALLOWED_SENDERS?: string; // CSV list of allowed from addresses (e.g. "you@example.com,noreply@example.com")
	ANTHROPIC_API_KEY?: string;
	COMPOSE_RTE_ENABLED?: string;
}
