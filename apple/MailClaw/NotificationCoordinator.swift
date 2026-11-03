import Foundation
import MailClawKit
import UserNotifications

#if os(iOS)
	import UIKit
#else
	import AppKit
#endif

/// Owns OS registration, fenced to one session. Mail content stays in the authenticated API.
/// iPhone and iPad only: the Mac announces new mail itself while it runs (AppModel+Notifications,
/// NotificationRouter), so a server push there would be a second banner for the same message.
/// On iPhone and iPad it is also the delegate for the banners the app posts itself while in front
/// (new Needs-you notes, build 6): they show over the app and a tap opens their conversation.
@MainActor
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
	static weak var current: NotificationCoordinator?
	weak var model: AppModel?
	private var session: AppSession?
	private var generation = UUID()
	private var registration: Task<Void, Never>?
	private var setup: Task<Void, Never>?
	private var token: String?
	private var attemptedFor: String?
	private var registeredFor: String?
	/// Sign-in's ask is out. iOS shows one system prompt at a time, so Mileage holds its location and motion asks
	/// meanwhile (MileageLocation): build 12 raised the location alert while this ask was still out, and the walk's
	/// iPads never showed Notifications (iPad/Mac UX walk P1-5). Over when iOS answers, or after a minute if it never does.
	private(set) var asking = false
	private var tokenDefaults: UserDefaults? {
		LaunchOptions.fixtureMode
			? UserDefaults(suiteName: LaunchOptions.fixtureKeychainService) : .standard
	}
	private var environment: String {
		Bundle.main.object(forInfoDictionaryKey: "MCAPNsEnvironment") as? String == "production"
			? "production" : "sandbox"
	}
	override init() {
		super.init()
		Self.current = self
		#if os(iOS)
			if !LaunchOptions.fixtureMode { UNUserNotificationCenter.current().delegate = self }
		#endif
	}
	func configure(_ session: AppSession, prompt: Bool) {
		self.session = session
		generation = UUID()
		attemptedFor = nil
		registeredFor = nil
		token = tokenDefaults?.string(forKey: "apns-device-token")
		setup?.cancel()
		registration?.cancel()
		registration = nil
		let current = generation
		asking = false
		#if os(macOS)
			// The Mac keeps its own banners (above); it registers no device token.
			guard LaunchOptions.fixtureMode else { return }
		#endif
		// Set before any await: Mileage's first ask needs a sync round trip, so it always finds this.
		if prompt, !LaunchOptions.fixtureMode {
			asking = true
			Task { [weak self] in
				try? await Task.sleep(for: .seconds(60))
				self?.asked(current)
			}
		}
		setup = Task { [weak self] in
			guard let self else { return }
			if LaunchOptions.fixtureMode {
				guard LaunchOptions.fixturePush else { return }
				token = String(repeating: "ab", count: 32)
				await registerToken()
				if let tap = LaunchOptions.fixtureNotification {
					model?.queueNotification(
						account: tap.account, messageId: tap.messageId)
				}
				return
			}
			let center = UNUserNotificationCenter.current()
			// Sign-in asks straight away: iOS shows its alert only if it never asked, else answers at once. (Build 12 read
			// the settings first; on the old-code iPad run that answer never came, so the request was never sent.)
			if prompt {
				_ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
			}
			// Answered, refused, failed or never needed: the row reads iOS again and Mileage may ask now.
			asked(current)
			guard current == generation, !Task.isCancelled else { return }
			let status = await center.notificationSettings().authorizationStatus
			guard current == generation, !Task.isCancelled,
				status == .authorized || status == .provisional
			else { return }
			#if os(iOS)
				UIApplication.shared.registerForRemoteNotifications()
			#else
				NSApplication.shared.registerForRemoteNotifications()
			#endif
		}
	}
	func receivedToken(_ data: Data) {
		let next = data.map { String(format: "%02x", $0) }.joined()
		if next != token { registeredFor = nil }
		token = next
		tokenDefaults?.set(next, forKey: "apns-device-token")
		guard session != nil else { return }
		retryRegistration()
	}
	private func registerToken() async {
		guard let session, let token, !Task.isCancelled else { return }
		let current = generation
		let key = session.cacheIdentity + " " + token
		guard attemptedFor != key, registeredFor != key else { return }
		attemptedFor = key
		defer { if current == generation { attemptedFor = nil } }
		#if os(iOS)
			let platform = "ios"
		#else
			let platform = "macos"
		#endif
		do {
			// The session's own server: a demo sign-in registers with the demo instance.
			let client = try SessionClient(for: session)
			try await client.registerDevice(
				session, token: token, environment: environment, platform: platform)
			if current == generation { registeredFor = key }
		} catch { /* Mail remains usable; retry on the next foreground/OS token callback. */  }
	}
	func retryRegistration() {
		guard let session, let token, registration == nil,
			registeredFor != session.cacheIdentity + " " + token
		else { return }
		let current = generation
		registration = Task { [weak self] in
			await self?.registerToken()
			guard let self, generation == current else { return }
			registration = nil
			// An OS rotation during an in-flight registration must not strand the newer token.
			if self.token != token { retryRegistration() }
		}
	}
	/// Sign-in's ask is over for this session (answered, or a minute passed): once, Mileage may ask now.
	private func asked(_ current: UUID) {
		guard asking, current == generation else { return }
		asking = false
		model?.notificationsAsked()
	}
	func signOut(_ previous: AppSession?) async {
		generation = UUID()
		asking = false
		session = nil
		attemptedFor = nil
		registeredFor = nil
		let oldTask = registration
		let oldSetup = setup
		registration = nil
		setup = nil
		oldSetup?.cancel()
		oldTask?.cancel()
		await oldSetup?.value
		await oldTask?.value
		if let previous, let token, let client = try? SessionClient(for: previous) {
			try? await client.unregisterDevice(previous, token: token, environment: environment)
		}
		token = nil
		tokenDefaults?.removeObject(forKey: "apns-device-token")
		if !LaunchOptions.fixtureMode {
			UNUserNotificationCenter.current().removeAllDeliveredNotifications()
		}
	}
	/// The system hides a banner for the app in front unless asked: a note the app posted while you
	/// are in it shows. A server push ("New message", any inbound mail) stays hidden in front, as
	/// before: the open list already shows that mail.
	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		let pushed = notification.request.trigger is UNPushNotificationTrigger
		completionHandler(pushed ? [] : [.banner, .list, .sound])
	}
	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		let info = response.notification.request.content.userInfo
		if let account = info["account"] as? String, let messageId = info["messageId"] as? String {
			Task { @MainActor [weak self] in
				self?.model?.queueNotification(account: account, messageId: messageId)
			}
		} else if let id = info["conversation_id"] as? String, !id.isEmpty {
			// The app's own banner names its conversation; no lookup.
			let emailId = (info["email_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
			Task { @MainActor [weak self] in self?.model?.queueBanner(id, emailId: emailId) }
		}
		completionHandler()
	}
}

#if os(iOS)
	final class MobileAppDelegate: NSObject, UIApplicationDelegate {
		func application(
			_ application: UIApplication,
			didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
		) { NotificationCoordinator.current?.receivedToken(deviceToken) }
	}
#endif
