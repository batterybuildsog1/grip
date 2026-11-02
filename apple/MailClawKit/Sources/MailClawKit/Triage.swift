import Foundation

/// Triage (S7, design/r2-build-spec.md): Archive, Trash, Restore and Read/Unread on whole
/// conversations, the same actions the web sends (`POST /api/emails/actions` with thread ids).
public enum TriageAction: String, Sendable, CaseIterable {
	case archive
	case trash
	case restore
	case markRead = "mark_read"
	case markUnread = "mark_unread"

	/// What Undo sends.
	public var undo: TriageAction {
		switch self {
		case .archive, .trash: .restore
		case .restore: .trash
		case .markRead: .markUnread
		case .markUnread: .markRead
		}
	}
}

extension MailSync {
	private struct ActionBody: Encodable {
		let ids: [String]
		let action: String
		let threadIds: [String]

		enum CodingKeys: String, CodingKey {
			case ids, action
			case threadIds = "thread_ids"
		}
	}

	/// Runs `action` on the server first, then stores what it confirmed: the read state, and the
	/// conversations leaving `view` when given. Refused or unreachable, it throws with the store
	/// untouched, and nothing is queued for later.
	public func act(_ action: TriageAction, on ids: [String], leaving view: MailView?) async throws {
		guard !ids.isEmpty else { return }
		let body = try JSONEncoder().encode(ActionBody(ids: [], action: action.rawValue, threadIds: ids))
		let unread: Bool? = switch action {
		case .markRead: false
		case .markUnread: true
		case .archive, .trash, .restore: nil
		}
		if let unread { noteReadMarks(ids, unread: unread) }
		do {
			_ = try await api.write(.post, ["api", "emails", "actions"], json: body)
		} catch {
			if let unread { forgetReadMarks(ids, restoring: !unread) }
			throw error
		}
		if let unread {
			try store.setUnread(ids, unread)
			confirmReadMarks(ids)
		}
		if let view { try store.removeFromView(ids, view: view) }
	}

	/// Delete forever, from inside Trash after the confirm: every message of the conversation that
	/// is in Trash, nothing outside it. Returns how many messages were deleted.
	@discardableResult
	public func deleteForever(_ id: String, from view: MailView = .trash) async throws -> Int {
		let detail = try await threadFull(id: id, emailId: nil)
		var deleted = 0
		for email in detail.emails where email.mailboxState == "trash" {
			_ = try await api.write(.delete, ["api", "emails", email.id])
			deleted += 1
		}
		try store.removeFromView([id], view: view)
		return deleted
	}
}
