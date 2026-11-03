import SwiftUI

/// The key list ("?" or "Shortcuts ?" in the sidebar). The same keys as the Message and View menus.
struct ShortcutHelp: View {
	@Environment(\.dismiss) private var dismiss
	@Environment(AppModel.self) private var model
	@Environment(MileageReportModel.self) private var book

	private struct Shortcut: Identifiable {
		let keys: String
		let meaning: String
		var id: String { keys }
	}

	private let shortcuts = [
		Shortcut(keys: "j / k", meaning: "Next / previous conversation (the rail follows)"),
		Shortcut(keys: Self.mac ? "o or Return" : "o", meaning: "Open: the list folds into the rail"),
		Shortcut(keys: Self.mac ? "u or Esc" : "u", meaning: "Back to the full list"),
		Shortcut(keys: "e", meaning: "Archive (opens the next one; in Trash: Restore)"),
		Shortcut(keys: "#", meaning: "Trash (in Trash: Delete forever, after a confirm)"),
		Shortcut(keys: "⇧U", meaning: "Mark unread"),
		Shortcut(keys: "r / a / f", meaning: "Reply / Reply all / Forward"),
		Shortcut(keys: "c or ⌘N", meaning: "New message"),
		Shortcut(keys: Self.mac ? "/ or ⌘F, ⌘K" : "/", meaning: "Search"),
		Shortcut(keys: "x", meaning: "Select (in the list)"),
		Shortcut(keys: "[", meaning: "Show or hide the sidebar"),
		Shortcut(keys: "z or ⌘Z", meaning: "Undo"),
		Shortcut(keys: "⌘,", meaning: "Settings"),
		Shortcut(keys: "?", meaning: "This list"),
	].filter { $0.keys != "⌘," || Self.mac }

	/// Mileage's keys (the Trip menu), shown while Mileage is on screen. 1 2 3 name the report's first
	/// three companies, the ones they file to.
	private var mileage: [Shortcut] { [
		Shortcut(keys: "y", meaning: "Yes: file the agent's guess"),
		Shortcut(keys: "s", meaning: "Skip this question"),
		Shortcut(keys: "1 2 3", meaning: MileageCompanyWords.keys(book.report?.companies, separator: " / ")),
		Shortcut(keys: "Return", meaning: "File (on the report: open the question)"),
		Shortcut(keys: "j / k", meaning: "Next / previous trip (the rail follows)"),
		Shortcut(keys: "u or Esc", meaning: "Back to the month"),
		Shortcut(keys: "⌫", meaning: "Delete the open trip (5 seconds to undo)"),
		Shortcut(keys: "⌘E", meaning: "Export"),
		Shortcut(keys: "[", meaning: "Show or hide the sidebar"),
		Shortcut(keys: "?", meaning: "This list"),
	] }

	/// The iPad has no Settings window (its settings open from the column's account control), and
	/// Return, Esc and ⌘K aren't proven on its keyboard: its list shows the keys it answers.
	private static var mac: Bool {
		#if os(macOS)
		true
		#else
		false
		#endif
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 16) {
			HStack {
				Text("Keyboard").font(.title3.weight(.semibold))
				Spacer()
				Button("Close") { dismiss() }
					.keyboardShortcut(.cancelAction)
			}
			Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 7) {
				ForEach(model.showsMileage ? mileage : shortcuts) { shortcut in
					GridRow {
						Text(shortcut.keys)
							.font(.body.monospaced())
							.foregroundStyle(.mcMuted)
						Text(shortcut.meaning)
					}
				}
			}
		}
		.padding(22)
		.frame(width: 440)
		.foregroundStyle(.mcText)
		.background(.mcSheet)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("shortcut-help")
	}
}
