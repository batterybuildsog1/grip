import Foundation
import MailClawKit

/// One composer's message kept on this device (L3 S5: "Drafts are state"). Written on every edit,
/// before and whether or not the server save works, so Cancel, leaving the conversation, closing
/// the window, quitting or a crash loses no word. The next composer for the same slot brings it back.
struct KeptDraft: Codable {
	let id: UUID
	/// What it answers: "reply:<conversation>" (Reply and Reply all share it), "forward:<conversation>",
	/// or "new" (each New message its own entry; New brings back the account's newest).
	var slot: String
	var mode: ComposeKind
	/// The message answered or forwarded.
	var emailId: String?
	var draftId: String?
	var revision: Int
	var from: String
	var to: String
	var cc: String
	var bcc: String
	var subject: String
	var body: String
	var quote: String
	var hasQuote: Bool
	var inReplyTo: String?
	var references: String?
	/// The server hasn't seen these words (or these files) yet.
	var unsaved: Bool
	var filesUnsaved: Bool
	var updatedAt: Date
}

/// The signed-in identity's kept drafts: one folder per identity (`Credentials.identityTag`) beside
/// the mail cache, never inside it (a cache reset or a damaged cache keeps every draft). Another
/// identity's folder is deleted when this one opens: drafts go with their identity, as on the web.
/// One small file per draft, its files in a second one written only when they change.
@MainActor
final class DraftShelf {
	private let directory: URL
	private var drafts: [UUID: KeptDraft] = [:]
	private var fileSignatures: [UUID: [String]] = [:]
	/// Drafts open in a composer, and that composer's request id: never handed to a second one.
	private var claims: [UUID: String] = [:]

	init(root: URL, identity: String, reset: Bool) {
		let files = FileManager.default
		directory = root.appendingPathComponent(identity, isDirectory: true)
		for other in (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
		where other.lastPathComponent != identity {
			try? files.removeItem(at: other)
		}
		if reset { try? files.removeItem(at: directory) }
		try? files.createDirectory(at: directory, withIntermediateDirectories: true)
		for url in (try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
		where url.pathExtension == "draft" {
			guard let data = try? Data(contentsOf: url),
			      let draft = try? JSONDecoder().decode(KeptDraft.self, from: data) else { continue }
			drafts[draft.id] = draft
		}
	}

	/// The newest unopened draft in `slot`. A New message's only under the selected account (its
	/// domain, as the Drafts list narrows; nil: All accounts).
	func find(slot: String, account: String?) -> KeptDraft? {
		drafts.values
			.filter { $0.slot == slot && claims[$0.id] == nil && (slot != "new" || Self.domain($0.from, matches: account)) }
			.max { $0.updatedAt < $1.updatedAt }
	}

	/// The unopened copy of a saved draft (a Drafts row).
	func find(draftId: String) -> KeptDraft? {
		drafts.values.first { $0.draftId == draftId && claims[$0.id] == nil }
	}

	/// The request of the composer that has this saved draft open (the Mac brings its window forward).
	func openRequest(draftId: String) -> String? {
		drafts.values.first { $0.draftId == draftId }.flatMap { claims[$0.id] }
	}

	func files(_ id: UUID) -> [DraftAttachment] {
		guard let data = try? Data(contentsOf: url(id, "files")),
		      let files = try? JSONDecoder().decode([DraftAttachment].self, from: data) else { return [] }
		fileSignatures[id] = Self.signature(files)
		return files
	}

	func keep(_ draft: KeptDraft, files: [DraftAttachment]) {
		drafts[draft.id] = draft
		write(draft, to: url(draft.id, "draft"))
		let signature = Self.signature(files)
		guard fileSignatures[draft.id] != signature else { return }
		fileSignatures[draft.id] = signature
		if files.isEmpty { try? FileManager.default.removeItem(at: url(draft.id, "files")) }
		else { write(files, to: url(draft.id, "files")) }
	}

	/// Sent or discarded (here, or found sent or deleted on the server): it never comes back.
	func remove(_ id: UUID) {
		drafts[id] = nil
		fileSignatures[id] = nil
		for kind in ["draft", "files"] { try? FileManager.default.removeItem(at: url(id, kind)) }
	}

	func claim(_ id: UUID, by request: String) { claims[id] = request }
	func release(_ id: UUID) { claims[id] = nil }

	private func url(_ id: UUID, _ kind: String) -> URL {
		directory.appendingPathComponent("\(id.uuidString).\(kind)")
	}

	private func write(_ value: some Encodable, to url: URL) {
		guard let data = try? JSONEncoder().encode(value) else { return }
		try? data.write(to: url, options: .atomic)
	}

	private static func signature(_ files: [DraftAttachment]) -> [String] {
		files.map { "\($0.filename)|\($0.contentBase64.count)" }
	}

	private static func domain(_ address: String, matches account: String?) -> Bool {
		guard let account else { return true }
		let domain = { (value: String) in value.split(separator: "@").last.map { $0.lowercased() } ?? "" }
		return domain(address) == domain(account)
	}
}
