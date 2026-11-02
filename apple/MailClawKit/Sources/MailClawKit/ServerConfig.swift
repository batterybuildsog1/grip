import Foundation

/// The MailClaw servers the apps talk with. Built in: users never see, type or pick one (no
/// server address in the app). Sign-in picks the origin from the login email (`origin(forEmail:)`)
/// and the session keeps it (`AppSession.baseURL`), so mail, Mileage, the NSE and device registration
/// all use the origin the person signed in to.
///
/// `url` is the Debug developer seam only (`DeveloperConfig`: a fixture bearer for a loopback
/// `-MCServer`); Release never reads it for a request.
public enum ServerConfig {
	public static func configuredURL(_ key: String, fallback: String) -> URL {
		guard let text = Bundle.main.object(forInfoDictionaryKey: key) as? String,
			let url = URL(string: text), url.scheme == "https", url.host != nil,
			url.user == nil, url.password == nil else { return URL(string: fallback)! }
		return url
	}
	public static let hosted = configuredURL("GripHostedOrigin", fallback: "https://discovery.grip.invalid")
	public static let demo = configuredURL("GripDemoOrigin", fallback: "https://demo.grip.invalid")
	public static let demoDomain = "wrenfield.example"
	/// A marker, never requested. SessionClient resolves it asynchronously before sending a password.
	static let discoveryRequired = URL(string: "https://discovery.grip.invalid")!

	/// Synchronous compatibility for app callers. Unknown users get a fail-closed marker; the
	/// non-UI SessionClient login performs lookup -> verify -> cache. Saved sessions never rediscover.
	public static func origin(
		forEmail email: String, environment: [String: String] = ProcessInfo.processInfo.environment
	) -> URL {
		let address = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let parts = address.split(separator: "@", omittingEmptySubsequences: false)
		let isDemo = parts.count == 2 && !parts[0].isEmpty && parts[1] == demoDomain
		#if DEBUG
		if let local = loopback(environment[isDemo ? "MC_DEMO_ORIGIN" : "MC_HOSTED_ORIGIN"]) { return local }
		#endif
		if isDemo { return demo }
		return discoveryRequired
	}

	/// A loopback origin (`127.0.0.1`, `localhost`, `::1`): the only kind a Debug override or a test
	/// harness may use.
	public static func isLoopback(_ url: URL) -> Bool {
		["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host() ?? "")
	}

	#if DEBUG
	private static func loopback(_ value: String?) -> URL? {
		guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
			let url = URL(string: value), url.scheme == "http" || url.scheme == "https", isLoopback(url),
			let origin = try? ServerEndpoint.validate(url, allowInsecureLoopback: true)
		else { return nil }
		return origin
	}
	#endif

	// MARK: Debug developer seam (DeveloperConfig)

	public static let argumentKey = "MCServer"

	/// Debug: the `-MCServer <url>` launch argument (UI tests' loopback fixtures), read from the
	/// argument domain alone so a `defaults write` cannot point an installed app elsewhere; else `hosted`.
	public static var url: URL {
		resolve(argument: argument)
	}

	public static func resolve(argument: String?) -> URL {
		guard let value = argument?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
			return hosted
		}
		guard let url = URL(string: value), url.scheme == "https" || url.scheme == "http", url.host() != nil
		else { preconditionFailure("-\(argumentKey) is not an http(s) URL") }
		return url
	}

	private static var argument: String? {
		#if DEBUG
		UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)[argumentKey] as? String
		#else
		nil
		#endif
	}
}

/// MailClaw's public pages on the operator's site (SPEC §5). The sign-in screen and Settings link the
/// same two; each opens in the system browser.
public enum PublicLinks {
	public static let privacy = ServerConfig.configuredURL("GripPrivacyURL", fallback: "https://grip.invalid/privacy")
	public static let support = ServerConfig.configuredURL("GripSupportURL", fallback: "https://grip.invalid/support")
}
