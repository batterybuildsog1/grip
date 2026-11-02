import MailClawKit
import SwiftUI

/// One conversation, laid out like Mail: unread dot, sender (or "To name") and time, subject, the
/// new text of its message in one line (search: the matched words in two). No icons (design r2 §1).
struct ConversationRowView: View {
	let row: ConversationRow
	var identifier = "conversation-row"
	/// Search results: where the conversation lives ("Personal", "Sent", "All mail"; r2 S4).
	var place: String?
	/// Search results: the snippet with the words the search matched.
	var marked: [SnippetRun]?
	@Environment(\.dynamicTypeSize) private var typeSize
	@Environment(\.mcPalette) private var palette

	var body: some View {
		HStack(alignment: .top, spacing: 8) {
			Circle()
				.fill(.mcAccent)
				.opacity(row.unread ? 1 : 0)
				.frame(width: 9, height: 9)
				.padding(.top, 6)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: 1) {
				HStack(alignment: .firstTextBaseline, spacing: 4) {
					if row.isDraft {
						Text("Draft").font(.headline).foregroundStyle(.mcNeg)
					}
					// Unread: the dot and the name at 600; read: the name at 400 (design-taste X2).
					Text(row.sender)
						.font(.headline)
						.fontWeight(row.unread ? .semibold : .regular)
						.lineLimit(1)
					if row.messageCount > 1 {
						Text("\(row.messageCount)")
							.font(.footnote.weight(.medium))
							.foregroundStyle(.mcFaint)
					}
					Spacer(minLength: 6)
					if let place {
						Text(place)
							.font(.footnote)
							.foregroundStyle(.mcFaint)
							.lineLimit(1)
					}
					if !typeSize.isAccessibilitySize { date }
				}
				if typeSize.isAccessibilitySize { date }
				// The subject is always 400 in ink: the dot and the name already say unread (X2).
				Text(row.subject)
					.font(.subheadline)
					.lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
				if let marked, !marked.isEmpty {
					Text(Self.highlighted(marked, mark: palette[.mark], ink: palette[.text]))
						.font(.subheadline)
						.foregroundStyle(.mcMuted)
						.lineLimit(2)
				} else if !row.snippet.isEmpty {
					// One line: name and time, subject, snippet (Phone inbox A: 3-line rows). A search
					// result keeps two, where the matched words are why the row is there.
					Text(row.snippet)
						.font(.subheadline)
						.foregroundStyle(.mcMuted)
						.lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
				}
			}
		}
		.padding(.vertical, 3)
		.foregroundStyle(.mcText)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		// The dot is hidden from VoiceOver: the row says it in words (build 4).
		.accessibilityValue(row.unread ? "Unread" : "")
		.accessibilityIdentifier(identifier)
	}

	private var date: some View {
		// Never bold: unread in ink, read in grey (X2).
		Text(RowDate.string(row.date))
			.font(.subheadline)
			.foregroundStyle(row.unread ? MCColor.mcText : .mcMuted)
			.lineLimit(1)
	}

	/// The matched words on a highlight, like the web's `<mark>`.
	static func highlighted(_ runs: [SnippetRun], mark: Color, ink: Color) -> AttributedString {
		var text = AttributedString()
		for run in runs {
			var part = AttributedString(run.text)
			if run.marked {
				part.backgroundColor = mark
				part.foregroundColor = ink
			}
			text += part
		}
		return text
	}
}

/// Today: time. Yesterday. This week: weekday. Older: short date.
enum RowDate {
	static func string(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
		if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
		if calendar.isDateInYesterday(date) { return "Yesterday" }
		if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: now).day, days < 7 {
			return date.formatted(.dateTime.weekday(.abbreviated))
		}
		// "Oct 3" this year, "Oct 3, 2025" before (design r2 S1, as the web).
		if calendar.isDate(date, equalTo: now, toGranularity: .year) {
			return date.formatted(.dateTime.month(.abbreviated).day())
		}
		return date.formatted(.dateTime.month(.abbreviated).day().year())
	}

	/// The same, with the time of day after it ("Tue 12:11 PM"; today is a time already): rail rows
	/// whose name and subject repeat (L3).
	static func withTimeOfDay(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
		let day = string(date, now: now, calendar: calendar)
		if calendar.isDateInToday(date) { return day }
		return "\(day) \(date.formatted(date: .omitted, time: .shortened))"
	}
}
