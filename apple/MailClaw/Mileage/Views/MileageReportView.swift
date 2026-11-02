import SwiftUI

/// Mileage's first screen (CLEAN-SPEC, Designer B "Two things"): the month's answer in one
/// sentence, the Report behind a one-line disclosure that still carries its figures, and the next
/// question in one card. Every figure and every word of a question is the server's (`GET /report`).
struct MileageReportView: View {
	let report: MileageReport
	/// iPhone: the Report opens as rows and the card's answers are three large buttons.
	var phone = false
	@Environment(MileageReportModel.self) private var book
	@Environment(MileageModel.self) private var mileage

	var body: some View {
		VStack(alignment: .leading, spacing: phone ? 16 : 18) {
			status
			if report.trips.isEmpty {
				empty
				// A new phone or the first day of a month: Export and Settings (recording, rates,
				// companies) are still one row away (apple-r1-04).
				MileageReportDisclosure(report: report, phone: phone)
			} else {
				MileageSentence(report: report, phone: phone)
				MileageReportDisclosure(report: report, phone: phone)
				if let next = book.next {
					MileageQuestionCard(trip: next, report: report, phone: phone)
				} else {
					MileageAllAnswered(report: report, phone: phone)
				}
			}
		}
	}

	/// Offline: the report kept on the device, with when it was read; trips this iPhone recorded
	/// that haven't reached the server yet; recording that lacks its location permission.
	@ViewBuilder private var status: some View {
		let lines = statusLines
		if !lines.isEmpty || permission != nil {
			VStack(alignment: .leading, spacing: 2) {
				// Recording is always on (owner, 2026-11-02): the one thing that can stop it is iOS's location
				// permission, so that is said here, where "No trips" is read, with its fix beside it. It stays
				// until the permission is back (a lost permission used to stop recording with nothing on screen saying why).
				if let permission {
					MileageFlow(spacing: 12) {
						Text("Recording needs location Always and Precise").font(.callout).foregroundStyle(.mcWarn)
							.fixedSize(horizontal: false, vertical: true)
							.frame(minHeight: 44)
							.accessibilityIdentifier("mileage-permission")
						MileagePermissionButton(settingsOnly: permission)
					}
				}
				ForEach(lines, id: \.self) { line in
					Text(line).font(.callout).foregroundStyle(.mcWarn).fixedSize(horizontal: false, vertical: true)
				}
				if book.status == .offline || book.status == .unreadable {
					Button("Try again") { book.reload() }
						.buttonStyle(MileageWord())
						.accessibilityIdentifier("mileage-retry")
				}
			}
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("mileage-status")
		}
	}

	/// This iPhone (or iPad) records this owner's drives and iOS hasn't given it Always and Precise location:
	/// `true` = only iOS Settings can fix it, `false` = Grip can still ask. The Mac never records.
	private var permission: Bool? {
		#if os(iOS)
		mileage.permissionLost
		#else
		nil
		#endif
	}

	private var statusLines: [String] {
		var lines: [String] = []
		let time = book.loadedAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "earlier"
		if book.status == .offline {
			lines.append("Offline · the report from \(time)")
		} else if book.status == .unreadable {
			lines.append(Self.unreadable(report.month) + " This is the report from \(time).")
		}
		#if os(iOS)
		if mileage.pending > 0 {
			lines.append("\(mileage.pending) trip\(mileage.pending == 1 ? "" : "s") recorded on this iPhone "
				+ "\(mileage.pending == 1 ? "waits" : "wait") to upload")
		}
		#endif
		return lines
	}

	/// A month the server sent that this app can't read: not offline, and Try again says so again
	/// until the app (or the server) is fixed.
	static func unreadable(_ month: String) -> String {
		let name = MileageTime.month(month).split(separator: " ").first.map(String.init) ?? month
		return "Couldn't read \(name) from Grip: this app may need an update."
	}

	/// "No trips in September. Recording started Oct 1."
	private var empty: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text("No trips in \(MileageTime.month(report.month).split(separator: " ").first.map(String.init) ?? report.month).")
				.font(.title2)
				.foregroundStyle(.mcText)
			if let started = report.recording_started, started > report.month {
				Text("Recording started \(MileageTripText.shortDate(started)).")
					.foregroundStyle(.mcMuted)
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier("mileage-empty")
	}
}

/// "You can claim **42.5** mi from Acme and **$29.75** est. for Side Co, including 3.2 mi and
/// $2.24 est. that wait for your yes." In the server's company order: a reimbursement company gives
/// its reimbursable miles, a business company its estimate; Personal is never in it.
struct MileageSentence: View {
	let report: MileageReport
	var phone = false
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		let parts = claims
		VStack(alignment: .leading, spacing: 4) {
			if parts.isEmpty {
				Text("Nothing to claim in \(monthWord) yet.")
					.font(sentenceFont)
					.foregroundStyle(.mcText)
					.accessibilityIdentifier("mileage-sentence")
			} else {
				VStack(alignment: .leading, spacing: 4) {
					Text(sentence(parts))
						.font(sentenceFont)
						.foregroundStyle(.mcText)
						.fixedSize(horizontal: false, vertical: true)
						// Without its trailing comma: the combined label joins the "including …" line with
						// its own ", " (it read "Side Co,, including").
						.accessibilityLabel(spoken(parts))
					if !waiting.isEmpty {
						Text("including \(MileageSentence.joined(waiting)) that wait for your yes.")
							.foregroundStyle(.mcMuted)
							.fixedSize(horizontal: false, vertical: true)
					}
				}
				.accessibilityElement(children: .combine)
				.accessibilityIdentifier("mileage-sentence")
				// Its own link under the sentence (CLEAN-SPEC), not folded into the sentence's label.
				if let missing = report.companies.first(where: { $0.estimates && (report.total($0.id)?.uncovered?.isEmpty == false) }) {
					Button("Set the IRS rate for \(missing.name)") { book.showSettings = true }
						.buttonStyle(MileageWord())
						.accessibilityIdentifier("mileage-set-rate")
				}
			}
		}
	}

	private var sentenceFont: Font { phone ? .title2 : .title }
	private var monthWord: String { String(MileageTime.month(report.month).split(separator: " ").first ?? "") }

	struct Claim { let figure: String; let unit: String; let words: String }

	private var claims: [Claim] {
		report.companies.compactMap { company -> Claim? in
			guard let total = report.total(company.id) else { return nil }
			if company.split_reimbursable {
				let meters = total.reimbursable_meters ?? 0
				return meters > 0 ? Claim(figure: MileageFormat.miles(meters), unit: "mi", words: "from \(company.name)") : nil
			}
			if company.estimates {
				if let usd = total.estimate_usd, usd > 0 {
					return Claim(figure: MileageFormat.usd(usd), unit: "est.", words: "for \(company.name)")
				}
				// No rate for its dates: the miles, and the link to set the rate under the sentence.
				return total.meters > 0 ? Claim(figure: MileageFormat.miles(total.meters), unit: "mi",
					words: "for \(company.name), no IRS rate set") : nil
			}
			return nil
		}
	}

	/// The agent's guesses inside those figures: "3.2 mi and $2.24 est.".
	private var waiting: [String] {
		report.companies.compactMap { company -> String? in
			guard let total = report.total(company.id) else { return nil }
			if company.split_reimbursable, let meters = total.proposed_reimbursable_meters, meters > 0 {
				return "\(MileageFormat.miles(meters)) mi"
			}
			if company.estimates, let usd = total.proposed_estimate_usd, usd > 0 { return "\(MileageFormat.usd(usd)) est." }
			return nil
		}
	}

	private func sentence(_ parts: [Claim]) -> AttributedString {
		var text = AttributedString("You can claim ")
		for (index, part) in parts.enumerated() {
			if index > 0 { text += AttributedString(index == parts.count - 1 ? " and " : ", ") }
			var figure = AttributedString(part.figure)
			figure.font = phone ? .system(.largeTitle).weight(.medium) : .system(size: 34, weight: .medium)
			text += figure
			text += AttributedString(" " + part.unit + " " + part.words)
		}
		text += AttributedString(waiting.isEmpty ? "." : ",")
		return text
	}

	private func spoken(_ parts: [Claim]) -> String {
		let text = String(sentence(parts).characters)
		return text.hasSuffix(",") ? String(text.dropLast()) : text
	}

	static func joined(_ parts: [String]) -> String {
		parts.count > 1 ? parts.dropLast().joined(separator: ", ") + " and " + parts[parts.count - 1] : parts.first ?? ""
	}
}

/// "Report ›  Acme 18.2 mi not reimbursable · Side Co 24.6 mi · Personal 12.4 mi". Opened: the
/// month as a table (Mac) or rows (iPhone), then Export, Spot-check and Settings. Closed at first, and
/// not remembered.
struct MileageReportDisclosure: View {
	let report: MileageReport
	var phone = false
	@Environment(MileageReportModel.self) private var book
	@Environment(\.dynamicTypeSize) private var typeSize
	/// The table's width: under 664 pt the notes go under their row (mac-r2-06).
	@State private var tableWidth: CGFloat = 980
	private var open: Bool { book.reportOpen }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Rectangle().fill(.mcRule).frame(height: 1)
			Button { book.reportOpen.toggle() } label: {
				// At accessibility sizes the closed line goes under "Report" rather than wrap in a sliver.
				let layout = typeSize.isAccessibilitySize
					? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
					: AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
				layout {
					HStack(spacing: 6) {
						Text("Report").fontWeight(.semibold).foregroundStyle(.mcText)
						MileageCaret(open: open).foregroundStyle(.mcMuted)
					}
					.fixedSize()
					Text(closedLine)
						.font(phone ? .body : .callout)
						.foregroundStyle(.mcMuted)
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
			.accessibilityLabel("Report: \(closedLine)")
			.accessibilityValue(open ? "expanded" : "collapsed")
			.accessibilityIdentifier("mileage-report-toggle")
			if open {
				Group {
					if phone { phoneRows } else { table }
				}
				.padding(.bottom, 14)
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier("mileage-report")
			}
			Rectangle().fill(.mcRule).frame(height: 1)
		}
	}

	/// The claimable companies first (in the server's order), then the rest (Personal).
	private var ordered: [MileageReport.Company] {
		report.companies.filter { $0.split_reimbursable || $0.estimates } + report.companies.filter { !$0.split_reimbursable && !$0.estimates }
	}

	/// A month with no trips has no figures: the Report holds only its foot.
	private var empty: Bool { report.trips.isEmpty }

	/// The figures the sentence doesn't show.
	private var closedLine: String {
		if empty { return "Export and Settings" }
		return ordered.compactMap { company -> String? in
			guard let total = report.total(company.id) else { return nil }
			if company.split_reimbursable {
				return "\(company.name) \(MileageFormat.miles(total.not_reimbursable_meters ?? 0)) mi not reimbursable"
			}
			return "\(company.name) \(MileageFormat.miles(total.meters)) mi"
		}.joined(separator: " · ")
	}

	struct Row: Identifiable {
		let id: String
		let name: String
		let trips: Int?
		let meters: Int
		let note: String
		var company: String?
		var apart = false
		var bold = false
	}

	private var rows: [Row] {
		var rows: [Row] = []
		for company in ordered {
			guard let total = report.total(company.id) else { continue }
			if company.split_reimbursable {
				rows.append(Row(id: company.id + "-yes", name: "\(company.name), reimbursable", trips: total.reimbursable_trips,
					meters: total.reimbursable_meters ?? 0, note: waiting(total.proposed_reimbursable_meters), company: company.id))
				rows.append(Row(id: company.id + "-no", name: "\(company.name), not reimbursable", trips: total.not_reimbursable_trips,
					meters: total.not_reimbursable_meters ?? 0, note: waiting(total.proposed_not_reimbursable_meters), company: company.id))
			} else if company.estimates {
				rows.append(Row(id: company.id, name: company.name, trips: total.trips, meters: total.meters,
					note: estimateNote(total), company: company.id))
			} else {
				rows.append(Row(id: company.id, name: company.name, trips: total.trips, meters: total.meters,
					note: waiting(total.proposed_meters), company: company.id))
			}
		}
		let open = report.totals.unassigned
		if open.trips > 0 {
			rows.append(Row(id: "unassigned", name: "Not answered yet", trips: open.trips, meters: open.meters,
				note: "in no total until you answer", apart: true))
		}
		return rows
	}

	private func waiting(_ meters: Int?) -> String {
		guard let meters, meters > 0 else { return "" }
		return "includes \(MileageFormat.miles(meters)) mi waiting for your yes"
	}

	/// "$29.75 est. at 72.5¢/mi, the IRS rate from Jan 1, 2026; includes 3.2 mi ($2.24 est.) waiting for your yes"
	private func estimateNote(_ total: MileageReport.CompanyTotal) -> String {
		var parts: [String] = []
		let used = total.rates_used ?? []
		if let usd = total.estimate_usd {
			if used.count == 1 {
				parts.append("\(MileageFormat.usd(usd)) est. at \(MileageFormat.cents(used[0].cents_per_mile)), the IRS rate from \(MileageTripText.shortDate(used[0].from, year: true))")
			} else {
				parts.append("\(MileageFormat.usd(usd)) est. at each trip's IRS rate")
			}
		}
		if let gap = total.uncovered?.first {
			parts.append("no IRS rate set for \(MileageTripText.shortDate(gap.from)) – \(MileageTripText.shortDate(gap.to))")
		}
		if total.proposed_meters > 0 {
			let money = total.proposed_estimate_usd.map { " (\(MileageFormat.usd($0)) est.)" } ?? ""
			parts.append("includes \(MileageFormat.miles(total.proposed_meters)) mi\(money) waiting for your yes")
		}
		return parts.joined(separator: "; ")
	}

	// MARK: Mac and iPad: a table, then Export, Spot-check and Settings

	@ViewBuilder private var table: some View {
		if empty { foot } else { figures }
	}

	/// The notes keep a column of their own only while it is at least 220 pt wide; otherwise each note
	/// runs under its row, so no note or figure ("$29.75") breaks a few characters a line (mac-r2-06).
	private var notesBeside: Bool { tableWidth >= nameWidth + 156 + 28 + 220 }
	/// The company column: 260 pt, narrower only when the table is.
	private var nameWidth: CGFloat { min(260, max(120, tableWidth - 156)) }

	private var figures: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: 0) {
				Spacer().frame(width: nameWidth)
				Text("Trips").frame(width: 60, alignment: .trailing)
				Text("Miles").frame(width: 96, alignment: .trailing)
				Spacer()
			}
			.font(.callout)
			.foregroundStyle(.mcMuted)
			.padding(.bottom, 6)
			ForEach(rows) { row in
				Rectangle().fill(.mcRule).frame(height: 1)
				tableRow(row)
			}
			Rectangle().fill(.mcControl).frame(height: 1)
			tableRow(Row(id: "all", name: "All trips", trips: report.totals.trips, meters: report.totals.all_meters, note: "", bold: true))
			foot.padding(.top, 14)
		}
		.frame(maxWidth: 980, alignment: .leading)
		.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { tableWidth = $0 }
	}

	private func tableRow(_ row: Row) -> some View {
		let note = Text(row.note)
			.font(.callout)
			.foregroundStyle(.mcMuted)
			.fixedSize(horizontal: false, vertical: true)
		return VStack(alignment: .leading, spacing: 2) {
			HStack(alignment: .firstTextBaseline, spacing: 0) {
				figuresRow(row)
				if notesBeside { note.padding(.leading, 28) }
				Spacer(minLength: 0)
			}
			if !notesBeside, !row.note.isEmpty { note }
		}
		.foregroundStyle(row.apart ? .mcMuted : .mcText)
		.padding(.vertical, 8)
		// A container, not one combined element: the company's name stays its own link (VoiceOver opens it).
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-report-row-" + row.id)
	}

	/// The name (the company's link), trips and miles.
	@ViewBuilder private func figuresRow(_ row: Row) -> some View {
		Group {
			if let company = row.company {
				Button(row.name) { openCompany(company) }
					.buttonStyle(.plain)
					.modifier(MileageReturnKey())
					.underline()
					.accessibilityIdentifier("mileage-report-company-" + row.id)
			} else {
				Text(row.name).foregroundStyle(row.apart ? .mcMuted : .mcText)
			}
		}
		.fontWeight(row.bold ? .semibold : .regular)
		.frame(width: nameWidth, alignment: .leading)
		Text(row.trips.map(String.init) ?? "").monospacedDigit().frame(width: 60, alignment: .trailing)
		Text("\(MileageFormat.miles(row.meters)) mi").monospacedDigit().fixedSize().frame(width: 96, alignment: .trailing)
			.fontWeight(row.bold ? .semibold : .regular)
	}

	/// Export, Spot-check and Settings: in a row with Settings at the end, or wrapping in a narrow sheet.
	@ViewBuilder private var foot: some View {
		if notesBeside {
			HStack(alignment: .firstTextBaseline, spacing: 14) { footWords(spaced: true) }
		} else {
			MileageFlow(spacing: 14) { footWords(spaced: false) }
		}
	}

	@ViewBuilder private func footWords(spaced: Bool) -> some View {
		Button("Export \(monthWord)") { book.showExport = true }
			.buttonStyle(MileageChoice())
			.accessibilityIdentifier("mileage-report-export")
		if report.totals.agent_filed > 0 {
			Button("Spot-check the \(report.totals.agent_filed) trips the agent filed") { book.openSpotCheck(asList: phone) }
				.buttonStyle(MileageWord())
				.underline()
				.accessibilityIdentifier("mileage-spot-check")
			Text("least sure first, nothing to approve").font(.callout).foregroundStyle(.mcMuted)
		}
		if spaced { Spacer() }
		Button("Settings") { book.showSettings = true }
			.buttonStyle(MileageWord())
			.underline()
			.accessibilityIdentifier("mileage-report-settings")
	}

	private var monthWord: String { String(MileageTime.month(report.month).split(separator: " ").first ?? "") }

	private func openCompany(_ id: String) {
		if phone {
			book.list = .company(id)
		} else if let first = book.trips(in: .company(id)).first {
			book.open = .init(trip: first.id, queue: .company(id))
		}
	}

	// MARK: iPhone: rows in a box, then Spot-check, Export and Settings

	private var phoneRows: some View {
		VStack(alignment: .leading, spacing: 12) {
			if !empty {
				box {
					ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
						if index > 0 { Rectangle().fill(.mcRule).frame(height: 1) }
						phoneRow(title: row.name, figure: "\(MileageFormat.miles(row.meters)) mi",
							detail: ([row.trips.map { "\($0) trip\($0 == 1 ? "" : "s")" }, row.note.isEmpty ? nil : row.note].compactMap { $0 })
								.joined(separator: " · "),
							muted: row.apart, id: "mileage-report-company-" + row.id, action: row.company.map { company in { openCompany(company) } })
					}
				}
				Text("All \(report.totals.trips) trips · \(MileageFormat.miles(report.totals.all_meters)) mi")
					.foregroundStyle(.mcMuted)
					.padding(.leading, 4)
			}
			box {
				if report.totals.agent_filed > 0 {
					phoneRow(title: "Spot-check what the agent filed", figure: "\(report.totals.agent_filed)",
						detail: "Least sure first. Nothing there needs a yes.", id: "mileage-spot-check") { book.openSpotCheck(asList: phone) }
					Rectangle().fill(.mcRule).frame(height: 1)
				}
				phoneRow(title: "Export \(monthWord)", figure: "", detail: "Without the agent's guesses unless you include them",
					id: "mileage-report-export") { book.showExport = true }
				Rectangle().fill(.mcRule).frame(height: 1)
				phoneRow(title: "Settings", figure: "", detail: "Rates, companies, places, recording",
					id: "mileage-report-settings") { book.showSettings = true }
			}
		}
	}

	private func box<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: 0) { content() }
			.overlay(MCCorner.box.rect.strokeBorder(.mcBorder))
	}

	private func phoneRow(title: String, figure: String, detail: String, muted: Bool = false, id: String,
	                      action: (() -> Void)?) -> some View {
		let content = HStack(alignment: .firstTextBaseline, spacing: 10) {
			VStack(alignment: .leading, spacing: 3) {
				Text(title).font(.headline.weight(muted ? .regular : .semibold)).foregroundStyle(muted ? .mcMuted : .mcText)
				if !detail.isEmpty { Text(detail).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true) }
			}
			Spacer(minLength: 8)
			if !figure.isEmpty { Text(figure).monospacedDigit().foregroundStyle(.mcMuted) }
			if action != nil { MileageCaret().foregroundStyle(.mcMuted) }
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 44)
		.contentShape(Rectangle())
		return Group {
			if let action {
				Button(action: action) { content }.buttonStyle(.plain).modifier(MileageReturnKey())
			} else {
				content
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier(id)
	}
}

/// The question card: "Needs you 1 of 6 · 48.0 mi in no total until you answer", its street map, the
/// day and distance, both ends, the question and its reason, and the answers.
struct MileageQuestionCard: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	var phone = false
	@Environment(MileageReportModel.self) private var book
	@Environment(\.dynamicTypeSize) private var typeSize

	var body: some View {
		let queue = book.needsYou
		VStack(alignment: .leading, spacing: 0) {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text("Needs you").font(.headline).foregroundStyle(.mcText)
				Text("\((queue.firstIndex(of: trip) ?? 0) + 1) of \(queue.count)"
					+ (!phone && report.totals.unassigned.meters > 0
						? " · \(MileageFormat.miles(report.totals.unassigned.meters)) mi in no total until you answer" : ""))
					.foregroundStyle(phone ? .mcMuted : .mcText)
					.font(phone ? .body : .callout)
				Spacer(minLength: 8)
				Button(phone ? "See all" : "Go through all \(queue.count)") { book.open = .init(trip: trip.id, queue: .needsYou) }
					.buttonStyle(MileageWord())
					.underline()
					.accessibilityIdentifier("mileage-see-all")
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 4)
			MileageMap(trip: trip, height: phone ? 170 : 260)
			VStack(alignment: .leading, spacing: 8) {
				Text("\(MileageTripText.shortDay(trip.date, today: report.today)) · \(MileageFormat.miles(trip.distance_meters)) mi")
					.font(phone ? .body : .callout)
					.foregroundStyle(.mcMuted)
				MileageCardEnds(trip: trip, report: report, phone: phone)
				Button { book.open = .init(trip: trip.id, queue: .needsYou) } label: {
					Text(trip.prompt ?? MileageTripText.route(trip))
						.font(.title3.weight(.semibold))
						.foregroundStyle(.mcText)
						.multilineTextAlignment(.leading)
						.fixedSize(horizontal: false, vertical: true)
				}
				.buttonStyle(.plain)
				.modifier(MileageReturnKey())
				.accessibilityIdentifier("mileage-question")
				if !phone, let reason = MileageTripText.reason(trip) {
					Text(reason).font(.callout).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
				}
				answers.padding(.top, 4)
			}
			.padding(16)
		}
		.background(.mcSheet, in: MCCorner.box.rect)
		.clipShape(MCCorner.box.rect)
		.overlay(MCCorner.box.rect.strokeBorder(.mcBorder))
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-card")
	}

	/// One click: a company files the question when nothing else is needed; otherwise the trip opens
	/// on its answer, the company chosen. A guess: Yes, file it / Change / Skip.
	@ViewBuilder private var answers: some View {
		if trip.state == .proposal {
			MileageFlow(spacing: 10) {
				Button(phone ? "Yes" : "Yes, file it") { Task { await book.file(trip, draft: .from(trip)) } }
					.buttonStyle(MileagePrimary(wide: phone))
					.disabled(book.saving.contains(trip.id))
					.accessibilityIdentifier("mileage-card-yes")
				Button("Change") {
					book.changing.insert(trip.id)
					book.open = .init(trip: trip.id, queue: .needsYou)
				}
				.buttonStyle(MileageChoice(wide: phone))
				.accessibilityIdentifier("mileage-card-change")
				if !phone { skip }
			}
		} else if typeSize.isAccessibilitySize {
			VStack(alignment: .leading, spacing: 8) { companyButtons }
		} else if phone {
			HStack(spacing: 8) { companyButtons }
		} else {
			// Mac and iPad: each answer at its own width, wrapping to another line in a narrow sheet rather
			// than breaking a word mid-name (on the iPad mini).
			MileageFlow(spacing: 8) {
				Text("File as").foregroundStyle(.mcMuted)
				companyButtons
				skip
			}
		}
	}

	private var skip: some View {
		Button("Skip") { book.skip(trip) }
			.buttonStyle(MileageWord(role: .muted))
			.padding(.leading, 6)
			.accessibilityIdentifier("mileage-card-skip")
	}

	private var companyButtons: some View {
		ForEach(report.companies) { company in
			Button(company.name) {
				let draft = MileageAnswerLogic.choosing(company.id, in: book.draft(trip), trip: trip, report: report)
				book.drafts[trip.id] = draft
				if book.missing(draft) == nil {
					Task { await book.file(trip, draft: draft) }
				} else {
					// Reimbursable or a purpose: the trip opens on its answer, the company chosen.
					book.open = .init(trip: trip.id, queue: .needsYou)
				}
			}
			.buttonStyle(MileageChoice(wide: phone))
			.disabled(book.saving.contains(trip.id))
			.accessibilityIdentifier("mileage-card-company-" + company.id)
		}
	}
}

/// "1:05 PM  Client office · 100 Example Street, Springfield": time, name, address.
struct MileageCardEnds: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	var phone = false
	@Environment(\.dynamicTypeSize) private var typeSize

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			line(trip.start, at: trip.started_at, id: "start")
			line(trip.end, at: trip.ended_at, id: "end")
		}
	}

	private func line(_ end: MileageReport.Trip.End, at: Int64, id: String) -> some View {
		let time = MileageTime.clock(at, zone: trip.timezone ?? report.timezone)
		let address = MileageTripText.address(end)
		let name = Text(end.name ?? MileageTripText.unrecorded).fontWeight(.semibold).foregroundStyle(.mcText)
		let rest = Text(address.isEmpty ? "" : " · " + address).foregroundStyle(.mcMuted)
		return Group {
			if typeSize.isAccessibilitySize {
				VStack(alignment: .leading, spacing: 2) {
					Text(time).foregroundStyle(.mcMuted)
					Text("\(name)\(rest)")
				}
			} else {
				HStack(alignment: .firstTextBaseline, spacing: 12) {
					Text(time)
						.foregroundStyle(.mcMuted)
						.monospacedDigit()
						.lineLimit(1)
						.fixedSize()
						.frame(minWidth: phone ? 82 : 72, alignment: .leading)
					Text("\(name)\(rest)").fixedSize(horizontal: false, vertical: true)
				}
			}
		}
		.font(phone ? .body : .callout)
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier("mileage-card-end-" + id)
	}
}

/// The card once the queue is empty: "Nothing. Every October trip is filed." and the spot-check.
struct MileageAllAnswered: View {
	let report: MileageReport
	var phone = false
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text("Needs you").font(.headline).foregroundStyle(.mcText)
				Text("Nothing. Every \(String(MileageTime.month(report.month).split(separator: " ").first ?? "")) trip is filed.")
					.foregroundStyle(.mcMuted)
			}
			if report.totals.agent_filed > 0 {
				Button("Spot-check the \(report.totals.agent_filed) the agent filed") { book.openSpotCheck(asList: phone) }
					.buttonStyle(MileageWord())
			}
		}
		.padding(16)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(MCCorner.box.rect.strokeBorder(.mcBorder))
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-all-answered")
	}
}

/// One trip as a row (a company's list, the spot-check, search on iPhone): the route and miles, then
/// the time and what it was filed as or that it needs you.
struct MileageTripRow: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	let queue: MileageReportModel.Queue
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		Button { book.open = .init(trip: trip.id, queue: queue) } label: {
			VStack(alignment: .leading, spacing: 2) {
				HStack(alignment: .firstTextBaseline) {
					Text(MileageTripText.route(trip)).foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
					Spacer(minLength: 8)
					Text("\(MileageFormat.miles(trip.distance_meters)) mi").monospacedDigit().foregroundStyle(.mcText)
				}
				Text([MileageTime.clock(trip.started_at, zone: trip.timezone ?? report.timezone),
					MileageTripText.railLine(trip, report: report),
					(trip.purpose ?? "").isEmpty || trip.needsYou ? nil : trip.purpose]
					.compactMap { $0 }.joined(separator: " · "))
					.font(.callout)
					.foregroundStyle(.mcMuted)
					.fixedSize(horizontal: false, vertical: true)
			}
			.padding(.vertical, 9)
			.frame(minHeight: 44)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.modifier(MileageReturnKey())
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier("mileage-row-" + trip.id)
	}
}
