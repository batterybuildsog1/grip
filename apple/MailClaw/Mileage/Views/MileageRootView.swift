import SwiftUI

/// The report, or what stands in for it: the first read, a read that failed with nothing kept, or
/// (an account that isn't a Mileage owner) one quiet sentence. Mileage runs on the app's sign-in: it
/// has no form of its own.
struct MileageHome: View {
	var phone = false
	@Environment(MileageReportModel.self) private var book
	@Environment(MileageModel.self) private var mileage

	var body: some View {
		Group {
			if OfflinePilot.enabled {
				MileagePilotHome()
			} else if book.status == .notOwner {
				MileageNotOwner()
			} else if !book.signedIn && book.report == nil {
				// Signed out the window is the sign-in screen; nothing of Mileage is left to show.
				EmptyView()
			} else if let report = book.report {
				MileageReportView(report: report, phone: phone)
			} else if let failure {
				VStack(alignment: .leading, spacing: 8) {
					Text(failure).foregroundStyle(.mcWarn).fixedSize(horizontal: false, vertical: true)
					Button("Try again") { book.reload() }
						.buttonStyle(MileageWord())
						.accessibilityIdentifier("mileage-retry")
				}
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier("mileage-failed")
			} else {
				Text("Loading \(MileageTime.month(book.month))…")
					.foregroundStyle(.mcMuted)
					.accessibilityIdentifier("mileage-loading")
			}
		}
		.background(alignment: .topLeading) { MileageTestProbe() }
		.task(id: mileage.signedInEmail) {
			if book.report == nil || book.status == .idle { await book.load() }
		}
	}

	/// The first read failed and nothing is kept: why, with Try again.
	private var failure: String? {
		switch book.status {
		case let .failed(text): "Mileage didn't load: \(text)"
		case .unreadable: MileageReportView.unreadable(book.month)
		default: nil
		}
	}
}

/// Signed in as someone the server doesn't keep Mileage for (403 "not a mileage owner").
struct MileageNotOwner: View {
	var body: some View {
		Text(MileageFailure.notOwnerText)
			.foregroundStyle(.mcMuted)
			.fixedSize(horizontal: false, vertical: true)
			.accessibilityIdentifier("mileage-not-owner")
	}
}

/// The month and its switcher: "October 2026 ▾" with the months that have trips.
struct MileageMonthMenu: View {
	var large = false
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		Menu {
			ForEach(months, id: \.self) { month in
				Button(MileageTime.month(month)) { Task { await book.load(month) } }
			}
		} label: {
			HStack(alignment: .center, spacing: 8) {
				Text(title)
					.font(large ? .title.weight(.mcTitle) : .subheadline)
					.foregroundStyle(large ? .mcText : .mcMuted)
				MileageCaret(open: true).foregroundStyle(.mcMuted)
			}
		}
		.menuStyle(.button)
		.menuIndicator(.hidden)
		.buttonStyle(.plain)
		.accessibilityIdentifier("mileage-month")
	}

	/// "October so far" (this month), "September" (this year), "December 2025" (another year).
	private var title: String {
		let full = MileageTime.month(book.month)
		let today = book.report?.today ?? MileageReportModel.currentMonth()
		let name = today.hasPrefix(String(book.month.prefix(4))) ? String(full.split(separator: " ").first ?? "") : full
		return today.hasPrefix(book.month) ? name + " so far" : name
	}

	/// The months with trips, and this month (an empty month says why).
	private var months: [String] {
		var list = book.report?.months ?? []
		let now = MileageReportModel.currentMonth()
		if !list.contains(now) { list.insert(now, at: 0) }
		if !list.contains(book.month) { list.append(book.month) }
		return list.sorted(by: >)
	}
}

/// The offline pilot build (a device build with no backend): recording only; drives stay on this iPhone.
struct MileagePilotHome: View {
	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text("Drives stay on this iPhone.").foregroundStyle(.mcMuted)
			#if os(iOS)
			Form { MileageRecordingSection() }
				.scrollContentBackground(.hidden)
				.frame(minHeight: 260)
			#endif
		}
		.accessibilityIdentifier("mileage-pilot")
	}
}
