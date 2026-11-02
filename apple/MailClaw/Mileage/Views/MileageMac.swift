import SwiftUI

/// Mileage in L3's window (Mac, and iPad at regular width): two states, as mail. Browsing: the
/// views in the column and the report in the sheet. A question or a trip open: the column holds
/// that queue as the rail (Needs you, a company, the spot-check) and the trip fills the sheet in
/// one centred column. Never three panes.
struct MileageSheet: View {
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView {
				VStack(alignment: .leading, spacing: 18) {
					if let open = book.open, let report = book.report {
						if let trip = report.trip(open.trip), !book.deleting.contains(open.trip) {
							MileageTripView(trip: trip, report: report)
								.id(trip.id)
								.padding(.top, 20)
						} else {
							Text(open.queue == .needsYou ? "Nothing else needs you." : "This trip is gone.")
								.foregroundStyle(.mcMuted)
						}
					} else if let search = book.submittedSearch, book.search(search).isEmpty {
						Text("No trips match “\(search)” in \(MileageTime.month(book.month)).")
							.foregroundStyle(.mcMuted)
							.accessibilityIdentifier("mileage-search-empty")
					} else {
						header
						MileageHome()
					}
				}
				.frame(maxWidth: book.open == nil ? 1150 : 760, alignment: .leading)
				.padding(.horizontal, 28)
				.padding(.vertical, 24)
				.frame(maxWidth: .infinity)
				.id("top")
			}
			.onChange(of: book.open?.trip) { _, _ in proxy.scrollTo("top", anchor: .top) }
		}
		.background(.mcSheet)
		.overlay(alignment: .bottom) { MileageToastView() }
		.sheet(isPresented: Bindable(book).showExport) {
			if let report = book.report {
				MileageExportView(report: report) { book.showExport = false }
			}
		}
		.accessibilityIdentifier("mileage-sheet")
	}

	/// "October so far ▾": the title is the month switcher.
	@ViewBuilder private var header: some View {
		if book.showsMonth { MileageMonthMenu(large: true) }
	}
}

/// The rail while a trip is open: the queue you came from ("Needs you ▾ 6 left"), one row per trip
/// (the place, the time, the question or what it was filed as). The spot-check lives under Report
/// (Designer B deleted the rail's spot-check paragraph).
struct MileageRail: View {
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		let open = book.open
		let trips = open.map { book.trips(in: $0.queue) } ?? []
		ScrollViewReader { proxy in
			List {
				if let report = book.report {
					ForEach(trips) { trip in
						MileageRailRow(trip: trip, report: report, open: trip.id == open?.trip)
							.id(trip.id)
					}
				}
			}
			.listStyle(.sidebar)
			.onChange(of: open?.trip, initial: true) { _, id in
				guard let id else { return }
				Task { @MainActor in proxy.scrollTo(id) }
			}
		}
		.safeAreaInset(edge: .top, spacing: 0) { MileageRailTitle().background(.mcFrame) }
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-rail")
	}
}

/// "Needs you ▾  6 left": a menu of the queues, and back to the report.
private struct MileageRailTitle: View {
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 10) {
			Menu {
				Button("Needs you") { if let first = book.needsYou.first { book.open = .init(trip: first.id, queue: .needsYou) } }
					.disabled(book.needsYou.isEmpty)
				ForEach(book.report?.companies ?? []) { company in
					Button(company.name) {
						if let first = book.trips(in: .company(company.id)).first { book.open = .init(trip: first.id, queue: .company(company.id)) }
					}
				}
				Divider()
				Button("Back to \(MileageTime.month(book.month))") { book.open = nil }
				Divider()
				// The mail views, as mail's rail title holds them (two regions at most: L3).
				ViewsMenuItems()
			} label: {
				HStack(spacing: 6) {
					Text(title).fontWeight(.semibold).lineLimit(1)
					MileageCaret(open: true).foregroundStyle(.mcMuted)
				}
			}
			.menuStyle(.button)
			.menuIndicator(.hidden)
			.buttonStyle(.plain)
			.fixedSize()
			.accessibilityIdentifier("mileage-rail-title")
			if let count {
				Text(count).foregroundStyle(.mcMuted).monospacedDigit()
			}
			Spacer(minLength: 0)
		}
		.padding(.leading, 16)
		.padding(.trailing, 10)
		.padding(.vertical, 6)
	}

	private var title: String {
		switch book.open?.queue {
		case let .company(id): book.report?.company(id)?.name ?? "Trips"
		case .spotCheck: "Spot-check"
		case let .search(text): "“\(text)”"
		default: "Needs you"
		}
	}

	private var count: String? {
		guard let queue = book.open?.queue else { return nil }
		let number = book.trips(in: queue).count
		return queue == .needsYou ? "\(number) left" : "\(number)"
	}
}

private struct MileageRailRow: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	let open: Bool
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		Button {
			if let queue = book.open?.queue { book.open = .init(trip: trip.id, queue: queue) }
		} label: {
			// The name and time, then the question or "Filed: …"; each wraps to another line rather than
			// cut (a long place name, "Acme, reimbursa…"; ipad-r1-01).
			VStack(alignment: .leading, spacing: 1) {
				HStack(alignment: .firstTextBaseline, spacing: 6) {
					Text(MileageTripText.railName(trip))
						.fontWeight(trip.needsYou ? .semibold : .regular)
						// The Mac's sidebar list keeps a row's words to one line unless told (mac-r2-02).
						.lineLimit(nil)
						.fixedSize(horizontal: false, vertical: true)
					Spacer(minLength: 4)
					Text(trip.date == report.today ? MileageTime.clock(trip.started_at, zone: report.timezone)
						: MileageTime.day(trip.date, today: report.today))
						.font(.callout)
						.foregroundStyle(.mcFaint)
						.fixedSize()
				}
				Text(MileageTripText.railLine(trip, report: report))
					.font(.callout)
					.foregroundStyle(open ? .mcText : .mcMuted)
					.lineLimit(nil)
					.fixedSize(horizontal: false, vertical: true)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.fixedSize(horizontal: false, vertical: true)
			.padding(.vertical, 3)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.listRowBackground(MileageRailPill(shown: open))
		.help(trip.prompt ?? MileageTripText.route(trip))
		.accessibilityElement(children: .combine)
		.accessibilityValue(open ? "open" : "")
		.accessibilityAddTraits(open ? .isSelected : [])
		.accessibilityIdentifier("mileage-rail-row")
	}
}

/// The open row's pill: the sheet's colour (L3: "a tab of the sheet").
struct MileageRailPill: View {
	let shown: Bool

	var body: some View {
		if shown {
			MCCorner.control.rect.fill(.mcSheet).padding(.horizontal, 10)
		}
	}
}

/// The Mileage keys (Mac): y Yes, s Skip, 1 2 3 file as, Return files, j k move, u back.
@MainActor
struct MileageKeys {
	let book: MileageReportModel

	/// The trip the keys act on: the open one, else the report card's question.
	var trip: MileageReport.Trip? {
		if let open = book.open { return book.report?.trip(open.trip) }
		return book.next
	}

	func yes() {
		guard let trip, trip.state == .proposal else { return }
		Task { await book.file(trip, draft: .from(trip)) }
	}

	func skip() {
		guard let trip, trip.needsYou else { return }
		book.skip(trip)
	}

	func fileAs(_ index: Int) {
		guard let trip, let companies = book.report?.companies, companies.indices.contains(index) else { return }
		guard let report = book.report else { return }
		let draft = MileageAnswerLogic.choosing(companies[index].id, in: book.draft(trip), trip: trip, report: report)
		book.drafts[trip.id] = draft
		if book.missing(draft) == nil {
			Task { await book.file(trip, draft: draft) }
		} else if book.open == nil {
			book.open = .init(trip: trip.id, queue: .needsYou)
		}
	}

	func file() {
		guard let trip else { return }
		if book.open == nil {
			book.open = .init(trip: trip.id, queue: .needsYou)
			return
		}
		Task { await book.file(trip) }
	}

	func step(_ offset: Int) {
		if book.open == nil, let first = book.next {
			book.open = .init(trip: first.id, queue: .needsYou)
		} else {
			book.step(offset)
		}
	}

	func back() { book.open = nil }

	/// ⌫ on an open trip: the same 5-second "Deleted · Undo".
	func delete() {
		guard let open = book.open, let trip = book.report?.trip(open.trip) else { return }
		book.delete(trip)
	}

	var canDelete: Bool { book.open.flatMap { book.report?.trip($0.trip) } != nil }

	func export() { book.showExport = true }
}
