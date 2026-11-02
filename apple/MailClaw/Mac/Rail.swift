import MailClawKit
import SwiftUI

/// Reading (L3 Rail): the list folded into the column beside the thread. Its title is a menu
/// holding the views and Mileage ("Personal ▾"), because the views can't keep a column of their own
/// while the rail shows (two regions at most: r1 S4/S5). A row is the name and time with the
/// subject under it: enough to tell one conversation from the next, nothing to read.
struct Rail: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		let rows = model.visibleRows
		let repeated = Self.repeated(rows)
		ScrollViewReader { proxy in
			List {
				ForEach(rows) { row in
					RailRow(row: row, open: row.id == model.selection, timeOfDay: repeated.contains(Self.key(row)))
						.id(row.id)
				}
				if rows.isEmpty { empty }
			}
			.listStyle(.sidebar)
			// The open row stays in view as j/k, Prev/Next and Archive move through the list.
			.onChange(of: model.selection, initial: true) { _, id in
				guard let id else { return }
				Task { @MainActor in proxy.scrollTo(id) }
			}
		}
		.safeAreaInset(edge: .top, spacing: 0) { RailTitle().background(.mcFrame) }
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("rail")
	}

	/// An empty rail says why, as the list does (r2 §5): offline or failing, else the view's empty
	/// line. A conversation opened from a note or a link while nothing is downloaded left it blank.
	@ViewBuilder private var empty: some View {
		let stale = FreshnessText.isStale(model.freshness)
		let loaded = if case .updated = model.freshness { true } else { false }
		if stale || (loaded && !model.isSearching) {
			Text(stale ? FreshnessText.string(model.freshness, now: .now) : model.view.emptyText)
				.font(.callout)
				.foregroundStyle(stale ? MCColor.mcWarn : .mcMuted)
				.fixedSize(horizontal: false, vertical: true)
				.padding(.vertical, 4)
				.listRowBackground(Color.clear)
				.accessibilityIdentifier("rail-empty")
		}
	}

	private static func key(_ row: ConversationRow) -> String { row.sender + "\u{1F}" + row.subject }

	/// Name and subject pairs listed more than once: those rows add the time of day, so two
	/// "Robin Example, Follow up" rows read apart (L3; the lead's call 3).
	private static func repeated(_ rows: [ConversationRow]) -> Set<String> {
		var seen = Set<String>()
		var twice = Set<String>()
		for row in rows where !seen.insert(key(row)).inserted { twice.insert(key(row)) }
		return twice
	}
}

/// "Personal ▾" (or the search, in quotes): the views, then Mileage. Choosing one leaves the thread
/// for that view's list.
private struct RailTitle: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		ViewsMenu {
			Text(model.search.map { "“\($0.query)”" } ?? model.view.title)
				.fontWeight(.semibold)
				.lineLimit(1)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.leading, 16)
		.padding(.trailing, 10)
		.padding(.vertical, 6)
		.accessibilityLabel("\(model.isSearching ? "Search results" : model.view.title): switch view")
		.accessibilityIdentifier("rail-title")
	}
}

/// A title that opens the views ("Personal ▾"): the rail's, and the list's with the column hidden.
/// The Mac's borderless menu draws its own chevron; the iPad draws the iPhone header's.
struct ViewsMenu<Title: View>: View {
	@ViewBuilder let title: Title

	var body: some View {
		Menu { ViewsMenuItems() } label: {
			#if os(macOS)
			title
			#else
			HStack(spacing: 7) {
				title
				Chevron().frame(width: 9, height: 5).foregroundStyle(.mcMuted)
			}
			#endif
		}
		#if os(macOS)
		.menuStyle(.borderlessButton)
		#else
		.buttonStyle(.plain)
		#endif
		.tint(.mcText)
		.fixedSize()
	}
}

/// The views, then Mileage: the iPhone's views menu, the rail's title menu and, with the column
/// hidden, the list's title. Words only: a Picker drew the system's checkmark beside the current
/// view (ipad-r2-03); the current one is a disabled item instead (the menu's title already names
/// it), which VoiceOver reads as current.
struct ViewsMenuItems: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		// The forwarded-in people after Money, then Notifications, as on the web and the Mac
		// (S6, X9).
		let views = [MailView.personal, .money] + model.persons.map(MailView.person)
			+ [.notifications, .all, .sent, .drafts, .trash]
		let current = model.isSearching || model.showsMileage ? nil : model.view.unscoped
		ForEach(views) { view in
			// The app's one count: Personal unread.
			let title = view == .personal && model.personalUnread > 0
				? "\(view.title)  \(model.personalUnread)" : view.title
			MenuChoice(title: title, current: view == current) { model.select(view) }
		}
		// Mileage last (L3): a placeholder until its own design.
		Divider()
		MenuChoice(title: "Mileage", current: model.showsMileage) { model.selectMileage() }
	}
}

/// One choice in a menu of words: the current one disabled and read as current, never a checkmark.
struct MenuChoice: View {
	let title: String
	let current: Bool
	let action: () -> Void

	var body: some View {
		Button(title, action: action)
			.disabled(current)
			// Native menus drop an accessibility value; the label carries "current" instead.
			.accessibilityLabel(current ? "\(title), current" : title)
	}
}

private struct RailRow: View {
	@Environment(AppModel.self) private var model
	let row: ConversationRow
	let open: Bool
	let timeOfDay: Bool

	/// The Mac's rail reads at 13/12pt; at the iPad's 17pt a 240pt rail kept seven letters of a name.
	#if os(macOS)
	private let nameFont: Font? = nil, smallFont = Font.callout
	#else
	private let nameFont: Font? = .subheadline, smallFont = Font.footnote
	#endif

	var body: some View {
		Button { model.open(row.id) } label: {
			HStack(alignment: .top, spacing: 7) {
				Circle()
					.fill(row.unread ? AnyShapeStyle(.mcAccent) : AnyShapeStyle(.clear))
					.frame(width: 7, height: 7)
					.padding(.top, 5)
				VStack(alignment: .leading, spacing: 1) {
					HStack(alignment: .firstTextBaseline, spacing: 6) {
						Text(row.sender)
							.font(nameFont)
							.fontWeight(row.unread ? .semibold : .regular)
							.lineLimit(1)
						Spacer(minLength: 4)
						Text(timeOfDay ? RowDate.withTimeOfDay(row.date) : RowDate.string(row.date))
							.font(smallFont)
							.foregroundStyle(row.unread ? .mcMuted : .mcFaint)
							.lineLimit(1)
							.fixedSize()
					}
					// The subject is always 400 in ink (design-taste X2); the pill marks the open one.
					Text(row.subject)
						.font(smallFont)
						.foregroundStyle(.mcText)
						.lineLimit(1)
				}
			}
			.padding(.vertical, 3)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.listRowBackground(SheetPill(shown: open))
		// The rail cuts long names and subjects; the whole subject shows on hover.
		.help(row.subject)
		.accessibilityElement(children: .combine)
		.accessibilityValue(open ? "open" : (row.unread ? "unread" : ""))
		.accessibilityAddTraits(open ? .isSelected : [])
		.accessibilityIdentifier("rail-row")
	}
}
