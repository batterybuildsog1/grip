import MailClawKit
import SwiftUI

/// Every key the rail window answers, as a menu item, so the keys can be found (r2 S6, NM-16): the
/// Mac's menu bar, and the iPad's (and its ⌘-hold list) with a hardware keyboard.
/// Single keys hold their shortcut only while the main window has the keyboard and nothing takes
/// typing (`mailShortcutsLive`); otherwise the item keeps no key and the letter types.
/// Return, Esc and ⌘K are the second keys of Open, Back and Search (MacRootView's KeyAlternates);
/// Esc is also Mileage's Back to the Report there.
struct MailCommands: Commands {
	let model: AppModel
	@FocusedValue(\.mailShortcutsLive) private var live: Bool?
	@FocusedValue(\.mileageKeys) private var mileage: MileageKeys?
	/// A Mileage button or disclosure has keyboard focus: Return is its (mac-r2-05).
	@FocusedValue(\.mileageControlFocused) private var controlFocused: Bool?
	@Environment(\.openWindow) private var openWindow

	var body: some Commands {
		// ⌘N is New Message (the window list's MailClaw ⌘0 brings the one window back): S5's
		// compose window.
		CommandGroup(replacing: .newItem) {
			Button("New Message") { newMessage() }.keyboardShortcut("n")
		}
		// Mileage: File > Export… (⌘E) and Edit > Delete Trip (⌫), the CLEAN-SPEC add-backs.
		CommandGroup(after: .importExport) {
			Button("Export…") { mileage?.export() }.keyboardShortcut("e").disabled(mileage == nil)
		}
		CommandGroup(after: .pasteboard) {
			Button("Delete Trip") { mileage?.delete() }
				.keyboardShortcut(mileage?.canDelete == true ? KeyboardShortcut(.delete, modifiers: []) : nil)
				.disabled(mileage?.canDelete != true)
		}
		CommandGroup(after: .sidebar) {
			// The one column toggle: the views while browsing, the rail while reading (L3).
			Toggle("Sidebar", isOn: Binding(get: { model.sidebarShown }, set: { model.sidebarShown = $0 }))
				// Mail's key and Mileage's both.
				.keyboardShortcut(live == true || mileage != nil ? KeyboardShortcut("[", modifiers: []) : nil)
			Divider()
			Button("Refresh") { model.refresh() }.keyboardShortcut("r")
		}
		// iPad: iPadOS keeps ⌘F for its own Edit > Find; the press never reaches the app (ipad-r2-05,
		// four ways tried), so the iPad's Search key is / and nothing there promises ⌘F.
		#if os(macOS)
		CommandGroup(after: .textEditing) {
			Button("Search Mail") { model.focusSearch() }.keyboardShortcut("f")
		}
		#endif
		// Mileage's keys, live while it shows and nothing takes typing (V3: y s 1 2 3 Return j k u).
		CommandMenu("Trip") {
			Button("Yes, File It") { mileage?.yes() }.keyboardShortcut(mileageKey("y")).disabled(mileage == nil)
			Button("Skip") { mileage?.skip() }.keyboardShortcut(mileageKey("s")).disabled(mileage == nil)
			Button("File as First Company") { mileage?.fileAs(0) }.keyboardShortcut(mileageKey("1")).disabled(mileage == nil)
			Button("File as Second Company") { mileage?.fileAs(1) }.keyboardShortcut(mileageKey("2")).disabled(mileage == nil)
			Button("File as Third Company") { mileage?.fileAs(2) }.keyboardShortcut(mileageKey("3")).disabled(mileage == nil)
			Button("File") { mileage?.file() }
				.keyboardShortcut(mileage == nil || controlFocused == true ? nil : KeyboardShortcut(.return, modifiers: []))
				.disabled(mileage == nil)
			Divider()
			Button("Next Trip") { mileage?.step(1) }.keyboardShortcut(mileageKey("j")).disabled(mileage == nil)
			Button("Previous Trip") { mileage?.step(-1) }.keyboardShortcut(mileageKey("k")).disabled(mileage == nil)
			// Esc is its second key, a hidden button in MacRootView's KeyAlternates: a menu item can't hold
			// Esc (mac-r2-04).
			Button("Back to the Report") { mileage?.back() }.keyboardShortcut(mileageKey("u")).disabled(mileage == nil)
			Divider()
			Button("Trip Keys") { model.showsShortcuts = true }.keyboardShortcut(mileageKey("?")).disabled(mileage == nil)
		}
		CommandMenu("Message") {
			Button("Next Conversation") { model.step(1) }.keyboardShortcut(key("j"))
			Button("Previous Conversation") { model.step(-1) }.keyboardShortcut(key("k"))
			Button("Open") { model.openCursor() }.keyboardShortcut(key("o"))
			Button("Back") { model.back() }.keyboardShortcut(key("u"))
			Divider()
			Button("Archive") { model.archive() }.keyboardShortcut(key("e"))
			Button("Move to Trash") { model.trash() }.keyboardShortcut(key("#"))
			Button("Mark as Unread") { model.markUnread() }.keyboardShortcut(key("u", .shift))
			Button("Undo") { model.undoLast() }.keyboardShortcut(key("z"))
			Button("Select") { model.togglePicked() }.keyboardShortcut(key("x")).disabled(model.selection != nil)
			Divider()
			Button("Reply") { compose(.reply) }.keyboardShortcut(key("r")).disabled(model.selection == nil)
			Button("Reply All") { compose(.replyAll) }.keyboardShortcut(key("a")).disabled(model.selection == nil)
			Button("Forward") { compose(.forward) }.keyboardShortcut(key("f")).disabled(model.selection == nil)
			Button("New Message") { newMessage() }.keyboardShortcut(key("c"))
			Divider()
			Button("Search") { model.focusSearch() }.keyboardShortcut(key("/"))
			Button("Keyboard Shortcuts") { model.showsShortcuts = true }.keyboardShortcut(key("?"))
		}
	}

	private func newMessage() {
		openWindow.compose(ComposeRequest(kind: .new), in: model)
	}

	private func compose(_ kind: ComposeKind) {
		if let request = model.replyRequest(kind) { openWindow.compose(request, in: model) }
	}

	private func mileageKey(_ character: Character) -> KeyboardShortcut? {
		mileage == nil ? nil : KeyboardShortcut(KeyEquivalent(character), modifiers: [])
	}

	private func key(_ character: Character, _ modifiers: EventModifiers = []) -> KeyboardShortcut? {
		live == true ? KeyboardShortcut(KeyEquivalent(character), modifiers: modifiers) : nil
	}
}
