import MailClawKit
import SwiftUI

// Triage (S7, design/r2-build-spec.md): labelled swipes on iPhone, the same actions in a context
// menu on every row (and keys on the Mac list), one toast with Undo. Words, never icons.

extension View {
	/// Mark as read|unread on the leading swipe (full swipe); Archive (full swipe), Trash and Mark as
	/// read|unread on the trailing one, so either swipe changes the read state (build 4: a left swipe
	/// that offered only Archive surprised people). Inside Trash: Restore (full swipe) and Delete
	/// Forever, which asks first.
	func triageActions(_ row: ConversationRow) -> some View {
		modifier(TriageActions(row: row))
	}

	/// The confirm before Delete Forever: names the conversation, Cancel is the safe answer.
	func triageConfirm() -> some View {
		modifier(TriageConfirm())
	}
}

private struct TriageActions: ViewModifier {
	@Environment(AppModel.self) private var model
	let row: ConversationRow
	#if os(macOS)
	@State private var menuOpen = false
	#endif

	/// The lanes are the prototype's (Read accent, Archive primary, Trash neg), always at the theme's
	/// light values: iOS draws swipe titles in white, which the dark values (light fills) can't carry.
	private func lane(_ role: MCRole) -> Color { MCPalette.light[role] }

	/// A verb, not the state: the bare "Read" read as a label for read mail.
	private var readLane: some View {
		Button(row.unread ? "Mark as read" : "Mark as unread") {
			model.triage(row.unread ? .markRead : .markUnread, [row])
		}
		.tint(lane(.accent))
	}

	func body(content: Content) -> some View {
		content
			.swipeActions(edge: .leading) { readLane }
			.swipeActions(edge: .trailing, allowsFullSwipe: true) {
				if model.inTrash {
					Button("Restore") { model.triage(.restore, [row]) }
						.tint(lane(.primary))
					// Not the destructive role: that would animate the row away before the confirm.
					Button("Delete Forever") { model.pendingDelete = row }
						.tint(lane(.neg))
				} else {
					// The first is the outermost, the full swipe: Mark as … · Trash · Archive on screen.
					Button("Archive") { model.triage(.archive, [row]) }
						.tint(lane(.primary))
					Button("Trash", role: .destructive) { model.triage(.trash, [row]) }
						.tint(lane(.neg))
					readLane
				}
			}
			.contextMenu {
				if model.inTrash {
					Button("Restore") { model.triage(.restore, [row]) }
				} else {
					Button("Archive") { model.triage(.archive, [row]) }
				}
				Button(row.unread ? "Mark as Read" : "Mark as Unread") {
					model.triage(row.unread ? .markRead : .markUnread, [row])
				}
				Divider()
				if model.inTrash {
					Button("Delete Forever…", role: .destructive) { model.pendingDelete = row }
				} else {
					Button("Trash", role: .destructive) { model.triage(.trash, [row]) }
				}
			}
			#if os(macOS)
			// The Mac row opens the same menu itself (RowMenuCatcher), outlined in --mc-focus while open;
			// the context menu above stays for VoiceOver's "show menu".
			// Out of the accessibility tree and its hit-testing: the row stays the element VoiceOver
			// and the tests reach (with it in, a hit at the row's centre stopped at the table cell).
			.overlay { RowMenuCatcher(items: macMenu, open: $menuOpen).accessibilityHidden(true) }
			.overlay {
				if menuOpen {
					Rectangle().strokeBorder(.mcFocus, lineWidth: 2).allowsHitTesting(false)
				}
			}
			#endif
	}

	#if os(macOS)
	private var macMenu: [RowMenuCatcher.Item?] {
		let row = row
		let model = model
		return [
			model.inTrash
				? .init(title: "Restore") { model.triage(.restore, [row]) }
				: .init(title: "Archive") { model.triage(.archive, [row]) },
			.init(title: row.unread ? "Mark as Read" : "Mark as Unread") {
				model.triage(row.unread ? .markRead : .markUnread, [row])
			},
			nil,
			model.inTrash
				? .init(title: "Delete Forever…") { model.pendingDelete = row }
				: .init(title: "Trash") { model.triage(.trash, [row]) },
		]
	}
	#endif
}

#if os(macOS)
import AppKit

/// Right-click (or Control-click) on a Mac row shows the row's menu from the row itself. Through the
/// List, AppKit outlined the row in the system's blue while its menu was open, whatever the theme
/// (mac-r3-02); now the List never sees the click, and the row draws its own outline in
/// --mc-focus. Every other click, hover and scroll passes through to the row.
struct RowMenuCatcher: NSViewRepresentable {
	struct Item {
		let title: String
		let action: () -> Void
	}

	let items: [Item?]
	@Binding var open: Bool

	func makeNSView(context: Context) -> Catcher { Catcher() }

	func updateNSView(_ view: Catcher, context: Context) {
		view.items = items
		view.onOpen = { open = $0 }
	}

	final class Catcher: NSView {
		var items: [Item?] = []
		var onOpen: (Bool) -> Void = { _ in }

		override func hitTest(_ point: NSPoint) -> NSView? {
			guard let event = NSApp.currentEvent else { return nil }
			let wantsMenu = event.type == .rightMouseDown
				|| (event.type == .leftMouseDown && event.modifierFlags.contains(.control))
			return wantsMenu ? super.hitTest(point) : nil
		}

		override func isAccessibilityElement() -> Bool { false }
		override func accessibilityHitTest(_ point: NSPoint) -> Any? { nil }

		override func rightMouseDown(with event: NSEvent) { show(event) }
		override func mouseDown(with event: NSEvent) { show(event) }  // only a Control-click gets here

		private func show(_ event: NSEvent) {
			let menu = NSMenu()
			for item in items {
				guard let item else {
					menu.addItem(.separator())
					continue
				}
				let entry = NSMenuItem(title: item.title, action: #selector(run(_:)), keyEquivalent: "")
				entry.target = self
				entry.representedObject = Run(item.action)
				menu.addItem(entry)
			}
			onOpen(true)
			NSMenu.popUpContextMenu(menu, with: event, for: self)
			onOpen(false)
		}

		@objc private func run(_ sender: NSMenuItem) {
			(sender.representedObject as? Run)?.action()
		}
	}

	final class Run: NSObject {
		let action: () -> Void
		init(_ action: @escaping () -> Void) { self.action = action }
	}
}
#endif

private struct TriageConfirm: ViewModifier {
	@Environment(AppModel.self) private var model

	func body(content: Content) -> some View {
		content
			.confirmationDialog(
				model.pendingDelete.map { "Delete \(AppModel.quoted($0.subject)) forever?" } ?? "",
				isPresented: Binding(
					get: { model.pendingDelete != nil },
					set: { if !$0 { model.pendingDelete = nil } }),
				titleVisibility: .visible,
				presenting: model.pendingDelete
			) { row in
				Button("Delete Forever", role: .destructive) { model.deleteForever(row) }
				Button("Cancel", role: .cancel) { model.pendingDelete = nil }
			} message: { _ in
				Text("This can’t be undone.")
			}
	}
}
