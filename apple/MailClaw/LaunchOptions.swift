import CryptoKit
import Foundation
#if os(iOS)
import UIKit
#endif
import MailClawKit

/// Launch arguments (`-MCName value`) and environment the dev build understands. Test seams are
/// compiled into Debug builds only.
enum LaunchOptions {
	private static var defaults: UserDefaults { .standard }
	private static var environment: [String: String] { ProcessInfo.processInfo.environment }

	#if DEBUG
	static var fixtureNotification: (account:String,messageId:String)? {
		guard fixtureMode, fixtureCredentials != nil, let account=environment["MC_FIXTURE_NOTIFICATION_ACCOUNT"], let id=environment["MC_FIXTURE_NOTIFICATION_MESSAGE"] else { return nil }
		return (account,id)
	}
	static var fixtureEmptyServer: Bool { fixtureMode && environment["MC_FIXTURE_EMPTY_SERVER"] == "1" }
	static var fixturePush: Bool { fixtureMode && environment["MC_FIXTURE_PUSH"] == "1" }
	/// The preauthenticated fixture also gets the app lock: Mac lifecycle cases need it without the
	/// Keychain session an ad hoc build can't save.
	static var fixtureAppLock: Bool { fixtureMode && environment["MC_FIXTURE_APP_LOCK"] == "1" }
	/// The fixture run's own `screenIsLocked`/`screenIsUnlocked` pair, beside the system's.
	static var fixtureScreenLockPrefix: String? {
		guard fixtureMode, let run = environment["MC_FIXTURE_RUN"] else { return nil }
		return "io.examplebusiness.mailclaw.fixture.\(run)."
	}
	static var localAuthResult: String { fixtureMode ? environment["MC_FIXTURE_LA"] ?? "unavailable" : "unavailable" }
	static var fixtureMode: Bool { environment["MC_FIXTURE_MODE"] == "1" }
	static var fixtureSignedOut: Bool { fixtureMode && environment["MC_FIXTURE_SIGNED_OUT"] == "1" }
	static var fixtureKeychainService: String {
		let digest = SHA256.hash(data: Data(fixtureIdentity.utf8)).map { String(format: "%02x", $0) }.joined()
		return "io.examplebusiness.mailclaw.fixture." + digest
	}
	static var fixtureOffline: Bool { fixtureMode && environment["MC_FIXTURE_OFFLINE"] == "1" }
	static var fixtureIdentity: String { "fixture " + (environment["MC_FIXTURE_RUN"] ?? UUID().uuidString) + " " + (environment["MC_FIXTURE_ACCOUNT"] ?? "") }
	/// The fixture's address when it starts signed in (no Keychain session): Delete account's identity.
	static var fixtureAccount: String? {
		fixtureMode && !fixtureSignedOut && fixtureCredentials != nil ? environment["MC_FIXTURE_ACCOUNT"] : nil
	}
	static var fixtureCredentials: Credentials? {
		guard fixtureMode, let raw = environment["MC_FIXTURE_ORIGIN"], let url = URL(string: raw),
			let host = url.host, ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host),
			let validated = try? ServerEndpoint.validate(url, allowInsecureLoopback: true),
			environment["MC_FIXTURE_RUN"] != nil, environment["MC_FIXTURE_ACCOUNT"] != nil else { return nil }
		return Credentials(baseURL: validated, bearer: "fixture-app-session-not-a-secret", allowInsecureLoopback: true)
	}
	/// Test harnesses keep the app session in a file in the run's own folder (FileSessionStore): every
	/// Mileage test run (unsigned simulator builds have no Keychain), and fixture runs on the Mac (an ad
	/// hoc build can't keep a data-protection Keychain item). Nil: the Keychain.
	static var testSessionFile: URL? {
		let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
		if MileageModel.testMode {
			return support.appendingPathComponent(MileageModel.namespace, isDirectory: true)
				.appendingPathComponent("app-session.json")
		}
		#if os(macOS)
		if fixtureMode, fixtureCredentials != nil {
			return support.appendingPathComponent(fixtureKeychainService, isDirectory: true)
				.appendingPathComponent("app-session.json")
		}
		#endif
		return nil
	}
	/// Start with an empty store (cold launch). Drafts kept on the device stay (they are not cache).
	static var resetCache: Bool { defaults.bool(forKey: "MCResetCache") }
	/// Start with no drafts kept on the device (DraftsTests' clean slate).
	static var resetDrafts: Bool { defaults.bool(forKey: "MCResetDrafts") }
	/// Use this store file instead of the identity's own (fixture stores). Without it a Debug build
	/// still keeps its own files: AppModel scopes its identities apart from Release's, so it never
	/// migrates the installed app's cache (d2-21).
	static var storePath: String? { environment["MC_STORE_PATH"] }
	/// Show the invisible timing probe the UI test reads.
	static var perfProbe: Bool { defaults.bool(forKey: "MCPerfProbe") }
	/// No thread prefetch, so the first open of a thread measures the network path.
	static var noPrefetch: Bool { defaults.bool(forKey: "MCNoPrefetch") }
	/// Forget the newest N Personal and All Mail rows at launch, as if they arrived since the last sync.
	static var dropNewest: Int { defaults.integer(forKey: "MCDropNewest") }
	/// Open this conversation at launch (with `MC_OPEN_ANCHOR` as the message to show). Environment,
	/// not arguments: argument values are parsed as plists, and thread ids start with "<".
	static var openThread: String? { environment["MC_OPEN_THREAD"] }
	static var openAnchor: String? { environment["MC_OPEN_ANCHOR"] }
	/// A thread detail JSON file (an API response body) stored before launch: the hostile fixture.
	static var fixturePath: String? { environment["MC_FIXTURE_PATH"] }
	/// Hold every API request back by this long (the list-jump test).
	static var networkDelay: Duration? {
		environment["MC_NETWORK_DELAY_MS"].flatMap(Int.init).map { .milliseconds($0) }
	}
	/// Seconds between refreshes while the app is active (the auto-refresh test shortens it).
	static var autoRefreshInterval: Duration {
		let seconds = defaults.double(forKey: "MCAutoRefreshSeconds")
		return seconds > 0 ? .seconds(seconds) : .seconds(120)
	}
	/// Answer every write (Needs you's Done and Undo) on the device: UI tests run on production.
	static var dryWrites: Bool { defaults.bool(forKey: "MCDryWrites") }
	/// Needs you from this JSON array of notes instead of the server (synthetic, no real mail).
	static var notesFixtureJSON: String? { environment["MC_NOTES_FIXTURE_JSON"] }
	/// Needs you as if GET /api/notes failed.
	static var notesFail: Bool { environment["MC_NOTES_FAIL"] == "1" }
	/// Compose writes (drafts, send, delete) go to this local sink instead of the server, without
	/// the token (the S5 compose E2E, apple/scripts/write_sink.py).
	static var writeSink: URL? { environment["MC_WRITE_SINK"].flatMap(URL.init(string:)) }
	/// Start in this view ("mileage", or a view's kind: "trash", "all", …): state-driven Mac captures
	/// that never take input from whoever is using the Mac (no synthesized input).
	static var openView: String? { environment["MC_OPEN_VIEW"] }
	/// Mac: open Settings at launch (the same captures: its Appearance words).
	static var showSettings: Bool { defaults.bool(forKey: "MCShowSettings") }
	/// Mac: Settings opens with Delete account's sheet (the same captures, consent-delete-e2e.sh).
	static var showDeleteAccount: Bool { defaults.bool(forKey: "MCShowDeleteAccount") }
	/// Start with the key list open (the same captures).
	static var showShortcuts: Bool { defaults.bool(forKey: "MCShowShortcuts") }
	/// Mileage opens on this month (YYYY-MM): the fixture's October, whatever today is.
	static var mileageMonth: String? { environment["MC_MILEAGE_MONTH"] }
	/// Mileage opens on this screen: `trip:<id>` (from Needs you), `trip:<id>@company:<id>`,
	/// `company:<id>`, `spot-check`, `settings`, `export`, `month`, `search:<words>`, `delete:<id>`.
	/// State-driven captures with no input (apple/scripts/mileage-v3-states.sh).
	static var mileageScreen: String? { environment["MC_MILEAGE_SCREEN"] }
	/// iPad, windowed apps: pin the window to WIDTHxHEIGHT (`-MCWindowSize 678x1032`), or to what the
	/// file at MC_WINDOW_SIZE_FILE says, re-read while the app runs so a test can resize mid-run
	/// (IPadRailTests; MailClawApp applies it). Nil: the window keeps the system's sizes.
	/// iPad: lay out as this horizontal size class (`-MCForceSizeClass compact|regular`), whatever
	/// the window is: the rail window at regular, the iPhone's stack at compact (MileageV3Tests).
	static var forcedSizeClass: String? { defaults.string(forKey: "MCForceSizeClass") }
	/// The iPhone's stack lays Mileage out (an iPhone, or an iPad forced compact): launch steps that
	/// differ by layout (search) pick the stack's form.
	static var mileagePhoneLayout: Bool {
		#if os(iOS)
		UIDevice.current.userInterfaceIdiom == .phone || forcedSizeClass == "compact"
		#else
		false
		#endif
	}
	static var windowSizeWatched: Bool {
		environment["MC_WINDOW_SIZE_FILE"] != nil || defaults.string(forKey: "MCWindowSize") != nil
	}
	static var windowSize: CGSize? {
		let text = environment["MC_WINDOW_SIZE_FILE"].flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }
			?? defaults.string(forKey: "MCWindowSize") ?? ""
		let parts = text.trimmingCharacters(in: .whitespacesAndNewlines)
			.split(separator: "x").compactMap { Double($0) }
		return parts.count == 2 ? CGSize(width: parts[0], height: parts[1]) : nil
	}
	#else
	static let fixtureMode = false
	static let fixturePush = false
	static let fixtureAppLock = false
	static let fixtureScreenLockPrefix: String? = nil
	static let fixtureEmptyServer = false
	static let fixtureNotification: (account: String, messageId: String)? = nil
	static let fixtureSignedOut = false
	static let fixtureKeychainService = "io.examplebusiness.mailclaw.invalid-fixture"
	static let fixtureOffline = false
	static let fixtureIdentity = ""
	static let fixtureAccount: String? = nil
	static let fixtureCredentials: Credentials? = nil
	static let autoRefreshInterval: Duration = .seconds(120)
	static let dryWrites = false
	static let notesFixtureJSON: String? = nil
	static let notesFail = false
	static let resetCache = false
	static let resetDrafts = false
	static let storePath: String? = nil
	static let perfProbe = false
	static let noPrefetch = false
	static let dropNewest = 0
	static let openThread: String? = nil
	static let openAnchor: String? = nil
	static let fixturePath: String? = nil
	static let networkDelay: Duration? = nil
	static let writeSink: URL? = nil
	static let openView: String? = nil
	static let showSettings = false
	static let showDeleteAccount = false
	static let showShortcuts = false
	static let mileageMonth: String? = nil
	static let mileageScreen: String? = nil
	static let forcedSizeClass: String? = nil
	static let mileagePhoneLayout = false
	static let windowSizeWatched = false
	static let windowSize: CGSize? = nil
	#endif
}
