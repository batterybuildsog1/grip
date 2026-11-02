import MailClawKit
import SwiftUI

/// The Mac window, and a regular-width iPad's (RootView): L3 "Rail" (chosen 2026-10-26), two
/// columns, never three. Browsing: the sidebar holds the views and the detail
/// the one-line list. Reading: the list folds into the sidebar as the rail and the thread takes the
/// detail, so the next conversation is one click away. "Sidebar" (`[`) hides the column in either
/// state. Words only (r1 S6). The iPad differs in what it lacks: composers are the iPhone's
/// sheet, settings the account popover's, and its words sit on a bar of its own (`bar`).
struct MacRootView: View {
	let sync: MailSync?
	@Environment(AppModel.self) private var model
	@Environment(MileageReportModel.self) private var book
	#if os(macOS)
	@Environment(\.openSettings) private var openSettings
	#else
	@State private var mileageSettings = false
	#endif
	@Environment(\.undoManager) private var undoManager
	@Environment(\.mcPalette) private var palette
	@Environment(\.openWindow) private var openWindow
	@FocusState private var pane: Pane?
	@FocusState private var searchFocused: Bool
	/// Search asked for (/, ⌘F, ⌘K) where the bar has no field: while reading (design-taste T1/M1:
	/// Search is the list's word) and on an iPad bar with no room for it (ipad-r3-02). The thread's
	/// words give way to the field until Cancel, an empty field let go, or a thread opening.
	@State private var searching = false
	#if os(iOS)
	@State private var barWidth: CGFloat = 1000
	#else
	/// The window's width: Mileage's month lets New Message give way to Search trips (mac-r2-03).
	@State private var windowWidth: CGFloat = 1280
	#endif

	var body: some View {
		@Bindable var model = model
		NavigationSplitView(columnVisibility: sidebarVisibility) {
			MacSidebar()
				// One width in both states, so the sheet never moves when the list folds (L3).
				.navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 320)
		} detail: {
			detail
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.background(.mcSheet)
				#if os(iOS)
				// The iPad's words sit on a bar of their own over the detail (`bar`).
				.toolbar(.hidden, for: .navigationBar)
				.safeAreaInset(edge: .top, spacing: 0) { bar }
				#endif
		}
		#if os(macOS)
		// The colour itself, resolved here: the window resolves a token outside the scene's
		// environment and drew the wrong frame (mac-r2-02), or the system material in Dark.
		.toolbarBackground(palette[.frame], for: .windowToolbar)
		// The title sits in the sheet (the list's heading) or is the thread's subject: never twice.
		.toolbar(removing: .title)
		.toolbar { toolbar }
		.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
		#else
		// Beside each other in portrait too: the column never covers the sheet (L3: two regions).
		.navigationSplitViewStyle(.balanced)
		#endif
		.toolbar(removing: .sidebarToggle)
		.onChange(of: model.draft) { _, text in
			if text.isEmpty, model.isSearching { model.cancelSearch() }
		}
		// A draft opened from the list (a Drafts row): its own composer window.
		.onChange(of: model.composeWindow) { _, request in
			guard let request else { return }
			openWindow.compose(request, in: model)
			model.composeWindow = nil
		}
		.overlay(alignment: .bottom) { ToastBar() }
		.background { KeyAlternates() }
		.sheet(isPresented: $model.showsShortcuts) { ShortcutHelp() }
		.focusedSceneValue(\.mailShortcutsLive, model.shortcutsLive)
		// Report's "Settings": on the Mac the Settings window (⌘,) on its Mileage tab; on the iPad a sheet.
		.onChange(of: book.showSettings) { _, shown in
			guard shown else { return }
			book.showSettings = false
			#if os(macOS)
			UserDefaults.standard.set("mileage", forKey: "MCSettingsTab")
			openSettings()
			#else
			mileageSettings = true
			#endif
		}
		#if os(iOS)
		// iPad: Sign out in Mileage settings closes the sheet over the sign-in form (apple-r1-07).
		.onChange(of: book.signedIn) { _, signedIn in if !signedIn { mileageSettings = false } }
		.sheet(isPresented: $mileageSettings) {
			NavigationStack {
				MileageSettingsView()
					.navigationTitle("Mileage settings")
					.navigationBarTitleDisplayMode(.inline)
					.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { mileageSettings = false } } }
			}
		}
		#endif
		.focusedSceneValue(\.mileageKeys, model.showsMileage && !model.isTyping && !book.typing ? MileageKeys(book: book) : nil)
		.onChange(of: searchFocused, initial: true) { _, focused in model.isTyping = focused }
		.onChange(of: model.searchFocusRequests) { _, _ in searchFocused = true }
		// Opening a conversation from the search results hands the keyboard to the thread.
		.onChange(of: model.selection) { _, id in if id != nil { searchFocused = false } }
		// "/" (⌘F, ⌘K on the Mac) always reaches Search: where the bar has no field, it becomes the
		// field until Cancel, an empty field let go, or a thread opening (its words come back).
		.onChange(of: model.searchFocusRequests) { _, _ in
			searching = true
			#if os(iOS)
			DispatchQueue.main.async { searchFocused = true }
			#endif
		}
		.onChange(of: searchFocused) { _, now in if !now, model.draft.isEmpty, !model.isSearching { searching = false } }
		.onChange(of: model.isSearching) { _, on in if !on, !searchFocused { searching = false } }
		.onChange(of: model.selection) { _, id in if id != nil { searching = false } }
		// So does choosing a view: the list takes the keyboard, ready for j/k.
		.onChange(of: model.view) { _, _ in
			searchFocused = false
			pane = .list
		}
		.onAppear {
			model.undoManager = undoManager
			model.prepareNotifications()
			#if os(macOS)
			NotificationRouter.shared.attach { id, emailId in
				openWindow(id: "main")
				model.openFromNotification(id, emailId: emailId)
			}
			#endif
		}
	}

	/// Reading: the thread. Browsing: the one-line list, or Mileage (its report, or a trip with the
	/// column as its rail). Signed in with no mail store (or the offline pilot): why, in the list's place.
	@ViewBuilder private var detail: some View {
		if let id = model.selection, let sync {
			ThreadView(id: id, anchor: model.anchor(for: id), sync: sync, pane: $pane)
				.id(id)
				.navigationTitle(model.listName)
		} else if model.showsMileage {
			MileageSheet()
				.navigationTitle("Mileage")
		} else if sync == nil {
			MailUnavailableView()
		} else {
			ConversationListView(pane: $pane)
		}
	}

	private var sidebarVisibility: Binding<NavigationSplitViewVisibility> {
		Binding(
			get: { model.sidebarShown ? .all : .detailOnly },
			set: { model.sidebarShown = $0 != .detailOnly })
	}

	/// Words on the window's frame, no capsules (r1 S6; L3 S6). Browsing: New message (the one
	/// filled button) and Search. Reading, the thread's six words and nothing else (design-taste T1/M1,
	/// Thread A): ‹ back, Archive, Mark unread, Trash (red, set apart), More (Reply all, Forward) and
	/// Reply, the one filled button. New message and Search stay the list's, and its keys' (⌘N, ⌘F).
	/// A lone newsletter has nothing to reply to: Archive is the filled one (L3 S3, as the web).
	@ToolbarContentBuilder private var toolbar: some ToolbarContent {
		ToolbarItemGroup(placement: .navigation) {
			sidebarWord
			if model.showsMileage {
				MileageToolbarLead()
			} else if model.selection != nil {
				backWord
				positionWords
			}
		}
		.sharedBackgroundVisibility(.hidden)
		if model.showsMileage {
			ToolbarItemGroup(placement: .primaryAction) {
				MileageToolbarWords()
			}
			.sharedBackgroundVisibility(.hidden)
		}
		if model.selection != nil {
			ToolbarItemGroup(placement: .primaryAction) {
				if searching {
					// ⌘F, ⌘K or / while reading: the field takes the thread's words' place.
					SearchField(focused: $searchFocused, focusNow: true, onCancel: { searching = false })
					cancelSearchWord
				} else {
					archiveWord
					unreadWord
					trashWord
					// Reply, Reply all and Forward each open their own composer window (r2 S5).
					moreWord()
					if !readingNewsletter { replyWord }
				}
			}
			.sharedBackgroundVisibility(.hidden)
		} else {
			ToolbarItemGroup(placement: .primaryAction) {
				if !mileageCrowded { newWord }
				if model.showsMileage {
					MileageSearchField()
				} else {
					SearchField(focused: $searchFocused)
				}
			}
			.sharedBackgroundVisibility(.hidden)
		}
	}

	#if os(macOS)
	/// Mileage's month on a narrow Mac window: CLEAN-SPEC's toolbar keeps Search trips, so New message
	/// (⌘N, File > New Message) gives way when the words can't all fit beside the column, never into
	/// AppKit's overflow chevron (an icon). At 760 pt AppKit dropped Search trips instead (mac-r2-03).
	private var mileageCrowded: Bool {
		model.showsMileage && book.open == nil && windowWidth - (model.sidebarShown ? 250 : 90) < 600
	}
	#else
	private var mileageCrowded: Bool { false }
	#endif

	#if os(iOS)
	/// iPad: the toolbar's words on a plain bar over the detail. It is never wider than its window
	/// (ipad-r2-02: with the rail hidden at 700pt the bar pushed the detail off both edges): Sidebar
	/// and ‹ back always show. Reading shows the Mac's six words (no search field: / brings it); on a
	/// narrow bar they fold into More, never into the system's overflow "…" (no icons): Mark unread,
	/// then Archive and Trash, then "4 of 25 · Prev · Next" goes, leaving More and Reply. Browsing:
	/// New message and the search field where it leaves room.
	private var bar: some View {
		let reading = model.selection != nil
		let placed = reading && !model.sidebarShown && model.openPosition != nil
		let search = !reading && barWidth >= 520
		return HStack(spacing: 6) {
			sidebarWord
			if model.showsMileage {
				// Mileage, as mail: where you are keeps its words. On the month Search trips stays and New
				// Message gives way under 600 pt (an iPad mini's 504 pt portrait bar); on a trip the search
				// field shows from 700 pt (ipad-r1-05: at 688 it pushed the trip under the rail).
				MileageToolbarLead()
					.fixedSize()
				Spacer(minLength: 12)
				MileageToolbarWords()
				if book.open != nil || barWidth >= 600 { newWord }
				if book.open == nil || barWidth >= 700 { MileageSearchField(width: barWidth >= 1000 ? 220 : 170) }
			} else if searching, !search {
				// No field on the bar (reading, or no room): the field takes the words' place.
				SearchField(focused: $searchFocused, width: nil, onCancel: { searching = false })
				cancelSearchWord
			} else {
				if reading { backWord }
				ViewThatFits(in: .horizontal) {
					barRow(.full, placed: placed)
					barRow(.folded, placed: placed)
					// With the rail hidden the bar is where you are (P5, P19 at 700pt): Archive and
					// Trash fold into More before "4 of 25 · Prev · Next" gives way.
					barRow(.minimal, placed: placed)
					barRow(.folded, placed: false)
					barRow(.minimal, placed: false)
					Spacer(minLength: 0)
				}
				.layoutPriority(1)
				if search { SearchField(focused: $searchFocused, width: barWidth >= 1100 ? 220 : 170) }
			}
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 3)
		.mcBarText()
		.background(.mcSheet)
		.overlay(alignment: .bottom) { Rectangle().fill(.mcRule).frame(height: 1) }
		.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barWidth = $0 }
	}

	/// One candidate for the bar's middle: where you are (with the rail hidden), then the actions.
	private func barRow(_ fit: Fit, placed: Bool) -> some View {
		HStack(spacing: 6) {
			if placed { positionWords }
			Spacer(minLength: 12)
			if model.selection != nil {
				if fit != .minimal || readingNewsletter { archiveWord }
				if fit == .full { unreadWord }
				if fit != .minimal { trashWord }
				moreWord(fit)
				if !readingNewsletter { replyWord }
			} else if fit != .minimal {
				newWord
			}
		}
	}
	#endif

	private func endSearch() {
		model.cancelSearch()
		searchFocused = false
		searching = false
	}

	/// What the bar has room for while reading: every word (the Mac's toolbar always), Mark unread
	/// folded into More, or More and Reply alone (iPad: a narrow window with the rail hidden).
	private enum Fit { case full, folded, minimal }

	// The words, one definition for the Mac's toolbar and the iPad's bar.

	private var sidebarWord: some View {
		Button("Sidebar") { model.sidebarShown.toggle() }
			.buttonStyle(ToolbarWord(isOn: model.sidebarShown))
			.accessibilityValue(model.sidebarShown ? "shown" : "hidden")
			.accessibilityIdentifier("tb-sidebar")
	}

	private var backWord: some View {
		Button("‹ \(model.listName)") { model.back() }
			.buttonStyle(ToolbarWord(weight: .semibold))
			.accessibilityLabel("Back to \(model.listName)")
			.accessibilityIdentifier("tb-back")
	}

	/// With the rail hidden, the bar says where you are; the rail says it otherwise (L3).
	@ViewBuilder private var positionWords: some View {
		if !model.sidebarShown, let position = model.openPosition {
			OpenPosition(index: position.index, count: position.count)
		}
	}

	private var archiveWord: some View {
		Button("Archive") { model.archive() }
			.buttonStyle(ToolbarWord(role: readingNewsletter && !model.inTrash ? .primary : .plain))
			.accessibilityIdentifier("tb-archive")
	}

	/// "Mark read" / "Mark unread": a verb, never the state (design-taste X7). It always takes the
	/// longer word's width, so the toolbar's first measure never cuts the other (mac-r2-01).
	private var unreadWord: some View {
		Button { model.toggleRead() } label: {
			ZStack {
				Text("Mark unread").hidden()
				Text(readTitle)
			}
		}
		.buttonStyle(ToolbarWord())
		.accessibilityLabel(readTitle)
		.accessibilityIdentifier("tb-unread")
	}

	private var readTitle: String { model.actionTargetRow?.unread == true ? "Mark read" : "Mark unread" }

	/// Trash is red and set apart, never next to Archive (r2 S7, WP-04).
	private var trashWord: some View {
		Button("Trash", role: .destructive) { model.trash() }
			.buttonStyle(ToolbarWord(role: .neg))
			.padding(.horizontal, 10)
			.accessibilityIdentifier("tb-trash")
	}

	private var replyWord: some View {
		Button("Reply") { compose(.reply) }
			.buttonStyle(ToolbarWord(role: .primary))
			.accessibilityIdentifier("tb-reply")
	}

	/// More: Reply all and Forward (a lone newsletter: Forward), each said once in the window
	/// (design-taste X4: no Reply · Reply all · Forward row under the message). Where the iPad's bar
	/// is narrow it also holds the words that gave way, Trash last and set apart.
	private func moreWord(_ fit: Fit = .full) -> some View {
		Menu {
			if fit == .minimal, !readingNewsletter { Button("Archive") { model.archive() } }
			if fit != .full { Button(readTitle) { model.toggleRead() } }
			if !readingNewsletter { Button("Reply all") { compose(.replyAll) } }
			Button("Forward") { compose(.forward) }
			if fit == .minimal {
				Divider()
				Button("Trash", role: .destructive) { model.trash() }
			}
		} label: {
			Text("More")
		}
		.menuStyle(.button)
		.buttonStyle(ToolbarWord())
		.menuIndicator(.hidden)
		.fixedSize()
		.accessibilityIdentifier("tb-more")
	}

	private var cancelSearchWord: some View {
		Button("Cancel") { endSearch() }
			.buttonStyle(ToolbarWord())
			.accessibilityIdentifier("search-cancel")
	}

	/// New message is filled only while browsing; in a thread it leaves the bar (⌘N and c keep it)
	/// and Reply is the one (L3-R2-11, design-taste T1).
	private var newWord: some View {
		Button("New message") { openWindow.compose(ComposeRequest(kind: .new), in: model) }
			.buttonStyle(ToolbarWord(role: model.selection == nil && !model.showsMileage ? .primary : .plain))
			.padding(.leading, 8)
			.accessibilityIdentifier("tb-new")
	}

	private var readingNewsletter: Bool {
		model.selection != nil && model.newsletterOpen == model.selection
	}

	private func compose(_ kind: ComposeKind) {
		if let request = model.replyRequest(kind) { openWindow.compose(request, in: model) }
	}
}

/// "4 of 25 · Prev · Next": only while the rail is hidden (L3).
private struct OpenPosition: View {
	@Environment(AppModel.self) private var model
	let index: Int
	let count: Int

	var body: some View {
		HStack(spacing: 10) {
			// As wide as "000 of 000" whatever the numbers: the toolbar measures this item once, and a
			// count that grew after it cut "Next" to "Ne…" (mac-r2-01).
			ZStack(alignment: .trailing) {
				Text(verbatim: "000 of 000").monospacedDigit().hidden()
				Text("\(index + 1) of \(count)")
					.monospacedDigit()
					.foregroundStyle(.mcMuted)
					.accessibilityIdentifier("tb-position")
			}
			Button("Prev") { model.step(-1) }
				.disabled(index == 0)
				.accessibilityIdentifier("tb-prev")
			Button("Next") { model.step(1) }
				.disabled(index >= count - 1)
				.accessibilityIdentifier("tb-next")
		}
		.fixedSize()
		.buttonStyle(ToolbarWord(role: .muted))
	}
}

/// The toolbar's search field (r2 S4): a plain field with "Search" and its key, no glyph. Return
/// searches over All mail; clearing it (or Esc) returns to the view.
private struct SearchField: View {
	@Environment(AppModel.self) private var model
	var focused: FocusState<Bool>.Binding
	/// Nil: as wide as the bar allows (the iPad's search state).
	var width: CGFloat? = 220
	/// Put there by the request it answers (⌘F while reading): takes the keyboard as it appears.
	var focusNow = false
	/// Where the field took the thread's words' place: Esc gives them back. On the Mac the field's
	/// focus is AppKit's, so letting go fires no SwiftUI focus change the bar could watch.
	var onCancel: (() -> Void)? = nil

	var body: some View {
		@Bindable var model = model
		HStack(spacing: 6) {
			TextField("Search", text: $model.draft)
				.textFieldStyle(.plain)
				.focused(focused)
				.onSubmit {
					model.submitSearch()
					// The results take the keyboard, as the web does: j/k and Return work at once.
					focused.wrappedValue = false
				}
				#if os(macOS)
				.onExitCommand { cancel() }
				#else
				.onKeyPress(.escape) {
					cancel()
					return .handled
				}
				#endif
				.accessibilityIdentifier("search-field")
			Text(Self.keyCap)
				.font(.caption)
				.foregroundStyle(.mcFaint)
				.padding(.horizontal, 4)
				.overlay(MCCorner.control.rect.strokeBorder(.mcBorder))
				.accessibilityHidden(true)
		}
		.foregroundStyle(.mcText)
		.padding(.horizontal, 10)
		.frame(width: width, height: 28)
		.frame(maxWidth: width == nil ? .infinity : nil)
		.background(.mcRaised, in: MCCorner.control.rect)
		.overlay(MCCorner.control.rect.strokeBorder(focused.wrappedValue ? AnyShapeStyle(.mcFocus) : AnyShapeStyle(.clear)))
		#if os(macOS)
		// ⌘F, ⌘K and / (and letting go after Return or Esc) through AppKit: see FieldFocus.
		.onChange(of: focused.wrappedValue) { _, now in if !now { letGo += 1 } }
		.background { FieldFocus(focus: model.searchFocusRequests, letGo: letGo, focusNow: focusNow) }
		#endif
	}

	@State private var letGo = 0

	/// The key that reaches Search: ⌘F on the Mac; / on iPad, where iPadOS keeps ⌘F (ipad-r2-05).
	private static var keyCap: String {
		#if os(macOS)
		"⌘F"
		#else
		"/"
		#endif
	}

	private func cancel() {
		model.cancelSearch()
		focused.wrappedValue = false
		onCancel?()
	}
}

#if os(macOS)
/// Moves AppKit's first responder into the toolbar's search field, or out of it. A @FocusState
/// request never reached a field in the window's toolbar: after ⌘F the list kept the keyboard
/// (mac-r2-04), and after Return the field could keep it, leaving the single-key shortcuts off.
/// @FocusState follows AppKit's focus (as it does for a click), so `isTyping` stays true.
private struct FieldFocus: NSViewRepresentable {
	let focus: Int
	let letGo: Int
	/// A field made by the request it answers: the first update counts that request as new.
	var focusNow = false

	final class Coordinator {
		var focus: Int
		var letGo: Int
		init(focus: Int, letGo: Int) { (self.focus, self.letGo) = (focus, letGo) }
	}

	func makeCoordinator() -> Coordinator { Coordinator(focus: focusNow ? focus - 1 : focus, letGo: letGo) }
	func makeNSView(context: Context) -> NSView { NSView() }

	func updateNSView(_ view: NSView, context: Context) {
		let wantsFocus = focus != context.coordinator.focus
		let wantsOut = letGo != context.coordinator.letGo
		(context.coordinator.focus, context.coordinator.letGo) = (focus, letGo)
		guard wantsFocus || wantsOut else { return }
		Task { @MainActor in
			guard let window = view.window, let field = Self.field(near: view) else { return }
			if wantsFocus {
				window.makeFirstResponder(field)
			} else if field.currentEditor() != nil {
				window.makeFirstResponder(nil)
			}
		}
	}

	/// The text field beside this view: the nearest ancestor's first editable NSTextField.
	private static func field(near view: NSView) -> NSTextField? {
		var ancestor = view.superview
		while let current = ancestor {
			if let field = firstField(in: current) { return field }
			ancestor = current.superview
		}
		return nil
	}

	private static func firstField(in view: NSView) -> NSTextField? {
		for sub in view.subviews {
			if let field = sub as? NSTextField, field.isEditable { return field }
			if let found = firstField(in: sub) { return found }
		}
		return nil
	}
}
#endif

/// A toolbar word: text on the frame, a soft fill on hover and while on (Sidebar), the theme's
/// primary fill for the one main action, red for Trash.
struct ToolbarWord: ButtonStyle {
	enum Role { case plain, primary, neg, muted }
	var role: Role = .plain
	var isOn = false
	var weight: Font.Weight = .regular

	func makeBody(configuration: Configuration) -> some View {
		WordBody(configuration: configuration, role: role, isOn: isOn, weight: weight)
	}

	private struct WordBody: View {
		let configuration: ButtonStyleConfiguration
		let role: Role
		let isOn: Bool
		let weight: Font.Weight
		@Environment(\.isEnabled) private var isEnabled
		@Environment(AppModel.self) private var app: AppModel?
		@State private var hovering = false

		/// One filled button: while a composer is open (a Mac window, the iPad's sheet) its Send is
		/// the one, and the main window's (Reply, New Message, a newsletter's Archive) steps down
		/// (mac-r2-03, ipad-r1-03; L3-R2-11).
		private var filled: Bool {
			role == .primary && (app?.composerWindows ?? 0) == 0 && app?.composer == nil
		}

		/// The toolbar keeps the width it first measured: a newsletter's Archive, measured plain and
		/// then filled, read "Archi…" (mac-r2-01). So a word always takes its semibold width, and it
		/// never truncates (`fixedSize`): if its item is still short, it spills into the margin.
		var body: some View {
			ZStack {
				configuration.label.font(.body.weight(.semibold)).hidden()
				configuration.label.font(.body.weight(filled ? .semibold : weight))
			}
				.fixedSize()
				.foregroundStyle(ink)
				.padding(.horizontal, 9)
				.frame(height: 26)
				.background(fill, in: MCCorner.control.rect)
				#if os(iOS)
				.padding(.vertical, 9) // a 44pt target for a finger; the fill stays the Mac's 26
				#endif
				.opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
				.contentShape(MCCorner.control.rect)
				.onHover { hovering = $0 }
		}

		private var ink: AnyShapeStyle {
			switch role {
			case .primary: filled ? AnyShapeStyle(.mcOnPrimary) : AnyShapeStyle(.mcText)
			case .neg: AnyShapeStyle(.mcNeg)
			case .muted: AnyShapeStyle(.mcMuted)
			case .plain: AnyShapeStyle(.mcText)
			}
		}

		private var fill: AnyShapeStyle {
			if filled { return AnyShapeStyle(.mcPrimary) }
			return isOn || hovering ? AnyShapeStyle(.mcRaised) : AnyShapeStyle(.clear)
		}
	}
}

// MARK: - Mileage's words on the frame

/// "Mileage / October 2026 so far · 6 need you" while browsing; "‹ October" with a trip open.
private struct MileageToolbarLead: View {
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		if book.open != nil {
			Button("‹ \(book.report.map { String(MileageTime.month($0.month).split(separator: " ").first ?? "") } ?? "Mileage")") {
				book.open = nil
			}
			.buttonStyle(ToolbarWord(weight: .semibold))
			.accessibilityIdentifier("tb-mileage-back")
		} else {
			VStack(alignment: .leading, spacing: 0) {
				Text("Mileage").font(.headline).foregroundStyle(.mcText)
				if book.report != nil {
					Text(book.needsYou.isEmpty ? "nothing needs you" : "\(book.needsYou.count) need you")
						.font(.caption)
						.foregroundStyle(.mcMuted)
				}
			}
			.padding(.horizontal, 6)
			.accessibilityElement(children: .combine)
			.accessibilityIdentifier("tb-mileage-title")
		}
	}
}

/// Export (CLEAN-SPEC add-back: one click from the first screen). Settings is the Settings window
/// (⌘,) and Report's foot; Delete is in a trip's Details and ⌫.
private struct MileageToolbarWords: View {
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		if book.open == nil, book.report != nil {
			Button("Export") { book.showExport = true }
				.buttonStyle(ToolbarWord())
				.accessibilityIdentifier("tb-mileage-export")
		}
	}
}

/// "Search trips": filters the month's trips as you type; Esc clears it. Not for an account that isn't
/// a Mileage owner: there is nothing to search.
private struct MileageSearchField: View {
	var width: CGFloat = 220
	@Environment(MileageReportModel.self) private var book
	@FocusState private var focused: Bool

	var body: some View {
		if book.status != .notOwner { field }
	}

	private var field: some View {
		@Bindable var book = book
		return TextField("Search trips", text: $book.searchText)
			.textFieldStyle(.plain)
			.focused($focused)
			.onChange(of: focused) { _, value in book.typing = value }
			.onChange(of: book.searchText) { _, text in if text.isEmpty { book.cancelSearch() } }
			// Return searches, as mail's field does: the results fill the rail, the first one open.
			.onSubmit {
				book.submitSearch()
				focused = false
			}
			#if os(macOS)
			.onExitCommand {
				book.cancelSearch()
				focused = false
			}
			#else
			.onKeyPress(.escape) {
				book.cancelSearch()
				focused = false
				return .handled
			}
			#endif
			.foregroundStyle(.mcText)
			.padding(.horizontal, 10)
			.frame(width: width, height: 28)
			.background(.mcRaised, in: MCCorner.control.rect)
			.overlay(MCCorner.control.rect.strokeBorder(focused ? AnyShapeStyle(.mcFocus) : AnyShapeStyle(.clear)))
			.accessibilityIdentifier("mileage-search")
	}
}

// MARK: - Toast

/// "Archived “Newsletter” · Undo · z" for 6 s at the bottom of the window, or why an action failed.
private struct ToastBar: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		if let toast = model.toast {
			HStack(spacing: 14) {
				Text(toast.text)
					.lineLimit(2)
					.accessibilityIdentifier("toast-text")
				if toast.undoable {
					Button("Undo") { model.runToastUndo() }
						.buttonStyle(.plain)
						.fontWeight(.semibold)
						.underline()
						.accessibilityIdentifier("toast-undo")
					Text("z")
						.font(.callout.monospaced())
						.opacity(0.7)
						.accessibilityHidden(true)
				}
				// A failure stays until dismissed (S7).
				if toast.isError {
					Button("Dismiss") { model.dismissToast() }
						.buttonStyle(.plain)
						.underline()
				}
			}
			.font(.callout)
			.foregroundStyle(.mcOnToast)
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
			.background(.mcToast, in: MCCorner.box.rect)
			.mcFloatShadow()
			.padding(.bottom, 18)
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("toast")
		}
	}
}

// MARK: - Keys without a menu item of their own

/// Return and Esc (the second keys of Open and Back) and ⌘K (Search) as invisible buttons: a menu
/// item holds one key. Off while typing, so Return and Esc still reach the search field.
private struct KeyAlternates: View {
	@Environment(AppModel.self) private var model
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		let live = model.shortcutsLive
		// Mileage: Esc goes back from an open trip to the month, as u does (mac-r2-04). The Trip
		// menu's Esc item never fired: a menu item can't hold Esc, a button in the window can.
		let mileageBack = model.showsMileage && !model.isTyping && !book.typing && book.open != nil
		ZStack {
			Button("Back to the Report") { book.open = nil }
				.keyboardShortcut(mileageBack ? KeyboardShortcut(.escape, modifiers: []) : nil)
			Button("Open") { model.openCursor() }
				.keyboardShortcut(live ? KeyboardShortcut(.return, modifiers: []) : nil)
			Button("Back") { model.back() }
				.keyboardShortcut(live ? KeyboardShortcut(.escape, modifiers: []) : nil)
			Button("Search") { model.focusSearch() }
				.keyboardShortcut("k", modifiers: .command)
		}
		.opacity(0)
		.frame(width: 0, height: 0)
		.accessibilityHidden(true)
	}
}

extension FocusedValues {
	/// The key window's single-key shortcuts are live (nothing takes typing). Nil in other windows
	/// (Settings, compose), so letters typed there never move the mailbox.
	@Entry var mailShortcutsLive: Bool?
	/// Mileage shows and nothing takes typing: its keys (y s 1 2 3 Return j k u) are live.
	@Entry var mileageKeys: MileageKeys?
}
