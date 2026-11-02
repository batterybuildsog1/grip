import Foundation
import MailClawKit
import UserNotifications

/// A one-shot completion protected against the system expiry callback racing the API result.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
	private let lock = NSLock()
	private var completion: ((UNNotificationContent) -> Void)?
	private var fallback: UNNotificationContent?
	private var task: Task<Void, Never>?
	private struct Work: @unchecked Sendable {
		let content: UNNotificationContent
		let session: AppSession
		let group: String
		let id: String
	}
	override func didReceive(
		_ request: UNNotificationRequest,
		withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
	) {
		lock.withLock {
			completion = contentHandler
			fallback = request.content
		}
		let info = request.content.userInfo
		guard let account = info["account"] as? String, let id = info["messageId"] as? String,
			let group = Bundle.main.object(forInfoDictionaryKey: "MCSharedKeychainGroup")
				as? String,
			let session = KeychainSessionStore(accessGroup: group).loadSession(),
			session.email == account
		else {
			finish(request.content)
			return
		}
		let work = Work(content: request.content, session: session, group: group, id: id)
		let workTask = Task { [self, work] in
			let api = APIClient(credentials: work.session.credentials)
			guard let message = try? await api.notificationMessage(id: work.id),
				!Task.isCancelled,
				let content = work.content.mutableCopy() as? UNMutableNotificationContent
			else {
				finish(work.content)
				return
			}
			guard let current = KeychainSessionStore(accessGroup: work.group).loadSession(),
				current.cacheIdentity == work.session.cacheIdentity,
				current.expiresAt == work.session.expiresAt
			else {
				finish(work.content)
				return
			}
			content.title =
				message.fromName.flatMap { $0.isEmpty ? nil : $0 } ?? message.fromAddress
			content.body = message.subject.flatMap { $0.isEmpty ? nil : $0 } ?? "No subject"
			finish(content)
		}
		lock.withLock { task = workTask }
	}

	override func serviceExtensionTimeWillExpire() {
		lock.withLock { task }?.cancel()
		if let fallback = lock.withLock({ fallback }) { finish(fallback) }
	}
	private func finish(_ content: UNNotificationContent) {
		let handler = lock.withLock {
			let value = completion
			completion = nil
			fallback = nil
			return value
		}
		handler?(content)
	}
}
