import SwiftUI

/// The decision on one trip (CLEAN-SPEC M2/M3). A guess: "The agent's guess: **Acme,
/// reimbursable** · purpose", its reason, Yes, file it / Change / Skip; Change opens the fields, each
/// marked as the agent's until changed, and files only with Yes or File. A question: Name it, Drive
/// back, File as and Skip; Acme then asks reimbursable or not, business a purpose. A filed trip:
/// "Filed by you: …" with Change, and every change saves at once with Undo.
struct MileageDecision: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	/// iPhone: the companies and Yes ride in the bottom bar; Change opens a sheet.
	var phone = false
	@Environment(MileageReportModel.self) private var book
	@Environment(\.mileageSheet) private var inSheet

	var body: some View {
		let draft = book.draft(trip)
		VStack(alignment: .leading, spacing: 12) {
			if trip.state == .ask {
				if let end = MileageAnswerLogic.unnamedEnd(trip) { MileageNameField(trip: trip, end: end, phone: phone) }
				if let back = book.returnTrip(of: trip) { driveBack(back) }
				if !phone && !inSheet { row("File as", note: nil) { companies(draft, skip: true) } }
				fields(draft)
				if !phone && !inSheet, MileageAnswerLogic.needsFile(trip, draft, report: report) { actions(draft) }
			} else if phone && trip.state == .proposal && !inSheet {
				MileageGuessBox(trip: trip, report: report)
			} else {
				if !inSheet { line(draft) }
				if !inSheet, let reason = MileageTripText.reason(trip), trip.state != .filed {
					Text(reason).font(.callout).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
				}
				if editing(draft) {
					if !inSheet && !phone { row("Company", note: note(\.company)) { companies(draft, skip: false) } }
					fields(draft)
				}
				if !phone && !inSheet { actions(draft) }
			}
			if let problem = book.missing(draft), draft.company != nil, editing(draft) || trip.state == .ask {
				Text(problem).font(.callout).foregroundStyle(.mcMuted).accessibilityIdentifier("mileage-missing")
			}
		}
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-decision")
	}

	/// Change was pressed, or the draft no longer matches the trip.
	private func editing(_ draft: MileageReportModel.Draft) -> Bool {
		inSheet || book.changing.contains(trip.id) || draft != .from(trip)
	}

	/// "The agent's guess: **Acme, reimbursable** · Client visit"
	private func line(_ draft: MileageReportModel.Draft) -> some View {
		let shown = trip.state == .proposal ? draft : MileageReportModel.Draft.from(trip)
		let changed = trip.state == .proposal && draft != .from(trip)
		let who: String = switch trip.state {
		case .proposal: changed ? "The agent's guess, changed by you (not filed yet)" : "The agent's guess"
		case .auto: "Filed by the agent"
		default: trip.set_by == .agent ? "Filed by the agent" : "Filed by you"
		}
		let company = report.company(shown.company)
		var answer = MileageTripText.answer(company: company, reimbursable: shown.reimbursable)
		if company?.estimates == true {
			answer += trip.estimate_usd.map { " · \(MileageFormat.usd($0)) est." } ?? " · no IRS rate set"
		}
		let purpose = company?.treatment != "personal" && !shown.purpose.isEmpty ? " · " + shown.purpose : ""
		return Text("\(Text(who + ":").foregroundStyle(.mcMuted)) \(Text(answer).fontWeight(.semibold))\(purpose)")
			.font(.title3)
			.foregroundStyle(.mcText)
			.fixedSize(horizontal: false, vertical: true)
			.accessibilityIdentifier("mileage-decision-line")
	}

	/// Reimbursable or not (Acme) and the purpose (a business trip), once a company asks for them.
	@ViewBuilder private func fields(_ draft: MileageReportModel.Draft) -> some View {
		if let company = report.company(draft.company), company.split_reimbursable {
			row(company.name, note: note(\.reimbursable)) {
				// iPhone: side by side while both fit, else stacked (iphone-r1-04: they truncated at AX3 and AX5).
				// Mac and iPad: at their own width, wrapping in a narrow sheet.
				if phone {
					MileageButtonRow(spacing: 8) { reimbursable(draft, wide: true) }
				} else {
					MileageFlow { reimbursable(draft, wide: false) }
				}
			}
		}
		if let company = report.company(draft.company), company.treatment != "personal" {
			row("Purpose", note: note(\.purpose).map { _ in "the agent's" }) {
				// iPhone: the purpose wraps as it grows rather than scroll out of sight.
				MileageTextField(placeholder: "What was it for?", text: binding(\.purpose), wraps: phone, minHeight: 40, id: "mileage-purpose")
					.onSubmit { if !phone && !inSheet { Task { await book.file(trip) } } }
					.frame(maxWidth: 460)
			}
		}
	}

	@ViewBuilder private func reimbursable(_ draft: MileageReportModel.Draft, wide: Bool) -> some View {
		Button("Reimbursable") { set(reimbursable: true) }
			.buttonStyle(MileageChoice(chosen: draft.reimbursable == true, wide: wide))
			.accessibilityIdentifier("mileage-reimbursable-yes")
		Button("Not reimbursable") { set(reimbursable: false) }
			.buttonStyle(MileageChoice(chosen: draft.reimbursable == false, wide: wide))
			.accessibilityIdentifier("mileage-reimbursable-no")
	}

	private func driveBack(_ back: MileageReport.Trip) -> some View {
		let words = "File the drive back the same way: \(MileageTripText.shortDay(back.date, today: report.today)) "
			+ "\(MileageTime.clock(back.started_at, zone: back.timezone ?? report.timezone)), \(MileageTripText.route(back)), "
			+ "\(MileageFormat.miles(back.distance_meters)) mi"
		return row(phone ? nil : "Drive back", note: nil) {
			Toggle(isOn: binding(\.alsoReturn)) {
				Text(words).foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
			}
			#if os(macOS)
			.toggleStyle(MileageCheck())
			#endif
			.tint(.mcPrimary)
			.accessibilityIdentifier("mileage-also-return")
		}
	}

	private func binding<Value>(_ path: WritableKeyPath<MileageReportModel.Draft, Value>) -> Binding<Value> {
		Binding(get: { book.draft(trip)[keyPath: path] }, set: { value in
			var draft = book.draft(trip)
			draft[keyPath: path] = value
			book.drafts[trip.id] = draft
		})
	}

	/// "the agent's guess" / "set by the agent" beside a field the agent set (L4), until you change it.
	private func note<Value: Equatable>(_ path: KeyPath<MileageReportModel.Draft, Value>) -> String? {
		guard trip.state == .proposal || trip.state == .auto else { return nil }
		return book.draft(trip)[keyPath: path] == MileageReportModel.Draft.from(trip)[keyPath: path]
			? (trip.state == .auto ? "set by the agent" : "the agent's guess") : nil
	}

	@ViewBuilder
	private func row<Content: View>(_ label: String?, note: String?, @ViewBuilder content: () -> Content) -> some View {
		if phone || label == nil {
			VStack(alignment: .leading, spacing: 6) {
				if let label {
					Text([label, note].compactMap { $0 }.joined(separator: " · ")).font(.callout).foregroundStyle(.mcMuted)
				}
				content()
			}
		} else {
			// The label beside the answers, or above them in a narrow sheet (ipad-r1-05).
			MileageLabeled {
				Text(label ?? "").foregroundStyle(.mcMuted)
				HStack(alignment: .center, spacing: 14) {
					content()
					if let note { Text(note).font(.callout).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true) }
					Spacer(minLength: 0)
				}
			}
		}
	}

	private func companies(_ draft: MileageReportModel.Draft, skip: Bool) -> some View {
		MileageFlow {
			ForEach(report.companies) { company in
				Button(company.name) { Task { await choose(company.id) } }
					.buttonStyle(MileageChoice(chosen: draft.company == company.id))
					.disabled(book.saving.contains(trip.id))
					.accessibilityIdentifier("mileage-company-" + company.id)
			}
			if skip && trip.needsYou {
				Button("Skip") { book.skip(trip) }
					.buttonStyle(MileageWord(role: .muted))
					.padding(.leading, 6)
					.accessibilityIdentifier("mileage-skip")
			}
		}
	}

	@ViewBuilder
	private func actions(_ draft: MileageReportModel.Draft) -> some View {
		MileageFlow(spacing: 10) {
			if trip.state == .proposal {
				Button(MileageAnswerLogic.isGuess(trip, draft) ? "Yes, file it" : "File") { Task { await book.file(trip) } }
					.buttonStyle(MileagePrimary())
					.disabled(book.missing(draft) != nil || book.saving.contains(trip.id))
					.accessibilityIdentifier("mileage-yes")
				if !editing(draft) {
					Button("Change") { book.changing.insert(trip.id) }
						.buttonStyle(MileageChoice())
						.accessibilityIdentifier("mileage-change")
				}
			} else if editing(draft) {
				if MileageAnswerLogic.needsFile(trip, draft, report: report) {
					Button("File") { Task { await book.file(trip) } }
						.buttonStyle(MileagePrimary())
						.disabled(book.missing(draft) != nil || book.saving.contains(trip.id))
						.accessibilityIdentifier("mileage-file")
				}
				if trip.state != .ask {
					Button("Cancel") {
						book.drafts[trip.id] = nil
						book.changing.remove(trip.id)
					}
					.buttonStyle(MileageWord(role: .muted))
				}
			} else {
				Button("Change") { book.changing.insert(trip.id) }
					.buttonStyle(MileageChoice())
					.accessibilityIdentifier("mileage-change")
			}
			if trip.needsYou && trip.state != .ask {
				Button("Skip") { book.skip(trip) }
					.buttonStyle(MileageWord(role: .muted))
					.padding(.leading, 6)
					.accessibilityIdentifier("mileage-skip")
			}
		}
	}

	private func choose(_ company: String) async {
		var draft = book.draft(trip)
		guard draft.company != company else { return }
		draft = MileageAnswerLogic.choosing(company, in: draft, trip: trip, report: report)
		book.drafts[trip.id] = draft
		// One click files when nothing else is needed (a question; a filed trip moving companies).
		// A guess changes only the guess: it files with Yes or File.
		if trip.state != .proposal, book.missing(draft) == nil { await book.file(trip, draft: draft) }
	}

	private func set(reimbursable: Bool) {
		var draft = book.draft(trip)
		draft.reimbursable = reimbursable
		book.drafts[trip.id] = draft
		if trip.state == .filed || trip.state == .auto, !inSheet, book.missing(draft) == nil {
			Task { await book.file(trip, draft: draft) }
		}
	}
}

enum MileageAnswerLogic {
	/// Choosing a company: a question's hint for that company fills its purpose and reimbursable
	/// (the agent fills what it can); another company keeps what you typed.
	static func choosing(_ company: String, in draft: MileageReportModel.Draft, trip: MileageReport.Trip,
	                     report: MileageReport) -> MileageReportModel.Draft {
		var draft = draft
		draft.company = company
		if report.company(company)?.split_reimbursable != true { draft.reimbursable = nil }
		if let hint = trip.proposal, hint.company_id == company {
			if draft.purpose.isEmpty { draft.purpose = hint.purpose ?? "" }
			if draft.reimbursable == nil { draft.reimbursable = hint.reimbursable }
		}
		return draft
	}

	/// The draft is still exactly the agent's guess: filing it is "Yes".
	static func isGuess(_ trip: MileageReport.Trip, _ draft: MileageReportModel.Draft) -> Bool {
		guard trip.state == .proposal, let proposal = trip.proposal else { return false }
		return draft.company == proposal.company_id && draft.reimbursable == proposal.reimbursable
			&& draft.purpose == (proposal.purpose ?? "")
	}

	/// A File button shows when a choice waits for more (reimbursable, purpose) or a filed trip's
	/// purpose was edited.
	static func needsFile(_ trip: MileageReport.Trip, _ draft: MileageReportModel.Draft, report: MileageReport) -> Bool {
		guard draft.company != nil else { return false }
		if trip.state == .ask { return report.company(draft.company)?.treatment != "personal" }
		return draft != MileageReportModel.Draft.from(trip)
	}

	/// The end with no name yet (Apple's address or coordinates): the answer offers to name it.
	static func unnamedEnd(_ trip: MileageReport.Trip) -> MileageEnd? {
		let unnamed = ["address", "coordinates"]
		if unnamed.contains(trip.end.name_source) { return .end }
		if unnamed.contains(trip.start.name_source) { return .start }
		return nil
	}
}

extension MileageReportModel.Draft {
	/// What the trip says now: the agent's guess, or what is filed; a question starts empty.
	static func from(_ trip: MileageReport.Trip) -> Self {
		var draft = Self()
		if trip.state == .proposal, let proposal = trip.proposal {
			draft.company = proposal.company_id
			draft.reimbursable = proposal.reimbursable
			draft.purpose = proposal.purpose ?? ""
		} else if trip.state != .ask {
			draft.company = trip.company_id
			draft.reimbursable = trip.reimbursable
			draft.purpose = trip.purpose ?? ""
		}
		return draft
	}
}

/// "Name it": what you call the place at the end that matters; "Save it as a place", on by default.
struct MileageNameField: View {
	let trip: MileageReport.Trip
	let end: MileageEnd
	var phone = false
	@Environment(MileageReportModel.self) private var book

	var body: some View {
		if phone {
			VStack(alignment: .leading, spacing: 8) {
				field
				if !book.draft(trip).name.isEmpty { save }
			}
		} else {
			// Beside its label with "Save it as a place" after it; in a narrow sheet each takes a line.
			MileageLabeled {
				Text("Name it").foregroundStyle(.mcMuted)
				HStack(spacing: 0) {
					MileageFlow(spacing: 14) {
						field.frame(minWidth: 200, idealWidth: 300, maxWidth: 340)
						save
					}
					Spacer(minLength: 0)
				}
			}
		}
	}

	private var field: some View {
		MileageTextField(placeholder: phone ? "Name this place (saved for next time)" : "What you call this place",
			text: Binding(get: { book.draft(trip).name }, set: { value in
				var draft = book.draft(trip)
				draft.name = value
				book.drafts[trip.id] = draft
			}), wraps: phone, id: "mileage-name")
	}

	/// Its words wrap inside the screen: a fixed size made it 453 pt wide at AX5 and widened the whole
	/// trip and its bars past the iPhone's edges (iphone-r2-01). The Mac's and iPad's row lays it out at
	/// its one-line width while that fits (MileageFlow).
	private var save: some View {
		Toggle(isOn: Binding(get: { book.draft(trip).saveAsPlace }, set: { value in
			var draft = book.draft(trip)
			draft.saveAsPlace = value
			book.drafts[trip.id] = draft
		})) {
			Text("Save it as a place").foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
		}
		#if os(macOS)
		.toggleStyle(MileageCheck())
		#endif
		.tint(.mcPrimary)
		.accessibilityIdentifier("mileage-save-place")
	}
}

/// The agent's guess on iPhone: one bordered block with its answer, purpose and reason.
struct MileageGuessBox: View {
	let trip: MileageReport.Trip
	let report: MileageReport

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			if let proposal = trip.proposal {
				let company = report.company(proposal.company_id)
				Text("The agent's guess").foregroundStyle(.mcMuted)
				Text([company?.name ?? proposal.company_id,
					company?.split_reimbursable == true ? (proposal.reimbursable == true ? "Reimbursable" : proposal.reimbursable == false ? "Not reimbursable" : nil)
						: company?.estimates == true ? trip.estimate_usd.map { "\(MileageFormat.usd($0)) est." } : nil]
					.compactMap { $0 }.joined(separator: " · "))
					.font(.title3.weight(.semibold))
					.foregroundStyle(.mcText)
				if let purpose = proposal.purpose, !purpose.isEmpty {
					Text(purpose).foregroundStyle(.mcText)
				}
				if let reason = proposal.reason {
					Text(reason).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
				}
			}
		}
		.padding(16)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(MCCorner.box.rect.strokeBorder(.mcBorder))
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier("mileage-guess")
	}
}

#if os(iOS)
/// The iPhone's bottom bar on a trip: Change and Yes for a guess; "File as" and the companies for a
/// question; Back and "File as Side Co" once a choice needs reimbursable or a purpose; Change once filed.
/// Each set sits in a row while its words fit and stacks before any is cut (iphone-r1-06).
struct MileageAnswerBar: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	@Environment(MileageReportModel.self) private var book
	@State private var changing = false

	var body: some View {
		let draft = book.draft(trip)
		VStack(alignment: .leading, spacing: 6) {
			if trip.state == .ask && !MileageAnswerLogic.needsFile(trip, draft, report: report) {
				Text("File as").font(.subheadline).foregroundStyle(.mcMuted)
				MileageButtonRow(spacing: 8) { companyButtons }
			} else if trip.state == .ask {
				MileageButtonRow(weights: [1, 1.6]) {
					Button("Back") {
						var draft = book.draft(trip)
						draft.company = nil
						book.drafts[trip.id] = draft
					}
					.buttonStyle(MileageChoice(wide: true))
					Button("File as \(report.company(draft.company)?.name ?? "")") { Task { await book.file(trip) } }
						.buttonStyle(MileagePrimary(wide: true))
						.disabled(book.missing(draft) != nil || book.saving.contains(trip.id))
						.accessibilityIdentifier("mileage-file")
				}
			} else {
				MileageButtonRow {
					Button("Change") { changing = true }
						.buttonStyle(MileageChoice(wide: true))
						.accessibilityIdentifier("mileage-change")
					if trip.state == .proposal {
						Button("Yes") { Task { await book.file(trip, draft: .from(trip)) } }
							.buttonStyle(MileagePrimary(wide: true))
							.disabled(book.saving.contains(trip.id))
							.accessibilityIdentifier("mileage-yes")
					}
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.mcBottomBar()
		.sheet(isPresented: $changing) {
			// Its detents are its own (MileageChangeSheet): full height at accessibility sizes.
			MileageChangeSheet(trip: trip, report: report)
		}
	}

	@ViewBuilder private var companyButtons: some View {
		ForEach(report.companies) { company in
			Button(company.name) {
				let draft = MileageAnswerLogic.choosing(company.id, in: book.draft(trip), trip: trip, report: report)
				book.drafts[trip.id] = draft
				if book.missing(draft) == nil { Task { await book.file(trip, draft: draft) } }
			}
			.buttonStyle(MileageChoice(wide: true))
			.disabled(book.saving.contains(trip.id))
			.accessibilityIdentifier("mileage-company-" + company.id)
		}
	}
}

/// Change: the company list (added companies appear), then reimbursable or a purpose when needed.
/// On a guess it only changes the guess until File.
struct MileageChangeSheet: View {
	let trip: MileageReport.Trip
	let report: MileageReport
	@Environment(MileageReportModel.self) private var book
	@Environment(\.dismiss) private var dismiss
	@Environment(\.dynamicTypeSize) private var typeSize

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 12) {
					let draft = book.draft(trip)
					ForEach(report.companies) { company in
						Button(company.name) {
							book.drafts[trip.id] = MileageAnswerLogic.choosing(company.id, in: book.draft(trip), trip: trip, report: report)
						}
						.buttonStyle(MileageChoice(chosen: draft.company == company.id, wide: true))
						.accessibilityIdentifier("mileage-change-" + company.id)
					}
					MileageDecision(trip: trip, report: report, phone: true)
						.environment(\.mileageSheet, true)
				}
				.padding(20)
			}
			.background(.mcSheet)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") {
						book.drafts[trip.id] = nil
						dismiss()
					}
				}
				ToolbarItem(placement: .confirmationAction) {
					Button("File") {
						Task { if await book.file(trip) { dismiss() } }
					}
					.disabled(book.missing(book.draft(trip)) != nil)
					.accessibilityIdentifier("mileage-change-file")
				}
			}
			.navigationTitle("Change")
			.navigationBarTitleDisplayMode(.inline)
		}
		// At accessibility sizes the options outgrow half a screen: the whole height from the start, and a drag
		// scrolls them rather than resizing the sheet, so the last one (Not reimbursable) is reachable (ipad-r1-03).
		.presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
		.presentationContentInteraction(typeSize.isAccessibilitySize ? .scrolls : .automatic)
	}
}
#endif

extension EnvironmentValues {
	/// Inside the iPhone's Change sheet: the sheet lists the companies, so the decision shows only
	/// reimbursable and the purpose.
	@Entry var mileageSheet = false
}
