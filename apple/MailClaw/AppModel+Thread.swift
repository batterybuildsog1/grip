import Foundation
import MailClawKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// What a thread's bar and More menu ask of the app (round-2 S2, L3).
enum ThreadAction: Sendable {
	case archive, trash, markUnread, notPersonal, reply, replyAll, forward

	var title: String {
		switch self {
		case .archive: "Archive"
		case .trash: "Trash"
		case .markUnread: "Mark unread"
		case .notPersonal: "Not Personal"
		case .reply: "Reply"
		case .replyAll: "Reply all"
		case .forward: "Forward"
		}
	}
}

extension AppModel {
	/// A thread's bar and More menu (iPhone): Archive, Trash and Mark unread run S7's one engine on
	/// the open conversation, so Archive and Trash open the next one (L3, iOS Mail's default) and
	/// the toast offers Undo. Returns a notice when the action can't run here.
	func threadAction(_ action: ThreadAction, row: ConversationRow?) -> String? {
		guard let row else { return "\(action.title) isn’t available until the conversation loads." }
		switch action {
		case .archive where !inTrash: triage(.archive, [row])
		case .trash: if inTrash { pendingDelete = row } else { triage(.trash, [row]) }
		case .markUnread: triage(.markUnread, [row])
		default: return "\(action.title) isn’t in this build yet."
		}
		return nil
	}
}

/// How far the sender's unsubscribe got for one message (L3 S3; the web's NewsletterReader).
enum UnsubscribeStep: Equatable {
	case ready, working, done
	/// Nothing was sent: the user finishes on the sender's page.
	case link(URL)
	/// The reason, after "Couldn’t unsubscribe."
	case failed(String)
}

extension AppModel {
	func unsubscribeStep(_ emailId: String) -> UnsubscribeStep { unsubscribes[emailId] ?? .ready }

	/// The user's tap on Unsubscribe (the head, the iPhone bar, a newsletter's box) and nothing else
	/// (CLAUDE.md "Manual unsubscribe"): one tap, one request. Nothing goes out while one is in flight
	/// or once it's done; after a hand-off the tap opens the sender's page again. Dry writes and the
	/// write sink apply (APIClient.write).
	func unsubscribe(_ emailId: String) {
		guard let sync else { return }
		switch unsubscribeStep(emailId) {
		case .working, .done: return
		case let .link(url):
			Self.openInBrowser(url)
			return
		case .ready, .failed: break
		}
		unsubscribes[emailId] = .working
		Task {
			do {
				switch try await sync.unsubscribe(emailId: emailId) {
				case .unsubscribed:
					unsubscribes[emailId] = .done
				case let .link(url):
					unsubscribes[emailId] = .link(url)
					Self.openInBrowser(url)
				}
			} catch {
				unsubscribes[emailId] = .failed(Self.unsubscribeReason(error))
			}
		}
	}

	/// The server's own words when it gave them ("Unsubscribe failed: HTTP 500"), as the web shows.
	private static func unsubscribeReason(_ error: Error) -> String {
		switch error as? APIError {
		case .offline?: "You’re offline. Try again once you’re back online."
		case let .rejected(message)?: message
		case let .http(status, _)?: "The server returned \(status)."
		case .decoding?: "The server’s answer couldn’t be read."
		case nil: "The server couldn’t be reached."
		}
	}

	private static func openInBrowser(_ url: URL) {
		#if os(iOS)
		UIApplication.shared.open(url)
		#else
		NSWorkspace.shared.open(url)
		#endif
	}
}
