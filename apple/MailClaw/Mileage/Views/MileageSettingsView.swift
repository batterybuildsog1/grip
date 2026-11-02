import SwiftUI

/// Mileage's settings: recording (iPhone), the IRS rate periods, the companies and your saved places.
/// The Mac shows it in the Settings window (⌘,); the iPhone from the report's last row. Each change
/// saves at once and the report is read again. Signing out is the app's own (one sign-in); signed
/// out, or not a Mileage owner, one sentence stands in.
struct MileageSettingsView: View {
	@Environment(MileageReportModel.self) private var book
	@Environment(\.mcPalette) private var palette
	@Environment(\.dynamicTypeSize) private var typeSize
	@State private var editing: MileageReport.RatePeriod?
	@State private var addingRate = false
	@State private var addingCompany = false
	@State private var problem: String?

	var body: some View {
		if book.status == .notOwner || !book.signedIn {
			Text(book.status == .notOwner ? MileageFailure.notOwnerText : "Sign in to Grip to see Mileage.")
				.foregroundStyle(.mcMuted)
				.fixedSize(horizontal: false, vertical: true)
				.padding(24)
				.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
				.background(.mcFrame)
				.accessibilityIdentifier("mileage-settings")
		} else {
			list
		}
	}

	private var list: some View {
		MileageSettingsList {
			#if os(iOS)
			MileageRecordingSection()
			#endif
			MileageSettingsSection(title: "IRS rate",
				footer: MileageCompanyWords.rateFooter(book.report?.companies ?? [])) {
				ForEach(book.report?.rates ?? []) { period in
					Button { editing = period } label: {
						let cents = Text(MileageFormat.cents(period.cents_per_mile)).monospacedDigit().foregroundStyle(.mcText)
						// The rate beside the dates; at accessibility sizes, under them.
						Group {
							if !typeSize.isAccessibilitySize {
								HStack(alignment: .firstTextBaseline) {
									VStack(alignment: .leading, spacing: 2) {
										Text(span(period)).foregroundStyle(.mcText)
										if let source = period.source { Text(source).font(.callout).foregroundStyle(.mcMuted) }
									}
									Spacer(minLength: 8)
									cents.fixedSize()
								}
							} else {
								VStack(alignment: .leading, spacing: 2) {
									Text(span(period)).foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
									cents.fixedSize(horizontal: false, vertical: true)
									if let source = period.source {
										Text(source).font(.callout).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
									}
								}
							}
						}
						.frame(minHeight: 44)
						.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
					.accessibilityIdentifier("mileage-rate-" + period.from)
				}
				Button("Add a period") { addingRate = true }
					.buttonStyle(MileageWord())
					.accessibilityIdentifier("mileage-rate-add")
			}
			MileageSettingsSection(title: "Companies") {
				ForEach(book.report?.companies ?? []) { company in
					let counts = company.split_reimbursable ? "reimbursable or not" : company.estimates ? "IRS estimate" : "miles only"
					// Side by side while both fit; at accessibility sizes, how it counts goes under the name.
					ViewThatFits(in: .horizontal) {
						HStack {
							Text(company.name).foregroundStyle(.mcText)
							Spacer()
							Text(counts).font(.callout).foregroundStyle(.mcMuted)
						}
						VStack(alignment: .leading, spacing: 2) {
							Text(company.name).foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
							Text(counts).font(.callout).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
						}
					}
					.frame(minHeight: 36)
				}
				Button("Add a company") { addingCompany = true }
					.buttonStyle(MileageWord())
					.accessibilityIdentifier("mileage-company-add")
			}
			MileageSettingsSection(title: "Saved places") {
				if let places = book.places {
					if places.isEmpty { Text("No saved places yet. Name a place when you answer a trip.").foregroundStyle(.mcMuted) }
					ForEach(places) { place in MileagePlaceRow(place: place) }
				} else {
					Text("Loading your places…").foregroundStyle(.mcMuted)
				}
			}
			if let problem {
				Text(problem).foregroundStyle(.mcWarn).accessibilityIdentifier("mileage-settings-problem")
					.mcRows(palette)
			}
		}
		.foregroundStyle(.mcText)
		.task { await book.loadPlaces() }
		.sheet(item: $editing) { period in
			MileageRateEditor(period: period) { editing = nil }
		}
		.sheet(isPresented: $addingRate) {
			MileageRateEditor(period: nil) { addingRate = false }
		}
		.sheet(isPresented: $addingCompany) {
			MileageCompanyEditor { addingCompany = false }
		}
		.accessibilityIdentifier("mileage-settings")
	}

	private func span(_ period: MileageReport.RatePeriod) -> String {
		let from = MileageTripText.shortDay(period.from, today: "")
		guard let to = period.to else { return "From \(from)" }
		return "\(from) – \(MileageTripText.shortDay(to, today: ""))"
	}
}

/// Settings' list. iPhone and iPad: a grouped Form, each row on the theme's sheet (mcRows). Mac: a grouped
/// Form keeps AppKit's translucent grey boxes whatever the theme, so it is a scroll of sections drawn as
/// Rail's Mac Settings draws the mail tabs: --mc-frame behind, each section a box on --mc-sheet.
struct MileageSettingsList<Content: View>: View {
	@ViewBuilder var content: Content

	var body: some View {
		#if os(macOS)
		ScrollView {
			VStack(alignment: .leading, spacing: 18) { content }
				.padding(20)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.scrollContentBackground(.hidden)
		.background(.mcFrame)
		#else
		Form { content }
			.formStyle(.grouped)
			.scrollContentBackground(.hidden)
			.background(.mcFrame)
		#endif
	}
}

/// One section: a muted title, its rows on the theme's sheet with --mc-rule between them, a muted footer.
struct MileageSettingsSection<Content: View>: View {
	var title: String?
	var footer: String?
	@ViewBuilder var content: Content
	@Environment(\.mcPalette) private var palette

	var body: some View {
		#if os(macOS)
		VStack(alignment: .leading, spacing: 6) {
			if let title {
				Text(title).font(.headline).foregroundStyle(.mcMuted).padding(.leading, 4)
			}
			Group(subviews: content) { rows in
				VStack(alignment: .leading, spacing: 10) {
					ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
						if index > 0 { Rectangle().fill(.mcRule).frame(height: 1) }
						row
					}
				}
			}
			.padding(.horizontal, 14)
			.padding(.vertical, 12)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(.mcSheet, in: MCCorner.box.rect)
			if let footer {
				Text(footer).font(.callout).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
					.padding(.horizontal, 4)
			}
		}
		#else
		Section {
			content
		} header: {
			if let title { Text(title).foregroundStyle(.mcMuted) }
		} footer: {
			if let footer { Text(footer).foregroundStyle(.mcMuted) }
		}
		.mcRows(palette)
		#endif
	}
}

/// A rate period's editor: start date, cents per mile and source; Remove. Overlaps are the server's
/// to refuse, and it says why. iPhone and iPad: the words scroll and every label and value wraps, and
/// the actions are one per row as the prototype's sheet has them (Save, Remove this period, Cancel), so
/// AX5 cuts none of them (iphone-r1-01). Mac: one dialog, the actions in a row.
struct MileageRateEditor: View {
	let period: MileageReport.RatePeriod?
	let done: () -> Void
	@Environment(MileageReportModel.self) private var book
	@State private var from = ""
	@State private var cents = ""
	@State private var source = ""
	@State private var problem: String?
	@State private var saving = false

	var body: some View {
		MileageEditorSheet {
			Text(period == nil ? "Add an IRS rate period" : "IRS rate period")
				.font(.title3.weight(.semibold))
				.foregroundStyle(.mcText)
				.fixedSize(horizontal: false, vertical: true)
			field("Starts (YYYY-MM-DD)", text: $from, id: "mileage-rate-from")
			field("Cents per mile", text: $cents, id: "mileage-rate-cents")
			field("Source (the IRS notice)", text: $source, id: "mileage-rate-source")
			if let problem { Text(problem).foregroundStyle(.mcWarn).fixedSize(horizontal: false, vertical: true) }
		} actions: {
			Button("Save") { Task { await save() } }
				.buttonStyle(MileagePrimary(wide: stacksActions))
				.disabled(saving || Double(cents) == nil || from.count != 10 || source.trimmingCharacters(in: .whitespaces).isEmpty)
				.accessibilityIdentifier("mileage-rate-save")
			#if os(iOS)
			remove
			Button("Cancel") { done() }.buttonStyle(MileageChoice(wide: true))
			#else
			Button("Cancel") { done() }.buttonStyle(MileageWord(role: .muted))
			Spacer()
			remove
			#endif
		}
		.onAppear {
			from = period?.from ?? ""
			cents = period.map { String(format: $0.cents_per_mile.rounded() == $0.cents_per_mile ? "%.0f" : "%.1f", $0.cents_per_mile) } ?? ""
			source = period?.source ?? ""
		}
	}

	@ViewBuilder private var remove: some View {
		if let period {
			Button(stacksActions ? "Remove this period" : "Remove", role: .destructive) {
				Task {
					saving = true
					problem = await book.removeRate(from: period.from)
					saving = false
					if problem == nil { done() }
				}
			}
			.buttonStyle(MileageWord(role: .neg))
			.frame(maxWidth: stacksActions ? .infinity : nil)
			.accessibilityIdentifier("mileage-rate-remove")
		}
	}

	private func field(_ label: String, text: Binding<String>, id: String) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(label).font(.callout).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
			MileageTextField(placeholder: label, text: text, wraps: stacksActions, id: id)
		}
	}

	private func save() async {
		guard let value = Double(cents) else { return }
		saving = true
		defer { saving = false }
		// A new start date is a new period: the old one goes once the new one is saved.
		problem = await book.putRate(from: from, centsPerMile: value, source: source)
		if problem == nil, let period, period.from != from {
			problem = await book.removeRate(from: period.from)
		}
		if problem == nil { done() }
	}
}

/// "Add a company": its name and how it counts (an IRS estimate, or reimbursable or not), as two
/// answers in the theme (not the system's segmented greys).
struct MileageCompanyEditor: View {
	let done: () -> Void
	@Environment(MileageReportModel.self) private var book
	@State private var name = ""
	@State private var reimburses = false
	@State private var problem: String?

	var body: some View {
		MileageEditorSheet {
			Text("Add a company")
				.font(.title3.weight(.semibold))
				.foregroundStyle(.mcText)
				.fixedSize(horizontal: false, vertical: true)
			MileageTextField(placeholder: "Name", text: $name, wraps: stacksActions, id: "mileage-company-name")
			VStack(alignment: .leading, spacing: 6) {
				Text("Counts as").font(.callout).foregroundStyle(.mcMuted)
				MileageButtonRow(spacing: 8) {
					Button("IRS estimate") { reimburses = false }
						.buttonStyle(MileageChoice(chosen: !reimburses, wide: true))
					Button("Reimbursable or not") { reimburses = true }
						.buttonStyle(MileageChoice(chosen: reimburses, wide: true))
				}
			}
			if let problem { Text(problem).foregroundStyle(.mcWarn).fixedSize(horizontal: false, vertical: true) }
		} actions: {
			Button("Add") {
				Task {
					problem = await book.addCompany(name: name.trimmingCharacters(in: .whitespaces),
						treatment: reimburses ? "reimbursement" : "business")
					if problem == nil { done() }
				}
			}
			.buttonStyle(MileagePrimary(wide: stacksActions))
			.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
			.accessibilityIdentifier("mileage-company-save")
			#if os(iOS)
			Button("Cancel") { done() }.buttonStyle(MileageChoice(wide: true))
			#else
			Button("Cancel") { done() }.buttonStyle(MileageWord(role: .muted))
			#endif
		}
	}
}

#if os(iOS)
/// iPhone and iPad editors: the fields wrap and the actions stack, one per row.
private let stacksActions = true
#else
private let stacksActions = false
#endif

/// A Settings editor sheet. iPhone and iPad: the fields scroll and the actions stay pinned under them,
/// one per row, full width. Mac: one dialog, the actions in a row.
struct MileageEditorSheet<Content: View, Actions: View>: View {
	@ViewBuilder var content: Content
	@ViewBuilder var actions: Actions

	var body: some View {
		#if os(iOS)
		// The fields scroll; the actions stay pinned under them, so a short sheet (the iPad's form
		// sheet at AX3/AX5) never hides Save, Cancel or Remove below the fold.
		ScrollView {
			VStack(alignment: .leading, spacing: 14) { content }
				.padding(24)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			VStack(spacing: 10) { actions }
				.padding(.horizontal, 24)
				.padding(.vertical, 12)
				.background(.mcSheet)
				.overlay(alignment: .top) { Rectangle().fill(.mcRule).frame(height: 1) }
		}
		.background(.mcSheet)
		#else
		VStack(alignment: .leading, spacing: 14) {
			content
			HStack(spacing: 12) { actions }
		}
		.padding(24)
		.frame(minWidth: 360, alignment: .leading)
		.background(.mcSheet)
		#endif
	}
}

/// A saved place: its name (rename in place) and Remove.
struct MileagePlaceRow: View {
	let place: MileagePlace
	@Environment(MileageReportModel.self) private var book
	@State private var name = ""
	@State private var problem: String?

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack {
				TextField("Name", text: $name)
					.textFieldStyle(.plain)
					.onSubmit {
						let typed = name.trimmingCharacters(in: .whitespaces)
						guard !typed.isEmpty, typed != place.name else { return }
						Task { problem = await book.renamePlace(place.id, name: typed) }
					}
					.accessibilityIdentifier("mileage-place-" + place.id)
				Button("Remove", role: .destructive) { Task { problem = await book.removePlace(place.id) } }
					.buttonStyle(MileageWord(role: .neg))
			}
			if let problem { Text(problem).font(.callout).foregroundStyle(.mcWarn) }
		}
		.onAppear { name = place.name }
		.onChange(of: place.name) { _, value in name = value }
	}
}

/// The fix for missing location access: Grip asks iOS while it still can (`settingsOnly == false`),
/// then only iOS Settings can grant Always and Precise. Shown only on iOS (the Mac never records).
struct MileagePermissionButton: View {
	let settingsOnly: Bool
	@Environment(MileageModel.self) private var mileage
	@Environment(\.openURL) private var openURL

	var body: some View {
		#if os(iOS)
		Button(settingsOnly ? "Open Settings" : "Allow") {
			if settingsOnly {
				if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
			} else {
				mileage.allowAlways()
			}
		}
		.font(.callout)
		.buttonStyle(MileageWord())
		.accessibilityIdentifier("mileage-permission-fix")
		#endif
	}
}

#if os(iOS)
/// Recording on this iPhone: always on while signed in (owner, 2026-11-02), and what location access it has.
/// No switch: iOS Settings → Location is how to stop it.
struct MileageRecordingSection: View {
	@Environment(MileageModel.self) private var mileage
	@Environment(\.mcPalette) private var palette

	var body: some View {
		Section {
			Text(mileage.health).foregroundStyle(.mcText)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityIdentifier("mileage-recording")
			if let settingsOnly = mileage.permissionLost {
				MileagePermissionButton(settingsOnly: settingsOnly)
			}
			#if DEBUG && targetEnvironment(simulator)
			// The capture tests' hooks; review screenshots leave them out.
			if MileageModel.testMode, ProcessInfo.processInfo.environment["MILEAGE_TEST_CONTROLS"] == "1" { MileageTestControls() }
			#endif
		} header: {
			Text("Recording").foregroundStyle(.mcMuted)
		} footer: {
			Text("Always on while you're signed in. Drives are measured on this iPhone and uploaded to Grip with their route. "
				+ "To stop, turn off Location for Grip in iPhone Settings.")
				.foregroundStyle(.mcMuted)
		}
		// The sheet behind each row in the theme, not the system's grouped grey (ipad-r1-04).
		.mcRows(palette)
	}
}
#endif

#if DEBUG && targetEnvironment(simulator)
/// Test mode only (MileageCaptureTests): drive the capture by hand. The GPX replay moves the
/// simulator; these ask Core Location for a candidate and end the drive.
struct MileageTestControls: View {
	@Environment(MileageModel.self) private var mileage

	var body: some View {
		Button("Sync now") { Task { await mileage.sync(force: true) } }.accessibilityIdentifier("mileage-sync")
		Button("Check safety cases") { mileage.runDiagnostics() }.accessibilityIdentifier("mileage-diagnostics")
		Button("Start location candidate") { mileage.wake() }.accessibilityIdentifier("mileage-test-candidate")
		// Ends the drive as a gap, as an interruption does; recording stays on (there is no off).
		Button("Finish synthetic drive") { mileage.finish(reason: "gap") }.accessibilityIdentifier("mileage-test-finish")
		// Both carry the probe's words, so a drive is watched from here: going back to the month and relaunching
		// to return would restart the app mid-drive (a gap).
		Button("End drive here") { mileage.finish() }
			.accessibilityIdentifier("mileage-test-end")
			.accessibilityValue(MileageTestProbe.words(mileage))
		Button("Leave the parked circle") { mileage.deliverCircleExit() }
			.accessibilityIdentifier("mileage-test-circle-exit")
			.accessibilityValue(MileageTestProbe.words(mileage))
	}
}
#endif

/// Invisible in every build; present only in Debug test mode. Carries the capture phase and upload
/// counts the XCUITests assert, so none of them appear as words on screen.
struct MileageTestProbe: View {
	@Environment(MileageModel.self) private var mileage
	/// "recording on · phase driving · 0 pending · 0 conflicts · 2 trips · circle 45.51205,-122.63410 100 m inside · leg 412 m · woke circle"
	static func words(_ mileage: MileageModel) -> String {
		"recording \(mileage.recording ? "on" : "off") · phase \(mileage.phase) · \(mileage.pending) pending · \(mileage.conflicts) conflicts"
			+ " · \(mileage.trips.count) trips · circle \(mileage.circle) · leg \(mileage.startLegNote) · woke \(mileage.woke)"
	}

	var body: some View {
		if MileageModel.testMode {
			VStack {
				Text(Self.words(mileage))
					.accessibilityIdentifier("mileage-probe")
				if !mileage.diagnostics.isEmpty { Text(mileage.diagnostics) }
			}
			.font(.system(size: 1))
			.foregroundStyle(.clear)
			.frame(width: 2, height: 2)
			.allowsHitTesting(false)
		}
	}
}
