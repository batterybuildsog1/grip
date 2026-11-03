import Foundation
import MailClawKit

/// Archive, Trash, Read/Unread from the Mac toolbar, menus and keys (r2 S6). They run S7's one
/// triage engine (AppModel.triage): the server first, a toast with Undo, a failure that says so
/// and puts the screen back (no offline queue, CLAUDE.md). On the Mac the window's UndoManager
/// holds each Undo, so Edit > Undo, ⌘Z, z and the toast's Undo are one history.
extension AppModel {
	/// What the toolbar and keys act on: the open conversation, else the list's visible cursor.
	var actionTarget: String? { selection ?? (cursorShown ? cursor : nil) }

	var actionTargetRow: ConversationRow? {
		guard let id = actionTarget else { return nil }
		return visibleRows.first { $0.id == id }
	}

	/// The Archive slot's word: inside Trash it restores (walkthrough P1-3), as the row's swipe and
	/// the bulk bar already said. Every bar, menu and key of the open conversation uses these two.
	var archiveTitle: String { inTrash ? "Restore" : "Archive" }
	/// The Trash slot's word: inside Trash it deletes forever, after the confirm.
	var trashTitle: String { inTrash ? "Delete forever" : "Trash" }

	/// Archive (e); inside Trash, Restore. Either opens the next conversation.
	func archive() {
		if bulkPicked(inTrash ? .restore : .archive) { return }
		if let row = actionTargetRow { archive(row) }
	}

	func archive(_ row: ConversationRow) {
		triage(inTrash ? .restore : .archive, [row])
	}

	/// Trash (#); inside Trash, the Delete-forever confirm (S7).
	func trash() {
		if !inTrash, bulkPicked(.trash) { return }
		if let row = actionTargetRow { trash(row) }
	}

	func trash(_ row: ConversationRow) {
		if inTrash { pendingDelete = row } else { triage(.trash, [row]) }
	}

	func markUnread() {
		if bulkPicked(.markUnread) { return }
		if let row = actionTargetRow { triage(.markUnread, [row]) }
	}

	// MARK: Picked rows (x, r2 S7): the bulk bar

	/// The picked rows in list order.
	var pickedRows: [ConversationRow] { visibleRows.filter { picked.contains($0.id) } }

	/// x: picks or unpicks the cursor's row (the first row if the cursor isn't shown yet).
	func togglePicked() {
		guard isListing, let id = (cursorShown ? cursor : nil) ?? visibleRows.first?.id else { return }
		cursor = id
		cursorShown = true
		togglePicked(id)
	}

	func togglePicked(_ id: String) {
		if !picked.insert(id).inserted { picked.remove(id) }
	}

	/// The bar's actions (and e, #, ⇧U while rows are picked): one triage for all of them.
	func bulk(_ action: TriageAction) {
		let rows = pickedRows
		picked = []
		guard !rows.isEmpty else { return }
		triage(action, rows)
	}

	/// While browsing with rows picked, the action takes them all; false when nothing is picked.
	private func bulkPicked(_ action: TriageAction) -> Bool {
		guard isListing, !picked.isEmpty else { return false }
		bulk(action)
		return true
	}

	func toggleRead() {
		guard let row = actionTargetRow else { return }
		triage(row.unread ? .markRead : .markUnread, [row])
	}
}

extension TriageAction {
	/// Edit > Undo's name for it ("Undo Archive").
	var title: String {
		switch self {
		case .archive: "Archive"
		case .trash: "Move to Trash"
		case .restore: "Restore"
		case .markRead: "Mark as Read"
		case .markUnread: "Mark as Unread"
		}
	}
}
