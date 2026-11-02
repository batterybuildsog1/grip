import Foundation

// Compose for the native app (r2 build spec, S5): reply, reply all, forward and new mail as server
// drafts (POST/PATCH /api/emails/drafts), sent with POST /api/emails/drafts/:id/send. The rules
// for who a reply goes to, its subject and its quote are the web's (ui/src/utils/reply-format.ts).

public enum ComposeKind: String, Codable, Sendable, Hashable {
	case new, reply, replyAll = "reply-all", forward
}

/// The message being answered or forwarded (GET /api/emails/:id).
public struct ReplySource: Decodable, Sendable {
	public let id: String
	public let fromAddress: String
	public let fromName: String?
	public let toAddress: String?
	public let toAddresses: [String]?
	public let ccAddresses: [String]?
	public let replyToAddresses: [String]?
	public let direction: String
	public let subject: String?
	public let messageId: String?
	public let referencesHeader: String?
	public let textContent: String?
	public let htmlContent: String?
	public let receivedAt: Int64
	public let sentAt: Int64?
	public let threadParticipants: [Participant]?

	/// A name for an address: the message's own headers first, then one made from the address.
	public func name(for address: String) -> String {
		let key = address.lowercased()
		if fromAddress.lowercased() == key { return Display.name(address: fromAddress, name: fromName) }
		if let named = threadParticipants?.first(where: { $0.address.lowercased() == key }) {
			return Display.name(address: named.address, name: named.name)
		}
		return Display.name(address: address, name: nil)
	}
}

/// What a reply or forward starts with.
public struct ComposePlan: Sendable, Equatable {
	/// The account that received the message (nil: keep the default).
	public var from: String?
	public var to: [String]
	public var cc: [String]
	/// The people Reply all adds to a plain reply.
	public var others: [String]
	public var subject: String
	public var inReplyTo: String?
	public var references: String?
	/// Sent under the typed text: the quoted original, or the forwarded message.
	public var quote: String
}

public enum Reply {
	public static func plan(_ kind: ComposeKind, source: ReplySource, own: [String]) -> ComposePlan {
		let mine = Set(own.map { $0.lowercased() })
		let from = sender(source: source, own: own)
		if kind == .forward {
			return ComposePlan(
				from: from, to: [], cc: [], others: [], subject: subject(source.subject, prefix: "Fwd"),
				inReplyTo: nil, references: nil, quote: forwarded(source))
		}
		let (to, rest) = recipients(source: source, own: mine)
		let references = source.messageId.flatMap { id in
			dedupeReferences([source.referencesHeader, id].compactMap { $0 }.joined(separator: " "))
		}
		return ComposePlan(
			from: from, to: to.isEmpty ? [] : [to], cc: kind == .replyAll ? rest : [], others: rest,
			subject: subject(source.subject, prefix: "Re"), inReplyTo: source.messageId,
			references: references, quote: quoted(source))
	}

	/// Our own sent message keeps its identity; inbound mail is answered from the account that got it.
	static func sender(source: ReplySource, own: [String]) -> String? {
		if source.direction == "outbound" {
			return own.first { $0.lowercased() == source.fromAddress.lowercased() }
		}
		let got = ([source.toAddress].compactMap { $0 } + (source.toAddresses ?? []) + (source.ccAddresses ?? []))
			.map { $0.lowercased() }
		return own.first { got.contains($0.lowercased()) }
	}

	/// ui/src/utils/reply-format.ts buildReplyRecipients: who the reply goes to, and everyone else.
	static func recipients(source: ReplySource, own: Set<String>) -> (String, [String]) {
		let originalTo = (source.toAddresses?.isEmpty == false ? source.toAddresses : nil)
			?? [source.toAddress].compactMap { $0 }
		let replyTo = source.replyToAddresses ?? []
		let primary = source.direction == "outbound" ? originalTo : (replyTo.isEmpty ? [source.fromAddress] : replyTo)
		let extra = source.direction != "outbound" && replyTo.isEmpty ? [source.fromAddress] : []
		var seen = Set<String>()
		let all = (primary + extra + originalTo + (source.ccAddresses ?? [])).compactMap { raw -> String? in
			let address = raw.trimmingCharacters(in: .whitespaces)
			guard !address.isEmpty, seen.insert(address.lowercased()).inserted else { return nil }
			return address
		}
		let external = all.filter { !own.contains($0.lowercased()) }
		let to = external.first ?? all.first ?? ""
		return (to, external.filter { $0.lowercased() != to.lowercased() })
	}

	/// "Re: " / "Fwd: " once, whatever prefixes the subject already had.
	public static func subject(_ subject: String?, prefix: String) -> String {
		var stripped = subject?.trimmingCharacters(in: .whitespaces) ?? ""
		let pattern = "^(?:re|fwd|fw|forward)(?:\\[\\d+\\])?:\\s*"
		while let range = stripped.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
			stripped = String(stripped[range.upperBound...]).trimmingCharacters(in: .whitespaces)
		}
		return stripped.isEmpty ? "\(prefix): " : "\(prefix): \(stripped)"
	}

	static func text(_ source: ReplySource) -> String {
		let raw = source.textContent?.isEmpty == false ? source.textContent! : Display.stripTags(source.htmlContent ?? "")
		return raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
			.replacingOccurrences(of: "\u{00A0}", with: " ")
	}

	static func mailbox(_ name: String?, _ address: String) -> String {
		if let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return "\(name) <\(address)>" }
		return address
	}

	static let dateFormatter: DateFormatter = {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.dateFormat = "EEE, MMM d, yyyy 'at' h:mm a"
		return formatter
	}()

	static func date(_ source: ReplySource) -> String {
		let ms = source.sentAt ?? source.receivedAt
		return dateFormatter.string(from: Date(timeIntervalSince1970: Double(ms < 100_000_000_000 ? ms * 1000 : ms) / 1000))
	}

	/// buildPlainReplyBody: a blank line, the attribution, the original with "> ".
	static func quoted(_ source: ReplySource) -> String {
		let lines = text(source).split(separator: "\n", omittingEmptySubsequences: false)
			.map { $0.isEmpty ? ">" : "> \($0)" }
		return "\n\nOn \(date(source)), \(mailbox(source.fromName, source.fromAddress)) wrote:\n" + lines.joined(separator: "\n")
	}

	static func forwarded(_ source: ReplySource) -> String {
		let to = (source.toAddresses?.isEmpty == false ? source.toAddresses! : [source.toAddress].compactMap { $0 })
			.joined(separator: ", ")
		var lines = [
			"", "", "---------- Forwarded message ----------",
			"From: \(mailbox(source.fromName, source.fromAddress))",
			"Date: \(date(source))",
			"Subject: \(source.subject ?? "")",
			"To: \(to)",
		]
		if let cc = source.ccAddresses, !cc.isEmpty { lines.append("Cc: \(cc.joined(separator: ", "))") }
		lines += ["", text(source)]
		return lines.joined(separator: "\n")
	}

	static func dedupeReferences(_ raw: String) -> String? {
		var seen = Set<String>()
		var ids: [String] = []
		var rest = Substring(raw)
		while let open = rest.firstIndex(of: "<"), let close = rest[open...].firstIndex(of: ">") {
			let id = String(rest[open...close])
			if !id.dropFirst().dropLast().contains("<"), seen.insert(id).inserted { ids.append(id) }
			rest = rest[rest.index(after: close)...]
		}
		return ids.isEmpty ? nil : ids.joined(separator: " ")
	}

	/// What goes out: the typed text, then the quote (left out once cleared).
	public static func message(body: String, quote: String?) -> String {
		guard let quote, !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return body }
		var typed = body
		while typed.last?.isWhitespace == true { typed.removeLast() }
		return typed + (quote.hasPrefix("\n") ? "" : "\n\n") + quote
	}
}

public struct DraftAttachment: Codable, Sendable, Equatable {
	public let filename: String
	public let contentType: String
	public let contentBase64: String

	public init(filename: String, contentType: String, contentBase64: String) {
		self.filename = filename
		self.contentType = contentType
		self.contentBase64 = contentBase64
	}

	enum CodingKeys: String, CodingKey {
		case filename
		case contentType = "content_type"
		case contentBase64 = "content_base64"
	}
}

/// A draft's content, as POST/PATCH /api/emails/drafts takes it. Empty lists are left out of a
/// first save (the server accepts an unfinished draft; Send checks the recipients).
public struct DraftFields: Sendable, Equatable {
	public var from: String
	public var to: [String]
	public var cc: [String]
	public var bcc: [String]
	public var subject: String
	public var text: String
	public var inReplyTo: String?
	public var references: String?
	/// Sent only when the files changed since the last save.
	public var attachments: [DraftAttachment]?

	public init(
		from: String, to: [String], cc: [String], bcc: [String], subject: String, text: String,
		inReplyTo: String?, references: String?, attachments: [DraftAttachment]? = nil
	) {
		self.from = from
		self.to = to
		self.cc = cc
		self.bcc = bcc
		self.subject = subject
		self.text = text
		self.inReplyTo = inReplyTo
		self.references = references
		self.attachments = attachments
	}

	public var hasContent: Bool {
		!to.isEmpty || !cc.isEmpty || !bcc.isEmpty || !subject.trimmingCharacters(in: .whitespaces).isEmpty
			|| !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(attachments ?? []).isEmpty
	}

	func body(revision: Int?) throws -> Data {
		var object: [String: Any] = ["from": from]
		let existing = revision != nil
		if existing || !to.isEmpty { object["to"] = to }
		if existing || !cc.isEmpty { object["cc"] = cc }
		if existing || !bcc.isEmpty { object["bcc"] = bcc }
		if existing || !subject.isEmpty { object["subject"] = subject }
		let typed = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		if typed { object["text"] = text } else if existing { object["text"] = NSNull() }
		if let inReplyTo { object["in_reply_to"] = inReplyTo }
		if let references { object["references"] = references }
		if let attachments {
			object["attachments"] = attachments.map {
				["filename": $0.filename, "content_type": $0.contentType, "content_base64": $0.contentBase64]
			}
		}
		if let revision { object["draft_revision"] = revision }
		return try JSONSerialization.data(withJSONObject: object)
	}
}

public struct SavedDraft: Decodable, Sendable {
	public let id: String
	public let draftRevision: Int?
}

/// A draft as the server holds it (GET /api/emails/:id): opened from Drafts, or checked before this
/// device's copy is trusted. Not a draft any more (`mailboxState` "sent") or gone (404): sent or
/// deleted elsewhere.
public struct ServerDraft: Decodable, Sendable {
	public let id: String
	public let mailboxState: String
	public let draftRevision: Int?
	public let fromAddress: String
	public let toAddresses: [String]?
	public let ccAddresses: [String]?
	public let bccAddresses: [String]?
	public let subject: String?
	public let textContent: String?
	public let inReplyTo: String?
	public let referencesHeader: String?
	public let attachments: [Attachment]?

	public var isDraft: Bool { mailboxState == "draft" }
}

private struct DraftEnvelope: Decodable { let draft: SavedDraft }
private struct SendersMeta: Decodable { let allowedSenders: [String]? }

/// The compose calls. Writes go through `APIClient.write`, the app's only write path.
public struct ComposeAPI: Sendable {
	public let api: APIClient

	public init(api: APIClient) { self.api = api }

	/// Every address mail can be sent from (`allowed_senders`).
	public func senders() async throws -> [String] {
		try JSON.data(SendersMeta.self, from: try await api.get(["api", "meta"])).allowedSenders ?? []
	}

	public func source(_ emailId: String) async throws -> ReplySource {
		try JSON.data(ReplySource.self, from: try await api.get(["api", "emails", emailId]))
	}

	public func draft(_ id: String) async throws -> ServerDraft {
		try JSON.data(ServerDraft.self, from: try await api.get(["api", "emails", id]))
	}

	/// A saved draft's file, as the composer holds files (so a later save keeps it).
	public func file(_ attachment: Attachment) async throws -> DraftAttachment {
		let data = try await api.get(["api", "emails", attachment.emailId, "attachments", attachment.id])
		return DraftAttachment(
			filename: attachment.filename ?? "attachment", contentType: attachment.mimeType,
			contentBase64: data.base64EncodedString())
	}

	public func create(_ fields: DraftFields) async throws -> SavedDraft {
		let body = try await api.write(.post, ["api", "emails", "drafts"], json: try fields.body(revision: nil))
		return try JSON.data(DraftEnvelope.self, from: body).draft
	}

	public func update(_ id: String, _ fields: DraftFields, revision: Int) async throws -> SavedDraft {
		let body = try await api.write(.patch, ["api", "emails", "drafts", id], json: try fields.body(revision: revision))
		return try JSON.data(DraftEnvelope.self, from: body).draft
	}

	/// The server's send key row for the draft lets it go out once, whatever is retried.
	public func send(draftId: String) async throws {
		_ = try await api.write(.post, ["api", "emails", "drafts", draftId, "send"])
	}

	public func delete(draftId: String) async throws {
		_ = try await api.write(.delete, ["api", "emails", draftId])
	}
}
