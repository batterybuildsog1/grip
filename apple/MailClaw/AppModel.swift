import CryptoKit
import Foundation
import MailClawKit
import Observation
#if os(iOS)
import UIKit
#endif

/// App state: the selected view and its rows (always read from the store first), freshness,
/// selection and search; on the Mac also the sidebar and the keyboard cursor (L3 Rail, S6).
/// Writes: the batch actions (AppModel+Actions.swift), Needs you's Done, compose (r2 S5).
/// The session (apps readiness): Release restores the device-only app session from the Keychain;
/// fixtures and the developer config are Debug only. Sign-in and sign-out use their own transport.
/// One session for mail and Mileage (1.0): sign-in picks the server from the email
/// (`ServerConfig.origin(forEmail:)`), the session keeps it, and Mileage is handed the same session.
@MainActor @Observable
final class AppModel {
	/// The mail privacy gate (Face ID / passcode), separate from the session's storage.
	let lock = AppLock()
	/// The owner's AI sorting switch, as the server holds it (Consent.swift).
	let consent = ConsentModel()
	let notifications = NotificationCoordinator()
	private var queuedNotification: (account: String, messageId: String)?
	/// iPhone and iPad: a tapped banner this app posted itself (a note, AppModel+Notifications).
	private var queuedBanner: (id: String, emailId: String?)?
	private var notificationTask: Task<Void, Never>?
	/// Mail is on screen and may refresh: signed in, unlocked, not covered, not signing out.
	var canRead: Bool { sync != nil && !lock.isLocked && !lock.privacyCovered && !signingOut }
	private let sessionStore: any SessionStore
	private var session: AppSession? {
		didSet { mileage?.use(session, restored: restoring) }
	}
	/// Set while a kept session is restored at launch: Mileage keeps recording as it was.
	private var restoring = false
	/// Explicit sign-out suppresses retries even if clearing Keychain fails. Only a new sign-in
	/// can re-establish a session in this process; active/unlock callbacks cannot resurrect it.
	private var sessionRetryBlocked = false
	#if os(iOS)
	@ObservationIgnored private var protectedDataObserver: NSObjectProtocol?
	#endif
	/// Mileage runs on this session (MailClawApp connects it); it never signs in on its own.
	private weak var mileage: MileageModel?
	private(set) var sessionEmail: String?
	private(set) var signingIn = false
	private(set) var signingOut = false
	private(set) var signInError: String?
	/// The root view is keyed by this, so a previous account's reader state is discarded.
	private(set) var sessionGeneration = UUID()
	/// Mail can open: a session (or, Debug, the developer config). Signed out, the window is the
	/// sign-in screen alone (SignInView).
	var signedIn: Bool { session != nil || sync != nil }

	/// UserDefaults keys. Launch arguments (`-MCSidebarShown NO`) override them for a run.
	enum Key {
		static let account = "MCAccount"
		static let notify = "MCNotify"
		/// L3's one column toggle. Not the r2 build's `MCSidebarShown.focus`: the Debug app shares
		/// the installed app's defaults domain, and neither should flip the other's sidebar.
		static let sidebarShown = "MCSidebarShown"
	}

	/// One line at the bottom: what an action did, with Undo when it can be undone, or why it failed
	/// (design r2 §5: toast undo for every mutation).
	struct Toast: Identifiable {
		let id = UUID()
		let text: String
		let undo: (@MainActor () -> Void)?
		var isError = false
		var undoable: Bool { undo != nil }
	}

	enum Freshness: Equatable {
		case idle
		case updating
		case updated(Date)
		case offline(lastUpdated: Date?)
		case failed(String)
	}

	/// A submitted search (r2 S4): the query as typed (the title), the view it started from (its pill
	/// narrows to it), the scope, and the answer. Offline or a failure is never "0 results".
	struct Search: Equatable {
		enum Scope: Equatable { case all, view }
		enum Status: Equatable {
			case loading
			case answered(SearchAnswer)
			/// No network: nothing was searched.
			case offline
			/// The server failed or its answer could not be read.
			case failed
			/// The server refused the query (400) and said why.
			case rejected(String)
		}

		let query: String
		let view: MailView
		var scope: Scope = .all
		var status: Status = .loading
		/// The other pill's count, once known.
		var otherCount: String?

		/// All Mail has no filters to narrow to: one pill.
		var narrows: Bool { !view.filters.isEmpty }
		var answer: SearchAnswer? {
			guard case let .answered(answer) = status else { return nil }
			return answer
		}
	}

	private(set) var sync: MailSync?
	/// Why there is no `sync` although credentials loaded: the on-device store could not be opened
	/// (it rebuilds a damaged or incompatible cache itself, d2-21; this is what is left).
	private(set) var storeError: String?
	/// The view in the selected account (`account`); the sidebar selects `view.unscoped`.
	private(set) var view: MailView = .personal
	/// The selected account's address; nil is All accounts. Changing it never changes the view
	/// (design r2 S1, audit WD-02). Kept across launches.
	private(set) var account: String?
	private(set) var meta: MailMeta?
	private var metaFetchedAt: Date?
	/// Personal's unread conversations in the selected account: the one count in the app.
	private(set) var personalUnread = 0
	private(set) var rows: [ConversationRow] = []
	/// Rows from a refresh that would move what is on screen; shown when the user asks or scrolls up.
	private(set) var pendingRows: [ConversationRow]?
	private(set) var notes: [ActionNote] = []
	/// The last notes load failed: Needs you says so instead of looking like nothing to do (WD-13).
	private(set) var notesFailed = false
	var jobs: [NeedsYouJob] { NeedsYouJob.build(notes) }
	private(set) var toast: Toast?
	private var toastTask: Task<Void, Never>?
	private(set) var freshness: Freshness = .idle
	private(set) var lastUpdated: Date?
	private(set) var viewComplete = false
	var selection: String? {
		didSet {
			guard let selection, selection != oldValue else { return }
			Perf.begin("open_thread", key: "open:\(selection)")
			Perf.begin("open_body", key: "body:\(selection)")
		}
	}
	/// Mac, browsing: the row the keyboard is on (j/k), shown after the first key.
	var cursor: String?
	var cursorShown = false
	/// Mac, browsing: rows picked with x (or their checkboxes) for the bulk bar (r2 S7).
	var picked: Set<String> = []
	/// Message to show first when a conversation is opened from a note or a notification.
	private(set) var anchors: [String: String] = [:]
	/// How far each message's unsubscribe got this session (AppModel+Thread.swift): reopening the
	/// newsletter shows it, and a done one is never sent again.
	var unsubscribes: [String: UnsubscribeStep] = [:]
	/// The open conversation, when it reads as a lone newsletter: the Mac toolbar's Archive is then
	/// the filled word, with nothing to reply to (L3 S3, as the web).
	var newsletterOpen: String?

	/// Mileage, the views' last entry (V3 "Answer first"). Choosing any mail view leaves it.
	private(set) var showsMileage = false

	// MARK: Mac window (L3 Rail, S6)

	/// The left column: the views while browsing, the rail while reading. "Sidebar" and `[` hide it
	/// in either state (r1 S5).
	var sidebarShown: Bool {
		didSet { UserDefaults.standard.set(sidebarShown, forKey: Key.sidebarShown) }
	}
	/// The search field has the keyboard: single-key shortcuts are off so letters type.
	var isTyping = false
	var showsShortcuts = false
	/// Bumped to move the keyboard to the search field (/, ⌘F, ⌘K).
	private(set) var searchFocusRequests = 0
	/// The window's undo manager: Edit > Undo, ⌘Z, z and the toast's Undo all undo the last action.
	@ObservationIgnored weak var undoManager: UndoManager?

	/// Settings: "New mail in Personal and Needs you".
	var notifyEnabled: Bool {
		didSet {
			guard notifyEnabled != oldValue else { return }
			UserDefaults.standard.set(notifyEnabled, forKey: Key.notify)
			notificationsChanged()
		}
	}
	var notificationsDenied = false
	/// Newest Personal mail and the notes already announced (or already here at launch: the first
	/// check of a run takes stock and announces nothing). AppModel+Notifications.swift.
	@ObservationIgnored var announcedThrough: Int64?
	@ObservationIgnored var announcedNotes: Set<String> = []
	private(set) var isActive = false
	var isAtTop = true {
		didSet { if isAtTop, pendingRows != nil { showPendingRows() } }
	}

	/// The search field's text (the iPhone's bottom field, the Mac toolbar's field). Typing never
	/// searches: Return does (`submitSearch`), so the title is what ran.
	var draft = ""
	private(set) var search: Search?
	var isSearching: Bool { search != nil }

	// Compose (r2 S5, AppModel+Compose.swift): the iPhone sheet's composer, the one whose send is
	// waiting out its Undo, and the short notice above the bottom edge ("Sent", "Not sent").
	var composer: ComposeModel?
	var sending: ComposeModel?
	var notice: String?
	/// This identity's drafts kept on the device (DraftShelf); nil signed out.
	private(set) var drafts: DraftShelf?
	/// Mac: a composer to open in its own window (MacRootView opens it), e.g. from a Drafts row.
	var composeWindow: ComposeRequest?
	/// Mac: composer windows open now. While one is, its Send is the one filled button and the main
	/// window's filled word (Reply, New Message, a newsletter's Archive) steps down (mac-r2-03).
	var composerWindows = 0

	private var refreshTask: Task<Void, Never>?
	/// The view `refreshTask` refreshes. Switching view starts the new view's own refresh; the
	/// older one still stores its page but no longer touches what is on screen.
	private var refreshing: MailView?
	private var refreshGeneration = 0
	private var autoRefreshTask: Task<Void, Never>?
	private var refreshesDone = 0
	private var backgroundTask: Task<Void, Never>?
	private var loadMoreTask: Task<Void, Never>?
	private var searchTask: Task<Void, Never>?
	private var otherCountTask: Task<Void, Never>?

	init() {
		let defaults = UserDefaults.standard
		sidebarShown = Self.flag(Key.sidebarShown) ?? true
		notifyEnabled = Self.flag(Key.notify) ?? true
		let account = defaults.string(forKey: Key.account).flatMap { $0.isEmpty ? nil : $0 }
		self.account = account
		if let start = LaunchOptions.openView {
			if start == "mileage" { showsMileage = true }
			if let kind = MailView.Kind(rawValue: start), kind != .person { view = MailView(kind).scoped(to: account) }
			else { view = MailView.personal.scoped(to: account) }
		} else {
			view = MailView.personal.scoped(to: account)
		}
		showsShortcuts = LaunchOptions.showShortcuts
		sessionStore = Self.makeSessionStore()
		#if os(iOS)
		// Subscribe at process launch, including location-only launches without a mounted scene.
		if !OfflinePilot.enabled && !LaunchOptions.fixtureMode && !MileageModel.testMode {
			protectedDataObserver = NotificationCenter.default.addObserver(
				forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
			) { [weak self] _ in
				Task { @MainActor [weak self] in
					self?.retrySession()
					self?.mileage?.active()
				}
			}
		}
		#endif
		notifications.model = self
		consent.onSessionEnded = { [weak self] _ in
			Task { await self?.sessionRejected() }
		}
		// The offline pilot: no account at all; the shell opens on Mileage.
		if OfflinePilot.enabled {
			if LaunchOptions.openView == nil { showsMileage = true }
			return
		}
		#if DEBUG
		// A Mileage test run: the app's own sign-in against the run's loopback Worker, opening on Mileage.
		if MileageModel.testMode {
			if LaunchOptions.openView == nil { showsMileage = true }
			if let saved = sessionStore.loadSession() {
				restore(saved)
			} else if let login = ProcessInfo.processInfo.environment["MILEAGE_TEST_LOGIN"], let colon = login.firstIndex(of: ":") {
				// `MILEAGE_TEST_LOGIN=email:password`: signs in at launch, so a state is captured with no input.
				let email = String(login[..<colon]), password = String(login[login.index(after: colon)...])
				Task { await signIn(email: email, password: password) }
			}
			return
		}
		#endif
		if LaunchOptions.fixtureMode {
			// Fixture failures are terminal; never consult Keychain or the real developer config.
			guard let credentials = LaunchOptions.fixtureCredentials else { return }
			if LaunchOptions.fixtureSignedOut {
				if let saved = sessionStore.loadSession(), saved.baseURL == credentials.baseURL {
					restore(saved)
				}
			} else {
				configure(credentials, identity: LaunchOptions.fixtureIdentity)
				if LaunchOptions.fixtureAppLock {
					lock.configure(identity: LaunchOptions.fixtureIdentity, restored: false)
				}
			}
			return
		}
		if let saved = sessionStore.loadSession() {
			restore(saved)
			return
		}
		#if DEBUG
		// Debug only: the developer's opt-in config, or a UI test's fake bearer for a loopback fixture.
		if let dev = DeveloperConfig().load() {
			configure(dev, identity: "developer " + dev.identityTag)
		}
		#endif
	}

	/// The Keychain item, or (Debug test harnesses) a file in the run's own folder.
	private static func makeSessionStore() -> any SessionStore {
		#if DEBUG
		if let file = LaunchOptions.testSessionFile { return FileSessionStore(file: file) }
		#endif
		return KeychainSessionStore(
			service: LaunchOptions.fixtureMode ? LaunchOptions.fixtureKeychainService : "io.examplebusiness.mailclaw.session",
			accessGroup: LaunchOptions.fixtureMode
				? nil : Bundle.main.object(forInfoDictionaryKey: "MCSharedKeychainGroup") as? String)
	}

	/// Mileage runs on this model's session from now on, and a session the Mileage server refuses
	/// (401) signs the whole app out.
	func connect(_ mileage: MileageModel) {
		self.mileage = mileage
		mileage.use(session, restored: true)
		mileage.onSessionRejected = { [weak self] in
			guard let self, session != nil else { return }
			// Ended, or the account is being deleted (then its ledger goes too): AppModel+Account.swift.
			Task { await self.sessionRejected() }
		}
	}

	/// Keychain is unreadable on a locked background launch. Retry synchronously on the main
	/// actor, so sign-out cannot interleave a load with restore. Fixtures keep their own lifecycle.
	func retrySession() {
		guard !OfflinePilot.enabled, !LaunchOptions.fixtureMode, !MileageModel.testMode,
		      session == nil, !signingIn, !signingOut, !sessionRetryBlocked else { return }
		#if os(iOS)
		guard MileageModel.protectedDataAvailable else { return }
		#endif
		if let saved = sessionStore.loadSession() { restore(saved) }
		else { mileage?.use(nil, restored: true) }
	}

	/// Account deletion: Mileage's local store for this identity goes with the rest (AppModel+Account).
	func eraseMileage(host: URL, email: String) {
		mileage?.erase(host: host, email: email)
	}

	/// A session kept on this device: mail opens locked until Face ID or the passcode.
	private func restore(_ saved: AppSession) {
		restoring = true
		session = saved
		restoring = false
		sessionEmail = saved.email
		configure(saved.credentials, identity: cacheIdentity(saved))
		lock.configure(identity: cacheIdentity(saved), restored: true)
		if !MileageModel.testMode { notifications.configure(saved, prompt: false) }
	}

	/// Opens the identity's own store (each server + account its own folder, attachments and kept
	/// drafts inside it) and its client. Debug builds keep their identities apart from Release's, so
	/// a Debug run never migrates the installed app's cache (d2-21).
	private func configure(_ credentials: Credentials, identity: String) {
		#if DEBUG
		let scoped = "debug " + identity
		#else
		let scoped = identity
		#endif
		let url = LaunchOptions.storePath.map { URL(fileURLWithPath: $0) } ?? MailStore.scopedURL(identity: scoped)
		// Drafts are state, not cache: their own folder beside the store ("mail-drafts"), which a
		// cache reset or a damaged cache never touches.
		drafts = DraftShelf(
			root: url.deletingLastPathComponent()
				.appendingPathComponent(url.deletingPathExtension().lastPathComponent + "-drafts", isDirectory: true),
			identity: Self.tag(scoped), reset: LaunchOptions.resetDrafts)
		if LaunchOptions.resetCache { MailStore.destroy(at: url) }
		storeError = nil
		let store: MailStore
		do {
			// Rebuilds a damaged or incompatible cache itself (d2-21).
			store = try MailStore(url: url)
		} catch {
			drafts = nil
			storeError = error.localizedDescription
			return
		}
		if LaunchOptions.dropNewest > 0 {
			for view in [MailView.personal, .all] { try? store.dropNewest(LaunchOptions.dropNewest, in: view) }
		}
		let api = APIClient(
			credentials: credentials, debugDelay: LaunchOptions.networkDelay,
			writeBaseURL: LaunchOptions.writeSink, dryWrites: LaunchOptions.dryWrites,
			fixtureOffline: LaunchOptions.fixtureOffline)
		sync = MailSync(api: api, store: store)
		consent.attach(api)
		meta = try? store.meta()
		loadFromStore()
		openFixtureIfRequested(store)
	}

	/// A short, stable folder name for an identity (never the identity itself: it holds the email).
	private static func tag(_ identity: String) -> String {
		SHA256.hash(data: Data(identity.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
	}

	// MARK: Session

	/// The form supplies the email and password; the server comes from the email (no address on
	/// screen). The password never leaves this request.
	func signIn(email: String, password: String) async {
		guard !signingIn, !signingOut, sync == nil else { return }
		signingIn = true
		signInError = nil
		let generation = sessionGeneration
		defer { if generation == sessionGeneration { signingIn = false } }
		let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
		let origin = ServerConfig.origin(forEmail: email)
		do {
			#if DEBUG
			// Test harnesses never reach a real server, whatever the email: their override or nothing.
			if LaunchOptions.fixtureMode || MileageModel.testMode, !ServerConfig.isLoopback(origin) {
				throw APIError.rejected("Invalid local fixture server")
			}
			#endif
			let client = try SessionClient(baseURL: origin, allowInsecureLoopback: origin.scheme == "http")
			let saved = try await client.login(email: email, password: password)
			guard generation == sessionGeneration, !Task.isCancelled else { try? await client.logout(saved); return }
			do {
				try sessionStore.save(saved)
				configure(saved.credentials, identity: cacheIdentity(saved))
				guard sync != nil else { throw APIError.rejected("Couldn't open mail on this device") }
			} catch {
				try? sessionStore.clear()
				try? await client.logout(saved)
				throw error
			}
			sessionRetryBlocked = false
			session = saved
			sessionEmail = saved.email
			lock.configure(identity: cacheIdentity(saved), restored: false)
			if !MileageModel.testMode { notifications.configure(saved, prompt: true) }
			setActive(true)
		} catch {
			guard generation == sessionGeneration else { return }
			signInError = Self.signInMessage(error, origin: origin)
		}
	}

	static let sessionEnded = "Your sign-in ended. Sign in again."

	/// Clears visible mail at once; waits for owned work, then closes and removes the identity's
	/// store (its attachments and kept drafts with it). Mileage ends with it: capture freezes and its
	/// report goes (`session = nil` hands it nil) before the one token is revoked. Revocation can fail
	/// offline; local sign-out still completes. `because`: the line the sign-in screen shows.
	func signOut(because reason: String? = nil) async {
		guard !signingOut else { return }
		signingOut = true
		sessionRetryBlocked = true
		defer { signingOut = false }
		let previous = session
		let oldSync = sync
		let tasks = [
			refreshTask, autoRefreshTask, backgroundTask, loadMoreTask, searchTask, otherCountTask, notificationTask,
			toastTask,
		].compactMap { $0 }
		for task in tasks { task.cancel() }
		refreshGeneration += 1
		sessionGeneration = UUID()
		lock.reset()
		queuedNotification = nil
		queuedBanner = nil
		notificationTask = nil
		sync = nil
		consent.reset()
		storeError = nil
		drafts = nil
		composer = nil
		sending = nil
		notice = nil
		composeWindow = nil
		Documents.shared.clear()
		BodyHeights.shared.clear()
		var clearError: String?
		do { try sessionStore.clear() } catch { clearError = Self.signInMessage(error) }
		session = nil
		sessionEmail = nil
		signingIn = false
		selection = nil
		cursor = nil
		cursorShown = false
		picked = []
		search = nil
		draft = ""
		rows = []
		pendingRows = nil
		notes = []
		notesFailed = false
		anchors = [:]
		unsubscribes = [:]
		newsletterOpen = nil
		pendingDelete = nil
		toast = nil
		meta = nil
		metaFetchedAt = nil
		personalUnread = 0
		announcedThrough = nil
		announcedNotes = []
		freshness = .idle
		lastUpdated = nil
		viewComplete = false
		refreshing = nil
		account = nil
		UserDefaults.standard.set("", forKey: Key.account)
		view = .personal
		refreshTask = nil
		autoRefreshTask = nil
		backgroundTask = nil
		loadMoreTask = nil
		searchTask = nil
		otherCountTask = nil
		toastTask = nil
		signInError = clearError ?? reason
		for task in tasks { await task.value }
		if let store = oldSync?.store {
			try? store.close()
			// Only the identity's own folder; an explicit fixture store (MC_STORE_PATH) stays.
			if LaunchOptions.storePath == nil { try? FileManager.default.removeItem(at: store.directory) }
		}
		await notifications.signOut(previous)
		if let previous, let client = try? SessionClient(for: previous) {
			try? await client.logout(previous)
		}
	}

	/// The signed-in app session's origin and address: what Delete account deletes and erases. Nil
	/// with no app session (a developer token can't delete an account: 400 NOT_A_SESSION).
	var accountIdentity: (origin: URL, email: String)? {
		if let session { return (session.baseURL, session.email) }
		// Debug fixtures signed in without a Keychain session (the ad hoc Mac build can't keep one).
		if sync != nil, let email = LaunchOptions.fixtureAccount, let origin = LaunchOptions.fixtureCredentials?.baseURL {
			return (origin, email)
		}
		return nil
	}

	private func cacheIdentity(_ session: AppSession) -> String {
		(LaunchOptions.fixtureMode ? LaunchOptions.fixtureIdentity + " " : "") + session.cacheIdentity
	}

	private static func signInMessage(_ error: Error, origin: URL? = nil) -> String {
		switch error {
		case APIError.offline: "Can't reach the server"
		// Everyone's server: a person sets their own app password on the web (2026-10-30).
		case APIError.http(401, _) where origin == ServerConfig.hosted:
			"Check your email and password. No app password yet? Set one at mail.business.example: account menu, App password."
		case APIError.http(401, _): "Check your email and password"
		case APIError.http(429, _): "Too many attempts. Try again later"
		// 403 ACCOUNT_DELETED: the right password for an account being deleted (API.md).
		case AccountFailure.accountDeleted: accountDeletedLine
		case let APIError.rejected(message): message
		default: "Couldn't sign in. Try again"
		}
	}

	/// A push for this account was tapped: its conversation opens once mail can be read.
	func queueNotification(account: String, messageId: String) {
		guard account == sessionEmail, !messageId.isEmpty else { return }
		queuedNotification = (account, messageId)
		openQueuedNotification()
	}

	/// A banner this app posted was tapped: it names its conversation, which opens once mail can be read.
	func queueBanner(_ id: String, emailId: String?) {
		queuedBanner = (id, emailId)
		openQueuedNotification()
	}

	func openQueuedNotification() {
		if canRead, sync != nil, let banner = queuedBanner {
			queuedBanner = nil
			openFromNotification(banner.id, emailId: banner.emailId)
			return
		}
		guard canRead, let queued = queuedNotification, queued.account == sessionEmail, let sync else { return }
		queuedNotification = nil
		let generation = sessionGeneration
		notificationTask?.cancel()
		notificationTask = Task {
			guard let message = try? await sync.api.notificationMessage(id: queued.messageId),
				generation == sessionGeneration, !Task.isCancelled else { return }
			guard canRead else {
				queuedNotification = queued
				return
			}
			openFromNotification(message.threadId ?? message.id, emailId: message.id)
		}
	}

	/// A UserDefaults flag, nil when unset; launch arguments arrive as the strings YES/NO.
	private static func flag(_ key: String) -> Bool? {
		UserDefaults.standard.object(forKey: key) == nil ? nil : UserDefaults.standard.bool(forKey: key)
	}

	// MARK: Views and refresh

	/// A sidebar view, in the selected account. The view on screen again (from the rail's menu, or
	/// during a search) goes back to its full list.
	func select(_ newView: MailView) {
		showsMileage = false
		let scoped = newView.scoped(to: account)
		guard scoped != view else {
			cancelSearch()
			selection = nil
			return
		}
		show(scoped)
	}

	/// Mileage in place of the list; the view underneath stays as it was.
	func selectMileage() {
		cancelSearch()
		selection = nil
		cursorShown = false
		showsMileage = true
	}

	/// Changes the account and keeps the view (WD-02).
	func select(account newAccount: String?) {
		let newAccount = newAccount?.isEmpty == true ? nil : newAccount
		guard newAccount != account else { return }
		account = newAccount
		UserDefaults.standard.set(newAccount ?? "", forKey: Key.account)
		show(view.scoped(to: newAccount))
	}

	/// The account menu's addresses, the selected one included before /api/meta arrives.
	var accounts: [String] {
		let known = meta?.accounts ?? []
		guard let account, !known.contains(account) else { return known }
		return known + [account]
	}

	var persons: [String] { meta?.persons ?? [] }

	private func show(_ newView: MailView) {
		guard newView != view else { return }
		view = newView
		cancelSearch()
		// The reader shows a conversation of the list beside it (d2-16).
		selection = nil
		cursor = nil
		cursorShown = false
		picked = []
		pendingRows = nil
		isAtTop = true
		backgroundTask?.cancel()
		loadMoreTask?.cancel()
		loadFromStore()
		refresh()
	}

	private func loadFromStore() {
		guard let store = sync?.store else { return }
		rows = (try? store.rows(in: view)) ?? []
		if LaunchOptions.notesFail {
			notes = []
			notesFailed = true
		} else {
			notes = view.kind == .personal ? (Self.fixtureNotes ?? (try? store.notes()) ?? []) : []
		}
		let state = try? store.syncState(view)
		lastUpdated = state?.refreshedAt
		viewComplete = state?.complete ?? false
		freshness = lastUpdated.map(Freshness.updated) ?? .idle
		countPersonalUnread()
		if !rows.isEmpty { Perf.launchRowsShown(fromCache: true) }
	}

	func countPersonalUnread() {
		guard let store = sync?.store else { return }
		personalUnread = (try? store.unreadCount(in: MailView.personal.scoped(to: account))) ?? 0
	}

	func refresh() {
		guard let sync, refreshing != view else { return }
		let view = self.view
		refreshGeneration += 1
		let generation = refreshGeneration
		refreshing = view
		freshness = .updating
		refreshMetaIfStale()
		refreshTask = Task {
			defer {
				if generation == refreshGeneration {
					refreshTask = nil
					refreshing = nil
				}
			}
			// Notes: did the load work? A failure must not read as "nothing right now" (WD-13).
			let fixture = Self.fixtureNotes != nil || LaunchOptions.notesFail
			let notesTask: Task<Bool, Never>? = view.kind == .personal && !fixture
				? Task { (try? await sync.refreshNotes()) != nil } : nil
			do {
				try await sync.refresh(view)
				let notesLoaded = await notesTask?.value
				// Notifications compare the store with what was already announced, whichever
				// view is on screen by now.
				if view == .personal { postNewMailNotifications() }
				guard generation == refreshGeneration else { return }
				refreshesDone += 1
				if LaunchOptions.perfProbe { PerfProbe.shared.set("refreshes_ok", ms: Double(refreshesDone)) }
				lastUpdated = Date()
				freshness = .updated(lastUpdated!)
				reloadRows()
				if let notesLoaded {
					notesFailed = !notesLoaded
					if notesLoaded { notes = (try? sync.store.notes()) ?? [] }
				}
				startBackgroundWork(for: view)
			} catch let error as APIError {
				let notesLoaded = await notesTask?.value
				guard generation == refreshGeneration else { return }
				if notesLoaded == false { notesFailed = true }
				switch error {
				case .offline: freshness = .offline(lastUpdated: lastUpdated)
				case .http(401, _), .http(403, _):
					freshness = .failed("Sign-in rejected")
					// A revoked or expired session, or an account being deleted: back to sign-in, this
					// identity's cache wiped, the sign-in screen saying which (AppModel+Account.swift).
					Task { await self.sessionRejected() }
				case .http(429, _): freshness = .failed("Busy, try again shortly")
				case let .http(status, _): freshness = .failed("Error \(status)")
				case .decoding: freshness = .failed("Unexpected response")
				case let .rejected(message): freshness = .failed(message)
				}
			} catch is CancellationError {
			} catch {
				// Not the network: the device's store could not keep the page (d2-21). Offline is
				// only ever the network.
				guard generation == refreshGeneration else { return }
				if view.kind == .personal, !fixture { notesFailed = true }
				freshness = .failed("Couldn’t save mail on this device")
			}
		}
	}

	// MARK: Needs you

	/// Done for every note of the job: off the list at once, back with a message if the server
	/// refuses (no offline queue). Undo puts each note back (PUT re-opens it).
	func done(_ job: NeedsYouJob) {
		guard let sync else { return }
		let taken = job.notes
		let ids = Set(taken.map(\.emailId))
		notes.removeAll { ids.contains($0.emailId) }
		Task { [weak self] in
			guard let self else { return }
			do {
				for note in taken { try await sync.markNoteDone(note) }
				showToast("Done: \(job.text)") { [weak self] in self?.undoDone(taken) }
			} catch {
				notes += taken.filter { note in !notes.contains { $0.emailId == note.emailId } }
				showToast("Couldn't mark it done. Nothing changed.", undo: nil)
			}
		}
	}

	private func undoDone(_ taken: [ActionNote]) {
		guard let sync else { return }
		notes += taken.filter { note in !notes.contains { $0.emailId == note.emailId } }
		Task {
			do {
				for note in taken { try await sync.reopenNote(note) }
			} catch {
				let ids = Set(taken.map(\.emailId))
				notes.removeAll { ids.contains($0.emailId) }
				showToast("Couldn't put it back.", undo: nil)
			}
		}
	}

	/// Asks for the notes again (the error state's "Try again").
	func retryNotes() {
		guard let sync, Self.fixtureNotes == nil else {
			notesFailed = false
			notes = Self.fixtureNotes ?? []
			return
		}
		Task {
			do {
				try await sync.refreshNotes()
				notes = (try? sync.store.notes()) ?? []
				notesFailed = false
			} catch {
				notesFailed = true
			}
		}
	}

	/// One toast at a time, for 6 s: it replaces the last.
	/// An error stays until dismissed or the next toast (S7).
	func showToast(_ text: String, undo: (@MainActor () -> Void)? = nil, isError: Bool = false) {
		toast = Toast(text: text, undo: undo, isError: isError)
		toastTask?.cancel()
		guard !isError else { return }
		toastTask = Task {
			try? await Task.sleep(for: .seconds(6))
			if !Task.isCancelled { toast = nil }
		}
	}

	func runToastUndo() {
		let undo = toast?.undo
		toast = nil
		undo?()
	}

	/// Twelve synthetic notes for the UI test (`MC_NOTES_FIXTURE_JSON`), never the network's.
	static let fixtureNotes: [ActionNote]? = {
		guard let json = LaunchOptions.notesFixtureJSON, let data = json.data(using: .utf8) else { return nil }
		let decoder = JSONDecoder()
		decoder.keyDecodingStrategy = .convertFromSnakeCase
		return try? decoder.decode([ActionNote].self, from: data)
	}()

	/// Keeps the open app fresh (the app's scene phase calls this): one refresh on becoming active,
	/// then one every `LaunchOptions.autoRefreshInterval` (2 min) until it leaves the foreground.
	/// Each is the same `refresh()`; rows that would move on screen still wait in `pendingRows`,
	/// and a refresh of the same view still running makes the next one a no-op.
	/// Mac with notifications on: like Mail, it keeps checking Personal and Needs you on the same
	/// clock while the window is closed or another view is on screen (`checkForNewMail`).
	/// Refreshing on screen needs mail readable (`canRead`: unlocked, uncovered). The Mac's background
	/// check for banners needs only the session; the system's preview setting governs what a banner
	/// shows while the Mac is locked.
	func setActive(_ active: Bool) {
		isActive = active && canRead
		autoRefreshTask?.cancel()
		autoRefreshTask = nil
		if isActive {
			openQueuedNotification()
			notifications.retryRegistration()
		}
		guard sync != nil, !signingOut, isActive || pollsForNotifications else { return }
		autoRefreshTask = Task {
			while !Task.isCancelled {
				if isActive { refresh() }
				if !isActive || view != .personal { await checkForNewMail() }
				try? await Task.sleep(for: LaunchOptions.autoRefreshInterval)
			}
		}
	}

	/// The account menu's addresses and forwarded-in people's names change rarely: at most every 10 minutes.
	private func refreshMetaIfStale() {
		guard let sync, metaFetchedAt.map({ Date().timeIntervalSince($0) > 600 }) ?? true else { return }
		metaFetchedAt = Date()
		Task {
			if let fresh = try? await sync.refreshMeta() { meta = fresh }
		}
	}

	func refreshAndWait() async {
		refresh()
		await refreshTask?.value
	}

	/// Prefetch the newest Personal threads (opens become instant), then back-fill the rest.
	private func startBackgroundWork(for view: MailView) {
		guard view.kind == .personal, let sync, backgroundTask == nil else { return }
		let generation = sessionGeneration
		let newest = Array(rows.prefix(10))
		let prefetch = !LaunchOptions.noPrefetch
		backgroundTask = Task.detached(priority: .utility) { [weak self] in
			if prefetch { await sync.prefetch(newest) }
			await sync.backfill(view)
			await self?.backgroundFinished(generation: generation)
		}
	}

	private func backgroundFinished(generation: UUID) {
		guard generation == sessionGeneration else { return }
		backgroundTask = nil
		reloadRows()
	}

	/// Called when the last row appears: show what back-fill stored, or fetch the next page.
	func loadMoreIfNeeded() {
		guard let sync, loadMoreTask == nil, !isSearching else { return }
		let view = self.view
		let generation = sessionGeneration
		loadMoreTask = Task {
			defer { if generation == sessionGeneration { loadMoreTask = nil } }
			if backgroundTask == nil, !viewComplete { _ = try? await sync.loadMore(view) }
			guard generation == sessionGeneration, view == self.view, !Task.isCancelled else { return }
			reloadRows()
		}
	}

	func reloadRows() {
		guard let store = sync?.store else { return }
		let fresh = (try? store.rows(in: view)) ?? []
		viewComplete = (try? store.syncState(view))?.complete ?? false
		apply(fresh)
		countPersonalUnread()
	}

	/// The same change to every list on screen (rows, rows waiting behind "N new"), after the
	/// server took an action. A search's answer is the server's and shows again on its next run.
	func editRows(_ edit: (inout [ConversationRow]) -> Void) {
		edit(&rows)
		if pendingRows != nil { edit(&pendingRows!) }
	}

	/// New rows replace the list unless that would move rows the user is looking at: rows below the
	/// last one shown (older pages, back-fill) are appended at once; anything else waits behind the
	/// "N new" button while scrolled down.
	private func apply(_ fresh: [ConversationRow]) {
		let onlyAppended = fresh.count >= rows.count && zip(fresh, rows).allSatisfy { $0.id == $1.id }
		if rows.isEmpty || onlyAppended || isAtTop {
			let wasEmpty = rows.isEmpty
			rows = fresh
			pendingRows = nil
			if wasEmpty, !fresh.isEmpty { Perf.launchRowsShown(fromCache: false) }
		} else {
			pendingRows = fresh
			let shown = Set(rows.map(\.id))
			let bottom = fresh.indices.last { shown.contains(fresh[$0].id) } ?? fresh.count - 1
			let older = fresh[(bottom + 1)...].filter { !shown.contains($0.id) }
			if !older.isEmpty { rows += older }
		}
		if LaunchOptions.perfProbe { PerfProbe.shared.set("rows_pending", ms: pendingRows == nil ? 0 : 1) }
	}

	var pendingCount: Int {
		guard let pendingRows else { return 0 }
		let current = Set(rows.map(\.id))
		return pendingRows.filter { !current.contains($0.id) }.count
	}

	func showPendingRows() {
		guard let pendingRows else { return }
		rows = pendingRows
		self.pendingRows = nil
	}

	// MARK: Selection

	func open(_ note: ActionNote) {
		open(note.conversationId, anchor: note.emailId)
	}

	/// Opens a conversation: the thread takes the detail and the list folds into the rail (Mac),
	/// or the thread is pushed (iPhone). The list keeps its cursor there.
	func open(_ id: String, anchor: String? = nil) {
		// A draft opens in the composer (AppModel+Compose.swift).
		if openDraft(id) { return }
		if let anchor, !anchor.isEmpty { anchors[id] = anchor }
		showsMileage = false
		selection = id
		cursor = id
	}

	func focusSearch() {
		searchFocusRequests += 1
	}

	/// One line at the bottom of the window for 6 s: what an action did, with Undo when it can be
	/// undone, or why it failed.
	func dismissToast() {
		toastTask?.cancel()
		toast = nil
	}

	func anchor(for id: String) -> String? {
		anchors[id] ?? visibleRows.first(where: { $0.id == id })?.displayEmailId
	}

	/// Rows in on-screen order, for j/k.
	var visibleRows: [ConversationRow] {
		guard let search else { return rows }
		return search.answer?.results.map(\.row) ?? []
	}

	/// What the rail, Back and "Next in" call the list: the view, or "Results" during a search.
	var listName: String { isSearching ? "Results" : view.title }

	/// The conversation after `id` in the list on screen: iPhone's "Next in Personal" (L3).
	/// Nil at the end of the list, or when `id` isn't in it (opened from a note or a banner).
	func nextConversation(after id: String) -> ConversationRow? {
		let list = visibleRows
		guard let index = list.firstIndex(where: { $0.id == id }), index + 1 < list.count else { return nil }
		return list[index + 1]
	}

	/// Where the open conversation sits in the list ("4 of 25"), shown while the rail is hidden.
	var openPosition: (index: Int, count: Int)? {
		let list = visibleRows
		guard let selection, let index = list.firstIndex(where: { $0.id == selection }) else { return nil }
		return (index, list.count)
	}

	func moveSelection(by offset: Int) {
		let list = visibleRows
		guard !list.isEmpty else { return }
		guard let selection, let index = list.firstIndex(where: { $0.id == selection }) else {
			self.selection = list.first?.id
			return
		}
		self.selection = list[max(0, min(list.count - 1, index + offset))].id
	}

	// MARK: Search (r2 S4: on the server only, one answer per submit)

	/// Runs what the field holds over All Mail; the results replace the screen, even over an open
	/// thread (WP-09). An empty field leaves search.
	func submitSearch() {
		let query = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !query.isEmpty else { return cancelSearch() }
		showsMileage = false
		picked = []
		search = Search(query: query, view: view)
		selection = nil
		runSearch()
	}

	/// "Did you mean", "Search for … instead": the field takes the query and it runs.
	func searchFor(_ query: String) {
		draft = query
		submitSearch()
	}

	/// The pills: All mail, or the view the search started from.
	func setSearchScope(_ scope: Search.Scope) {
		guard var current = search, current.scope != scope else { return }
		// The pill being left keeps the count it had.
		current.otherCount = current.answer?.countLabel
		current.scope = scope
		search = current
		selection = nil
		runSearch()
	}

	func retrySearch() { runSearch() }

	/// Cancel (iPhone), a cleared field (Mac) or a view chosen: back to the view.
	func cancelSearch() {
		picked = []
		searchTask?.cancel()
		otherCountTask?.cancel()
		search = nil
		draft = ""
		// Leaving a search, the reader shows a conversation of the list beside it (d2-16).
		if let selection, !rows.contains(where: { $0.id == selection }),
		   !notes.contains(where: { $0.conversationId == selection }) {
			self.selection = nil
		}
	}

	private func runSearch() {
		guard let sync, var current = search else { return }
		searchTask?.cancel()
		otherCountTask?.cancel()
		current.status = .loading
		search = current
		let query = current.query
		let view = current.view
		let scope = current.scope
		let narrows = current.narrows
		Perf.begin("search_server", key: "search_server")
		searchTask = Task {
			let status: Search.Status
			do {
				let answer = try await sync.search(query, narrowedTo: scope == .view ? view : nil)
				status = .answered(answer)
			} catch is CancellationError {
				return
			} catch APIError.offline {
				status = .offline
			} catch let APIError.rejected(message) {
				status = .rejected(message)
			} catch {
				status = .failed
			}
			guard !Task.isCancelled, search?.query == query, search?.scope == scope else { return }
			search?.status = status
			Perf.end("search_server", key: "search_server", sample: "search_server_ms")
			if case .answered = status, narrows, search?.otherCount == nil {
				countOtherScope(query: query, view: view, scope: scope)
			}
		}
	}

	/// The other pill's count: its own request, once the answer on screen is in.
	private func countOtherScope(query: String, view: MailView, scope: Search.Scope) {
		guard let sync else { return }
		otherCountTask = Task {
			guard let answer = try? await sync.search(query, narrowedTo: scope == .view ? nil : view),
			      !Task.isCancelled, search?.query == query, search?.scope == scope
			else { return }
			search?.otherCount = answer.countLabel
		}
	}

	// MARK: Triage (S7): the one action engine; the Mac toolbar, menus and keys call it too

	/// The conversation the Delete-forever confirm names (inside Trash only, WP-04).
	var pendingDelete: ConversationRow?
	/// Conversations whose open is marking them read: one request each at a time.
	@ObservationIgnored private var markingRead: Set<String> = []

	/// Opening a conversation marks it read, as the web does (before, mail
	/// opened on the iPhone stayed unread). From the row the list shows unread, at once; with `detail`, the
	/// server's copy of the thread, one the list didn't show unread (opened from a note, a banner,
	/// search, or a list that drifted). Quiet when it works: opening isn't an action to undo.
	/// Refused or offline, the row reads unread again and the toast says so. Returns whether it
	/// asked the server.
	@discardableResult
	func markOpenedRead(_ id: String, detail: ConversationDetail? = nil) -> Bool {
		guard let sync, !markingRead.contains(id) else { return false }
		let row = visibleRows.first { $0.id == id } ?? rows.first { $0.id == id }
		guard row?.isDraft != true else { return false }
		guard detail.map({ $0.conversation.unreadCount > 0 }) ?? (row?.unread == true) else { return false }
		markingRead.insert(id)
		flipUnread([id], to: false)
		Task {
			defer { markingRead.remove(id) }
			do {
				try await sync.act(.markRead, on: [id], leaving: nil)
				countPersonalUnread()
			} catch {
				if let row { restoreRead([row]) }
				let it = row.map { Self.what([$0]) } ?? "this conversation"
				showToast(Self.failedText("mark \(it) read", error), isError: true)
			}
		}
		return true
	}

	var inTrash: Bool { view.kind == .trash && !isSearching }

	/// Archive, Trash, Restore and Read/Unread on whole conversations: the server first, then a
	/// toast with Undo. Refused or offline, the rows come back and the toast says what didn't
	/// happen; nothing queues. Rows that leave the list go at once. Archive and Trash of the open
	/// conversation open the next one, on the Mac and the iPhone alike (L3; iOS Mail's default),
	/// even where the row stays listed (All mail, search results); after the last, the list.
	func triage(_ action: TriageAction, _ targets: [ConversationRow]) {
		guard let sync, !targets.isEmpty else { return }
		let ids = targets.map(\.id)
		let gone = Set(ids)
		let leaving = leaves(action)
		let shownView = view
		let removed = rows.enumerated().filter { gone.contains($0.element.id) }.map { ($0.offset, $0.element) }
		let wasSelected = selection
		let advances = (action == .archive || action == .trash) && wasSelected.map(gone.contains) == true
		let next = advances || leaving ? nextSelection(after: gone) : nil
		if leaving {
			// The Mac list's keyboard cursor moves to the row taking the removed one's place (S6).
			if let cursor, gone.contains(cursor) { self.cursor = next ?? nextRow(after: cursor, skipping: gone) }
			rows.removeAll { gone.contains($0.id) }
		}
		if advances {
			selection = next
			if let next { cursor = next }
		}
		if action == .markRead || action == .markUnread {
			flipUnread(gone, to: action == .markUnread)
		}
		Task {
			await send(
				action, targets, sync: sync, leaving: leaving, advances: advances, from: shownView,
				removed: removed, wasSelected: wasSelected)
		}
	}

	/// The server half of `triage`: confirmed, a toast with Undo; refused, the screen as it was.
	private func send(
		_ action: TriageAction, _ targets: [ConversationRow], sync: MailSync, leaving: Bool, advances: Bool,
		from shownView: MailView, removed: [(Int, ConversationRow)], wasSelected: String?
	) async {
		do {
			try await sync.act(action, on: targets.map(\.id), leaving: leaving ? shownView : nil)
		} catch {
			if view == shownView {
				if leaving { putBack(removed) }
				if action == .markRead || action == .markUnread { restoreRead(targets) }
			}
			// The conversation it advanced from comes back on screen with the failure.
			if advances, let wasSelected, selection != wasSelected { selection = wasSelected }
			showToast(Self.failedText(action, targets, error), isError: true)
			return
		}
		let back = Self.changed(action, targets)
		let putAgain = leaving ? removed : []
		var undoIt: (@MainActor () -> Void)?
		if !back.isEmpty {
			let reverse: @MainActor () -> Void = { [weak self] in
				self?.undo(action.undo, back, removed: putAgain, in: shownView)
			}
			// Mac: the window's UndoManager holds it, so the toast's Undo, Edit > Undo, Cmd+Z and z
			// are one history (S6). Elsewhere the toast holds it.
			if let undoManager {
				undoManager.registerUndo(withTarget: self) { _ in MainActor.assumeIsolated { reverse() } }
				undoManager.setActionName(action.title)
				undoIt = { [weak undoManager] in undoManager?.undo() }
			} else {
				undoIt = reverse
			}
		}
		showToast(Self.doneText(action, targets), undo: undoIt)
	}

	/// e, #, Shift-U and z on the list (the Mac's menu calls the same actions).
	func triageKey(_ key: String) -> Bool {
		if key == "z" { return undoLast() }
		guard let row = actionTargetRow else { return false }
		switch key {
		case "e" where !inTrash: triage(.archive, [row])
		case "#": if inTrash { pendingDelete = row } else { triage(.trash, [row]) }
		case "U": triage(.markUnread, [row])
		default: return false
		}
		return true
	}

	/// z, the toast's Undo and Edit > Undo: the last action, once.
	@discardableResult
	func undoLast() -> Bool {
		if let undoManager {
			guard undoManager.canUndo else { return false }
			dismissToast()
			undoManager.undo()
			return true
		}
		guard toast?.undoable == true else { return false }
		runToastUndo()
		return true
	}

	/// After the confirm: every message of the conversation in Trash, deleted on the server first.
	func deleteForever(_ row: ConversationRow) {
		guard let sync else { return }
		pendingDelete = nil
		Task {
			do {
				try await sync.deleteForever(row.id, from: view)
			} catch {
				showToast(Self.failedText("delete \(Self.quoted(row.subject)) forever", error), isError: true)
				return
			}
			if selection == row.id { selection = nextSelection(after: [row.id]) }
			rows.removeAll { $0.id == row.id }
			showToast("Deleted \(Self.quoted(row.subject)) forever")
		}
	}

	private func undo(_ action: TriageAction, _ targets: [ConversationRow], removed: [(Int, ConversationRow)], in shownView: MailView) {
		guard let sync else { return }
		dismissToast()
		Task {
			do {
				try await sync.act(action, on: targets.map(\.id), leaving: nil)
			} catch {
				showToast(Self.failedText("undo", error), isError: true)
				return
			}
			if view == shownView {
				putBack(removed)
				if action == .markRead || action == .markUnread { restoreRead(targets) }
			}
			// The server's list puts back what this device dropped (view membership, order).
			refresh()
		}
	}

	/// Whether `action` takes a conversation out of the list on screen.
	private func leaves(_ action: TriageAction) -> Bool {
		switch action {
		case .markRead, .markUnread: false
		case .restore: inTrash
		case .trash: !inTrash
		// Archive takes mail out of Personal; All Mail, Sent, Drafts and search still list it.
		case .archive: view.kind == .personal && !isSearching
		}
	}

	/// The row below `id` that stays, else the one above (the cursor's next place).
	private func nextRow(after id: String, skipping gone: Set<String>) -> String? {
		let list = visibleRows
		guard let index = list.firstIndex(where: { $0.id == id }) else { return nil }
		return list[(index + 1)...].first { !gone.contains($0.id) }?.id
			?? list[..<index].last { !gone.contains($0.id) }?.id
	}

	/// Once `gone` leaves the list: the conversation below the open one, else the one above.
	private func nextSelection(after gone: Set<String>) -> String? {
		let list = visibleRows
		guard let selection, let index = list.firstIndex(where: { $0.id == selection }) else { return nil }
		return list[(index + 1)...].first { !gone.contains($0.id) }?.id
			?? list[..<index].last { !gone.contains($0.id) }?.id
	}

	private func flipUnread(_ ids: Set<String>, to unread: Bool) {
		editRows { list in list = list.map { ids.contains($0.id) ? $0.with(unread: unread) : $0 } }
		countPersonalUnread()
	}

	/// Each target's read state as it was before the action.
	private func restoreRead(_ targets: [ConversationRow]) {
		let before = Dictionary(targets.map { ($0.id, $0.unread) }, uniquingKeysWith: { first, _ in first })
		editRows { list in list = list.map { row in before[row.id].map { row.with(unread: $0) } ?? row } }
		countPersonalUnread()
	}

	private func putBack(_ removed: [(Int, ConversationRow)]) {
		for (index, row) in removed.sorted(by: { $0.0 < $1.0 }) where !rows.contains(where: { $0.id == row.id }) {
			rows.insert(row, at: min(index, rows.count))
		}
	}

	/// “Subject”, cut at 40 characters.
	static func quoted(_ subject: String) -> String {
		"“\(subject.count > 40 ? String(subject.prefix(40)).trimmingCharacters(in: .whitespaces) + "…" : subject)”"
	}

	private static func what(_ targets: [ConversationRow]) -> String {
		targets.count == 1 ? quoted(targets[0].subject) : "\(targets.count) conversations"
	}

	private static func doneText(_ action: TriageAction, _ targets: [ConversationRow]) -> String {
		let it = what(targets)
		switch action {
		case .archive: return "Archived \(it)"
		case .trash: return "Moved \(it) to Trash"
		case .restore: return "Restored \(it)"
		case .markRead: return "Marked \(it) read"
		case .markUnread: return "Marked \(it) unread"
		}
	}

	private static func failedText(_ action: TriageAction, _ targets: [ConversationRow], _ error: Error) -> String {
		let it = what(targets)
		let doing = switch action {
		case .archive: "archive \(it)"
		case .trash: "move \(it) to Trash"
		case .restore: "restore \(it)"
		case .markRead: "mark \(it) read"
		case .markUnread: "mark \(it) unread"
		}
		return failedText(doing, error)
	}

	/// A refusal changed nothing; offline, the outcome is unknown, and nothing retries.
	private static func failedText(_ doing: String, _ error: Error) -> String {
		if (error as? APIError)?.isOffline == true {
			return "Couldn’t \(doing): you’re offline. It’s shown as it was; check again once you’re online."
		}
		return "Couldn’t \(doing). Nothing changed."
	}

	/// Undo of Mark read re-marks only what was unread before; of Mark unread, only what was read.
	private static func changed(_ action: TriageAction, _ targets: [ConversationRow]) -> [ConversationRow] {
		switch action {
		case .markRead: targets.filter(\.unread)
		case .markUnread: targets.filter { !$0.unread }
		case .archive, .trash, .restore: targets
		}
	}

	// MARK: Debug fixture

	private func openFixtureIfRequested(_ store: MailStore) {
		if let path = LaunchOptions.fixturePath, let body = FileManager.default.contents(atPath: path) {
			try? store.saveFixtureThread(body)
		}
		if let id = LaunchOptions.openThread {
			if let anchor = LaunchOptions.openAnchor { anchors[id] = anchor }
			selection = id
		}
	}
}
