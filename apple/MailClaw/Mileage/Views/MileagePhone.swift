#if os(iOS)
import SwiftUI

/// Mileage on the iPhone (and iPad at compact width or Accessibility sizes): L3's one stack. The
/// report is the first screen under the views menu; a question or a trip is pushed one per screen
/// with its answers in the bottom bar; a company opens its full list. "Search trips" and Export sit
/// at the bottom, as Search and New do for mail.
struct MileagePhoneHome<Header: View>: View {
	@ViewBuilder var header: Header
	@Environment(MileageReportModel.self) private var book
	@Environment(MileageModel.self) private var mileage
	@Environment(\.dynamicTypeSize) private var typeSize
	@FocusState private var searching: Bool

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				header
				if book.showsMonth { MileageMonthMenu() }
				if let search = book.submittedSearch, let report = book.report {
					MileageListView(queue: .search(search), report: report)
				} else {
					MileageHome(phone: true)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, 20)
			.padding(.top, 4)
			.padding(.bottom, 24)
		}
		// On the scroll view itself: further out it passes through `.safeAreaInset` and renames
		// the bottom bar's Search trips and Export too (apple-r1-01).
		.accessibilityIdentifier("mileage-home")
		.background(.mcSheet)
		.toolbar(.hidden, for: .navigationBar)
		.refreshable {
			await mileage.sync(force: true)
			await book.load()
		}
		// Nothing to search or export for an account that isn't a Mileage owner.
		.safeAreaInset(edge: .bottom) { if book.status != .notOwner { bottomBar } }
		.overlay(alignment: .bottom) { MileageToastView(bottom: 72) }
		.sheet(isPresented: Bindable(book).showExport) {
			if let report = book.report {
				// At accessibility sizes its words fill a screen: it opens full height.
				MileageExportView(report: report) { book.showExport = false }
					.presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
			}
		}
	}

	private var bottomBar: some View {
		@Bindable var book = book
		return HStack(spacing: 10) {
			TextField("Search trips", text: $book.searchText, prompt: Text("Search trips").foregroundStyle(.mcMuted))
				.textFieldStyle(.plain)
				.submitLabel(.search)
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.focused($searching)
				// Return searches (as mail's field does): the results replace the report as a list.
				.onSubmit { book.submitSearch(openFirst: false) }
				.padding(.horizontal, 14)
				.frame(minHeight: 40)
				.foregroundStyle(.mcText)
				.background(.mcRaised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
				.accessibilityIdentifier("mileage-search")
			if searching || book.submittedSearch != nil {
				Button("Cancel") {
					searching = false
					book.cancelSearch()
				}
				.foregroundStyle(.mcAccent)
				.accessibilityIdentifier("mileage-search-cancel")
			} else if book.report != nil {
				Button("Export") { book.showExport = true }
					.fontWeight(.semibold)
					.foregroundStyle(.mcAccent)
					.accessibilityShowsLargeContentViewer()
					.accessibilityIdentifier("mileage-export-open")
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 8)
		.mcBottomBar()
	}
}

/// One trip per screen: "‹ October", "2 of 6" and Skip on top; the trip; its answers in the bar.
struct MileagePhoneTrip: View {
	let id: String
	let queue: MileageReportModel.Queue
	@Environment(MileageReportModel.self) private var book
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		Group {
			if let report = book.report, let trip = report.trip(id), !book.deleting.contains(id) {
				ScrollView {
					MileageTripView(trip: trip, report: report, phone: true)
						.padding(.bottom, 16)
				}
				.background(.mcSheet)
				.safeAreaInset(edge: .top, spacing: 0) { topBar(trip: trip) }
				.safeAreaInset(edge: .bottom, spacing: 0) { MileageAnswerBar(trip: trip, report: report) }
			} else {
				VStack(alignment: .leading, spacing: 12) {
					MileagePhoneTopBar(back: backTitle) { dismiss() }
					Text(queue == .needsYou ? "Nothing else needs you." : "This trip is gone.")
						.foregroundStyle(.mcMuted)
						.padding(.horizontal, 20)
					Spacer()
				}
				.background(.mcSheet)
			}
		}
		.toolbar(.hidden, for: .navigationBar)
		.overlay(alignment: .bottom) { MileageToastView(bottom: 96) }
	}

	private var backTitle: String {
		guard let month = book.report?.month else { return "Mileage" }
		return String(MileageTime.month(month).split(separator: " ").first ?? "Mileage")
	}

	private func topBar(trip: MileageReport.Trip) -> some View {
		MileagePhoneTopBar(back: backTitle, title: book.position(of: trip.id, in: queue).map { "\($0.index + 1) of \($0.count)" }) {
			dismiss()
		} trailing: {
			if trip.needsYou {
				Button("Skip") { book.skip(trip) }
					.foregroundStyle(.mcAccent)
					.frame(minHeight: 44)
					.accessibilityIdentifier("mileage-skip")
			}
		}
	}
}

/// A company's full list, or the spot-check list.
struct MileagePhoneList: View {
	let queue: MileageReportModel.Queue
	@Environment(MileageReportModel.self) private var book
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 14) {
				Text(title)
					.font(.largeTitle.weight(.mcTitle))
					.foregroundStyle(.mcText)
				if let report = book.report { MileageListView(queue: queue, report: report) }
			}
			.padding(.horizontal, 20)
			.padding(.bottom, 24)
		}
		.background(.mcSheet)
		.safeAreaInset(edge: .top, spacing: 0) {
			MileagePhoneTopBar(back: "Mileage") { dismiss() }
		}
		.toolbar(.hidden, for: .navigationBar)
	}

	private var title: String {
		switch queue {
		case let .company(id): book.report?.company(id)?.name ?? "Trips"
		case .spotCheck: "Spot-check"
		case .needsYou: "Needs you"
		case let .search(text): "“\(text)”"
		}
	}
}

/// Settings pushed from the report's last row.
struct MileagePhoneSettings: View {
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		MileageSettingsView()
			.safeAreaInset(edge: .top, spacing: 0) {
				MileagePhoneTopBar(back: "Mileage", title: "Settings") { dismiss() }
			}
			.toolbar(.hidden, for: .navigationBar)
	}
}

/// The top bar of a pushed Mileage screen, drawn as the thread's: L3's caret and the place you
/// came from, a title in the middle, one word on the right.
struct MileagePhoneTopBar<Trailing: View>: View {
	let back: String
	var title: String?
	let action: () -> Void
	@ViewBuilder var trailing: Trailing

	var body: some View {
		ZStack {
			if let title {
				Text(title).font(.headline).foregroundStyle(.mcText).accessibilityIdentifier("mileage-position")
			}
			HStack {
				Button(action: action) {
					HStack(spacing: 8) {
						Chevron()
							.rotationEffect(.degrees(90))
							.frame(width: 14, height: 8)
						Text(back)
					}
					.frame(minHeight: 44)
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.foregroundStyle(.mcText)
				.accessibilityLabel("Back to \(back)")
				.accessibilityIdentifier("mileage-back")
				Spacer()
				trailing
			}
		}
		.padding(.horizontal, 16)
		.mcBarText()
		.background(.mcSheet, ignoresSafeAreaEdges: .top)
	}
}

extension MileagePhoneTopBar where Trailing == EmptyView {
	init(back: String, title: String? = nil, action: @escaping () -> Void) {
		self.back = back
		self.title = title
		self.action = action
		trailing = EmptyView()
	}
}
#endif
