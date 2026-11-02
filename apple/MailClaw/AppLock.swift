import CryptoKit
import Foundation
import LocalAuthentication
import Observation

/// The mail privacy gate is separate from session storage. Credentials keep their device-only
/// Keychain protection. Off until the person turns it on (SPEC §1): an install that never chose
/// stays off. A device that can't authenticate its owner (no passcode) never locks, so the lock can
/// never shut someone out of their own mail.
@MainActor @Observable
final class AppLock {
	private(set) var enabled = false
	private(set) var timeout = 300
	private(set) var isLocked = false
	private(set) var privacyCovered = false
	private(set) var authenticating = false
	private(set) var error: String?
	private var backgroundAt: Date?
	private var generation = UUID()
	private var context: LAContext?
	private var defaults: UserDefaults = .standard
	private var preferenceKey = ""
	private var hasSession = false
	/// Set up for a session: the lock's settings apply (SessionSettings shows them).
	var isConfigured: Bool { hasSession }

	func configure(identity: String, restored: Bool) {
		reset()
		hasSession = true
		let hash = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
		defaults =
			LaunchOptions.fixtureMode
			? UserDefaults(suiteName: LaunchOptions.fixtureKeychainService)! : .standard
		preferenceKey = "mail-lock." + hash
		enabled = defaults.object(forKey: preferenceKey + ".enabled") as? Bool ?? false
		let saved = defaults.object(forKey: preferenceKey + ".timeout") as? Int ?? 300
		timeout = [0, 60, 300, 900].contains(saved) ? saved : 300
		isLocked = restored && enabled && Self.canAuthenticate
	}

	/// Whether the device can check its owner (Face ID, Touch ID or the passcode). Asked each time:
	/// a passcode can be removed while MailClaw runs.
	static var canAuthenticate: Bool {
		#if DEBUG
			if LaunchOptions.fixtureMode { return LaunchOptions.localAuthResult != "unavailable" }
		#endif
		return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
	}
	func reset() {
		generation = UUID()
		context?.invalidate()
		context = nil
		hasSession = false
		isLocked = false
		error = nil
		authenticating = false
		backgroundAt = nil
	}
	func setTimeout(_ seconds: Int) {
		guard [0, 60, 300, 900].contains(seconds), hasSession else { return }
		timeout = seconds
		defaults.set(seconds, forKey: preferenceKey + ".timeout")
	}
	func setEnabled(_ value: Bool) async {
		guard value != enabled, hasSession else { return }
		if value, !Self.canAuthenticate {
			error = "Set up a passcode on this device to lock Grip."
			return
		}
		let current = generation
		if !value, Self.canAuthenticate, !(await authenticate()) { return }
		guard current == generation, hasSession else { return }
		enabled = value
		defaults.set(value, forKey: preferenceKey + ".enabled")
	}
	func inactive(background: Bool) {
		privacyCovered = true
		guard background, !authenticating, hasSession, enabled else { return }
		if backgroundAt == nil { backgroundAt = Date() }
		if timeout == 0, Self.canAuthenticate { isLocked = true }
	}
	func foreground() {
		if let backgroundAt, enabled, Date().timeIntervalSince(backgroundAt) >= Double(timeout),
			Self.canAuthenticate
		{
			isLocked = true
		}
		backgroundAt = nil
		privacyCovered = false
	}
	func lockNow() {
		guard hasSession, enabled, Self.canAuthenticate else { return }
		isLocked = true
		error = nil
	}
	func unlock() async {
		// Locked, then the passcode was removed: nothing can check the owner, so it opens.
		guard Self.canAuthenticate else {
			isLocked = false
			return
		}
		let current = generation
		if await authenticate(), current == generation, hasSession { isLocked = false }
	}
	private func authenticate() async -> Bool {
		guard !authenticating, hasSession else { return false }
		authenticating = true
		error = nil
		let current = generation
		defer {
			if current == generation {
				authenticating = false
				context = nil
			}
		}
		#if DEBUG
			if LaunchOptions.fixtureMode {
				guard LaunchOptions.fixtureCredentials != nil else { return false }
				switch LaunchOptions.localAuthResult {
				case "success": return true
				case "cancel":
					error = "Unlock canceled. Try again when you’re ready."
					return false
				default:
					error =
						"Device authentication is unavailable. Set up a device passcode or sign in again."
					return false
				}
			}
		#endif
		let request = LAContext()
		context = request
		var failure: NSError?
		guard request.canEvaluatePolicy(.deviceOwnerAuthentication, error: &failure) else {
			error =
				"Device authentication is unavailable. Set up a device passcode or sign in again."
			return false
		}
		do {
			let success = try await request.evaluatePolicy(
				.deviceOwnerAuthentication, localizedReason: "Unlock your mail")
			return current == generation && success
		} catch {
			guard current == generation else { return false }
			let code = (error as? LAError)?.code
			if code == .userCancel || code == .systemCancel || code == .appCancel {
				self.error = "Unlock canceled. Try again when you’re ready."
			} else {
				self.error = "Couldn’t unlock your mail. Try again or sign in again."
			}
			return false
		}
	}
}
