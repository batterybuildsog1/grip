import { getConfiguredDomains } from "./platform";

export function ownerLocalParts(env: CloudflareBindings): string[] {
	return (env.OWNER_LOCAL_PARTS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export function ownerAddresses(env: CloudflareBindings): string[] {
	let names: string[] = [];
	try {
		names = Object.keys(JSON.parse(env.SENDER_NAMES_JSON || "{}"));
	} catch {
		/* no names */
	}
	return [
		...new Set(
			[
				...names,
				...getConfiguredDomains(env).flatMap((d) => ownerLocalParts(env).map((l) => `${l}@${d}`)),
			].map((a) => a.toLowerCase()),
		),
	];
}

export function isOwnerAddress(address: string, owners: string[], plus = true): boolean {
	const a = address.trim().toLowerCase();
	return owners.includes(a) || (plus && owners.includes(a.replace(/\+[^@]*(?=@)/, "")));
}

/** Memory-map scope contains domains and exact owner addresses; coworkers remain valid entities. */
export function ownershipScope(env: CloudflareBindings): string[] {
	const domains = getConfiguredDomains(env);
	const locals = ownerLocalParts(env);
	return [
		...domains,
		...(locals.length
			? domains.flatMap((d) => locals.map((l) => `${l}@${d}`))
			: ownerAddresses(env)),
	];
}
