import MailClawKit
import SwiftUI

/// The rail window's left column (L3 Rail; Mac and iPad): the account menu on top and "Shortcuts ?"
/// at the foot; between them the views while browsing, the rail while reading. The open item is a
/// pill in the sheet's colour (L3: "a tab of the sheet"; the system split view keeps it inset).
/// Words only.
struct MacSidebar: View {
	@Environment(AppModel.self) private var model
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		Group {
			// Mileage with a trip open: the column is its rail, holding the queue you came from.
			if model.showsMileage, book.open != nil { MileageRail() }
			else if model.selection == nil { ViewsList() } else { Rail() }
		}
		.scrollContentBackground(.hidden)
		.background(.mcFrame)
		.foregroundStyle(.mcText)
		.toolbar(removing: .sidebarToggle)
		.safeAreaInset(edge: .top, spacing: 0) {
			AccountMenu()
				.padding(.horizontal, 10)
				.padding(.vertical, 8)
				// Opaque: the rail's rows scroll under the account menu and the foot, never through them.
				.background(.mcFrame)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			Button { model.showsShortcuts = true } label: {
				HStack(spacing: 6) {
					Text("Shortcuts").foregroundStyle(.mcMuted)
					// Its key in a key cap, as the search field's ⌘F (L3 S6).
					Text("?")
						.font(.caption)
						.foregroundStyle(.mcFaint)
						.padding(.horizontal, 4)
						.overlay(MCCorner.control.rect.strokeBorder(.mcBorder))
				}
			}
			.buttonStyle(.borderless)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
			.background(.mcFrame)
			.accessibilityIdentifier("shortcuts-button")
		}
	}
}

/// Browsing: Personal (the app's one count), Money, the forwarded-in people, Notifications
/// (X9: no count); All mail, Sent, Drafts, Trash; Mileage last (L3). Gaps, not headings, between
/// the three groups.
private struct ViewsList: View {
	@Environment(AppModel.self) private var model
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		List {
			Section {
				row(.personal, count: model.personalUnread)
				row(.money)
				ForEach(model.persons, id: \.self) { row(.person($0)) }
				row(.notifications)
			}
			Section {
				ForEach([MailView.all, .sent, .drafts, .trash]) { row($0) }
			}
			Section {
				// Its count is the questions only you can answer, as Personal's is unread mail.
				Button { model.selectMileage() } label: { SidebarLabel(title: "Mileage", count: book.needsYou.count) }
					.buttonStyle(.plain)
					.listRowBackground(SheetPill(shown: model.showsMileage))
					.accessibilityAddTraits(model.showsMileage ? .isSelected : [])
					.accessibilityIdentifier("sidebar-mileage")
			}
		}
		.listStyle(.sidebar)
		.accessibilityIdentifier("mac-sidebar")
	}

	private func row(_ view: MailView, count: Int = 0) -> some View {
		let on = !model.showsMileage && !model.isSearching && model.view.unscoped == view
		return Button { model.select(view) } label: { SidebarLabel(title: view.title, count: count) }
			.buttonStyle(.plain)
			.listRowBackground(SheetPill(shown: on))
			.accessibilityAddTraits(on ? .isSelected : [])
			.accessibilityIdentifier(view.kind == .person ? "sidebar-person-\(view.title)" : "sidebar-\(view.kind.rawValue)")
	}
}

private struct SidebarLabel: View {
	let title: String
	var count = 0

	var body: some View {
		HStack {
			Text(title)
			Spacer(minLength: 8)
			if count > 0 {
				Text("\(count)")
					.monospacedDigit()
					.foregroundStyle(.mcMuted)
			}
		}
		.padding(.vertical, 3)
		.contentShape(Rectangle())
	}
}

/// The open item's pill: the sheet's colour, the native inset (L3).
struct SheetPill: View {
	let shown: Bool

	var body: some View {
		if shown {
			MCCorner.control.rect
				.fill(.mcSheet)
				.padding(.horizontal, 10)
		}
	}
}

/// All accounts and each served address. Changes the account, never the view (WD-02). iPad: the
/// iPhone's account sheet as a popover, with the notification switch, Theme and Appearance that the
/// Mac keeps in Settings (⌘,).
private struct AccountMenu: View {
	@Environment(AppModel.self) private var model
	@State private var shown = false

	var body: some View {
		#if os(macOS)
		picker
		#else
		Button { shown = true } label: {
			HStack(spacing: 8) {
				Text(model.account ?? "All accounts").lineLimit(1)
				Spacer(minLength: 4)
				Chevron().frame(width: 9, height: 5).foregroundStyle(.mcMuted)
			}
			.padding(.horizontal, 10)
			.frame(minHeight: 34)
			.background(.mcSheet, in: MCCorner.control.rect)
			.overlay(MCCorner.control.rect.strokeBorder(.mcControl))
			.contentShape(MCCorner.control.rect)
		}
		.buttonStyle(.plain)
		.popover(isPresented: $shown) { AccountSheet().frame(idealWidth: 400, idealHeight: 680) }
		.accessibilityLabel("Account: \(model.account ?? "All accounts")")
		.accessibilityIdentifier("account-menu")
		#endif
	}

	/// Words only: a pop-up Picker checkmarked the current account (ipad-r2-03); the current one is a
	/// disabled item instead.
	private var picker: some View {
		Menu {
			MenuChoice(title: "All accounts", current: model.account == nil) { model.select(account: nil) }
			ForEach(model.accounts, id: \.self) { address in
				MenuChoice(title: address, current: model.account == address) { model.select(account: address) }
			}
		} label: {
			MenuLabel(text: model.account ?? "All accounts")
		}
		.menuStyle(.button)
		.buttonStyle(.plain)
		.menuIndicator(.hidden)
		// Held to the column's leading edge (L3 S6): it sat centred while only "All accounts" had loaded.
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityLabel("Account")
		.accessibilityValue(model.account ?? "All accounts")
		.accessibilityIdentifier("account-menu")
	}
}
