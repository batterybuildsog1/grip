import SwiftUI

/// One trip in one column (CLEAN-SPEC M2/M3): the day, time and distance; the question as the
/// title (once filed, the route); its street map; both ends; the decision; and Details behind one
/// line. The Mac and iPad sheet put the answers inline; the iPhone puts the map first and keeps the
/// answers in the bottom bar.
struct MileageTripView: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	/// iPhone and compact iPad.
	var phone = false
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if phone {
				MileageMap(trip: trip, height: 230)
			}
			VStack(alignment: .leading, spacing: 14) {
				VStack(alignment: .leading, spacing: 4) {
					Text(MileageTripText.when(trip, report: report))
						.font(phone ? .body : .callout)
						.foregroundStyle(.mcMuted)
						.accessibilityIdentifier("mileage-when")
					Text(MileageTripText.title(trip))
						.font((phone ? Font.title : .title2).weight(.mcTitle))
						.foregroundStyle(.mcText)
						.fixedSize(horizontal: false, vertical: true)
						.accessibilityAddTraits(.isHeader)
						.accessibilityIdentifier("mileage-title")
					if trip.state == .ask, let reason = MileageTripText.reason(trip) {
						Text(reason)
							.foregroundStyle(.mcMuted)
							.fixedSize(horizontal: false, vertical: true)
					}
				}
				if !phone {
					MileageMap(trip: trip, interactive: true, height: 240)
						.clipShape(MCCorner.box.rect)
				}
				if phone {
					MileageEnds(trip: trip, report: report)
				} else {
					MileageCardEnds(trip: trip, report: report)
					Rectangle().fill(.mcRule).frame(height: 1)
				}
				MileageDecision(trip: trip, report: report, phone: phone)
				MileageDetails(trip: trip, report: report, phone: phone)
			}
			.padding(.horizontal, phone ? 20 : 0)
			.padding(.top, phone ? 14 : 0)
		}
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-trip-" + trip.id)
	}
}

/// iPhone: each end as its name with the time on the right, and the street address under it.
struct MileageEnds: View {
	let trip: MileageReport.Trip
	let report: MileageReport

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			end(trip.start, at: trip.started_at, id: "start")
			end(trip.end, at: trip.ended_at, id: "end")
		}
	}

	private func end(_ end: MileageReport.Trip.End, at: Int64, id: String) -> some View {
		VStack(alignment: .leading, spacing: 2) {
			ViewThatFits(in: .horizontal) {
				HStack(alignment: .firstTextBaseline) {
					Text(MileageTripText.name(end)).font(.title3.weight(.semibold)).foregroundStyle(.mcText)
					Spacer(minLength: 8)
					Text(MileageTime.clock(at, zone: trip.timezone ?? report.timezone)).foregroundStyle(.mcMuted).monospacedDigit()
				}
				VStack(alignment: .leading, spacing: 2) {
					Text(MileageTripText.name(end)).font(.title3.weight(.semibold)).foregroundStyle(.mcText)
					Text(MileageTime.clock(at, zone: trip.timezone ?? report.timezone)).foregroundStyle(.mcMuted)
				}
			}
			let address = MileageTripText.address(end)
			if !address.isEmpty {
				Text(address).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier("mileage-end-" + id)
	}
}

/// "Details ›": closed, the one thing worth knowing (the recording gap, or where the place's name
/// came from); open, the times, both names' sources, the agent and how sure, the gap, and Delete.
/// Open or closed is remembered for the session, across j and k.
struct MileageDetails: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	var phone = false
	@Environment(MileageReportModel.self) private var book
	@Environment(\.dynamicTypeSize) private var typeSize

	var body: some View {
		@Bindable var book = book
		VStack(alignment: .leading, spacing: 0) {
			Rectangle().fill(.mcRule).frame(height: 1)
			Button { book.detailsOpen.toggle() } label: {
				// At accessibility sizes the closed line goes under "Details" rather than wrap a word a line.
				let layout = typeSize.isAccessibilitySize
					? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
					: AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
				layout {
					HStack(spacing: 6) {
						Text("Details").fontWeight(.semibold).foregroundStyle(.mcText)
						MileageCaret(open: book.detailsOpen).foregroundStyle(.mcMuted)
					}
					.fixedSize()
					closedLine
						.font(phone ? .body : .callout)
						.multilineTextAlignment(.leading)
						.fixedSize(horizontal: false, vertical: true)
					Spacer(minLength: 0)
				}
				.padding(.vertical, 12)
				.frame(minHeight: 44)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.modifier(MileageReturnKey())
			.accessibilityValue(book.detailsOpen ? "expanded" : "collapsed")
			.accessibilityIdentifier("mileage-details-toggle")
			if book.detailsOpen {
				VStack(alignment: .leading, spacing: 10) {
					ForEach(rows, id: \.0) { label, text in
						if phone {
							VStack(alignment: .leading, spacing: 2) {
								Text(label).font(.callout).foregroundStyle(.mcMuted)
								Text(text).foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
							}
						} else {
							HStack(alignment: .firstTextBaseline, spacing: 14) {
								Text(label).foregroundStyle(.mcMuted).frame(width: 100, alignment: .leading)
								Text(text).foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
								Spacer(minLength: 0)
							}
							.font(.callout)
						}
					}
					if trip.start_estimate != nil && book.signedIn {
						actionRow {
							Button("Remove estimate") { Task { await book.removeEstimate(trip) } }
								.buttonStyle(MileageWord())
								.disabled(book.saving.contains(trip.id))
								.accessibilityIdentifier("mileage-remove-estimate")
							Text("Counts the recorded miles only")
								.font(.callout)
								.foregroundStyle(.mcMuted)
								.fixedSize(horizontal: false, vertical: true)
						}
					}
					actionRow {
						Button("Delete trip", role: .destructive) { book.delete(trip) }
							.buttonStyle(MileageWord(role: .neg))
							.accessibilityIdentifier("mileage-delete")
						Text("Deletes the trip and its full route, with 5 seconds to undo")
							.font(.callout)
							.foregroundStyle(.mcMuted)
							.fixedSize(horizontal: false, vertical: true)
					}
				}
				.padding(.bottom, 14)
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier("mileage-details")
			}
			Rectangle().fill(.mcRule).frame(height: 1)
		}
	}

	/// A word button and its one line: side by side, stacked at accessibility sizes (no word broken across lines).
	private func actionRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
		let layout = typeSize.isAccessibilitySize
			? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
			: AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 14))
		return layout { content() }
	}

	@ViewBuilder private var closedLine: some View {
		if let gap = trip.gap {
			Text(MileageTripText.gapShort(gap)).foregroundStyle(.mcWarn)
		} else if let late = MileageTripText.lateStart(trip) {
			Text(late).foregroundStyle(.mcMuted)
		} else {
			Text("\(MileageTime.clock(trip.started_at, zone: zone)) – \(MileageTime.clock(trip.ended_at, zone: zone)), "
				+ "\(trip.minutes) min · \(MileageTripText.source(focusEnd))")
				.foregroundStyle(.mcMuted)
		}
	}

	private var zone: String { trip.timezone ?? report.timezone }

	/// Where the place that matters got its name: the end, or a drive back's start.
	private var focusEnd: MileageReport.Trip.End {
		trip.end.name_source == "saved" && trip.start.name_source != "saved" ? trip.start : trip.end
	}

	private var rows: [(String, String)] {
		var rows: [(String, String)] = [
			("Times", MileageTripText.timesLine(trip, report: report)),
			("Names", MileageTripText.nameLine(trip.start) + "\n" + MileageTripText.nameLine(trip.end)),
		]
		if let agent = MileageTripText.agentLine(trip) { rows.append(("The agent", agent)) }
		// The late start is the closed line unless a gap holds it: then it is said here, under the gap.
		let recording = [trip.gap.map(MileageTripText.gapLong), trip.gap == nil ? nil : MileageTripText.lateStart(trip)].compactMap { $0 }
		if !recording.isEmpty { rows.append(("Recording", recording.joined(separator: "\n"))) }
		return rows
	}
}

/// The words every client shows for a trip, from the server's fields.
enum MileageTripText {
	/// "Today · 9:30 AM · 3.2 mi"
	static func when(_ trip: MileageReport.Trip, report: MileageReport) -> String {
		"\(shortDay(trip.date, today: report.today)) · \(MileageTime.clock(trip.started_at, zone: trip.timezone ?? report.timezone))"
			+ " · \(MileageFormat.miles(trip.distance_meters)) mi"
	}

	/// "Today · 9:30 AM – 9:41 AM · 11 min · 3.2 mi"
	static func timesLine(_ trip: MileageReport.Trip, report: MileageReport) -> String {
		let zone = trip.timezone ?? report.timezone
		return "\(shortDay(trip.date, today: report.today)) · \(MileageTime.clock(trip.started_at, zone: zone)) – "
			+ "\(MileageTime.clock(trip.ended_at, zone: zone)) · \(trip.minutes) min · \(MileageFormat.miles(trip.distance_meters)) mi"
	}

	/// "Sat, Oct 24" or "Today".
	static func shortDay(_ date: String, today: String) -> String {
		if date == today { return "Today" }
		guard let day = MileageTime.parse(date) else { return date }
		return format(day, "EEE, MMM d")
	}

	/// "Oct 1", or "Jul 1, 2026" with the year.
	static func shortDate(_ date: String, year: Bool = false) -> String {
		guard let day = MileageTime.parse(date) else { return date }
		return format(day, year ? "MMM d, yyyy" : "MMM d")
	}

	private static func format(_ day: Date, _ pattern: String) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US")
		formatter.timeZone = TimeZone(identifier: "UTC")
		formatter.dateFormat = pattern
		return formatter.string(from: day)
	}

	/// The question while it needs you; once filed, where it went.
	static func title(_ trip: MileageReport.Trip) -> String {
		if trip.needsYou, let prompt = trip.prompt, !prompt.isEmpty { return prompt }
		return route(trip)
	}

	/// "Home → Acme office"
	static func route(_ trip: MileageReport.Trip) -> String { "\(name(trip.start)) → \(name(trip.end))" }

	/// An end with no name and no coordinates (the server's `name: null`).
	static let unrecorded = "Place not recorded"

	/// The server's name; an end not looked up yet says so (offline, coordinates until the next sync).
	static func name(_ end: MileageReport.Trip.End) -> String {
		guard end.name_source == "coordinates" else { return end.name ?? unrecorded }
		return end.coordinate == nil ? unrecorded : "Address pending"
	}

	/// The street address; an end not looked up yet shows its coordinates.
	static func address(_ end: MileageReport.Trip.End) -> String {
		if end.name_source == "coordinates" {
			guard let lat = end.lat, let lng = end.lng else { return "" }
			return String(format: "%.5f, %.5f", lat, lng) + " · fills in on the next sync"
		}
		return end.address.map { $0 == end.name ? "" : $0 } ?? ""
	}

	/// "Acme office: your saved place"; "Address pending: it fills in on the next sync".
	static func nameLine(_ end: MileageReport.Trip.End) -> String {
		guard end.name_source == "coordinates" else { return "\(name(end)): \(source(end))" }
		return end.coordinate == nil ? "\(unrecorded): the phone had no location for it" : "Address pending: it fills in on the next sync"
	}

	/// Where an end's name came from, in words (Details).
	static func source(_ end: MileageReport.Trip.End) -> String {
		switch end.name_source {
		case "saved": return "your saved place"
		case "trip": return "your name for this trip only"
		case "agent":
			guard let basis = end.name_basis else { return "named by the agent" }
			let detail = basis.detail ?? ""
			if basis.kind == "calendar", detail.hasPrefix("Location of your ") {
				let when = detail.dropFirst("Location of your ".count).replacingOccurrences(of: " event", with: "")
				return "named from your \(when) calendar event"
			}
			// The server's basis in its own words ("Your 9:45 AM calendar event is at this address").
			return detail.isEmpty ? "named from \(sourceName(basis.kind))" : "named by the agent: " + detail.prefix(1).lowercased() + detail.dropFirst()
		case "apple": return "name from Apple Maps"
		case "address": return "Apple's address; no name yet"
		case "coordinates": return "address pending: it fills in on the next sync"
		default: return ""
		}
	}

	/// The agent's one-line reason for its guess, its filing, or its question's hint.
	static func reason(_ trip: MileageReport.Trip) -> String? {
		(trip.reason ?? trip.proposal?.reason ?? trip.auto?.reason).flatMap { $0.isEmpty ? nil : $0 + ($0.hasSuffix(".") ? "" : ".") }
	}

	/// "From your calendar · fairly sure, so it asks you before filing"
	static func agentLine(_ trip: MileageReport.Trip) -> String? {
		let how: String
		switch trip.state {
		case .auto: how = "sure, so it filed the trip without asking"
		case .proposal: how = "fairly sure, so it asks you before filing"
		case .ask: how = "it couldn't tell, so it asks you"
		case .filed: return nil
		}
		let raw = trip.proposal?.sources ?? trip.auto?.sources ?? []
		let sources = raw.map(sourceName)
		var line = (sources.isEmpty ? "" : "From " + MileageSentence.joined(sources) + " · ") + how
		if trip.end.name_source == "agent", let kind = trip.end.name_basis?.kind, sources.contains(sourceName(kind)) {
			line += " · it named the place from the same \(kind == "calendar" ? "event" : sourceName(kind))"
		}
		if raw.contains("texts") { line += " · your texts stay on your Mac; only this reason leaves it" }
		return line
	}

	static func sourceName(_ source: String) -> String {
		switch source {
		case "texts": "your texts"
		case "calendar": "your calendar"
		case "past-trips", "past_trips": "earlier trips"
		case "saved-place", "saved_place", "place": "a saved place"
		case "apple-poi", "apple_poi", "apple": "Apple Maps"
		default: source.replacingOccurrences(of: "_", with: " ")
		}
	}

	/// "6 minutes of the drive weren't recorded"
	/// Its size is null until the route is uploaded: "Part of the drive wasn't recorded".
	static func gapShort(_ gap: MileageReport.Trip.Gap) -> String {
		guard let seconds = gap.seconds else { return "Part of the drive wasn't recorded" }
		let minutes = max(1, Int((Double(seconds) / 60).rounded()))
		return "\(minutes) minute\(minutes == 1 ? "" : "s") of the drive weren't recorded"
	}

	/// LATE-START §4: "Started recording late. Includes 0.3 mi estimated from where you parked (Apple Maps)."
	/// or "Started recording late. Miles are what was recorded."; nil when the start was recorded.
	static func lateStart(_ trip: MileageReport.Trip) -> String? {
		if let estimate = trip.start_estimate {
			return "Started recording late. Includes \(MileageFormat.miles(estimate.meters)) mi estimated from where you parked (Apple Maps)."
		}
		return trip.quality == "delayed_start" ? "Started recording late. Miles are what was recorded." : nil
	}

	static func gapLong(_ gap: MileageReport.Trip.Gap) -> String {
		let size = gap.meters.map { " (\(MileageFormat.miles($0)) mi, dashed on the whole route)" } ?? ""
		return "\(gapShort(gap))\(size). The miles follow the roads between the parts that were."
	}

	/// A rail row's first line: where the trip went ("Hardware Store"), or for a drive back to a saved place
	/// where it came from ("Home, from 100 Example Street, Springfield").
	static func railName(_ trip: MileageReport.Trip) -> String {
		if trip.end.name_source == "saved" && trip.start.name_source != "saved" {
			return "\(name(trip.end)), from \(name(trip.start))"
		}
		return name(trip.end)
	}

	/// A rail row's second line: the question in short, or what it was filed as.
	static func railLine(_ trip: MileageReport.Trip, report: MileageReport) -> String {
		// The server's short form ("Side Co or personal?", "Filed: Acme, reimbursable").
		if let short = trip.rail_prompt, !short.isEmpty { return short }
		if trip.needsYou { return trip.prompt ?? "Needs you" }
		return "Filed: " + answer(company: report.company(trip.company_id), reimbursable: trip.reimbursable)
	}

	/// "Acme, reimbursable" · "Side Co" · "Personal"
	static func answer(company: MileageReport.Company?, reimbursable: Bool?) -> String {
		guard let company else { return "no company yet" }
		guard company.split_reimbursable else { return company.name }
		switch reimbursable {
		case true: return company.name + ", reimbursable"
		case false: return company.name + ", not reimbursable"
		default: return company.name + ", reimbursable or not?"
		}
	}
}
