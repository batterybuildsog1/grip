import SwiftUI

/// A company's full list ("All 61 trips"), by day, newest first; or the spot-check list, least
/// sure first; or the trips a search found. Each row opens the trip.
struct MileageListView: View {
	let queue: MileageReportModel.Queue
	let report: MileageReport
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		let trips = book.trips(in: queue)
		VStack(alignment: .leading, spacing: 14) {
			header(count: trips.count)
			if case .spotCheck = queue {
				ForEach(trips) { trip in
					MileageTripRow(trip: trip, report: report, queue: queue)
					Rectangle().fill(.mcRule).frame(height: 1)
				}
			} else {
				ForEach(days(trips), id: \.date) { day in
					VStack(alignment: .leading, spacing: 0) {
						// No day subtotal: every total on screen is the server's.
						Text(MileageTime.heading(day.date, today: report.today))
							.font(.subheadline.weight(.semibold))
							.foregroundStyle(.mcText)
							.padding(.vertical, 6)
						ForEach(day.trips) { trip in
							MileageTripRow(trip: trip, report: report, queue: queue)
							Rectangle().fill(.mcRule).frame(height: 1)
						}
					}
				}
			}
			if !trips.isEmpty {
				Text(endLine(trips.count))
					.font(.callout)
					.foregroundStyle(.mcFaint)
					.padding(.top, 6)
			} else {
				Text(emptyLine).foregroundStyle(.mcMuted)
			}
		}
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-list")
	}

	@ViewBuilder private func header(count: Int) -> some View {
		switch queue {
		case let .company(id):
			if let total = report.total(id) {
				Text("\(total.trips) trip\(total.trips == 1 ? "" : "s") · \(MileageFormat.miles(total.meters)) mi in \(MileageTime.month(report.month))")
					.foregroundStyle(.mcMuted)
			}
		case .spotCheck:
			Text("What the agent filed, least sure first. Nothing here needs a yes; change any that are wrong.")
				.foregroundStyle(.mcMuted)
				.fixedSize(horizontal: false, vertical: true)
		case .needsYou, .search:
			EmptyView()
		}
	}

	private func endLine(_ count: Int) -> String {
		"\(count) trip\(count == 1 ? "" : "s") in \(MileageTime.month(report.month))"
	}

	private var emptyLine: String {
		if case let .search(text) = queue { return "No trips match “\(text)” in \(MileageTime.month(report.month))." }
		return "No trips."
	}

	private func days(_ trips: [MileageReport.Trip]) -> [(date: String, trips: [MileageReport.Trip])] {
		var order: [String] = []
		var byDay: [String: [MileageReport.Trip]] = [:]
		for trip in trips {
			if byDay[trip.date] == nil { order.append(trip.date) }
			byDay[trip.date, default: []].append(trip)
		}
		return order.map { ($0, byDay[$0] ?? []) }
	}
}
