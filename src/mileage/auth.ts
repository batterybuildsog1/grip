import { accessConfig, verifyAccessJwt } from "@/auth/access-jwt";
import { hashToken } from "@/auth/principal";
import { findAccessUser, findSessionUser } from "@/database/users";
import { tokensMatch } from "@/utils/platform";

export class MileageError extends Error {
	constructor(
		public code: string,
		message: string,
		public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 503 | 504 = 400,
	) {
		super(message);
	}
}
export interface MileagePrincipal {
	owner: string;
	actor: string;
	human: boolean;
	scopes: string[];
	entities: string[];
	tokenId?: string;
}
export const csvList = (v: string | undefined) =>
	v
		?.split(",")
		.map((x) => x.trim().toLowerCase())
		.filter(Boolean) ?? [];
export async function identify(
	request: Request,
	env: CloudflareBindings,
): Promise<MileagePrincipal> {
	const owners = csvList(env.MILEAGE_OWNER_EMAILS);
	if (!env.MILEAGE_D1 || !owners.length)
		throw new MileageError(
			"MILEAGE_UNAVAILABLE",
			"Mileage binding and explicit owners must be configured",
			503,
		);
	const auth = request.headers.get("Authorization");
	let email: string | undefined;
	if (auth) {
		if (!/^Bearer [A-Za-z0-9_-]{1,256}$/.test(auth))
			throw new MileageError("UNAUTHORIZED", "Invalid mileage credential", 401);
		const token = auth.slice(7);
		if (
			(env.API_TOKEN && tokensMatch(token, env.API_TOKEN)) ||
			(env.API_TOKEN_PREVIOUS && tokensMatch(token, env.API_TOKEN_PREVIOUS))
		)
			throw new MileageError("UNAUTHORIZED", "Mail API credentials do not authorize mileage", 401);
		if (token.startsWith("mlg_")) {
			const row = await env.MILEAGE_D1.prepare(
				"SELECT * FROM mileage_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
			)
				.bind(await hashToken(token), Date.now())
				.first<{ id: string; owner: string; scopes: string; entity_ids: string }>();
			if (!row || !owners.includes(row.owner))
				throw new MileageError("UNAUTHORIZED", "Unknown or revoked mileage credential", 401);
			// An owner whose account is being deleted (v64 users.disabled_at) lends no credential.
			const disabled = await env.D1.prepare(
				"SELECT 1 FROM users WHERE email = ? AND disabled_at IS NOT NULL",
			)
				.bind(row.owner)
				.first();
			if (disabled) throw new MileageError("ACCOUNT_DELETED", "This account is being deleted", 401);
			return {
				owner: row.owner,
				actor: `agent:${row.id}`,
				human: false,
				scopes: JSON.parse(row.scopes),
				entities: JSON.parse(row.entity_ids),
				tokenId: row.id,
			};
		}
		const user = token.length >= 32 ? await findSessionUser(env.D1, token) : null;
		if (user && !user.session.borrowed) email = user.email;
	} else {
		const jwt = request.headers.get("Cf-Access-Jwt-Assertion"),
			config = accessConfig(env);
		if (jwt && config) {
			const verdict = await verifyAccessJwt(jwt, config);
			if (verdict.ok && verdict.identity.kind === "person") {
				const user = await findAccessUser(env.D1, verdict.identity.email);
				if (
					user &&
					user.disabled_at === null &&
					(user.signed_out_at === null || verdict.identity.issuedAt > user.signed_out_at)
				)
					email = user.email;
			}
		}
	}
	if (!email)
		throw new MileageError(
			"UNAUTHORIZED",
			"A human session or named mileage credential is required",
			401,
		);
	email = email.trim().toLowerCase();
	if (!owners.includes(email))
		throw new MileageError("FORBIDDEN", "This person is not a mileage owner", 403);
	return { owner: email, actor: `human:${email}`, human: true, scopes: [], entities: [] };
}
export function requireHuman(p: MileagePrincipal) {
	if (!p.human)
		throw new MileageError("OWNER_REQUIRED", "Only the owner can perform this action", 403);
}
export function requireScope(p: MileagePrincipal, scope: string, entity?: string | null) {
	if (p.human) return;
	if (
		!p.scopes.includes(scope) ||
		(entity !== undefined && (!entity || entity === "personal" || !p.entities.includes(entity)))
	)
		throw new MileageError("FORBIDDEN", "Mileage scope or entity is not granted", 403);
}
