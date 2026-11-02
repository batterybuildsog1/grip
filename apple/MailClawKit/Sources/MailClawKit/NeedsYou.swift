import Foundation

/// Needs you: the open notes as jobs, grouped and ranked on the device, the same rules as the web
/// (ui/src/lib/needs-you.ts; design r2 §4 S1). A job is one sender's notes, or every bounce about
/// the same address. Rank: urgent (log in, password, new device, security) → due within 14 days
/// → recent → due later → bounces of MailClaw's own test sends.
public struct NeedsYouJob: Identifiable, Hashable, Sendable {
	/// A sender address, or "bounce|<address>".
	public let id: String
	/// Newest first.
	public let notes: [ActionNote]
	/// The fullest note of the group, as a sentence.
	public let text: String
	/// "Example Agency", or "Example Agency · 2 emails" / "Mail Delivery Subsystem · 3 bounces".
	public let source: String
	/// Soonest due date of the group (yyyy-MM-dd).
	public let due: String?
	public let urgent: Bool
	/// The note to open: the fullest one.
	public let lead: ActionNote
	public let at: Date
	let rank: Double

	public var dueLabel: String? {
		guard let due, let date = Display.dayFormatter.date(from: due) else { return nil }
		return "Due " + Self.dueFormatter.string(from: date)
	}

	private static let dueFormatter: DateFormatter = {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.dateFormat = "MMM d"
		return formatter
	}()

	public static func build(_ notes: [ActionNote], now: Date = Date()) -> [NeedsYouJob] {
		var order: [String] = []
		var groups: [String: [ActionNote]] = [:]
		for note in notes {
			let target = isBounce(note) ? firstAddress(in: note.note) : nil
			let key = target.map { "bounce|\($0)" } ?? note.from.address.lowercased()
			if groups[key] == nil { order.append(key) }
			groups[key, default: []].append(note)
		}
		let nowMs = now.timeIntervalSince1970 * 1000
		let jobs = order.map { key -> NeedsYouJob in
			let list = (groups[key] ?? []).sorted { $0.receivedAt > $1.receivedAt }
			let lead = list.max { $0.note.count < $1.note.count } ?? list[0]
			let due = list.compactMap(\.due).min()
			let words = list.map { "\($0.note) \($0.subject ?? "")" }.joined(separator: " ")
			let urgent = words.range(
				of: "log ?in|password|new device|sign-?in|security", options: [.regularExpression, .caseInsensitive]) != nil
			let bounce = key.hasPrefix("bounce|")
			let test = bounce && key.dropFirst("bounce|".count)
				.range(of: "^(e2e|test)[\\w.+-]*@", options: [.regularExpression, .caseInsensitive]) != nil
			let days = due.flatMap { daysUntil($0, now: now) }
			var rank = 2 + (nowMs - Double(list[0].receivedAt)) / 1e12
			if urgent { rank = 0 } else if let days, days <= 14 { rank = 1 + Double(days) / 1000 } else if let days {
				rank = 3 + Double(days) / 1e6
			}
			if test { rank = 4 }
			let sender = lead.from.name?.isEmpty == false ? lead.from.name! : lead.from.address
			let more = list.count > 1 ? " · \(list.count) \(bounce ? "bounces" : "emails")" : ""
			return NeedsYouJob(
				id: key, notes: list, text: sentence(lead.note), source: sender + more, due: due, urgent: urgent,
				lead: lead, at: Date(timeIntervalSince1970: Double(list[0].receivedAt) / 1000), rank: rank)
		}
		return jobs.sorted { $0.rank < $1.rank }
	}

	private static func isBounce(_ note: ActionNote) -> Bool {
		let pattern = "mailer-daemon|postmaster|mail delivery subsystem"
		return note.from.address.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
			|| (note.from.name ?? "").range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
	}

	private static func firstAddress(in text: String) -> String? {
		text.range(of: "[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+", options: .regularExpression).map { text[$0].lowercased() }
	}

	private static func sentence(_ text: String) -> String {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let last = trimmed.last else { return trimmed }
		return ".!?".contains(last) ? trimmed : trimmed + "."
	}

	/// Whole days from today to a yyyy-MM-dd due date; negative when overdue.
	static func daysUntil(_ due: String, now: Date) -> Int? {
		guard let date = Display.dayFormatter.date(from: due) else { return nil }
		let calendar = Calendar(identifier: .gregorian)
		return calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day
	}
}
