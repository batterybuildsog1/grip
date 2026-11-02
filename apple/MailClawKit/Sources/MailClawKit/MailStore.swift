import Foundation
import GRDB
import CryptoKit

/// The on-device copy of the mail the app has seen (ticket 13): one SQLite file, read before any
/// network call so launch never waits for the server. Search runs on the server only (r2 S4: offline,
/// nothing is searched, and the app says so), so the store keeps no search index.
///
/// - `conversation`: what a list row shows, one row per thread.
/// - `view_member`: which views list a thread, ordered like the server (latest first).
/// - `thread`: the last full detail response of each opened thread, as received.
/// - `kv`: notes and per-view sync state.
///
/// Only a cache: everything in it comes back with the next sync, and nothing else (credentials,
/// drafts) lives here. So a file this build cannot use is erased and rebuilt, never worked around
/// (d2-21: another build's migration had dropped `search`). See scripts/cache-compat-failure-modes.md.
public final class MailStore: Sendable {
	private let db: DatabasePool
	public let directory: URL

	public init(url: URL) throws {
		directory = url.deletingLastPathComponent()
		try FileManager.default.createDirectory(
			at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		var configuration = Configuration()
		configuration.label = "mailclaw.store"
		db = try Self.open(url, configuration)
	}

	private static func open(_ url: URL, _ configuration: Configuration) throws -> DatabasePool {
		do {
			let db = try DatabasePool(path: url.path, configuration: configuration)
			try rebuildIfIncompatible(db)
			return db
		} catch {
			// Not a database at all (damaged): start a new file.
			destroy(at: url)
			let db = try DatabasePool(path: url.path, configuration: configuration)
			try migrator.migrate(db)
			return db
		}
	}

	public static var defaultURL: URL {
		let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
		return base.appendingPathComponent("io.examplebusiness.mailclaw", isDirectory: true)
			.appendingPathComponent("mail.sqlite")
	}

	/// Each server/account owns a separate store, including attachments. Never uses the old
	/// unscoped developer store. Full SHA-256 avoids identity collisions and filenames with PII.
	public static func scopedURL(identity: String) -> URL {
		let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
		return defaultURL.deletingLastPathComponent().appendingPathComponent("accounts", isDirectory: true)
			.appendingPathComponent(digest, isDirectory: true).appendingPathComponent("mail.sqlite")
	}

	/// Close before removing a signed-out account so late cancelled tasks cannot persist data.
	public func close() throws { try db.close() }

	/// Runs attachment writes while the store is open. Closing a signed-out store fences
	/// detached message/image tasks too, so a late response cannot recreate deleted mail files.
	func saveAttachment(_ data: Data, to file: URL) throws {
		guard file.path.hasPrefix(directory.path + "/") else { throw APIError.decoding("Invalid attachment path") }
		try db.read { _ in
			try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
			try data.write(to: file, options: .atomic)
		}
	}

	/// Deletes the store files (`-MCResetCache`, used by the cold-launch test).
	public static func destroy(at url: URL) {
		for suffix in ["", "-wal", "-shm"] {
			try? FileManager.default.removeItem(atPath: url.path + suffix)
		}
	}

	private static var migrator: DatabaseMigrator {
		var migrator = DatabaseMigrator()
		migrator.registerMigration("v1") { db in
			try db.execute(sql: """
				CREATE TABLE conversation (
					id TEXT PRIMARY KEY NOT NULL,
					latest_at INTEGER NOT NULL,
					sender TEXT NOT NULL,
					subject TEXT NOT NULL,
					snippet TEXT NOT NULL,
					people TEXT NOT NULL,
					message_count INTEGER NOT NULL,
					unread INTEGER NOT NULL,
					has_attachments INTEGER NOT NULL,
					is_draft INTEGER NOT NULL,
					is_outbound INTEGER NOT NULL,
					display_email_id TEXT
				);
				CREATE TABLE view_member (
					view TEXT NOT NULL,
					conversation_id TEXT NOT NULL,
					latest_at INTEGER NOT NULL,
					PRIMARY KEY (view, conversation_id)
				) WITHOUT ROWID;
				CREATE INDEX view_member_order ON view_member (view, latest_at DESC, conversation_id DESC);
				CREATE TABLE thread (
					conversation_id TEXT PRIMARY KEY NOT NULL,
					body BLOB NOT NULL,
					fetched_at INTEGER NOT NULL
				);
				CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL);
				CREATE VIRTUAL TABLE search USING fts5(
					subject, people, snippet, body, tokenize = 'unicode61 remove_diacritics 2'
				);
				""")
		}
		migrator.registerMigration("v2") { db in
			// The on-device search index: search runs on the server only (r2 S4).
			try db.execute(sql: "DROP TABLE IF EXISTS search")
		}
		migrator.registerMigration("v3") { db in
			// The row's file names and count (L3 Mac rows; display_attachment_names, attachment_count).
			try db.execute(sql: "ALTER TABLE conversation ADD COLUMN file_names TEXT NOT NULL DEFAULT ''")
			try db.execute(sql: "ALTER TABLE conversation ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0")
		}
		return migrator
	}

	/// Erases and recreates the store when it is not exactly what this build's migrations make:
	/// migrations it does not know (GRDB skips those silently), or any table, index or trigger
	/// that differs. Returns true when it rebuilt; the next sync fills it again.
	@discardableResult
	public func rebuildIfIncompatible() throws -> Bool {
		try Self.rebuildIfIncompatible(db)
	}

	@discardableResult
	private static func rebuildIfIncompatible(_ db: DatabasePool) throws -> Bool {
		if (try? isCompatible(db)) == true { return false }
		try db.erase()
		try migrator.migrate(db)
		return true
	}

	private static func isCompatible(_ db: DatabasePool) throws -> Bool {
		try migrator.migrate(db)
		let expected = try DatabaseQueue()
		try migrator.migrate(expected)
		let want = try expected.read(schema)
		return try db.read { db in try !migrator.hasBeenSuperseded(db) && schema(db) == want }
	}

	/// Every table, index and trigger with its SQL, without GRDB's own bookkeeping.
	private static func schema(_ db: Database) throws -> Set<String> {
		try Set(String.fetchAll(db, sql: """
			SELECT type || ' ' || name || ' ' || IFNULL(sql, '') FROM sqlite_master
			WHERE tbl_name != 'grdb_migrations'
			"""))
	}

	// MARK: Reads (fast, any thread)

	/// A view's rows, kept under `view.rawValue` (the view in one account, or in all of them).
	public func rows(in view: MailView, limit: Int = 5000) throws -> [ConversationRow] {
		try db.read { db in
			try Row.fetchAll(db, sql: """
				SELECT c.* FROM view_member m JOIN conversation c ON c.id = m.conversation_id
				WHERE m.view = ? ORDER BY m.latest_at DESC, m.conversation_id DESC LIMIT ?
				""", arguments: [view.rawValue, limit]).map(Self.row)
		}
	}

	/// Unread conversations a view lists on device (the sidebar's Personal count).
	public func unreadCount(in view: MailView) throws -> Int {
		try db.read { db in
			try Int.fetchOne(db, sql: """
				SELECT COUNT(*) FROM view_member m JOIN conversation c ON c.id = m.conversation_id
				WHERE m.view = ? AND c.unread = 1
				""", arguments: [view.rawValue]) ?? 0
		}
	}

	/// latest_at of the newest row a view lists on device.
	func newestAt(in view: MailView) throws -> Int64? {
		try db.read { db in
			try Int64.fetchOne(db, sql: "SELECT MAX(latest_at) FROM view_member WHERE view = ?", arguments: [view.rawValue])
		}
	}

	public func thread(id: String) throws -> ConversationDetail? {
		let body = try db.read { db in
			try Data.fetchOne(db, sql: "SELECT body FROM thread WHERE conversation_id = ?", arguments: [id])
		}
		guard let body else { return nil }
		return try? JSON.data(ConversationDetail.self, from: body)
	}

	public func notes() throws -> [ActionNote] {
		guard let body = try value(for: "notes") else { return [] }
		return (try? JSON.data(NotesResponse.self, from: body).notes) ?? []
	}

	/// The last `/api/meta` the device received (accounts and people), nil before the first.
	public func meta() throws -> MailMeta? {
		guard let body = try value(for: "meta") else { return nil }
		return try? JSON.data(MailMeta.self, from: body)
	}

	public func syncState(_ view: MailView) throws -> SyncState? {
		guard let data = try value(for: "sync:\(view.rawValue)") else { return nil }
		return try? JSONDecoder().decode(SyncState.self, from: data)
	}

	private func value(for key: String) throws -> Data? {
		try db.read { db in try Data.fetchOne(db, sql: "SELECT value FROM kv WHERE key = ?", arguments: [key]) }
	}

	// MARK: Writes

	/// Stores one page of a view and reconciles its time window: rows the store lists in
	/// (bottom, top) that the server no longer returns have left the view. Pages are contiguous
	/// (keyset cursor), so successive windows tile the timeline; `top` is the previous page's last
	/// row, which this page never repeats, so it is left out. The last page has no bottom;
	/// `dropBelow` also drops every stored row below the page.
	func applyPage(
		_ summaries: [ConversationSummary], view: MailView, top: Int64?, isLast: Bool, dropBelow: Bool = false
	) throws -> Int64? {
		let bottom = isLast ? Int64.min : (summaries.map(\.latestMessageAt).min() ?? Int64.min)
		let windowBottom = dropBelow ? Int64.min : bottom
		let key = view.rawValue
		try db.write { db in
			try upsert(summaries, db)
			let ids = summaries.map(\.id)
			let placeholders = ids.isEmpty ? "''" : Array(repeating: "?", count: ids.count).joined(separator: ",")
			var arguments: StatementArguments = [key, windowBottom, top ?? Int64.max]
			arguments += StatementArguments(ids)
			try db.execute(sql: """
				DELETE FROM view_member WHERE view = ? AND latest_at > ? AND latest_at < ?
				AND conversation_id NOT IN (\(placeholders))
				""", arguments: arguments)
			for summary in summaries {
				try db.execute(
					sql: "INSERT OR REPLACE INTO view_member (view, conversation_id, latest_at) VALUES (?, ?, ?)",
					arguments: [key, summary.id, summary.latestMessageAt])
			}
		}
		return isLast ? nil : bottom
	}

	/// Stores summaries without touching any view (server search results).
	func save(_ summaries: [ConversationSummary]) throws {
		try db.write { db in try upsert(summaries, db) }
	}

	func saveThread(_ body: Data, detail: ConversationDetail) throws {
		try db.write { db in
			try db.execute(
				sql: "INSERT OR REPLACE INTO thread (conversation_id, body, fetched_at) VALUES (?, ?, ?)",
				arguments: [detail.conversation.id, body, Int64(Date().timeIntervalSince1970 * 1000)])
			try upsert([detail.conversation], db)
		}
	}

	func saveNotes(_ body: Data) throws {
		try db.write { db in try db.execute(sql: "INSERT OR REPLACE INTO kv VALUES ('notes', ?)", arguments: [body]) }
	}

	func saveMeta(_ body: Data) throws {
		try db.write { db in try db.execute(sql: "INSERT OR REPLACE INTO kv VALUES ('meta', ?)", arguments: [body]) }
	}

	func setSyncState(_ state: SyncState, for view: MailView) throws {
		let data = try JSONEncoder().encode(state)
		let key = "sync:\(view.rawValue)"
		try db.write { db in
			try db.execute(sql: "INSERT OR REPLACE INTO kv VALUES (?, ?)", arguments: [key, data])
		}
	}

	/// Triage (S7) the server confirmed: these conversations no longer belong to `view`.
	func removeFromView(_ ids: [String], view: MailView) throws {
		guard !ids.isEmpty else { return }
		let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
		let name = view.rawValue
		try db.write { db in
			var arguments: StatementArguments = [name]
			arguments += StatementArguments(ids)
			try db.execute(
				sql: "DELETE FROM view_member WHERE view = ? AND conversation_id IN (\(placeholders))",
				arguments: arguments)
		}
	}

	/// Triage (S7) the server confirmed: these conversations are read, or unread.
	func setUnread(_ ids: [String], _ unread: Bool) throws {
		guard !ids.isEmpty else { return }
		let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
		try db.write { db in
			var arguments: StatementArguments = [unread]
			arguments += StatementArguments(ids)
			try db.execute(
				sql: "UPDATE conversation SET unread = ? WHERE id IN (\(placeholders))", arguments: arguments)
		}
	}

	/// Debug seam for the list-jump test: forget the newest `count` rows of a view, as if they
	/// arrived after the last sync.
	public func dropNewest(_ count: Int, in view: MailView) throws {
		try db.write { db in
			try db.execute(sql: """
				DELETE FROM view_member WHERE view = ?1 AND conversation_id IN (
					SELECT conversation_id FROM view_member WHERE view = ?1
					ORDER BY latest_at DESC, conversation_id DESC LIMIT ?2)
				""", arguments: [view.rawValue, count])
		}
	}

	/// Debug seam for the hostile-HTML fixture: store a thread detail (a full API response body)
	/// without listing it in any view.
	public func saveFixtureThread(_ body: Data) throws {
		let detail = try JSON.data(ConversationDetail.self, from: body)
		try db.write { db in
			try db.execute(
				sql: "INSERT OR REPLACE INTO thread (conversation_id, body, fetched_at) VALUES (?, ?, 0)",
				arguments: [detail.conversation.id, body])
		}
	}

	// MARK: Internals

	private func upsert(_ summaries: [ConversationSummary], _ db: Database) throws {
		for summary in summaries {
			let row = ConversationRow(summary: summary)
			let people = (summary.participants ?? []).map { [$0.name ?? "", $0.address].joined(separator: " ") }
				.joined(separator: " ")
			try db.execute(sql: """
				INSERT INTO conversation (id, latest_at, sender, subject, snippet, people, message_count, unread,
					has_attachments, is_draft, is_outbound, display_email_id, file_names, file_count)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET latest_at = excluded.latest_at, sender = excluded.sender,
					subject = excluded.subject, snippet = excluded.snippet, people = excluded.people,
					message_count = excluded.message_count, unread = excluded.unread,
					has_attachments = excluded.has_attachments, is_draft = excluded.is_draft,
					is_outbound = excluded.is_outbound, display_email_id = excluded.display_email_id,
					file_names = excluded.file_names, file_count = excluded.file_count
				""", arguments: [
					row.id, row.latestAt, row.sender, row.subject, row.snippet, people, row.messageCount,
					row.unread, row.hasAttachments, row.isDraft, row.isOutbound, row.displayEmailId,
					row.fileNames.joined(separator: Self.nameSeparator), row.fileCount,
				])
		}
	}

	private static func row(_ row: Row) -> ConversationRow {
		let names: String = row["file_names"] ?? ""
		return ConversationRow(
			id: row["id"], latestAt: row["latest_at"], sender: row["sender"], subject: row["subject"],
			snippet: row["snippet"], messageCount: row["message_count"], unread: row["unread"],
			hasAttachments: row["has_attachments"], isDraft: row["is_draft"], isOutbound: row["is_outbound"],
			displayEmailId: row["display_email_id"],
			fileNames: names.isEmpty ? [] : names.components(separatedBy: nameSeparator),
			fileCount: row["file_count"] ?? 0)
	}

	/// File names are stored in one column, split by the ASCII unit separator (never in a name).
	private static let nameSeparator = "\u{1F}"
}

/// Where a view's sync stands: when page 1 last succeeded, and where back-fill continues.
public struct SyncState: Codable, Sendable {
	public var refreshedAt: Date?
	/// Keyset cursor of the next older page, nil when the view is complete.
	public var cursor: String?
	/// latest_at of the oldest row the last stored page covered (top of the next window).
	public var bottom: Int64?
	public var complete: Bool
	public var completedAt: Date?
}
