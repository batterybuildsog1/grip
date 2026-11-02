import Foundation

public enum APIError: Error, Sendable, Equatable {
	/// No usable network path to the server (airplane mode, refused, timed out, DNS).
	case offline
	case http(status: Int, retryAfter: Double?)
	/// A refusal with the server's reason, shown as is: a 400 (an invalid search query), or any
	/// refusal of a write that asks for its reason (`write(reasons:)`: the unsubscribe).
	case rejected(String)
	case decoding(String)

	public var isOffline: Bool { self == .offline }
	public var isNotFound: Bool {
		if case .http(404, _) = self { return true }
		return false
	}
}

/// The writes the app makes (r2): Needs you's Done and its Undo (S1), drafts and sending (S5),
/// triage (S7), the unsubscribe (S3). Everything else is a GET.
public enum WriteMethod: String, Sendable {
	case post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
}

/// The MailClaw REST client. Reads are `get`; the one write path is `write`.
public final class APIClient: Sendable {
	public let baseURL: URL
	private let credentials: Credentials
	private let transport = HTTPTransport()
	private let fixtureOffline: Bool
	private let debugDelay: Duration?
	/// Test builds only: writes go here, without the token (the compose E2E's local sink).
	private let writeBaseURL: URL?
	/// Test builds only: every write is answered on the device and nothing is sent (UI tests that
	/// read production).
	private let dryWrites: Bool

	/// `debugDelay` holds every request back (the list-jump test needs a refresh that lands late).
	public init(
		credentials: Credentials, debugDelay: Duration? = nil, writeBaseURL: URL? = nil, dryWrites: Bool = false,
		fixtureOffline: Bool = false
	) {
		self.credentials = credentials
		self.baseURL = credentials.baseURL
		self.debugDelay = debugDelay
		self.writeBaseURL = writeBaseURL
		self.dryWrites = dryWrites
		#if DEBUG
		self.fixtureOffline = fixtureOffline
		#else
		self.fixtureOffline = false
		#endif
	}

	/// GET `/<path...>?<query>`; each path segment and query value is percent-encoded strictly,
	/// because thread ids look like `<abc@example.com>`.
	public func get(_ path: [String], query: [(String, String)] = []) async throws -> Data {
		var request = URLRequest(url: try url(baseURL, path, query: query))
		request.setValue("Bearer \(credentials.bearer)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		return try await perform(request)
	}

	/// POST/PUT/PATCH/DELETE `/<path...>` with an optional JSON body. `reasons`: any refusal that
	/// says why throws `.rejected(why)`, not only a 400.
	public func write(
		_ method: WriteMethod, _ path: [String], json body: Data? = nil, reasons: Bool = false
	) async throws -> Data {
		if dryWrites, writeBaseURL == nil { return Data(#"{"success":true,"data":{}}"#.utf8) }
		var request = URLRequest(url: try url(writeBaseURL ?? baseURL, path, query: []))
		request.httpMethod = method.rawValue
		if writeBaseURL == nil {
			request.setValue("Bearer \(credentials.bearer)", forHTTPHeaderField: "Authorization")
		}
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		return try await perform(request, reasons: reasons)
	}

	/// The account calls (Account.swift): always the server itself with the bearer, never the compose
	/// sink, and the answer whatever its status, so the caller can read `error.code`. A dry-writes
	/// build (UI tests reading production) sends no write here at all.
	func exchange(_ method: String, _ path: [String], json body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
		if method != "GET", dryWrites { throw APIError.offline }
		var request = URLRequest(url: try url(baseURL, path, query: []))
		request.httpMethod = method
		request.setValue("Bearer \(credentials.bearer)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		if let debugDelay { try await Task.sleep(for: debugDelay) }
		_ = try ServerEndpoint.validate(baseURL, allowInsecureLoopback: credentials.allowInsecureLoopback)
		if fixtureOffline { throw APIError.offline }
		return try await transport.exchange(request)
	}

	private func url(_ base: URL, _ path: [String], query: [(String, String)]) throws -> URL {
		var components = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
		let prefix = components.percentEncodedPath.hasSuffix("/")
			? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
		components.percentEncodedPath = prefix + "/" + path.map(Self.encode).joined(separator: "/")
		components.percentEncodedQuery = query.isEmpty
			? nil : query.map { "\(Self.encode($0.0))=\(Self.encode($0.1))" }.joined(separator: "&")
		guard let url = components.url else { throw APIError.decoding("bad url") }
		return url
	}

	private func perform(_ request: URLRequest, reasons: Bool = false) async throws -> Data {
		if let debugDelay { try await Task.sleep(for: debugDelay) }
		_ = try ServerEndpoint.validate(baseURL, allowInsecureLoopback: credentials.allowInsecureLoopback)
		if fixtureOffline { throw APIError.offline }
		let data = try await transport.data(for: request, reasons: reasons)
		return data
	}

	/// `error.message` of a `{ success: false, error: { code, message } }` body.
	static func errorMessage(_ body: Data) -> String? {
		struct Failure: Decodable {
			struct Detail: Decodable { let message: String? }
			let error: Detail?
		}
		let message = (try? JSONDecoder().decode(Failure.self, from: body))?.error?.message
		return message?.isEmpty == false ? message : nil
	}

	private static let unreserved = CharacterSet(
		charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

	static func encode(_ value: String) -> String {
		value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
	}
}

/// Every JSON response is `{ success, data, error }`.
struct Envelope<T: Decodable>: Decodable {
	let data: T?
}

enum JSON {
	static func decoder() -> JSONDecoder {
		let decoder = JSONDecoder()
		decoder.keyDecodingStrategy = .convertFromSnakeCase
		return decoder
	}

	/// Decodes the `data` member of an API response body.
	static func data<T: Decodable>(_ type: T.Type, from body: Data) throws -> T {
		do {
			guard let value = try decoder().decode(Envelope<T>.self, from: body).data else {
				throw APIError.decoding("missing data")
			}
			return value
		} catch let error as APIError {
			throw error
		} catch {
			throw APIError.decoding(String(describing: type))
		}
	}
}
