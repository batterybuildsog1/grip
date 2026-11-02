import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// Export the month (V3 L1): the server writes the whole month's log, every company in it, as the
/// web and the prototype do (no log picker: a company the server can't log alone, like an added one,
/// would fail; mac-r1-03). The agent's guesses are left out unless you tick the box, and the dialog
/// says how much that is. iPhone and iPad: the share sheet; Mac: a save panel.
struct MileageExportView: View {
	let report: MileageReport
	let done: () -> Void
	@Environment(MileageReportModel.self) private var book
	@State private var guesses = false
	@State private var working = false
	@State private var problem: String?
	@State private var file: ExportFile?
	#if os(iOS)
	@State private var sharing: SharedFile?
	#else
	@State private var saving = false
	#endif

	var body: some View {
		sheet
			.background(.mcSheet)
			// A container, so the figures, the box and Export keep their own identifiers (apple-r1-02).
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("mileage-export")
			#if os(iOS)
			.sheet(item: $sharing) { shared in
				MileageShareSheet(url: shared.url).ignoresSafeArea()
			}
			#else
			.fileExporter(isPresented: $saving, document: file, contentType: .commaSeparatedText,
				defaultFilename: file?.name ?? "mileage.csv") { result in
				if case .success = result { done() }
			}
			#endif
	}

	/// iPhone and iPad: the words scroll (Dynamic Type to AX5 makes them taller than the sheet) and
	/// Export and Cancel stay pinned under them, one per row, so neither is ever off the sheet
	/// (iphone-r1-08). Mac: one dialog, the actions in a row.
	@ViewBuilder private var sheet: some View {
		#if os(iOS)
		ScrollView {
			details
				.padding(.horizontal, 20)
				.padding(.top, 24)
				.padding(.bottom, 12)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			VStack(spacing: 10) {
				exportButton.buttonStyle(MileagePrimary(wide: true))
				Button("Cancel") { done() }.buttonStyle(MileageChoice(wide: true))
			}
			.padding(.horizontal, 20)
			.padding(.vertical, 12)
			.background(.mcSheet)
			.overlay(alignment: .top) { Rectangle().fill(.mcRule).frame(height: 1) }
		}
		#else
		VStack(alignment: .leading, spacing: 16) {
			details
			HStack(spacing: 12) {
				exportButton.buttonStyle(MileagePrimary())
				Button("Cancel") { done() }.buttonStyle(MileageWord(role: .muted))
			}
		}
		.padding(24)
		.frame(minWidth: 380, alignment: .leading)
		#endif
	}

	/// The month, the figures the file will hold, the box and what it adds.
	private var details: some View {
		VStack(alignment: .leading, spacing: 16) {
			Text("Export \(MileageTime.month(report.month))")
				.font(.title3.weight(.semibold))
				.foregroundStyle(.mcText)
				.fixedSize(horizontal: false, vertical: true)
			Text("Every trip: the IRS log")
				.font(.callout)
				.foregroundStyle(.mcMuted)
				.fixedSize(horizontal: false, vertical: true)
			// The figures it will hold: without the guesses, the report's `confirmed`; with them, its totals.
			Text(figures)
				.foregroundStyle(.mcText)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityIdentifier("mileage-export-figures")
			Toggle(isOn: $guesses) {
				Text("Include the agent's guesses").foregroundStyle(.mcText).fixedSize(horizontal: false, vertical: true)
			}
			.tint(.mcPrimary)
			#if os(macOS)
			.toggleStyle(MileageCheck())
			#endif
			.accessibilityIdentifier("mileage-export-guesses")
			Text(guessWords)
				.font(.callout)
				.foregroundStyle(.mcMuted)
				.fixedSize(horizontal: false, vertical: true)
			if let problem {
				Text(problem)
					.foregroundStyle(.mcWarn)
					.fixedSize(horizontal: false, vertical: true)
					.accessibilityIdentifier("mileage-export-problem")
			}
		}
	}

	private var exportButton: some View {
		Button(working ? "Exporting…" : "Export") { Task { await export() } }
			.disabled(working)
			.accessibilityIdentifier("mileage-export-go")
	}

	/// "Acme 31.0 mi reimbursable · Side Co 24.6 mi, $17.22 est. · Personal 12.4 mi" (default, the
	/// report's `confirmed`), or the report's totals with the guesses included: every company the
	/// report has, added ones too. Then what the export leaves out, in the server's words and counts.
	private var figures: String {
		let shown = report.companies.filter { $0.split_reimbursable || $0.estimates } + report.companies.filter { !$0.split_reimbursable && !$0.estimates }
		var lines: [String] = [shown.compactMap { company -> String? in
			guard let total = report.total(company.id) else { return nil }
			let confirmed = guesses ? nil : total.confirmed
			if company.split_reimbursable {
				let meters = confirmed?.reimbursable_meters ?? total.reimbursable_meters ?? 0
				return "\(company.name) \(MileageFormat.miles(meters)) mi reimbursable"
			}
			let miles = MileageFormat.miles(confirmed?.meters ?? total.meters)
			if company.estimates {
				let usd = guesses ? total.estimate_usd : (confirmed?.estimate_usd ?? total.estimate_usd)
				return "\(company.name) \(miles) mi" + (usd.map { ", \(MileageFormat.usd($0)) est." } ?? ", no IRS rate set")
			}
			return "\(company.name) \(miles) mi"
		}.joined(separator: " · ")]
		for company in shown {
			for part in report.total(company.id)?.confirmed?.left_out ?? [] where part.trips > 0 {
				lines.append("\(company.name): \(part.trips) trip\(part.trips == 1 ? "" : "s") left out: \(Self.reason(part.reason))")
			}
		}
		return lines.joined(separator: "\n")
	}

	static func reason(_ code: String) -> String {
		switch code {
		case "recording_gap": "part of the drive wasn't recorded"
		case "no_endpoints": "no start or end recorded"
		case "unconfirmed": "not confirmed yet"
		default: code.replacingOccurrences(of: "_", with: " ")
		}
	}

	/// What the box adds, per company, from the server's totals.
	private var guessWords: String {
		let parts = report.companies.compactMap { company -> String? in
			guard let total = report.total(company.id), total.proposed_meters > 0 else { return nil }
			let money = total.proposed_estimate_usd.map { ", \(MileageFormat.usd($0)) est." } ?? ""
			return "\(company.name) \(MileageFormat.miles(total.proposed_meters)) mi\(money)"
		}
		if parts.isEmpty { return "No guesses wait for your yes this month." }
		return (guesses ? "Included, listed apart: " : "Left out, listed apart: ") + parts.joined(separator: "; ")
	}

	private func export() async {
		working = true
		problem = nil
		defer { working = false }
		do {
			let (data, name) = try await book.export(type: "irs", includeGuesses: guesses)
			file = ExportFile(data: data, name: name)
			#if os(iOS)
			let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
			try data.write(to: url, options: .atomic)
			sharing = SharedFile(url: url)
			#else
			saving = true
			#endif
		} catch {
			problem = "Couldn't export: \(MileageReportModel.plain(error))"
		}
	}
}

/// The exported file, for the Mac's save panel.
struct ExportFile: FileDocument {
	static let readableContentTypes: [UTType] = [.commaSeparatedText]
	let data: Data
	let name: String
	init(data: Data, name: String) { self.data = data; self.name = name }
	init(configuration: ReadConfiguration) throws {
		data = configuration.file.regularFileContents ?? Data()
		name = configuration.file.filename ?? "mileage.csv"
	}
	func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

#if os(iOS)
struct SharedFile: Identifiable {
	let url: URL
	var id: String { url.absoluteString }
}

/// The system share sheet for the exported file.
struct MileageShareSheet: UIViewControllerRepresentable {
	let url: URL
	func makeUIViewController(context: Context) -> UIActivityViewController {
		UIActivityViewController(activityItems: [url], applicationActivities: nil)
	}
	func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif
