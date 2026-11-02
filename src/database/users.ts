/** Users, grants and sessions (v56, ticket 09). Every token is stored as its SHA-256 only. */
import { createId } from "@paralleldrive/cuid2";
import {
	FULL_MAILBOX_OWNER,
	type Grant,
	hashToken,
	newToken,
	PASSWORD_LINK_MS,
	type SessionUser,
} from "@/auth/principal";
import {
	clearLoginAttemptsStatement,
	type LoginKeys,
	loginSubject,
	loginSucceededStatements,
} from "@/database/login-attempts";

/** Sessions that authenticate API calls. password_link rows never do. */
const SIGN_IN_KINDS = "('web', 'app')";
const TOUCH_EVERY_MS = 60 * 60 * 1000;

function parseGrants(value: unknown): Grant[] {
	try {
		const grants = JSON.parse(String(value ?? "[]")) as Grant[];
		return grants
			.filter((grant) => grant && typeof grant.kind === "string")
			.sort((a, b) => `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`));
	} catch {
		return [];
	}
}

const GRANTS_SQL = `(SELECT json_group_array(json_object('kind', g.kind, 'value', g.value))
	FROM user_grants g WHERE g.user_id = u.id)`;

/** The signed-in user behind a token, or null when it is unknown, revoked or expired. */
export async function findSessionUser(
	db: D1Database,
	token: string,
	now = Date.now(),
): Promise<SessionUser | null> {
	const row = await db
		.prepare(
			`SELECT s.id AS session_id, s.kind, s.borrowed, s.created_at, s.expires_at, s.last_seen_at,
				u.id, u.email, u.name, u.is_admin, u.owner_key, ${GRANTS_SQL} AS grants
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ? AND s.kind IN ${SIGN_IN_KINDS}
			   AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL`,
		)
		.bind(await hashToken(token), now)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		id: String(row.id),
		email: String(row.email),
		name: row.name == null ? null : String(row.name),
		is_admin: Number(row.is_admin) === 1,
		owner_key: row.owner_key == null ? null : String(row.owner_key),
		grants: parseGrants(row.grants),
		session: {
			id: String(row.session_id),
			kind: String(row.kind),
			borrowed: Number(row.borrowed) === 1,
			expires_at: Number(row.expires_at),
			last_seen_at: Number(row.last_seen_at ?? 0),
			issued_at: Number(row.created_at ?? 0),
		},
	};
}

/**
 * True when a sign-in token (revoked or not) belongs to an account that is being deleted
 * (v64 users.disabled_at): the app shows "deleted", not "signed out", and a retried delete
 * request knows it already went through.
 */
export async function isDeletedAccountToken(db: D1Database, token: string): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ? AND s.kind IN ${SIGN_IN_KINDS} AND u.disabled_at IS NOT NULL`,
		)
		.bind(await hashToken(token))
		.first();
	return row !== null;
}

/** last_seen_at, written at most once an hour per session. */
export async function touchSession(db: D1Database, user: SessionUser, now = Date.now()) {
	if (user.session.last_seen_at >= now - TOUCH_EVERY_MS) return;
	await db
		.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
		.bind(now, user.session.id)
		.run();
}

/**
 * The person behind a verified Cloudflare Access JWT (the web), or null when Access lets in
 * someone MailClaw has no account for. `signed_out_at` is their last "sign out everywhere".
 */
export async function findAccessUser(
	db: D1Database,
	email: string,
): Promise<
	| (Omit<SessionUser, "session"> & { signed_out_at: number | null; disabled_at: number | null })
	| null
> {
	const row = await db
		.prepare(
			`SELECT u.id, u.email, u.name, u.is_admin, u.owner_key, u.signed_out_at, u.disabled_at,
				${GRANTS_SQL} AS grants
			 FROM users u WHERE u.email = ?`,
		)
		.bind(email)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		id: String(row.id),
		email: String(row.email),
		name: row.name == null ? null : String(row.name),
		is_admin: Number(row.is_admin) === 1,
		owner_key: row.owner_key == null ? null : String(row.owner_key),
		grants: parseGrants(row.grants),
		signed_out_at: row.signed_out_at == null ? null : Number(row.signed_out_at),
		disabled_at: row.disabled_at == null ? null : Number(row.disabled_at),
	};
}

export interface LoginUser {
	id: string;
	email: string;
	name: string | null;
	is_admin: boolean;
	password_hash: string | null;
	owner_key: string | null;
	/** v64: the account is being deleted; login is refused. */
	disabled_at: number | null;
}

export async function getLoginUser(db: D1Database, email: string): Promise<LoginUser | null> {
	const row = await db
		.prepare(
			"SELECT id, email, name, is_admin, password_hash, owner_key, disabled_at FROM users WHERE email = ?",
		)
		.bind(email)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return {
		id: String(row.id),
		email: String(row.email),
		name: row.name == null ? null : String(row.name),
		is_admin: Number(row.is_admin) === 1,
		password_hash: row.password_hash == null ? null : String(row.password_hash),
		owner_key: row.owner_key == null ? null : String(row.owner_key),
		disabled_at: row.disabled_at == null ? null : Number(row.disabled_at),
	};
}

/**
 * A sign-in session, fenced on the credential that was checked: the row is inserted only while the
 * user still has exactly `passwordHash` and is not being deleted, in one statement. A reset (new
 * hash + every session revoked, one batch) either commits first, so the insert finds no row, or
 * after, so it revokes this session. Returns null when the fence held nothing (the caller answers
 * 401). The throttle's success statements run in the same batch.
 */
export async function createSession(
	db: D1Database,
	input: {
		userId: string;
		passwordHash: string;
		kind: "web" | "app";
		borrowed: boolean;
		name: string | null;
		ttlMs: number;
		attempts: LoginKeys;
	},
	now = Date.now(),
): Promise<{ id: string; token: string; expires_at: number } | null> {
	const id = createId();
	const token = newToken();
	const expiresAt = now + input.ttlMs;
	const [inserted] = await db.batch([
		db
			.prepare(
				`INSERT INTO sessions (id, user_id, token_hash, kind, borrowed, name, created_at, expires_at, last_seen_at)
				 SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM users
				 WHERE id = ? AND password_hash = ? AND disabled_at IS NULL`,
			)
			.bind(
				id,
				await hashToken(token),
				input.kind,
				input.borrowed ? 1 : 0,
				input.name,
				now,
				expiresAt,
				now,
				input.userId,
				input.passwordHash,
			),
		...loginSucceededStatements(db, input.attempts, id),
	]);
	if ((inserted.meta.changes ?? 0) !== 1) return null;
	return { id, token, expires_at: expiresAt };
}

export async function revokeSession(db: D1Database, sessionId: string, now = Date.now()) {
	const result = await db
		.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
		.bind(now, sessionId)
		.run();
	return result.meta.changes ?? 0;
}

/**
 * "Sign out everywhere": every app session of the user ends, and every browser's Access JWT
 * issued until now is refused (users.signed_out_at, v59), so each browser signs in to Access again.
 */
export async function revokeUserSessions(db: D1Database, userId: string, now = Date.now()) {
	const [result] = await db.batch([
		db
			.prepare(
				`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND kind IN ${SIGN_IN_KINDS} AND revoked_at IS NULL`,
			)
			.bind(now, userId),
		db.prepare("UPDATE users SET signed_out_at = ? WHERE id = ?").bind(now, userId),
	]);
	return result.meta.changes ?? 0;
}

/** A one-time set-password link token. Any earlier unused link of the user stops working. */
export async function createPasswordLink(
	db: D1Database,
	userId: string,
	now = Date.now(),
): Promise<{ token: string; expires_at: number }> {
	const token = newToken();
	const expiresAt = now + PASSWORD_LINK_MS;
	await db.batch([
		db
			.prepare(
				"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND kind = 'password_link' AND revoked_at IS NULL",
			)
			.bind(now, userId),
		db
			.prepare(
				`INSERT INTO sessions (id, user_id, token_hash, kind, created_at, expires_at)
				 VALUES (?, ?, ?, 'password_link', ?, ?)`,
			)
			.bind(createId(), userId, await hashToken(token), now, expiresAt),
	]);
	return { token, expires_at: expiresAt };
}

/** Claim a set-password link atomically: a second use finds it revoked. Returns the user id. */
export async function claimPasswordLink(
	db: D1Database,
	token: string,
	now = Date.now(),
): Promise<string | null> {
	const claimed = await db
		.prepare(
			`UPDATE sessions SET revoked_at = ?
			 WHERE token_hash = ? AND kind = 'password_link' AND revoked_at IS NULL AND expires_at > ?
			 RETURNING user_id`,
		)
		.bind(now, await hashToken(token), now)
		.first<{ user_id: string }>();
	return claimed?.user_id ?? null;
}

/**
 * A new password for one user: the hash, every earlier sign-in ended, and the address's throttle
 * counters cleared (whoever sets it proved control through Access or a one-time link).
 */
async function passwordStatements(
	db: D1Database,
	user: { id: string; email: string },
	passwordHash: string,
	now: number,
) {
	const userId = user.id;
	return [
		clearLoginAttemptsStatement(db, await loginSubject(user.email)),
		db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId),
		db
			.prepare(
				`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND kind IN ${SIGN_IN_KINDS} AND revoked_at IS NULL`,
			)
			.bind(now, userId),
	];
}

/** Store a new password; every existing sign-in of the user ends. Returns the user's email. */
export async function setPassword(
	db: D1Database,
	userId: string,
	passwordHash: string,
	now = Date.now(),
): Promise<string | null> {
	const row = await db
		.prepare("SELECT email FROM users WHERE id = ?")
		.bind(userId)
		.first<{ email: string }>();
	if (!row) return null;
	await db.batch(await passwordStatements(db, { id: userId, email: row.email }, passwordHash, now));
	return row.email;
}

/**
 * The web's App password (routes/auth.ts): the person's own row, or for the mailbox owner every
 * owner row (`owner_key = 'all'`, the owner's addresses), in one batch, so the app signs in as any of
 * them. Returns the addresses set.
 */
export async function setAppPassword(
	db: D1Database,
	user: SessionUser,
	passwordHash: string,
	now = Date.now(),
): Promise<string[]> {
	const rows =
		user.owner_key === FULL_MAILBOX_OWNER
			? ((
					await db
						.prepare(
							"SELECT id, email FROM users WHERE owner_key = ? AND disabled_at IS NULL ORDER BY email",
						)
						.bind(FULL_MAILBOX_OWNER)
						.all<{ id: string; email: string }>()
				).results ?? [])
			: [{ id: user.id, email: user.email }];
	const statements = await Promise.all(
		rows.map((row) => passwordStatements(db, row, passwordHash, now)),
	);
	await db.batch(statements.flat());
	return rows.map((row) => row.email);
}

export interface UserSummary {
	id: string;
	email: string;
	name: string | null;
	is_admin: boolean;
	owner_key: string | null;
	password_set: boolean;
	grants: Grant[];
	active_sessions: number;
	created_at: number;
}

function mapUserSummary(row: Record<string, unknown>): UserSummary {
	return {
		id: String(row.id),
		email: String(row.email),
		name: row.name == null ? null : String(row.name),
		is_admin: Number(row.is_admin) === 1,
		owner_key: row.owner_key == null ? null : String(row.owner_key),
		password_set: Number(row.password_set) === 1,
		grants: parseGrants(row.grants),
		active_sessions: Number(row.active_sessions ?? 0),
		created_at: Number(row.created_at),
	};
}

const USER_SUMMARY_SQL = `SELECT u.id, u.email, u.name, u.is_admin, u.owner_key, u.created_at,
	u.password_hash IS NOT NULL AS password_set, ${GRANTS_SQL} AS grants,
	(SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.kind IN ${SIGN_IN_KINDS}
		AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
	FROM users u`;

export async function listUsers(db: D1Database, now = Date.now()): Promise<UserSummary[]> {
	const { results } = await db
		.prepare(`${USER_SUMMARY_SQL} ORDER BY u.created_at`)
		.bind(now)
		.all<Record<string, unknown>>();
	return results.map(mapUserSummary);
}

export async function getUserSummary(
	db: D1Database,
	email: string,
	now = Date.now(),
): Promise<UserSummary | null> {
	const row = await db
		.prepare(`${USER_SUMMARY_SQL} WHERE u.email = ?`)
		.bind(now, email)
		.first<Record<string, unknown>>();
	return row ? mapUserSummary(row) : null;
}

/** Creates the user and their grants in one batch. Returns null when the email is taken. */
export async function createUser(
	db: D1Database,
	input: {
		email: string;
		name: string | null;
		is_admin: boolean;
		owner_key: string | null;
		grants: Grant[];
	},
	now = Date.now(),
): Promise<string | null> {
	const existing = await db
		.prepare("SELECT 1 FROM users WHERE email = ?")
		.bind(input.email)
		.first();
	if (existing) return null;
	const id = createId();
	await db.batch([
		db
			.prepare(
				"INSERT INTO users (id, email, name, is_admin, owner_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(id, input.email, input.name, input.is_admin ? 1 : 0, input.owner_key, now),
		...input.grants.map((grant) =>
			db
				.prepare("INSERT INTO user_grants (user_id, kind, value) VALUES (?, ?, ?)")
				.bind(id, grant.kind, grant.value),
		),
	]);
	return id;
}

/** Deletes the user with their grants and sessions. */
export async function deleteUser(db: D1Database, email: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT id FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string }>();
	if (!row) return false;
	await db.batch([
		db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.id),
		db.prepare("DELETE FROM user_grants WHERE user_id = ?").bind(row.id),
		db.prepare("DELETE FROM users WHERE id = ?").bind(row.id),
	]);
	return true;
}
