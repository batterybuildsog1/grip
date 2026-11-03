import MailClawKit
import SwiftUI

/// Needs you on iPhone and the Mac (design r2 §4 S1; L3): one bordered line at the top of Personal
/// that opens in place. Collapsed every launch. States: collapsed, open, error (WD-13: a failed load never reads
/// as nothing to do), empty. Open shows the five most pressing jobs, then "Show all N", so the mail
/// still starts on the first screen (design-taste WM7, Needs you A). Done is a word in ink, a 44 pt
/// target named after its task (WP-03).
/// Text sizes (iPhone walkthrough 2026-11-02, P1-3): no word is ever squeezed narrower than itself. A
/// line of short words is one row when it fits by measure, else one under another; where words wrap
/// by design (the error, a job's note), Try again and Done go under them at accessibility sizes.
struct NeedsYouLineView: View {
	@Environment(AppModel.self) private var model
	@Environment(\.mcPalette) private var palette
	@Environment(\.dynamicTypeSize) private var typeSize
	@Binding var open: Bool
	/// "Show all N" tapped; Hide folds back to five.
	@State private var showsAll = false
	/// Jobs shown in place before "Show all N" (the web's cap too).
	static let cap = 5

	var body: some View {
		let jobs = model.jobs
		let failed = jobs.isEmpty && model.notesFailed
		VStack(alignment: .leading, spacing: 0) {
			if failed {
				let layout = typeSize.isAccessibilitySize
					? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
					: AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
				layout {
					VStack(alignment: .leading, spacing: 2) {
						title
						Text("Couldn't load, so this isn't a clear list")
							.fontWeight(.semibold)
							.foregroundStyle(.mcWarn)
					}
					.accessibilityElement(children: .combine)
					.accessibilityIdentifier("needs-you-error")
					if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
					Button("Try again") { model.retryNotes() }
						.buttonStyle(MCLinkButtonStyle())
						.fontWeight(.medium)
				}
				.padding(.horizontal, 14)
				.padding(.vertical, 12)
			} else if jobs.isEmpty {
				ViewThatFits(in: .horizontal) {
					HStack(spacing: 10) {
						title
						nothing
						Spacer(minLength: 0)
					}
					VStack(alignment: .leading, spacing: 2) {
						title
						nothing
					}
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.vertical, 10)
				}
				.frame(minHeight: 48)
				.padding(.horizontal, 14)
				.accessibilityElement(children: .combine)
				.accessibilityIdentifier("needs-you-empty")
			} else {
				let urgent = jobs.filter(\.urgent).count
				Button {
					withAnimation(.snappy) {
						open.toggle()
						showsAll = false
					}
				} label: {
					// Chosen by text size, not ViewThatFits: inside this List row's button, ViewThatFits
					// left a ~39 pt blank band above the box at AX5 when it opened (UX walkthrough review).
					Group {
						if typeSize.isAccessibilitySize {
							// Accessibility sizes: one under another, so no word breaks mid-word.
							VStack(alignment: .leading, spacing: 4) {
								title
								counts(jobs.count, urgent: urgent)
								showOrHide
							}
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding(.vertical, 10)
						} else {
							HStack(alignment: .firstTextBaseline, spacing: 8) {
								title
								Text("\(jobs.count)").foregroundStyle(.mcMuted)
								if urgent > 0 {
									Text("·").foregroundStyle(.mcFaint)
									Text("\(urgent) urgent").foregroundStyle(.mcNeg)
								}
								Spacer(minLength: 8)
								showOrHide
							}
						}
					}
					.frame(minHeight: 48)
					.padding(.horizontal, 14)
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityIdentifier("needs-you")
				if open {
					let shown = showsAll ? jobs : Array(jobs.prefix(Self.cap))
					Rectangle().fill(.mcRule).frame(height: 1)
					ForEach(shown) { job in
						JobRow(job: job)
						if job.id != jobs.last?.id { Rectangle().fill(.mcRule).frame(height: 1).padding(.leading, 14) }
					}
					if shown.count < jobs.count {
						Button {
							withAnimation(.snappy) { showsAll = true }
						} label: {
							Text("Show all \(jobs.count)")
								.fontWeight(.semibold)
								.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
								.padding(.horizontal, 14)
								.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
						.accessibilityIdentifier("needs-you-show-all")
					}
				}
			}
		}
		.foregroundStyle(.mcText)
		.background(MCCorner.box.rect.fill(failed ? MCColor.mcWarnSoft : .mcSheet))
		.overlay(MCCorner.box.rect.strokeBorder(failed ? palette[.warn].opacity(0.45) : palette[.border], lineWidth: 1))
		.clipShape(MCCorner.box.rect)
	}

	private var title: some View {
		Text("Needs you").fontWeight(.semibold)
	}

	private var nothing: some View {
		Text("Nothing right now").foregroundStyle(.mcMuted)
	}

	// In ink, not a link: the whole line is the control (X3).
	private var showOrHide: some View {
		Text(open ? "Hide" : "Show")
			.fontWeight(.medium)
			.foregroundStyle(.mcText)
	}

	/// "7 · 1 urgent" as one run of words, so a narrow line wraps it between words.
	private func counts(_ count: Int, urgent: Int) -> Text {
		let total = Text("\(count)").foregroundStyle(.mcMuted)
		guard urgent > 0 else { return total }
		return Text("\(total) \(Text("·").foregroundStyle(.mcFaint)) \(Text("\(urgent) urgent").foregroundStyle(.mcNeg))")
	}
}

private struct JobRow: View {
	@Environment(AppModel.self) private var model
	@Environment(\.dynamicTypeSize) private var typeSize
	let job: NeedsYouJob

	var body: some View {
		// At accessibility sizes Done goes under the note: beside it, it left the note a column too
		// narrow for its longer words.
		let stacked = typeSize.isAccessibilitySize
		let layout = stacked
			? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
			: AnyLayout(HStackLayout(alignment: .center, spacing: 16))
		layout {
			VStack(alignment: .leading, spacing: 3) {
				// The full note wraps (WP-02/NM-03); tapping it opens its email.
				// From XXXL up, an address in it ("Message to bob@… bounced") breaks only after its "@" or
				// "."; below that it fits whole, so it isn't split (UX walkthrough review: L split it).
				Button { model.open(job.lead) } label: {
					Text(typeSize >= .xxxLarge ? job.text.wrappingAtAddressSeams : job.text)
						.multilineTextAlignment(.leading)
						.fixedSize(horizontal: false, vertical: true)
				}
				.buttonStyle(.plain)
				.accessibilityLabel(job.text)
				.accessibilityIdentifier("needs-you-job")
				meta
					.font(.footnote)
					.foregroundStyle(.mcMuted)
					.fixedSize(horizontal: false, vertical: true)
			}
			if !stacked { Spacer(minLength: 0) }
			// A word, not an outlined pill: five of them read as a stack of buttons (WM7).
			Button { model.done(job) } label: {
				Text(job.notes.count > 1 ? "Done (\(job.notes.count))" : "Done")
					.fontWeight(.medium)
					.foregroundStyle(.mcText)
					.frame(minWidth: 44, minHeight: 44, alignment: stacked ? .leading : .trailing)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Done: \(job.text)")
		}
		.padding(.horizontal, 14)
		.padding(.vertical, 12)
	}

	/// "Urgent · Due Oct 30 · Example Agency · 2 emails · Yesterday".
	private var meta: Text {
		var parts: [Text] = []
		if job.urgent { parts.append(Text("Urgent").fontWeight(.semibold).foregroundStyle(.mcNeg)) }
		if let due = job.dueLabel {
			parts.append(Text(due).fontWeight(.semibold).foregroundStyle(.mcWarn))
		}
		parts.append(Text(job.source))
		parts.append(Text(RowDate.string(job.at)))
		return parts.dropFirst().reduce(parts[0]) { Text("\($0) · \($1)") }
	}
}
