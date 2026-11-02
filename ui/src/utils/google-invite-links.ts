import type { Email } from "../types";

function parseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

export function isGoogleCalendarUrl(value: string): boolean {
	const url = parseUrl(value);
	if (!url) return false;

	const host = url.hostname.toLowerCase();
	return (
		host === "calendar.google.com" ||
		((host === "google.com" || host.endsWith(".google.com")) &&
			url.pathname.toLowerCase().includes("/calendar"))
	);
}

export function isGoogleMeetUrl(value: string): boolean {
	const url = parseUrl(value);
	return url?.hostname.toLowerCase() === "meet.google.com";
}

export function withGoogleInviteAuthUser(value: string, invitedEmail: string | null): string {
	if (!invitedEmail || (!isGoogleCalendarUrl(value) && !isGoogleMeetUrl(value))) {
		return value;
	}

	const url = parseUrl(value);
	if (!url || url.searchParams.has("authuser")) {
		return value;
	}

	url.searchParams.set("authuser", invitedEmail);
	return url.toString();
}

export function inferGoogleInviteAccount(email: Email): string | null {
	const domainSuffix = `@${email.domain.toLowerCase()}`;
	const candidates = [
		...email.to_addresses,
		...email.cc_addresses,
		...email.bcc_addresses,
		email.to_address,
	];

	const workspaceAddress = candidates.find((address) =>
		address.toLowerCase().endsWith(domainSuffix),
	);
	return workspaceAddress ?? candidates[0] ?? null;
}
