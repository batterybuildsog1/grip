import MailClawKit
import UserNotifications

/// Shows MailClaw's banners. The Mac: new Personal mail and new Needs-you notes, and it opens the
/// conversation a clicked banner names (r2 S6). iPhone and iPad: new notes while the app is in front
/// (build 6, codes by email); NotificationCoordinator is the delegate there. Each banner carries the
/// conversation id as its thread identifier (Notification Center groups by it) and in `userInfo`,
/// the shape the spec gives the server's push too.
@MainActor
final class NotificationRouter: NSObject {
	static let shared = NotificationRouter()
	#if os(macOS)
	private var handler: ((String, String?) -> Void)?
	/// A click that arrived before the window was up (the click launched the app).
	private var pending: (id: String, emailId: String?)?

	func attach(_ handler: @escaping (String, String?) -> Void) {
		self.handler = handler
		if let pending {
			self.pending = nil
			handler(pending.id, pending.emailId)
		}
	}

	private func route(_ id: String, _ emailId: String?) {
		if let handler { handler(id, emailId) } else { pending = (id, emailId) }
	}
	#endif

	// MARK: Posting

	#if os(macOS)
	static func post(_ row: ConversationRow) {
		let content = UNMutableNotificationContent()
		content.title = row.sender
		content.subtitle = row.subject
		content.body = String(row.snippet.prefix(180))
		content.threadIdentifier = row.id
		content.userInfo = ["conversation_id": row.id, "email_id": row.displayEmailId ?? ""]
		content.sound = .default
		add(UNNotificationRequest(identifier: "mail-\(row.id)-\(row.latestAt)", content: content, trigger: nil))
	}
	#endif

	static func post(_ note: ActionNote) {
		let content = UNMutableNotificationContent()
		content.title = "Needs you"
		content.subtitle = note.senderName
		content.body = note.note
		content.threadIdentifier = note.conversationId
		content.userInfo = ["conversation_id": note.conversationId, "email_id": note.emailId]
		content.sound = .default
		add(UNNotificationRequest(identifier: "note-\(note.emailId)", content: content, trigger: nil))
	}

	/// The handler runs on a background queue: explicitly @Sendable, so Swift 6 doesn't infer it
	/// main-actor isolated (it would trap there).
	private static func add(_ request: UNNotificationRequest) {
		UNUserNotificationCenter.current().add(request) { @Sendable error in
			guard error == nil else { return }
			Task { @MainActor in
				if LaunchOptions.perfProbe { PerfProbe.shared.add("notifications_posted", ms: 1) }
			}
		}
	}
}

#if os(macOS)
extension NotificationRouter: UNUserNotificationCenterDelegate {
	/// Banners show while MailClaw is the frontmost app too.
	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		[.banner, .list, .sound]
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
	) async {
		let content = response.notification.request.content
		let info = content.userInfo
		let id = (info["conversation_id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? content.threadIdentifier
		let emailId = info["email_id"] as? String
		guard !id.isEmpty else { return }
		await MainActor.run { NotificationRouter.shared.route(id, emailId) }
	}
}
#endif
