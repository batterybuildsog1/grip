#if os(iOS)
import MailClawKit
import SwiftUI

/// The iPhone inbox (design r2 §4 S1, option A for the phone): a plain list whose large
/// title is a views menu and whose second line is the account; Needs you as the first section;
/// "Search all mail" and "New" at the bottom. No icons: words, type and spacing.
struct InboxView: View {
	@Environment(AppModel.self) private var model
	@Environment(\.mcPalette) private var palette
	@Binding var path: [PhoneRoute]
	@State private var needsYouOpen = false
	@State private var accountSheet = false
	@State private var now = Date()
	/// The large header has scrolled away: the compact title stands in (iphone-r2-10).
	@State private var compact = false
	@State private var headerHeight: CGFloat = 80

	var body: some View {
		Group {
			if model.showsMileage {
				// Mileage (V3): the report under the same views menu, its own bottom bar.
				MileagePhoneHome { header }
			} else if let search = model.search {
				// A submitted search replaces the inbox (r2 S4); Cancel brings it back as it was.
				@Bindable var model = model
				List(selection: $model.selection) { SearchSections(search: search).mcRows(palette) }
					.listStyle(.plain)
					.scrollContentBackground(.hidden)
					.background(.mcSheet)
					.toolbar(.hidden, for: .navigationBar)
			} else if model.sync == nil {
				// Signed in with no mail store (or the offline pilot): the views menu stays (Mileage
				// works), why mail can't open below it.
				VStack(alignment: .leading, spacing: 0) {
					header.padding(EdgeInsets(top: 4, leading: 20, bottom: 10, trailing: 20))
					MailUnavailableView()
				}
				.background(.mcSheet)
				.toolbar(.hidden, for: .navigationBar)
			} else {
				inbox
			}
		}
		.safeAreaInset(edge: .bottom) { if !model.showsMileage, model.sync != nil { bottomBar } }
		// Its detents are its own (Delete account opens it to full height).
		.sheet(isPresented: $accountSheet) { AccountSheet() }
		.task {
			while !Task.isCancelled {
				try? await Task.sleep(for: .seconds(30))
				now = .now
			}
		}
	}

	private var inbox: some View {
		List {
			header
				.mcRows(palette)
				.listRowSeparator(.hidden)
				.listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 10, trailing: 20))
			if model.view.kind == .personal {
				NeedsYouLineView(open: $needsYouOpen)
					.mcRows(palette)
					.listRowSeparator(.hidden)
					.listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
			}
			rows.mcRows(palette)
			if model.rows.isEmpty { emptyState.mcRows(palette).listRowSeparator(.hidden) }
		}
		.listStyle(.plain)
		.scrollContentBackground(.hidden)
		.background(.mcSheet)
		.accessibilityIdentifier("conversation-list")
		.toolbar(.hidden, for: .navigationBar)
		.refreshable { await model.refreshAndWait() }
		// iOS's large-title collapse in words (L3 S7, "Personal ⌄" over a scrolled list): once the
		// header is gone, the view's name and its menu stay at the top (iphone-r2-10).
		.onScrollGeometryChange(for: Bool.self) { geometry in
			geometry.contentOffset.y + geometry.contentInsets.top > headerHeight
		} action: { _, past in
			withAnimation(.easeInOut(duration: 0.15)) { compact = past }
		}
		.overlay(alignment: .top) {
			if compact { compactTitle.transition(.opacity) }
		}
	}

	/// The scrolled list's title: the view's name and its menu, centred on the sheet over a hairline.
	private var compactTitle: some View {
		viewsMenu {
			HStack(spacing: 6) {
				Text(viewTitle)
					.font(.headline.weight(.mcTitle))
					.foregroundStyle(.mcText)
					.lineLimit(1)
				Chevron().frame(width: 9, height: 5).foregroundStyle(.mcMuted)
			}
			.padding(.horizontal, 20)
			.frame(minHeight: 44)
			.contentShape(Rectangle())
		}
		// One views menu for VoiceOver and the tests at a time: the large one steps out meanwhile.
		.accessibilityIdentifier("inbox-views-menu")
		.mcBarText()
		.frame(maxWidth: .infinity)
		.background {
			Rectangle().fill(.mcSheet).ignoresSafeArea(edges: .top)
		}
		.overlay(alignment: .bottom) { Rectangle().fill(.mcControl).frame(height: 0.5) }
	}

	private var rows: some View {
		ForEach(model.rows) { row in
			// A button, not a NavigationLink: the list draws no disclosure chevrons (no icons). A
			// draft opens in the composer sheet, not the reader.
			Button { if !model.openDraft(row.id) { path.append(.thread(row.id)) } } label: {
				ConversationRowView(row: row)
			}
			.buttonStyle(.plain)
			.accessibilityIdentifier("conversation-row")
			// S7: labelled swipes (Mark as read|unread; Archive, Trash, Mark as …) and a context menu.
			.triageActions(row)
			.onAppear { if row.id == model.rows.last?.id { model.loadMoreIfNeeded() } }
		}
	}

	// MARK: Header: the view menu, the account line, freshness when it matters

	private var viewTitle: String { model.showsMileage ? "Mileage" : model.view.title }

	/// The views, as the large title's menu and the compact title's (ViewsMenuItems: words only).
	private func viewsMenu<Label: View>(@ViewBuilder label: () -> Label) -> some View {
		Menu { ViewsMenuItems() } label: { label() }
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: 3) {
			viewsMenu {
				HStack(alignment: .center, spacing: 10) {
					Text(viewTitle)
						.font(.largeTitle.weight(.mcTitle))
						.foregroundStyle(.mcText)
						.fixedSize(horizontal: false, vertical: true)
					Chevron().frame(width: 12, height: 7).foregroundStyle(.mcMuted)
				}
			}
			.accessibilityIdentifier("inbox-views-menu")
			.accessibilityHidden(compact)

			// Mileage's second line is its month (MileagePhoneHome), not the mail account.
			if !model.showsMileage {
			Button { accountSheet = true } label: {
				HStack(spacing: 7) {
					Text(accountLabel)
						.font(.subheadline)
						.foregroundStyle(.mcMuted)
						.fixedSize(horizontal: false, vertical: true)
					Chevron().frame(width: 8, height: 5).foregroundStyle(.mcMuted)
				}
			}
			.buttonStyle(.plain)
			.accessibilityIdentifier("inbox-account")
			}

			// Honest freshness (ticket 13), and only when the list may be stale (r2 §5: offline or
			// failing); a list that's current says nothing about it.
			if FreshnessText.isStale(model.freshness), !model.showsMileage {
				Text(FreshnessText.string(model.freshness, now: now))
					.font(.footnote)
					.foregroundStyle(.mcWarn)
					.accessibilityIdentifier("inbox-freshness")
			}
		}
		// Its row's top inset included: past this, the large title is out of sight.
		.onGeometryChange(for: CGFloat.self) { $0.size.height + 4 } action: { headerHeight = $0 }
	}

	private var accountLabel: String { model.account ?? "All accounts" }

	@ViewBuilder private var emptyState: some View {
		switch model.freshness {
		case .updating, .idle:
			SkeletonRows(view: model.view)
		default:
			Text(model.view.emptyText)
				.foregroundStyle(.mcMuted)
				.frame(maxWidth: .infinity)
				.padding(.top, 40)
		}
	}

	// MARK: Bottom: search and New

	/// S4's field pinned to the bottom (typing never searches; Return does), New beside it: the
	/// inbox's one filled button, as Reply is the thread's (design-taste I4/X3).
	private var bottomBar: some View {
		BottomSearchBar {
			// S5's compose sheet.
			NewMessageButton()
				.buttonStyle(MCPrimaryButtonStyle(capsule: true))
				.accessibilityShowsLargeContentViewer { Text("New") }
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier("inbox-new")
		}
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("inbox-search")
	}
}

#endif
