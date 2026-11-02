import Foundation
import MailClawKit

/// The Mac keys (L3 Rail, S6). Browsing: j/k move the list's cursor, o/Return open it (the list
/// folds into the rail). Reading: j/k step to the next or previous conversation (the rail
/// follows), u/Esc go back to the full list. `[` hides or shows the column in either state.
extension AppModel {
	/// No conversation open: the one-line list fills the detail.
	var isListing: Bool { selection == nil }

	/// Single-key shortcuts are live: signed in, nothing takes typing, no sheet over the window (the
	/// iPad's composer is a sheet in the same scene; the Mac's are windows of their own). Mileage has
	/// its own keys (the Trip menu), so mail's are off while it shows.
	var shortcutsLive: Bool { sync != nil && !isTyping && !showsShortcuts && composer == nil && !showsMileage }

	func step(_ offset: Int) {
		cursorShown = true
		guard isListing else {
			moveSelection(by: offset)
			cursor = selection
			return
		}
		let list = visibleRows
		guard !list.isEmpty else { return }
		let index = cursor.flatMap { id in list.firstIndex { $0.id == id } } ?? -1
		cursor = list[max(0, min(list.count - 1, index + offset))].id
	}

	func openCursor() {
		guard selection == nil, let id = cursor ?? visibleRows.first?.id else { return }
		open(id)
	}

	/// u/Esc: out of the thread; while browsing, first drop the picked rows, then leave a search.
	func back() {
		if selection != nil {
			selection = nil
		} else if !picked.isEmpty {
			picked = []
		} else if isSearching {
			cancelSearch()
		}
	}
}
