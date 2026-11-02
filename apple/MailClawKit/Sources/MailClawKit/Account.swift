import Foundation

// The 1.0 account API (release-prep/API.md, rel/server ffb4670): AI consent and account deletion.
// Every answer is read here and only here, branching on `error.code`, never the message: a change in
// the server's shapes is one edit in this file.

/// `GET /api/account/ai-consent`, and the acknowledgement of a PUT (the same body, read back).
public struct AIConsent: Decodable, Equatable, Sendable {
	public enum State: String, Decodable, Sendable { case undecided, allowed, declined }
	public let state: State
	/// The server's CONSENT_VERSION. A grant at an older version reads as undecided.
	public let version: Int
	/// Only the mailbox's owner (`owner_key 'all'`) decides; viewers never see the choice.
	public let canDecide: Bool

	public init(state: State, version: Int, canDecide: Bool) {
		self.state = state
		self.version = version
		self.canDecide = canDecide
	}
}

/// `POST /api/account/delete`: the request the operator completes within 30 days.
public struct DeletionReceipt: Decodable, Equatable, Sendable {
	public let requestId: String
	public let email: String
	public let requestedAt: Double
	public let status: String
}

/// Why an account call didn't do what it asked.
public enum AccountFailure: Error, Equatable, Sendable {
	/// No answer: no network, refused, timed out. The server may or may not have acted.
	case offline
	/// 401 INVALID_CREDENTIALS: the password is wrong; nothing changed.
	case wrongPassword
	/// 429 LOGIN_THROTTLED: too many wrong passwords; `seconds` from Retry-After.
	case throttled(seconds: Double?)
	/// 401 / 403 ACCOUNT_DELETED: the account is being deleted (here or on another device). Done.
	case accountDeleted
	/// 401 with any other code: the session is gone (revoked, expired).
	case signedOut
	/// 409 AI_CONSENT_STALE: the version changed; read it again.
	case stale
	/// 403 AI_CONSENT_OWNER_ONLY: this person can't decide.
	case ownerOnly
	/// 503 AI_CONSENT_UNAVAILABLE: the server couldn't read or write the decision.
	case unavailable
	/// Anything else, or a 2xx body that doesn't read.
	case server(status: Int, code: String?)

	/// The one mapping from an answer to a failure.
	static func from(status: Int, body: Data, retryAfter: Double?) -> AccountFailure {
		struct Envelope: Decodable {
			struct Detail: Decodable { let code: String? }
			let error: Detail?
		}
		let code = (try? JSONDecoder().decode(Envelope.self, from: body))?.error?.code
		switch (status, code) {
		case (_, "ACCOUNT_DELETED"): return .accountDeleted
		case (401, "INVALID_CREDENTIALS"): return .wrongPassword
		case (401, _): return .signedOut
		case (429, _): return .throttled(seconds: retryAfter)
		case (409, "AI_CONSENT_STALE"): return .stale
		case (403, "AI_CONSENT_OWNER_ONLY"): return .ownerOnly
		case (503, "AI_CONSENT_UNAVAILABLE"): return .unavailable
		default: return .server(status: status, code: code)
		}
	}
}

extension APIClient {
	/// The owner's decision, as the server holds it now.
	public func aiConsent() async throws(AccountFailure) -> AIConsent {
		try await account("GET", ["api", "account", "ai-consent"])
	}

	/// Records allow or decline for the version of the words the person read. Returns the server's
	/// state read back after the write (its acknowledgement); nothing else counts as saved.
	public func setAIConsent(allow: Bool, version: Int) async throws(AccountFailure) -> AIConsent {
		struct Body: Encodable { let allow: Bool; let version: Int }
		return try await account("PUT", ["api", "account", "ai-consent"], json: try? JSONEncoder().encode(Body(allow: allow, version: version)))
	}

	/// Re-authenticates with the password and disables the account everywhere (SPEC §3).
	public func deleteAccount(password: String) async throws(AccountFailure) -> DeletionReceipt {
		struct Body: Encodable { let password: String }
		return try await account("POST", ["api", "account", "delete"], json: try? JSONEncoder().encode(Body(password: password)))
	}

	private func account<T: Decodable>(_ method: String, _ path: [String], json: Data? = nil) async throws(AccountFailure) -> T {
		let data: Data
		let http: HTTPURLResponse
		do {
			(data, http) = try await exchange(method, path, json: json)
		} catch {
			throw .offline
		}
		guard (200..<300).contains(http.statusCode) else {
			let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
			throw AccountFailure.from(status: http.statusCode, body: data, retryAfter: retryAfter)
		}
		guard let value = try? JSON.data(T.self, from: data) else {
			throw .server(status: http.statusCode, code: nil)
		}
		return value
	}
}
