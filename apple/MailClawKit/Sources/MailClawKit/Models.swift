import Foundation

// MARK: - Views (r2 build spec S6: Personal, Money, the people, Notifications, then Mailboxes)

/// One list the app shows: a sidebar view, in one account or in all of them. Archive and Spam
/// views were cut (r2 spec section 1). `rawValue` keys the view's stored list, so each account's
/// Personal keeps its own rows and paging.
public struct MailView: Hashable, Sendable, Identifiable {
	public enum Kind: String, Sendable {
		case personal, money, person, notifications, all, sent, drafts, trash
	}

	public let kind: Kind
	/// The account's address (the menu's label; the list narrows by its domain); nil is All accounts.
	public let account: String?
	/// The forwarded-in person a `.person` view lists (`for_person`; names come from /api/meta).
	public let person: String?

	public init(_ kind: Kind, account: String? = nil, person: String? = nil) {
		self.kind = kind
		self.account = account
		self.person = kind == .person ? person : nil
	}

	public static let personal = MailView(.personal)
	public static let money = MailView(.money)
	/// Design-taste X9, as on the web: under the people, with no count (it isn't a queue).
	public static let notifications = MailView(.notifications)
	public static let all = MailView(.all)
	public static let sent = MailView(.sent)
	public static let drafts = MailView(.drafts)
	public static let trash = MailView(.trash)
	public static func person(_ name: String) -> MailView { MailView(.person, person: name) }

	/// The same view in another account (switching accounts never changes the view: WD-02).
	public func scoped(to account: String?) -> MailView { MailView(kind, account: account, person: person) }
	/// The sidebar's row for this view.
	public var unscoped: MailView { scoped(to: nil) }

	/// "personal", "person:Robin", "sent@you@example.com".
	public var rawValue: String {
		let base = kind == .person ? "person:\(person ?? "")" : kind.rawValue
		return account.map { "\(base)@\($0)" } ?? base
	}

	public var id: String { rawValue }

	public var title: String {
		switch kind {
		case .personal: "Personal"
		case .money: "Money"
		case .person: person ?? "Person"
		case .notifications: "Notifications"
		case .all: "All mail"
		case .sent: "Sent"
		case .drafts: "Drafts"
		case .trash: "Trash"
		}
	}

	/// What an empty list says (r2 spec section 5).
	public var emptyText: String {
		switch kind {
		case .drafts: "No drafts."
		case .trash: "Trash is empty."
		case .person: "No mail for \(title)."
		default: "No conversations here."
		}
	}

	/// The same filters the web list sends (ui/src/components/ConversationList.tsx buildFilters). A
	/// search with `scope=view` applies them; All mail has none, so a search from it has one scope.
	public var filters: [(String, String)] {
		var filters: [(String, String)] = switch kind {
		case .personal: [("category", "personal")]
		// Inbox levels (2026-10-14): Money is billing to act on.
		case .money: [("category", "billing"), ("sub_category", "failed_payments,invoice_conversations")]
		case .person: [("for_person", person ?? "")]
		case .notifications: [("category", "notifications")]
		case .all: []
		case .sent: [("mailbox_state", "sent")]
		case .drafts: [("mailbox_state", "draft")]
		case .trash: [("mailbox_state", "trash")]
		}
		// The account narrows by its domain, as the web does (r2 S1): mail to the domain's other
		// addresses (catch-all info@ and the like) stays in view.
		if let domain = account?.split(separator: "@").last { filters.append(("domain", String(domain))) }
		return filters
	}
}

// MARK: - API shapes (src/types.ts; keys arrive snake_case)

public struct Participant: Codable, Sendable, Hashable {
	public let name: String?
	public let address: String
}

public struct ConversationSummary: Codable, Sendable {
	public let id: String
	public let subject: String?
	public let latestMessageAt: Int64
	public let messageCount: Int
	public let unreadCount: Int
	public let mailboxState: String
	public let hasAttachments: Bool
	public let snippet: String?
	public let participants: [Participant]?
	public let category: String?
	public let latestEmailId: String?
	private let attachmentNames: [String]?
	public var displayAttachmentNames: [String] { attachmentNames ?? [] }
	/// Files in the conversation (`attachment_count`); nil from a server that doesn't send it.
	public let attachmentCount: Int?
	public let displayEmailId: String?
	public let displayMailboxState: String?
	public let displayDirection: String?
	public let displayFromAddress: String?
	public let displayFromName: String?
	public let displayToAddress: String?
	/// The name of `displayToAddress` on a sent or draft row (`display_to_name`, found by the server);
	/// nil when none is known (or from an older server): the row shows the whole address.
	public let displayToName: String?
	public let displaySnippet: String?
	public let displaySnippetSource: String?
	/// The first message's date: an older conversation with the same subject ended before it (S2).
	public let startedAt: Int64?

	private enum CodingKeys: String, CodingKey {
		case id
		case subject
		case latestMessageAt
		case messageCount
		case unreadCount
		case mailboxState
		case hasAttachments
		case snippet
		case participants
		case category
		case latestEmailId
		case attachmentNames = "displayAttachmentNames"
		case attachmentCount
		case displayEmailId
		case displayMailboxState
		case displayDirection
		case displayFromAddress
		case displayFromName
		case displayToAddress
		case displayToName
		case displaySnippet
		case displaySnippetSource
		case startedAt
	}
}

struct ConversationPage: Decodable, Sendable {
	let conversations: [ConversationSummary]
	let nextCursor: String?
	let hasMore: Bool?
	/// Server search only: what ran, the misspelled query it replaced (`corrected_from`), and a
	/// spelling it suggests when few or no conversations matched.
	let search: SearchEcho?

	struct SearchEcho: Decodable, Sendable {
		let query: String?
		let correctedFrom: String?
		let suggestion: String?
	}
}

// MARK: - Search (r2 S4)

/// One server search answer: the rows and what the server says it did with the query.
public struct SearchAnswer: Hashable, Sendable {
	public let results: [SearchResult]
	public let hasMore: Bool
	/// What ran: the corrected query when the server fixed a misspelling.
	public let query: String?
	/// The query as sent, when the server searched for `query` instead.
	public let correctedFrom: String?
	/// A spelling the server suggests (it may still have found one or two conversations).
	public let suggestion: String?

	/// The pill's count: "50+" when the server has more or stopped at its cap.
	public var countLabel: String { SearchCount.label(rows: results.count, hasMore: hasMore) }
}

/// One search result: the row, where the conversation lives, and its snippet with the matched words.
public struct SearchResult: Identifiable, Hashable, Sendable {
	public let row: ConversationRow
	/// "Personal", "Sent", "Drafts", "Trash", "Spam" or "All mail" (ui/src/utils/search.ts searchWhere).
	public let place: String
	public let snippet: [SnippetRun]

	public var id: String { row.id }

	init(summary s: ConversationSummary) {
		row = ConversationRow(summary: s)
		place = SearchPlace.of(summary: s)
		snippet = SnippetRun.parse(s.displaySnippet ?? s.snippet ?? "")
	}
}

/// A stretch of snippet text; `marked` stretches are the words the search matched (`<mark>`).
public struct SnippetRun: Hashable, Sendable {
	public let text: String
	public let marked: Bool

	/// Splits the server's snippet at its `<mark>` tags; every other tag is dropped and entities decoded.
	public static func parse(_ html: String) -> [SnippetRun] {
		var runs: [SnippetRun] = []
		var marked = false
		var rest = Substring(html)
		while !rest.isEmpty {
			let open = rest.range(of: "<mark>", options: .caseInsensitive)
			let close = rest.range(of: "</mark>", options: .caseInsensitive)
			let next = marked ? close : open
			let text = next.map { rest[..<$0.lowerBound] } ?? rest
			let clean = Display.collapse(Display.stripTags(String(text)))
			if !clean.isEmpty {
				// Keep the spaces around a marked word: collapse() trims them away.
				let lead = text.first?.isWhitespace == true && !runs.isEmpty ? " " : ""
				let trail = text.last?.isWhitespace == true ? " " : ""
				runs.append(SnippetRun(text: lead + clean + trail, marked: marked))
			} else if !text.isEmpty, !runs.isEmpty {
				runs.append(SnippetRun(text: " ", marked: false))
			}
			guard let next else { break }
			rest = rest[next.upperBound...]
			marked.toggle()
		}
		return runs
	}
}

/// Where a search result lives, in the redesign's views. Money needs the conversation's
/// sub-category, which the list API does not return, so billing outside Personal reads "All mail".
public enum SearchPlace {
	static func of(summary s: ConversationSummary) -> String {
		let state = s.displayMailboxState ?? s.mailboxState
		if state == "trash" { return "Trash" }
		if state == "draft" { return "Drafts" }
		if s.category == "spam" { return "Spam" }
		if s.category == "personal" { return "Personal" }
		if s.displayDirection == "outbound" { return "Sent" }
		return "All mail"
	}
}

public enum SearchCount {
	/// Ranked search returns at most this many conversations (src/routes/conversations.ts).
	public static let cap = 50

	/// A pill's count: rows, with "+" when the server has more or stopped at its cap (50 or more).
	public static func label(rows: Int, hasMore: Bool) -> String {
		hasMore || rows >= cap ? "\(rows)+" : "\(rows)"
	}

	/// The query as typed, with each word the server corrected quoted: the search compiler never
	/// corrects a quoted word ("inovice" -> "\"inovice\""; ui/src/utils/search.ts literalQuery).
	public static func literal(typed: String, corrected: String) -> String {
		let mine = typed.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
		let fixed = corrected.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
		guard mine.count == fixed.count else { return "\"\(typed.replacingOccurrences(of: "\"", with: ""))\"" }
		return zip(mine, fixed).map { word, fix in
			word != fix && !word.contains("\"") ? "\"\(word)\"" : word
		}.joined(separator: " ")
	}
}

public struct Attachment: Codable, Sendable, Hashable, Identifiable {
	public let id: String
	public let emailId: String
	public let filename: String?
	public let mimeType: String
	public let size: Int
	public let disposition: String?
	public let contentId: String?

	/// Bare content id (`<a@b>` and `a@b` both become `a@b`).
	public var bareContentId: String? {
		guard let contentId else { return nil }
		return contentId.trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
	}
}

public struct QuoteSegment: Codable, Sendable {
	public let kind: String
	public let start: Int?
	public let end: Int?
}

/// Read-time quoted-text split (src/services/quoted.ts).
public struct QuoteSplit: Codable, Sendable {
	public let hasQuoted: Bool
	public let newText: String
	public let segments: [QuoteSegment]
}

public struct Email: Codable, Sendable, Identifiable {
	public let id: String
	public let fromAddress: String
	public let fromName: String?
	public let toAddress: String?
	public let toAddresses: [String]?
	public let ccAddresses: [String]?
	public let direction: String
	public let mailboxState: String
	public let subject: String?
	public let receivedAt: Int64
	public let sentAt: Int64?
	public let htmlContent: String?
	public let textContent: String?
	public let attachments: [Attachment]?
	public let quote: QuoteSplit?
	// The long thread (round-2 S2): who "me" is, bulk mail, the split-conversation join.
	public let replyToAddresses: [String]?
	public let mailbox: String?
	public let domain: String?
	public let category: String?
	public let listUnsubscribe: String?
	public let readAt: Int64?
	public let messageId: String?
	public let inReplyTo: String?
	public let referencesHeader: String?

	public var isOutbound: Bool { direction == "outbound" }
	public var isDraft: Bool { mailboxState == "draft" }
	public var date: Date { Date(timeIntervalSince1970: Double(sentAt ?? receivedAt) / 1000) }
	public var senderName: String { Display.name(address: fromAddress, name: fromName) }
	public var recipients: [String] { (toAddresses?.isEmpty == false ? toAddresses : toAddress.map { [$0] }) ?? [] }

	/// Attachments to list under the body: everything except inline images the HTML shows itself.
	public var listedAttachments: [Attachment] {
		let html = htmlContent ?? ""
		return (attachments ?? []).filter { attachment in
			guard let cid = attachment.bareContentId, !cid.isEmpty else { return true }
			return !html.contains("cid:\(cid)")
		}
	}

	/// One-line preview for a collapsed message: the new text when the server trimmed quotes.
	public var preview: String {
		if let quote, quote.hasQuoted { return Display.collapse(quote.newText) }
		if let textContent, !textContent.isEmpty { return Display.collapse(textContent) }
		return Display.collapse(Display.stripTags(htmlContent ?? ""))
	}
}

public struct ConversationDetail: Codable, Sendable {
	public let conversation: ConversationSummary
	public let emails: [Email]
	public let anchorEmailId: String?
	public let remainingEmailCount: Int?
}

/// An open "Needs you" note (v55, src/routes/notes.ts).
public struct ActionNote: Codable, Sendable, Hashable, Identifiable {
	public let emailId: String
	public let threadId: String?
	public let note: String
	public let due: String?
	public let from: Participant
	public let subject: String?
	public let receivedAt: Int64

	public var id: String { emailId }
	public var conversationId: String { threadId ?? emailId }
	public var senderName: String { Display.name(address: from.address, name: from.name) }

	public var dueDate: Date? {
		guard let due else { return nil }
		return Display.dayFormatter.date(from: due)
	}

	public var isOverdue: Bool {
		guard let due else { return false }
		return due < Display.dayFormatter.string(from: Date())
	}
}

struct NotesResponse: Decodable { let notes: [ActionNote] }

// MARK: - What a list row shows (computed once, when a summary is stored)

public struct ConversationRow: Identifiable, Hashable, Sendable {
	public let id: String
	public let latestAt: Int64
	public let sender: String
	public let subject: String
	public let snippet: String
	public let messageCount: Int
	public internal(set) var unread: Bool
	public let hasAttachments: Bool
	public let isDraft: Bool
	public let isOutbound: Bool
	public let displayEmailId: String?
	/// Up to three file names of the shown message (`display_attachment_names`), and how many files
	/// the conversation holds: the Mac row names the first and counts the rest (L3).
	public let fileNames: [String]
	public let fileCount: Int

	public var date: Date { Date(timeIntervalSince1970: Double(latestAt) / 1000) }

	/// This row after the server marked the conversation read or unread.
	public func with(unread: Bool) -> ConversationRow {
		var row = self
		row.unread = unread
		return row
	}

	public init(summary s: ConversationSummary) {
		id = s.id
		latestAt = s.latestMessageAt
		isOutbound = s.displayDirection == "outbound"
		isDraft = s.displayMailboxState == "draft" || s.mailboxState == "draft"
		if isOutbound {
			// The person's name when the server knows one, else the whole address (never its local part).
			let name = s.displayToName.map(Display.readable) ?? ""
			let address = s.displayToAddress?.trimmingCharacters(in: .whitespaces) ?? ""
			sender = "To \(!name.isEmpty ? name : !address.isEmpty ? address : "(no recipient)")"
		} else {
			sender = Display.name(address: s.displayFromAddress ?? "", name: s.displayFromName)
		}
		let trimmedSubject = s.subject?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		subject = trimmedSubject.isEmpty ? "(no subject)" : trimmedSubject
		snippet = Display.newText(Display.collapse(Display.stripTags(s.displaySnippet ?? s.snippet ?? "")))
		messageCount = s.messageCount
		unread = s.unreadCount > 0
		hasAttachments = s.hasAttachments
		displayEmailId = s.displayEmailId ?? s.latestEmailId
		fileNames = s.displayAttachmentNames.filter { !$0.isEmpty }
		fileCount = max(s.attachmentCount ?? 0, fileNames.count)
	}

	init(
		id: String, latestAt: Int64, sender: String, subject: String, snippet: String, messageCount: Int,
		unread: Bool, hasAttachments: Bool, isDraft: Bool, isOutbound: Bool, displayEmailId: String?,
		fileNames: [String] = [], fileCount: Int = 0
	) {
		self.id = id
		self.latestAt = latestAt
		self.sender = sender
		self.subject = subject
		self.snippet = snippet
		self.messageCount = messageCount
		self.unread = unread
		self.hasAttachments = hasAttachments
		self.isDraft = isDraft
		self.isOutbound = isOutbound
		self.displayEmailId = displayEmailId
		self.fileNames = fileNames
		self.fileCount = fileCount
	}
}

// MARK: - Text helpers shared by rows and the thread view

public enum Display {
	/// Sender display name, after ui/src/utils/sender.ts parseSenderName (simplified), read the way
	/// people say it (`readable`): rows, the rail and the thread name a person alike.
	public static func name(address raw: String, name: String?) -> String {
		if let name = name.map(readable), !name.isEmpty { return name }
		if let open = raw.firstIndex(of: "<"), open > raw.startIndex {
			let display = readable(String(raw[..<open]))
			if !display.isEmpty, !display.contains("@") { return display }
		}
		let address = raw.trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
		guard let at = address.firstIndex(of: "@") else { return address.isEmpty ? "Unknown" : address }
		let local = String(address[..<at])
		let domain = String(address[address.index(after: at)...])
		let machine = local.range(
			of: "^(bounce|bounces|mailer-daemon|noreply|no-reply|donotreply|do-not-reply|postmaster|notifications?|updates?|info|support|hello|team)",
			options: [.regularExpression, .caseInsensitive]) != nil
		if machine {
			let parts = domain.split(separator: ".")
			let brand = parts.count >= 2 ? String(parts[parts.count - 2]) : domain
			return brand.prefix(1).uppercased() + brand.dropFirst()
		}
		return local
	}

	/// "Rivera, Sam" reads "Sam Rivera" ("Acme, LLC" stays); "(via …)" and quotes go. The web's
	/// ThreadPeople.name rule (ui/src/utils/thread-text.ts).
	public static func readable(_ name: String) -> String {
		let name = name
			.replacingOccurrences(of: #"\s*\((via|on behalf of) [^)]*\)"#, with: "", options: [.regularExpression, .caseInsensitive])
			.trimmingCharacters(in: CharacterSet(charactersIn: " \"'").union(.whitespacesAndNewlines))
		let whole = NSRange(name.startIndex..., in: name)
		guard let match = flipped.firstMatch(in: name, range: whole),
		      let last = Range(match.range(at: 1), in: name), let first = Range(match.range(at: 2), in: name)
		else { return name }
		let given = String(name[first])
		guard company.firstMatch(in: given, range: NSRange(given.startIndex..., in: given)) == nil else { return name }
		return "\(given) \(name[last])"
	}

	nonisolated(unsafe) private static let flipped = try! NSRegularExpression(
		pattern: #"^([\p{L}'’-]+(?: [\p{L}'’-]+)?),\s*([\p{L}'’-]+(?: [\p{L}.'’-]+)?)$"#)
	nonisolated(unsafe) private static let company = try! NSRegularExpression(
		pattern: #"^(llc|pbc|inc\.?|ltd\.?|co\.?|corp\.?|llp|pllc|n\.a\.|lp)$"#, options: .caseInsensitive)

	public static func stripTags(_ html: String) -> String {
		guard html.contains("<") || html.contains("&") else { return html }
		var text = html
		text = text.replacingOccurrences(
			of: "<(style|script|head)[^>]*>[\\s\\S]*?</\\1>", with: " ", options: [.regularExpression, .caseInsensitive])
		text = text.replacingOccurrences(of: "<[^>]*>", with: " ", options: .regularExpression)
		return decodeEntities(text)
	}

	static func decodeEntities(_ text: String) -> String {
		guard text.contains("&") else { return text }
		var out = text
		for (entity, value) in [
			("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"),
			("&zwnj;", ""), ("&#8203;", ""), ("&amp;", "&"),
		] {
			out = out.replacingOccurrences(of: entity, with: value)
		}
		return out
	}

	public static func collapse(_ text: String) -> String {
		text.split(whereSeparator: { $0.isWhitespace || $0 == "\u{200C}" || $0 == "\u{034F}" })
			.joined(separator: " ")
	}

	/// Where repeated history or a legal footer starts in a one-line snippet (the web's
	/// ui/src/utils/row-format.ts newText): "On … wrote:", "-----Original Message", an Outlook
	/// "From: … Sent:", a rule of underscores, "Get Outlook for", a confidentiality notice.
	static let history: [(pattern: String, anyCase: Bool)] = [
		("\\bOn\\s.{4,160}?\\bwrote:", false),
		("-{2,}\\s*Original Message", true),
		("\\bFrom:\\s.{1,200}?\\b(?:Sent|Date):", false),
		("_{8,}", false),
		("\\bGet Outlook for\\b", false),
		("\\b(?:CONFIDENTIAL(?:ITY)? (?:NOTICE|COMMUNICATION)|THIS ELECTRONIC MESSAGE)\\b", true),
	]

	/// A row's snippet cut to the message's new text (design r2 §4 S1). History alone gives "".
	public static func newText(_ snippet: String) -> String {
		var cut = snippet.endIndex
		for rule in history {
			let options: String.CompareOptions = rule.anyCase ? [.regularExpression, .caseInsensitive] : .regularExpression
			if let range = snippet.range(of: rule.pattern, options: options), range.lowerBound < cut {
				cut = range.lowerBound
			}
		}
		return snippet[..<cut].trimmingCharacters(in: .whitespaces)
	}

	static let dayFormatter: DateFormatter = {
		let formatter = DateFormatter()
		formatter.calendar = Calendar(identifier: .gregorian)
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.dateFormat = "yyyy-MM-dd"
		return formatter
	}()
}
