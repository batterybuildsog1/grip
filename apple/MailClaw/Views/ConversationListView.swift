import MailClawKit
import SwiftUI

/// The rail window's list while browsing (L3 Rail; Mac and iPad): the whole detail, one line per
/// conversation (who and how many, subject — new text, a file, when). A click or o/Return opens the row: the thread takes
/// the detail and the list folds into the rail. Back (u/Esc) brings the list back with the row
/// just read in view. The iPhone stack has its own inbox (Phone/InboxView.swift).
struct ConversationListView: View {
	@Environment(AppModel.self) private var model
	@Environment(\.mcPalette) private var palette
	var pane: FocusState<Pane?>.Binding
	/// Collapsed whenever the list comes back (r2 S1: collapsed by default).
	@State private var needsYouOpen = false

	var body: some View {
		ScrollViewReader { proxy in
			List { content }
			.listStyle(.plain)
			.scrollContentBackground(.hidden)
			.listRowSeparatorTint(palette[.rule])
			.onChange(of: model.cursor) { _, id in
				if let id { withAnimation { proxy.scrollTo(id) } }
			}
			// Back from a thread rebuilds the list: the row just read (the cursor) comes back into view.
			.task {
				guard let cursor = model.cursor else { return }
				proxy.scrollTo(cursor, anchor: .center)
			}
			// Each view gets its own list, starting at the top: `isAtTop` (reset by select) then
			// matches what is on screen, and the scroll callback below reports the next change.
			// A search's results start at the top too.
			.id(model.search.map { "search:\($0.query)" } ?? model.view.rawValue)
			.accessibilityIdentifier("conversation-list")
			.focused(pane, equals: .list)
			#if os(macOS)
			// The window has no saved split-view frames at launch (AppDelegate drops them, d2-04), and
			// such a window never moves keyboard focus on a click: the list takes it itself whenever it
			// comes on screen (launch, Back), unless the search field has it (d2-20). In L3 a click
			// opens the thread, which takes the keyboard; j/k are menu keys either way.
			.onAppear { if !model.isTyping { pane.wrappedValue = .list } }
			#endif
			.onScrollGeometryChange(for: Bool.self) { geometry in
				geometry.contentOffset.y + geometry.contentInsets.top < 12
			} action: { _, atTop in
				model.isAtTop = atTop
				if LaunchOptions.perfProbe { PerfProbe.shared.set("list_at_top", ms: atTop ? 1 : 0) }
			}
			.overlay(alignment: .top) {
				if model.pendingRows != nil {
					NewRowsButton(count: model.pendingCount) {
						model.showPendingRows()
						if let first = model.rows.first { withAnimation { proxy.scrollTo(first.id, anchor: .top) } }
					}
					.padding(.top, 8)
				}
			}
			// The window's name (Window menu); the toolbar shows no title (MacRootView).
			.navigationTitle(model.isSearching ? "Search" : model.view.title)
			.refreshable { await model.refreshAndWait() }
		}
	}

	@ViewBuilder private var content: some View {
		if let search = model.search {
			SearchSections(search: search)
		} else {
			// Rows picked: the bulk bar takes the heading's place and Needs you steps aside (r2 S7).
			// Rows that aren't conversations sit on the sheet too: a List row's own ground is the
			// system's (white or black on the iPad; the Mac's is clear), never Grip's (P23).
			if model.picked.isEmpty {
				ListHeading()
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
					.listRowInsets(EdgeInsets(top: 18, leading: 22, bottom: 2, trailing: 14))
			} else {
				BulkBar()
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
					.listRowInsets(EdgeInsets(top: 14, leading: 14, bottom: 4, trailing: 14))
			}
			// One collapsed line at the top of Personal only, never in the rail or a search (L3).
			if model.view.kind == .personal, model.picked.isEmpty {
				NeedsYouLineView(open: $needsYouOpen)
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
					.listRowInsets(EdgeInsets(top: 10, leading: 14, bottom: 8, trailing: 14))
			}
			Section {
				ForEach(model.rows) { row in
					ConversationListRow(row: row)
						.id(row.id)
						.onAppear { if row.id == model.rows.last?.id { model.loadMoreIfNeeded() } }
				}
			}
			if model.rows.isEmpty { emptyState }
		}
	}

	@ViewBuilder private var emptyState: some View {
		switch model.freshness {
		case .updating, .idle:
			SkeletonRows(view: model.view).listRowBackground(Color.clear).listRowSeparator(.hidden)
		default:
			Text(model.view.emptyText)
				.foregroundStyle(.mcMuted)
				.frame(maxWidth: .infinity)
				.padding(.top, 40)
				.listRowBackground(Color.clear)
				.listRowSeparator(.hidden)
		}
	}
}

/// The list's title at the top of the sheet (L3): the view's name; with the column hidden it is the
/// views menu ("Personal ▾") and Personal's unread count joins it (the column carries it otherwise).
/// Stale data says so here, and only then (r2 §5).
private struct ListHeading: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 12) {
			if model.sidebarShown {
				title
			} else {
				ViewsMenu { title }
					.accessibilityIdentifier("list-views-menu")
				if model.view.kind == .personal, model.personalUnread > 0 {
					Text("\(model.personalUnread) unread")
						.foregroundStyle(.mcMuted)
						.accessibilityIdentifier("list-unread")
				}
			}
			if FreshnessText.isStale(model.freshness) {
				Text(FreshnessText.string(model.freshness, now: .now))
					.foregroundStyle(.mcWarn)
					.accessibilityIdentifier("list-freshness")
			}
			Spacer(minLength: 0)
		}
		.selectionDisabled()
	}

	private var title: some View {
		Text(model.view.title)
			.font(.title.weight(.mcTitle))
			.foregroundStyle(.mcText)
			.accessibilityAddTraits(.isHeader)
			.accessibilityIdentifier("list-title")
	}
}

/// "3 selected · Archive · Mark read · Mark unread · Trash · Clear" (r2 S7): the picked rows' actions,
/// Trash red and set apart. Inside Trash: Restore in Archive's place, no bulk Delete forever.
private struct BulkBar: View {
	@Environment(AppModel.self) private var model
	/// Under 620pt (an iPad mini's or 11-inch's portrait list) the count takes its own line and the
	/// actions the next: the count was squeezed to 8pt wide, one letter a line (ipad-r1-06).
	@State private var narrow = false

	var body: some View {
		Group {
			if narrow {
				VStack(alignment: .leading, spacing: 4) {
					count
					HStack(spacing: 6) { actions }
				}
			} else {
				HStack(spacing: 6) {
					count
					actions
				}
			}
		}
		.frame(minHeight: 34)
		.onGeometryChange(for: Bool.self) { $0.size.width < 620 } action: { narrow = $0 }
		.selectionDisabled()
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("bulk-bar")
	}

	private var count: some View {
		Text("\(model.picked.count) selected")
			.fontWeight(.semibold)
			.foregroundStyle(.mcText)
			.fixedSize()
			.padding(.trailing, 8)
			.accessibilityIdentifier("bulk-count")
	}

	@ViewBuilder private var actions: some View {
		if model.inTrash {
			Button("Restore") { model.bulk(.restore) }.buttonStyle(ToolbarWord()).accessibilityIdentifier("bulk-restore")
		} else {
			Button("Archive") { model.bulk(.archive) }.buttonStyle(ToolbarWord()).accessibilityIdentifier("bulk-archive")
		}
		Button("Mark read") { model.bulk(.markRead) }.buttonStyle(ToolbarWord()).accessibilityIdentifier("bulk-read")
		Button("Mark unread") { model.bulk(.markUnread) }.buttonStyle(ToolbarWord()).accessibilityIdentifier("bulk-unread")
		if !model.inTrash {
			Button("Trash") { model.bulk(.trash) }
				.buttonStyle(ToolbarWord(role: .neg))
				.padding(.leading, 14)
				.accessibilityIdentifier("bulk-trash")
		}
		Spacer(minLength: 8)
		Button("Clear") { model.picked = [] }.buttonStyle(ToolbarWord(role: .muted)).accessibilityIdentifier("bulk-clear")
	}
}

/// One line of the rail window's list: a button that opens the conversation, highlighted while the
/// keyboard cursor is on it (its accessibility value says "cursor"). In the iPhone stack's search
/// results: the inbox's row, opened by the list's selection (Phone/InboxView.swift).
private struct ConversationListRow: View {
	@Environment(AppModel.self) private var model
	@Environment(\.usesRail) private var usesRail
	let row: ConversationRow
	var identifier = "conversation-row"
	/// Search results (r2 S4): where it lives, and the snippet with the matched words.
	var place: String?
	var marked: [SnippetRun]?

	var body: some View {
		if usesRail {
			oneLine
		} else {
			ConversationRowView(row: row, identifier: identifier, place: place, marked: marked)
				.triageActions(row)
		}
	}

	@ViewBuilder private var oneLine: some View {
		let isCursor = model.cursorShown && model.cursor == row.id
		let isPicked = model.picked.contains(row.id)
		HStack(spacing: 0) {
			// While rows are picked every row offers its checkbox in place of the dot (r2 S7).
			if !model.picked.isEmpty {
				Toggle("Select", isOn: Binding(get: { isPicked }, set: { _ in model.togglePicked(row.id) }))
					#if os(macOS)
					.toggleStyle(.checkbox)
					#else
					.toggleStyle(PickBox())
					#endif
					.labelsHidden()
					.padding(.leading, 2)
					.accessibilityIdentifier("row-checkbox")
			}
			Button { model.open(row.id) } label: {
				OneLineRowView(row: row, place: place, marked: marked, picking: !model.picked.isEmpty)
			}
			.buttonStyle(.plain)
		}
		.listRowBackground(cursorBackground(isCursor || isPicked))
		.accessibilityElement(children: .contain)
		.accessibilityValue(isPicked ? "picked" : (isCursor ? "cursor" : ""))
		.accessibilityAddTraits(isCursor ? .isSelected : [])
		.accessibilityIdentifier(identifier)
		.triageActions(row)
	}

	@ViewBuilder private func cursorBackground(_ isCursor: Bool) -> some View {
		if isCursor {
			MCCorner.control.rect
				.fill(.mcAccentSoft)
				.padding(.horizontal, 4)
		}
	}
}

/// Who (and how many), subject — new text, a file, when: one line, so a 900pt window shows about
/// sixteen conversations (L3); a search row in a narrow list adds its snippet as a second line.
/// Unread rows carry the dot and the name at 600; subject and time stay 400 (design-taste X2).
private struct OneLineRowView: View {
	let row: ConversationRow
	var place: String?
	var marked: [SnippetRun]?
	/// The checkbox stands where the dot was.
	var picking = false
	/// Under 600pt (an iPad mini's portrait list): a narrower name and files as a count, so the
	/// subject keeps its words.
	@State private var narrow = false
	/// A search row narrower than `oneLineSearch` (an iPad's portrait list) puts its snippet, with the
	/// matched words, on a second line and its files as a count: the matched words are why the row is
	/// there, and one line holds the subject, about 400pt of snippet and a file's name only from about
	/// 960pt (the Mac's 1280pt window gives about 1030).
	@State private var stacked = false
	private static let oneLineSearch: CGFloat = 960
	@Environment(\.mcPalette) private var palette

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			firstLine
			if stacked, let marked {
				Text(ConversationRowView.highlighted(marked, mark: palette[.mark], ink: palette[.text]))
					.foregroundStyle(.mcMuted)
					.lineLimit(2)
					.padding(.leading, (picking ? 0 : 7 + 12) + (narrow ? 130 : 180) + 12)
			}
		}
		.padding(.vertical, 6)
		.contentShape(Rectangle())
		.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
			narrow = width < 600
			stacked = marked?.isEmpty == false && width < Self.oneLineSearch
		}
		.accessibilityElement(children: .combine)
		// As the iPhone's row: the dot in words (the row around it says cursor or picked).
		.accessibilityValue(row.unread ? "Unread" : "")
	}

	private var firstLine: some View {
		HStack(alignment: .firstTextBaseline, spacing: 12) {
			if !picking {
				Circle()
					.fill(row.unread ? AnyShapeStyle(.mcAccent) : AnyShapeStyle(.clear))
					.frame(width: 7, height: 7)
					.alignmentGuide(.firstTextBaseline) { $0[.bottom] }
					.accessibilityHidden(true)
			}
			HStack(alignment: .firstTextBaseline, spacing: 5) {
				if row.isDraft { Text("Draft").foregroundStyle(.mcNeg) }
				Text(row.sender)
					.fontWeight(row.unread ? .semibold : .regular)
					.foregroundStyle(.mcText)
					.lineLimit(1)
				if row.messageCount > 1 {
					Text("\(row.messageCount)")
						.font(.callout)
						.foregroundStyle(.mcFaint)
				}
			}
			.frame(width: narrow ? 130 : 180, alignment: .leading)
			line
				.lineLimit(1)
				.frame(maxWidth: .infinity, alignment: .leading)
			files
			if let place {
				Text(place)
					.font(.callout)
					.foregroundStyle(.mcMuted)
					.lineLimit(1)
			}
			Text(RowDate.string(row.date))
				.foregroundStyle(row.unread ? .mcText : .mcMuted)
				.lineLimit(1)
				.frame(minWidth: 64, alignment: .trailing)
		}
	}

	/// The files (L3, as the web): the first name, cut in the middle so its extension shows, and "+N"
	/// for the others; "N files" when the server sends no names (one older than the field).
	@ViewBuilder private var files: some View {
		if let first = row.fileNames.first, !narrow, !stacked {
			HStack(spacing: 4) {
				chip(first).frame(maxWidth: 200)
				if row.fileCount > 1 { chip("+\(row.fileCount - 1)") }
			}
			.accessibilityElement(children: .combine)
			.accessibilityIdentifier("row-files")
		} else if row.hasAttachments || !row.fileNames.isEmpty {
			let count = max(row.fileCount, row.fileNames.count, 1)
			chip(count == 1 ? "1 file" : "\(count) files")
				.accessibilityIdentifier("row-files")
		}
	}

	private func chip(_ text: String) -> some View {
		Text(text)
			.font(.callout)
			.foregroundStyle(.mcMuted)
			.lineLimit(1)
			.truncationMode(.middle)
			.padding(.horizontal, 6)
			.padding(.vertical, 1)
			.overlay(MCCorner.control.rect.strokeBorder(.mcBorder))
			.fixedSize(horizontal: false, vertical: true)
	}

	/// "Subject — new text", the text in grey (search: the matched words marked).
	private var line: Text {
		let subject = Text(row.subject).foregroundStyle(.mcText)
		if stacked { return subject }
		if let marked, !marked.isEmpty {
			let runs = ConversationRowView.highlighted(marked, mark: palette[.mark], ink: palette[.text])
			return Text("\(subject)  —  \(Text(runs).foregroundStyle(.mcMuted))")
		}
		guard !row.snippet.isEmpty else { return subject }
		return Text("\(subject)  —  \(Text(row.snippet).foregroundStyle(.mcMuted))")
	}
}

#if os(iOS)
/// The Mac's checkbox, drawn (iPad): a box at half the control radius, filled when picked.
private struct PickBox: ToggleStyle {
	func makeBody(configuration: Configuration) -> some View {
		Button { configuration.isOn.toggle() } label: { Box(on: configuration.isOn) }
			.buttonStyle(.plain)
			.accessibilityValue(configuration.isOn ? "1" : "0")
	}

	private struct Box: View {
		let on: Bool

		var body: some View {
			let shape = RoundedRectangle(cornerRadius: MCCorner.control.radius / 2, style: .continuous)
			shape.fill(on ? AnyShapeStyle(.mcAccent) : AnyShapeStyle(.mcSheet))
				.overlay(shape.strokeBorder(on ? AnyShapeStyle(.mcAccent) : AnyShapeStyle(.mcControl)))
				.frame(width: 18, height: 18)
				.frame(width: 30, height: 30)
				.contentShape(Rectangle())
		}
	}
}
#endif

/// Loading (r2 §5): the rows' final layout with flat bars where the words will be, no shimmer, no
/// counts. One line per row on the Mac, three on iPhone.
struct SkeletonRows: View {
	let view: MailView
	@Environment(\.usesRail) private var usesRail

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			ForEach(0..<8, id: \.self) { index in
				row(index)
					.padding(.vertical, rowPadding)
					.overlay(alignment: .bottom) { Rectangle().fill(.mcRule).frame(height: 1) }
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Loading \(view.title)")
		.accessibilityIdentifier("list-loading")
	}

	private var rowPadding: CGFloat { usesRail ? 9 : 10 }

	@ViewBuilder private func row(_ index: Int) -> some View {
		let widths: [CGFloat] = [0.92, 0.7, 0.84, 0.62, 0.78, 0.88, 0.66, 0.74]
		let width = widths[index % widths.count]
		if usesRail {
			HStack(spacing: 12) {
				bar(140, height: 12)
				GeometryReader { geometry in bar(geometry.size.width * width, height: 12) }.frame(height: 12)
				bar(48, height: 12)
			}
			.padding(.leading, 19)
		} else {
			VStack(alignment: .leading, spacing: 8) {
				HStack { bar(130, height: 14); Spacer(); bar(44, height: 12) }
				bar(220 * width, height: 12)
				bar(300 * width, height: 12)
			}
			.padding(.leading, 17)
		}
	}

	private func bar(_ width: CGFloat, height: CGFloat) -> some View {
		MCCorner.control.rect.fill(.mcRaised).frame(width: width, height: height)
	}
}

/// "Updated just now", "Offline · Updated 3 hr ago": never claims freshness it does not have.
enum FreshnessText {
	/// Offline or failing: the list on screen may be out of date, and only then is it said (r2 §5).
	static func isStale(_ freshness: AppModel.Freshness) -> Bool {
		switch freshness {
		case .offline, .failed: true
		default: false
		}
	}

	static func string(_ freshness: AppModel.Freshness, now: Date) -> String {
		switch freshness {
		case .idle: return ""
		case .updating: return "Updating…"
		case let .updated(date): return "Updated \(relative(date, now: now))"
		case let .offline(date): return "Offline · " + (date.map { "Updated \(relative($0, now: now))" } ?? "Not downloaded yet")
		case let .failed(message): return "Couldn’t update · \(message)"
		}
	}

	private static func relative(_ date: Date, now: Date) -> String {
		let seconds = now.timeIntervalSince(date)
		if seconds < 60 { return "just now" }
		return date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated))
	}
}

private struct NewRowsButton: View {
	let count: Int
	let action: () -> Void

	var body: some View {
		// It floats over the list: the toast's ground and the float shadow (no glass).
		Button(action: action) {
			Text(count > 0 ? "\(count) New" : "Updated")
				.font(.subheadline.weight(.semibold))
				.foregroundStyle(.mcOnToast)
				.padding(.horizontal, 14)
				.padding(.vertical, 6)
				.background(.mcToast, in: Capsule())
				.mcFloatShadow()
		}
		.buttonStyle(.plain)
		.accessibilityIdentifier("new-rows")
	}
}

// MARK: - Search (r2 S4)

/// A submitted search: its header, then its results (or nothing, when it could not run).
struct SearchSections: View {
	let search: AppModel.Search

	var body: some View {
		Section {
			SearchHeaderView(search: search)
				.listRowBackground(Color.clear)
				.listRowSeparator(.hidden)
				.selectionDisabled()
			switch search.status {
			case .loading:
				HStack { Spacer(); ProgressView(); Spacer() }
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
					.selectionDisabled()
					.accessibilityIdentifier("search-loading")
			case let .answered(answer):
				ForEach(answer.results) { result in
					ConversationListRow(row: result.row, identifier: "search-row", place: result.place, marked: result.snippet)
						.tag(result.id)
				}
			case .offline, .failed, .rejected:
				EmptyView()
			}
		}
	}
}

/// What a search ran and where (r2 S4, the web's SearchHeader): the query as typed, "Searched
/// [All mail 50+] [Personal 10] in all accounts", then at most one note. Counts show only once the
/// server answered; offline or a failure says so and never shows a count (WD-11/12, NM-14).
struct SearchHeaderView: View {
	@Environment(AppModel.self) private var model
	let search: AppModel.Search

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Text("“\(search.query)”")
				.font(titleFont)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityIdentifier("search-title")
			ViewThatFits(in: .horizontal) {
				HStack(spacing: 8) { scopeRow }
				VStack(alignment: .leading, spacing: 8) { scopeRow }
			}
			note
		}
		.foregroundStyle(.mcText)
		.padding(.vertical, 6)
	}

	private var titleFont: Font {
		#if os(iOS)
		.title.weight(.mcTitle)
		#else
		.title2.weight(.mcTitle)
		#endif
	}

	@ViewBuilder private var scopeRow: some View {
		Text("Searched").foregroundStyle(.mcMuted)
		pill(.all, label: "All mail")
		if search.narrows { pill(.view, label: search.view.title) }
		// The app has no account choice yet: it searches every account the server allows.
		Text("in all accounts")
			.foregroundStyle(.mcMuted)
			.accessibilityIdentifier("search-account")
	}

	private func countText(for scope: AppModel.Search.Scope) -> String? {
		guard let answer = search.answer else { return nil }
		return scope == search.scope ? answer.countLabel : search.otherCount
	}

	private func pill(_ scope: AppModel.Search.Scope, label: String) -> some View {
		let selected = search.scope == scope
		let count = countText(for: scope)
		return Button {
			model.setSearchScope(scope)
		} label: {
			HStack(spacing: 4) {
				Text(label)
				if let count {
					Text(count)
						.fontWeight(.semibold)
						.opacity(selected ? 0.8 : 1)
						.foregroundStyle(selected ? MCColor.mcOnPrimary : .mcMuted)
				}
			}
			.font(.subheadline.weight(.medium))
			.foregroundStyle(selected ? MCColor.mcOnPrimary : .mcText)
			.padding(.horizontal, 12)
			.padding(.vertical, 6)
			.background { Capsule().fill(selected ? MCColor.mcPrimary : .mcSheet) }
			.overlay { Capsule().strokeBorder(selected ? MCColor.mcPrimary : .mcControl) }
			.contentShape(Capsule())
		}
		.buttonStyle(.plain)
		.accessibilityIdentifier(scope == .all ? "search-pill-all" : "search-pill-view")
		.accessibilityAddTraits(selected ? .isSelected : [])
	}

	@ViewBuilder private var note: some View {
		switch search.status {
		case .loading:
			EmptyView()
		case .offline:
			NoteBox(warn: true) {
				Text("You're offline, so nothing was searched.")
				Button("Try again") { model.retrySearch() }
			}
		case .failed:
			NoteBox(warn: true) {
				Text("Search didn't run: the server returned an error.")
				Button("Try again") { model.retrySearch() }
			}
		case let .rejected(reason):
			NoteBox(warn: true) { Text("Search didn't run: \(reason)") }
		case let .answered(answer):
			if let typed = answer.correctedFrom, let fixed = answer.query {
				NoteBox {
					Text("Showing results for \(Text(fixed).bold()).")
					Button("Search for “\(typed)” instead") {
						model.searchFor(SearchCount.literal(typed: typed, corrected: fixed))
					}
				}
			} else if let fix = answer.suggestion {
				NoteBox {
					// A suggestion also comes with one or two results: only zero is "no mail".
					if answer.results.isEmpty { Text("No mail matches “\(search.query)”.") }
					Button { model.searchFor(fix) } label: { Text("Did you mean \(Text(fix).bold())?") }
				}
			} else if answer.results.isEmpty {
				NoteBox { Text("No mail matches “\(search.query)”.") }
			}
		}
	}
}

private struct NoteBox<Content: View>: View {
	let warn: Bool
	let content: Content
	@Environment(\.mcPalette) private var palette

	init(warn: Bool = false, @ViewBuilder content: () -> Content) {
		self.warn = warn
		self.content = content()
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 4) { content }
			.buttonStyle(MCLinkButtonStyle())
			.foregroundStyle(warn ? MCColor.mcWarn : .mcText)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, 14)
			.padding(.vertical, 10)
			.background(warn ? MCColor.mcWarnSoft : .mcRaised, in: MCCorner.box.rect)
			.overlay {
				if warn { MCCorner.box.rect.strokeBorder(palette[.warn].opacity(0.35)) }
			}
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("search-note")
	}
}

#if os(iOS)
/// The iPhone's search field, pinned to the bottom (r2 S4, WP-09): Return searches and the results
/// replace the screen; Cancel returns to the view. `trailing` (the inbox's New) shows while the
/// field is idle; Cancel takes its place.
struct BottomSearchBar<Trailing: View>: View {
	@Environment(AppModel.self) private var model
	@FocusState private var focused: Bool
	@ViewBuilder var trailing: Trailing

	var body: some View {
		@Bindable var model = model
		HStack(spacing: 10) {
			TextField("Search all mail", text: $model.draft, prompt: Text("Search all mail").foregroundStyle(.mcMuted))
				.textFieldStyle(.plain)
				.submitLabel(.search)
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.focused($focused)
				.onSubmit {
					focused = false
					model.submitSearch()
				}
				.padding(.horizontal, 14)
				.frame(minHeight: 40)
				.foregroundStyle(.mcText)
				.background(.mcRaised, in: MCCorner.control.rect)
				.accessibilityIdentifier("search-field")
			if focused || model.isSearching {
				Button("Cancel") {
					focused = false
					model.cancelSearch()
				}
				.foregroundStyle(.mcAccent)
				.accessibilityShowsLargeContentViewer()
				.accessibilityIdentifier("search-cancel")
			} else {
				trailing
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 8)
		.mcBottomBar()
	}
}

extension BottomSearchBar where Trailing == EmptyView {
	init() { trailing = EmptyView() }
}
#endif
