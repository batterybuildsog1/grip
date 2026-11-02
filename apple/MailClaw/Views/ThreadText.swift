import Foundation
import MailClawKit

/// The long thread's text rules (round-2 build spec S2), the same as ui/src/utils/thread-text.ts:
/// what a message says that is new, what repeats, who is "me", how a timeline folds.
enum ThreadText {
	struct Parts: Sendable {
		/// The message's new text (WD-05, NI-08).
		let shown: String
		/// History and legal footers, behind "Show trimmed text".
		let hidden: String
	}

	private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
		// The patterns are constants: a typo is a crash on first use, caught by the UI tests.
		try! NSRegularExpression(pattern: pattern, options: options)
	}

	// Quoted history: Outlook's rule and "From:/Sent:" block, "-----Original Message", "On … wrote:".
	private static let history: [NSRegularExpression] = [
		regex(#"^_{8,}\s*$"#, .anchorsMatchLines),
		regex(#"^-{2,}\s*Original Message"#, [.anchorsMatchLines, .caseInsensitive]),
		regex(#"^From: [^\n]+\n(?:Sent|Date): "#, .anchorsMatchLines),
		regex(#"^On [^\n]{4,140}(?:\n[^\n]{0,140})?wrote:[ \t]*$"#, .anchorsMatchLines),
		regex(#"^Get Outlook for "#, .anchorsMatchLines),
	]
	private static let footer = regex(
		#"^(?:CONFIDENTIAL(?:ITY)? (?:NOTICE|COMMUNICATION)|THIS ELECTRONIC MESSAGE|This (?:email|e-mail|message)(?: and any attachments)? (?:is|are) (?:intended|confidential))"#,
		[.anchorsMatchLines, .caseInsensitive])
	private static let tidyRules: [(NSRegularExpression, String)] = [
		(regex(#"\r"#), ""),
		(regex(#"\[cid:[^\]]*\]"#), ""),
		(regex(#"<(?:https?|mailto):[^>]*>"#), ""),
		(regex(#"\[[^\]\n]{0,160}(?:Description automatically generated|Image result for|logo)[^\]\n]*\]"#, .caseInsensitive), ""),
		(regex(#"^\[EXTERNAL( EMAIL)?\][ \t]*$"#, .anchorsMatchLines), ""),
		(regex("[\u{200B}-\u{200F}\u{00AD}\u{034F}\u{FEFF}]"), ""),
		(regex("[\u{00A0}\u{202F}]"), " "),
		(regex(#"[ \t]+\n"#), "\n"),
		(regex(#"\n{3,}"#), "\n\n"),
	]
	private static let messageIds = regex(#"<[^>\s]+>"#)
	private static let bulkSender = regex(#"no-?reply|receipts?@|invoice\+|stripe\.com$"#, .caseInsensitive)
	private static let replyPrefix = regex(#"^\s*((re|fw|fwd|aw|sv|wg)\s*(\[\d+\])?\s*:\s*)+"#, .caseInsensitive)

	private static func whole(_ text: String) -> NSRange { NSRange(text.startIndex..., in: text) }

	/// Plain text as people read it: no CR, cid stubs, bracketed URL echoes, logo alt text or zero-widths.
	static func tidy(_ text: String?) -> String {
		var out = text ?? ""
		for (pattern, template) in tidyRules {
			out = pattern.stringByReplacingMatches(in: out, range: whole(out), withTemplate: template)
		}
		return out.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	/// [before, from the first history marker or footer on]. A marker at the very start is not a cut.
	private static func cut(_ text: String) -> (String, String) {
		var index: String.Index?
		for pattern in history + [footer] {
			guard let match = pattern.firstMatch(in: text, range: whole(text)),
			      let range = Range(match.range, in: text), range.lowerBound > text.startIndex else { continue }
			if index == nil || range.lowerBound < index! { index = range.lowerBound }
		}
		guard let index else { return (text, "") }
		return (String(text[..<index]), String(text[index...]))
	}

	/// Confidentiality paragraphs that open a message: (what they said, the rest).
	private static func splitLeadFooter(_ text: String) -> (String, String) {
		var rest = text
		var dropped: [String] = []
		while let match = footer.firstMatch(in: rest, range: whole(rest)), match.range.location == 0 {
			guard let end = rest.range(of: "\n\n") else {
				dropped.append(rest)
				rest = ""
				break
			}
			dropped.append(String(rest[..<end.lowerBound]))
			rest = String(rest[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
		}
		return (dropped.joined(separator: "\n\n"), rest)
	}

	/// The server's quote split first (`quote.newText`), then the history and footer cuts.
	static func parts(_ email: Email) -> Parts {
		let (lead, full) = splitLeadFooter(tidy(email.textContent))
		let newText = email.quote?.hasQuoted == true ? email.quote?.newText ?? "" : ""
		let base = newText.isEmpty ? full : splitLeadFooter(tidy(newText)).1
		let shown = cut(base).0.trimmingCharacters(in: .whitespacesAndNewlines)
		var rest = cut(full).1.trimmingCharacters(in: .whitespacesAndNewlines)
		if rest.isEmpty, !newText.isEmpty, full.count > shown.count {
			rest = String(full.dropFirst(shown.count)).trimmingCharacters(in: .whitespacesAndNewlines)
		}
		return Parts(shown: shown, hidden: [lead, rest].filter { !$0.isEmpty }.joined(separator: "\n\n"))
	}

	/// Bulk mail keeps its own HTML; people's mail is set as text in the app's type (NM-15).
	static func isBulk(_ email: Email, category: String?) -> Bool {
		guard email.htmlContent?.isEmpty == false else { return false }
		let kind = email.category ?? category
		if ["newsletters", "marketing", "notifications"].contains(kind ?? "") || email.listUnsubscribe?.isEmpty == false {
			return true
		}
		let address = bareAddress(email.fromAddress)
		return bulkSender.firstMatch(in: address, range: whole(address)) != nil
	}

	/// People's mail with a text part reads as text; HTML-only and bulk mail keep their HTML.
	static func readsAsText(_ email: Email, parts: Parts, category: String?) -> Bool {
		!isBulk(email, category: category) && !parts.shown.isEmpty && !tidy(email.textContent).isEmpty
	}

	/// One line for a closed box: the new text, else the files it carries.
	static func firstLine(_ email: Email, parts: Parts) -> String {
		let text = parts.shown.isEmpty
			? (email.files.compactMap(\.filename).joined(separator: ", "))
			: parts.shown
		return Display.collapse(text.isEmpty ? Display.stripTags(email.htmlContent ?? "") : text)
	}

	/// "Re: Fwd: Project notes" and "project notes" are one subject.
	static func normalizeSubject(_ subject: String?) -> String {
		let text = subject ?? ""
		let stripped = replyPrefix.stringByReplacingMatches(in: text, range: whole(text), withTemplate: "")
		return Display.collapse(stripped).lowercased()
	}

	/// Message-ids the first message replies to that this thread doesn't hold (the split-conversation gap).
	static func answersMissingMessage(_ emails: [Email]) -> Bool {
		guard let first = emails.first else { return false }
		let here = Set(emails.compactMap(\.messageId))
		let refs = "\(first.inReplyTo ?? "") \(first.referencesHeader ?? "")"
		return messageIds.matches(in: refs, range: whole(refs))
			.compactMap { Range($0.range, in: refs).map { String(refs[$0]) } }
			.contains { !here.contains($0) }
	}

	static func bareAddress(_ raw: String) -> String {
		if let open = raw.firstIndex(of: "<"), let close = raw[open...].firstIndex(of: ">") {
			return String(raw[raw.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
		}
		return raw.trimmingCharacters(in: .whitespaces)
	}

	// MARK: Dates (the viewer's time zone)

	/// A closed box: 5:02 PM today, Yesterday, Oct 22, or Oct 22, 2025.
	static func shortDate(_ date: Date) -> String {
		let calendar = Calendar.current
		if calendar.isDateInToday(date) { return date.formatted(.dateTime.hour().minute()) }
		if calendar.isDateInYesterday(date) { return "Yesterday" }
		if calendar.isDate(date, equalTo: .now, toGranularity: .year) {
			return date.formatted(.dateTime.month(.abbreviated).day())
		}
		return date.formatted(.dateTime.month(.abbreviated).day().year())
	}

	/// An open box: Thu, Oct 22, 5:02 PM (with the year when it isn't this year, m3-02).
	static func fullDate(_ date: Date) -> String {
		if Calendar.current.isDate(date, equalTo: .now, toGranularity: .year) {
			return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
		}
		return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year().hour().minute())
	}

	static func monthDay(_ date: Date) -> String { date.formatted(.dateTime.month(.abbreviated).day()) }
}

/// Who a thread's people are: names seen in it, and which addresses are this mailbox's.
struct ThreadPeople: Sendable {
	private var names: [String: String] = [:]
	private var mine: Set<String> = []

	init(_ emails: [Email], participants: [Participant] = []) {
		for email in emails {
			if let mailbox = email.mailbox, let domain = email.domain { mine.insert("\(mailbox)@\(domain)".lowercased()) }
			if email.isOutbound { mine.insert(ThreadText.bareAddress(email.fromAddress).lowercased()) }
			learn(email.fromName, email.fromAddress)
		}
		for person in participants { learn(person.name, person.address) }
	}

	private mutating func learn(_ name: String?, _ address: String) {
		let key = ThreadText.bareAddress(address).lowercased()
		guard let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty, !name.contains("@"),
		      names[key] == nil else { return }
		names[key] = name
	}

	func isMe(_ address: String) -> Bool { mine.contains(ThreadText.bareAddress(address).lowercased()) }

	func name(_ address: String, given: String? = nil) -> String {
		var name = Display.readable(given ?? "")
		if name.isEmpty || name.contains("@") { name = names[ThreadText.bareAddress(address).lowercased()] ?? "" }
		if name.isEmpty { return Display.name(address: address, name: nil) }
		return Display.readable(name)
	}

	/// The sender as a box names them: "me" for this mailbox.
	func sender(_ email: Email) -> String {
		isMe(email.fromAddress) ? "me" : name(email.fromAddress, given: email.fromName)
	}

	/// "to me, Robin Example, Kai Sample" (and "and 2 more"): the button that reveals the addresses.
	func recipients(_ email: Email) -> String {
		let all = email.recipients + (email.ccAddresses ?? [])
		let names = all.map { isMe($0) ? "me" : name($0) }
		guard !names.isEmpty else { return "to undisclosed recipients" }
		let shown = names.prefix(3).joined(separator: ", ")
		return "to \(shown)" + (names.count > 3 ? " and \(names.count - 3) more" : "")
	}
}

/// What a thread's timeline shows, top to bottom.
enum TimelineItem: Identifiable {
	enum Stack: String, Sendable { case earlier, middle }

	case message(Email)
	case stack(Stack, [Email])

	var id: String {
		switch self {
		case let .message(email): "message:\(email.id)"
		case let .stack(kind, _): "stack:\(kind.rawValue)"
		}
	}

	/// A split-off earlier conversation folds into one stack at the top. Own messages: four or fewer
	/// all show; more show the first, a stack of the middle and the last three. `open`: unfolded stacks.
	static func plan(own: [Email], earlier: [Email], open: Set<Stack>) -> [TimelineItem] {
		var out: [TimelineItem] = []
		if !earlier.isEmpty {
			if open.contains(.earlier) { out += earlier.map(TimelineItem.message) } else { out.append(.stack(.earlier, earlier)) }
		}
		guard own.count > 4 else { return out + own.map(TimelineItem.message) }
		out.append(.message(own[0]))
		let middle = Array(own[1..<(own.count - 3)])
		if open.contains(.middle) || middle.count < 2 { out += middle.map(TimelineItem.message) } else { out.append(.stack(.middle, middle)) }
		return out + own.suffix(3).map(TimelineItem.message)
	}
}
