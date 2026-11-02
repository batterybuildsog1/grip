import CryptoKit
import Foundation
#if DEBUG
import Darwin
#endif

/// The server address and bearer token the app talks with.
///
/// The token is `internal`: only `APIClient` reads it, and every textual form of this value
/// (description, debugDescription, Mirror/dump) leaves it out, so it cannot reach a log by accident.
public struct Credentials: Sendable {
	public let baseURL: URL
	let bearer: String
	let allowInsecureLoopback: Bool

	public init(baseURL: URL, bearer: String, allowInsecureLoopback: Bool = false) {
		self.baseURL = baseURL
		self.bearer = bearer
		self.allowInsecureLoopback = allowInsecureLoopback
	}

	/// Who is signed in, as a name for files kept per identity (the drafts on this device): a hash
	/// of the server and the token, never the token itself.
	public var identityTag: String {
		SHA256.hash(data: Data("\(baseURL.absoluteString)\n\(bearer)".utf8))
			.prefix(8).map { String(format: "%02x", $0) }.joined()
	}
}

extension Credentials {
	/// Signs a request for this session's own server: the bearer is added only when the request's
	/// scheme, host and port are the session's (HTTPS; Debug also loopback HTTP). Anything else throws,
	/// so a built URL can never carry the token to another host. For clients outside this package
	/// (Mileage) that must not read the token itself.
	public func authorize(_ request: inout URLRequest) throws {
		guard let url = request.url, url.user == nil, url.password == nil,
			let origin = try? ServerEndpoint.validate(baseURL, allowInsecureLoopback: allowInsecureLoopback),
			url.scheme?.lowercased() == origin.scheme?.lowercased(),
			url.host()?.lowercased() == origin.host()?.lowercased(), url.port == origin.port
		else { throw APIError.rejected("Server does not match sign-in") }
		request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
	}
}

extension Credentials: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
	public var description: String { "Credentials(\(baseURL.host() ?? "?"), token: <redacted>)" }
	public var debugDescription: String { description }
	public var customMirror: Mirror { Mirror(self, children: ["host": baseURL.host() ?? "?"]) }
}

/// Session/developer sources return credentials without exposing the bearer to app views.
public protocol CredentialSource: Sendable {
	func load() -> Credentials?
}

/// Debug builds only; Release returns nil. Two ways in:
/// 1. The developer's operator credential, by explicit opt-in (`MC_ALLOW_DEVELOPER_CONFIG=1`): the
///    runtime environment/config, or a private FIFO inside the app sandbox (bytes in kernel memory,
///    never a launch environment or a new file). The host comes from the config, not `ServerConfig`.
/// 2. UI-test fixtures: a fake bearer in `MAILCLAW_API_TOKEN` for a loopback `-MCServer` fixture
///    (`ServerConfig.url`). Any other server ignores it, so an operator token in an environment can
///    never reach production this way. Never on a device.
/// App distribution and the readiness fixture mode (`MC_FIXTURE_MODE=1`) never use either.
public struct DeveloperConfig: CredentialSource {
	private let environment: [String: String]
	private let server: URL

	public init(environment: [String: String] = ProcessInfo.processInfo.environment, server: URL = ServerConfig.url) {
		self.environment = environment
		self.server = server
	}

	public func load() -> Credentials? {
		#if DEBUG
		guard environment["MC_FIXTURE_MODE"] != "1" else { return nil }
		if environment["MC_ALLOW_DEVELOPER_CONFIG"] == "1" {
			let file: File?
			if let pipe = nonEmpty(environment["MC_DEVELOPER_CONFIG_PIPE"]) {
				// Explicit IPC is fail-closed, including when stale environment credentials exist.
				guard let transferred = readPipe(pipe) else { return nil }
				file = transferred
			} else {
				file = readFile()
			}
			guard
				let host = nonEmpty(environment["MAILCLAW_HOST"]) ?? nonEmpty(file?.host),
				let url = URL(string: host), url.scheme == "https" || url.scheme == "http",
				let token = nonEmpty(environment["MAILCLAW_API_TOKEN"]) ?? nonEmpty(file?.apiToken)
			else { return nil }
			return Credentials(baseURL: url, bearer: token, allowInsecureLoopback: true)
		}
		#if os(iOS) && !targetEnvironment(simulator)
		return nil
		#else
		guard let token = nonEmpty(environment["MAILCLAW_API_TOKEN"]),
			let host = server.host(), ["127.0.0.1", "localhost", "::1"].contains(host)
		else { return nil }
		return Credentials(baseURL: server, bearer: token, allowInsecureLoopback: true)
		#endif
		#else
		return nil
		#endif
	}

	#if DEBUG
	private struct File: Decodable {
		let host: String?
		let apiToken: String?
		enum CodingKeys: String, CodingKey {
			case host
			case apiToken = "api_token"
		}
	}

	private func readPipe(_ path: String) -> File? {
		let path = path.hasPrefix("/") ? path : NSHomeDirectory() + "/" + path
		let fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
		guard fd >= 0 else { return nil }
		defer { close(fd) }
		var info = stat()
		guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFIFO,
			info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { return nil }
		let deadline = ProcessInfo.processInfo.systemUptime + 3
		var data = Data()
		var bytes = [UInt8](repeating: 0, count: 4096)
		while ProcessInfo.processInfo.systemUptime < deadline {
			let count = read(fd, &bytes, bytes.count)
			if count > 0 {
				guard data.count + count <= 4096 else { return nil }
				data.append(contentsOf: bytes.prefix(count))
				if let config = try? JSONDecoder().decode(File.self, from: data) { return config }
				if data.count >= 4096 { return nil }
			} else if count < 0, errno != EAGAIN, errno != EINTR { return nil }
			Thread.sleep(forTimeInterval: 0.01)
		}
		return nil
	}

	private func readFile() -> File? {
		let path: String
		if let explicit = nonEmpty(environment["MAILCLAW_CONFIG"]) {
			path = explicit
		} else if let simulatorHome = nonEmpty(environment["SIMULATOR_HOST_HOME"]) {
			path = simulatorHome + "/.mailclaw/config.json"
		} else {
			path = NSHomeDirectory() + "/.mailclaw/config.json"
		}
		guard let data = FileManager.default.contents(atPath: path) else { return nil }
		return try? JSONDecoder().decode(File.self, from: data)
	}

	private func nonEmpty(_ value: String?) -> String? {
		guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
			return nil
		}
		return value
	}
	#endif
}
