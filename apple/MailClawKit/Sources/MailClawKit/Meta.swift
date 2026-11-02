import Foundation

/// What the account menu, the sidebar and Settings read from `GET /api/meta` (src/types.ts
/// PlatformMeta): the addresses the user sends from and the forwarded-in people (each with a view).
public struct MailMeta: Decodable, Sendable, Equatable {
	public let allowedSenders: [String]
	/// Conversations per forwarded-in person (`threads.for_person`, FORWARDED_FOR_JSON names).
	public let conversationForPersonCounts: [String: Int]
	/// The owner's display name per sending address (SENDER_NAMES_JSON): who "me" is on screen.
	public let senderNames: [String: String]

	public init(from decoder: any Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		allowedSenders = try container.decodeIfPresent([String].self, forKey: .allowedSenders) ?? []
		conversationForPersonCounts =
			try container.decodeIfPresent([String: Int].self, forKey: .conversationForPersonCounts) ?? [:]
		senderNames = try container.decodeIfPresent([String: String].self, forKey: .senderNames) ?? [:]
	}

	private enum CodingKeys: String, CodingKey {
		case allowedSenders, conversationForPersonCounts, senderNames
	}

	/// The configured name for one of this mailbox's addresses, or nil.
	public func senderName(_ address: String) -> String? {
		let key = address.trimmingCharacters(in: CharacterSet(charactersIn: "<> ")).lowercased()
		return senderNames.first { $0.key.lowercased() == key }?.value
	}

	/// The account menu's addresses: senders that are a person's own address. Role mailboxes
	/// (support@, noreply@) send but are not accounts (r2 S1: All accounts, then each address).
	public var accounts: [String] {
		allowedSenders.filter { address in
			let local = address.split(separator: "@").first.map(String.init)?.lowercased() ?? ""
			return !Self.roleMailboxes.contains(local)
		}
	}

	/// One sidebar view per forwarded-in person, by name.
	public var persons: [String] { conversationForPersonCounts.keys.sorted() }

	private static let roleMailboxes: Set<String> = [
		"support", "noreply", "no-reply", "donotreply", "info", "hello", "team", "billing", "admin", "reports",
	]
}
