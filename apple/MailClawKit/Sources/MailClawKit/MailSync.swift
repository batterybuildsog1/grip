import Foundation
import Synchronization

/// Fetches from the API into the store. There is no sync feed yet (plan v2 Phase 1), so views are
/// kept fresh from list pages: page 1 on every refresh, older pages by back-fill (Personal) or as
/// the user scrolls (other views).
public final class MailSync: Sendable {
	public let api: APIClient
	public let store: MailStore
	static let pageSize = 100
	/// Read and unread this device asked for, and when the server confirmed it (nil while on its
	/// way). A list page or thread asked before then answers with the old state; it's put back.
	private let readMarks = Mutex<[String: ReadMark]>([:])

	private struct ReadMark {
		let unread: Bool
		var confirmedAt: Date?
	}

	public init(api: APIClient, store: MailStore) {
		self.api = api
		self.store = store
	}

	// MARK: Views

	/// Fetches page 1 of a view and reconciles it. Throws `APIError.offline` without a network.
	/// When page 1 no longer reaches the newest stored row (more new mail than a page since the
	/// last visit), the stored rows below it are dropped and paging restarts below page 1, so no
	/// stretch of the timeline the device never saw sits hidden between them.
	/// A view in one account (`MailView.account`) is its own list with its own paging.
	public func refresh(_ view: MailView) async throws {
		let asked = Date()
		let page = try await fetchPage(view, cursor: nil)
		try Task.checkCancellation()
		do {
			try apply(page, to: view)
		} catch {
			// Another build changed the store's schema while this app ran (failure mode 5): rebuild
			// it once and keep the page; any other store failure is the caller's to report.
			guard try store.rebuildIfIncompatible() else { throw error }
			try apply(page, to: view)
		}
		try keepReadMarks(askedAt: asked)
	}

	private func apply(_ page: ConversationPage, to view: MailView) throws {
		let pageBottom = page.conversations.map(\.latestMessageAt).min() ?? .min
		let newestStored = try store.newestAt(in: view)
		let gap = page.nextCursor != nil && newestStored.map { $0 < pageBottom } == true
		let bottom = try store.applyPage(
			page.conversations, view: view, top: nil, isLast: page.nextCursor == nil, dropBelow: gap)
		var state = try store.syncState(view) ?? SyncState(complete: false)
		state.refreshedAt = Date()
		if (state.cursor == nil && !state.complete) || page.nextCursor == nil || gap {
			// First sync of this view, a gap, or it fits in one page: paging continues below page 1.
			state.cursor = page.nextCursor
			state.bottom = bottom
			state.complete = page.nextCursor == nil
			if state.complete { state.completedAt = Date() }
		}
		try store.setSyncState(state, for: view)
	}

	/// Fetches the next older page of a view. Returns false when the view is complete.
	@discardableResult
	public func loadMore(_ view: MailView) async throws -> Bool {
		guard var state = try store.syncState(view), let cursor = state.cursor, !state.complete
		else { return false }
		let asked = Date()
		let page = try await fetchPage(view, cursor: cursor)
		try Task.checkCancellation()
		state.bottom = try store.applyPage(
			page.conversations, view: view, top: state.bottom, isLast: page.nextCursor == nil)
		try keepReadMarks(askedAt: asked)
		state.cursor = page.nextCursor
		state.complete = page.nextCursor == nil
		if state.complete { state.completedAt = Date() }
		try store.setSyncState(state, for: view)
		return !state.complete
	}

	/// Brings the whole view on device, one page at a time, paced well under the API limit
	/// (120 requests a minute per token, shared with agents). A sweep older than a day restarts
	/// below page 1 so rows that left the view in the middle of the timeline are dropped.
	public func backfill(_ view: MailView, pause: Duration = .milliseconds(1500)) async {
		do {
			if var state = try store.syncState(view), state.complete,
			   let done = state.completedAt, Date().timeIntervalSince(done) > 86_400 {
				state.complete = false
				state.cursor = nil
				try store.setSyncState(state, for: view)
				try await refresh(view)
			}
			while !Task.isCancelled {
				do {
					guard try await loadMore(view) else { return }
				} catch let APIError.http(429, retryAfter) {
					try await Task.sleep(for: .seconds(retryAfter ?? 30))
					continue
				}
				try await Task.sleep(for: pause)
			}
		} catch {
			// Offline or cancelled: the next launch or refresh continues from the stored cursor.
		}
	}

	/// `act` records read or unread before it asks the server, confirms it once the server has it, and
	/// forgets it when refused (the stored row back to `restoring`, as the screen goes back).
	func noteReadMarks(_ ids: [String], unread: Bool) {
		readMarks.withLock { marks in for id in ids { marks[id] = ReadMark(unread: unread) } }
	}

	func confirmReadMarks(_ ids: [String]) {
		let now = Date()
		readMarks.withLock { marks in for id in ids { marks[id]?.confirmedAt = now } }
	}

	func forgetReadMarks(_ ids: [String], restoring unread: Bool) {
		readMarks.withLock { marks in for id in ids { marks[id] = nil } }
		try? store.setUnread(ids, unread)
	}

	/// Puts back the read state this device set that an answer asked at `asked` predates: still on
	/// its way, or confirmed after `asked` (review, 2026-10-30: a list refresh in flight while a row was
	/// opened answered after the mark and showed it unread again). Marks confirmed over ten minutes
	/// ago are dropped: the server's answers carry them by then.
	private func keepReadMarks(askedAt asked: Date) throws {
		let now = Date()
		let kept = readMarks.withLock { marks in
			marks = marks.filter { $0.value.confirmedAt.map { now.timeIntervalSince($0) < 600 } ?? true }
			return marks.filter { $0.value.confirmedAt.map { $0 > asked } ?? true }
		}
		try store.setUnread(kept.filter { !$0.value.unread }.map(\.key), false)
		try store.setUnread(kept.filter { $0.value.unread }.map(\.key), true)
	}

	private func fetchPage(_ view: MailView, cursor: String?) async throws -> ConversationPage {
		var query = view.filters + [("limit", String(Self.pageSize))]
		if let cursor { query.append(("cursor", cursor)) }
		let body = try await api.get(["api", "conversations"], query: query)
		return try JSON.data(ConversationPage.self, from: body)
	}

	// MARK: Notes

	public func refreshNotes() async throws {
		let body = try await api.get(["api", "notes"])
		_ = try JSON.data(NotesResponse.self, from: body)
		try Task.checkCancellation()
		try store.saveNotes(body)
	}

	/// Done on a Needs-you note: POST /api/notes/:email_id/done.
	public func markNoteDone(_ note: ActionNote) async throws {
		_ = try await api.write(.post, ["api", "notes", note.emailId, "done"])
	}

	/// Undo of Done: PUT /api/notes/:email_id sets the note again and re-opens it.
	public func reopenNote(_ note: ActionNote) async throws {
		struct Body: Encodable {
			let note: String
			let due: String?
		}
		let body = try JSONEncoder().encode(Body(note: note.note, due: note.due))
		_ = try await api.write(.put, ["api", "notes", note.emailId], json: body)
	}

	// MARK: Accounts and people

	/// The account menu's addresses and the forwarded-in people; stored for the next launch.
	public func refreshMeta() async throws -> MailMeta {
		let body = try await api.get(["api", "meta"])
		let meta = try JSON.data(MailMeta.self, from: body)
		try store.saveMeta(body)
		return meta
	}

	// MARK: Threads

	/// The anchor message alone (fast, ~10 KB) — what the web shows first.
	public func threadAnchor(id: String, emailId: String?) async throws -> ConversationDetail {
		var query: [(String, String)] = []
		if let emailId { query.append(("email_id", emailId)) }
		let body = try await api.get(["api", "conversations", id], query: query)
		return try JSON.data(ConversationDetail.self, from: body)
	}

	/// Every message of the thread; stored, so the next open is instant and its text is searchable.
	@discardableResult
	public func threadFull(id: String, emailId: String?) async throws -> ConversationDetail {
		var query: [(String, String)] = [("load", "full")]
		if let emailId { query.append(("email_id", emailId)) }
		let asked = Date()
		let body = try await api.get(["api", "conversations", id], query: query)
		try Task.checkCancellation()
		let detail = try JSON.data(ConversationDetail.self, from: body)
		// Kept for the next open; a store that cannot keep it never hides the thread it fetched.
		try? store.saveThread(body, detail: detail)
		try? keepReadMarks(askedAt: asked)
		return detail
	}

	/// Warms the cache with the newest threads of a view that are not stored yet, one at a time.
	public func prefetch(_ rows: [ConversationRow], pause: Duration = .milliseconds(300)) async {
		for row in rows where !Task.isCancelled {
			guard (try? store.thread(id: row.id))?.conversation.latestMessageAt != row.latestAt else { continue }
			do {
				try await threadFull(id: row.id, emailId: row.displayEmailId)
				try await Task.sleep(for: pause)
			} catch {
				return
			}
		}
	}

	// MARK: Search and attachments

	/// Server search, the web's (r2 S4): All Mail, or with `view` narrowed to that view's filters
	/// (`scope=view`, the view's pill). Search runs on the server only: offline nothing is searched.
	/// The results' summaries are kept (in no view) so an opened result reads like any row.
	public func search(_ query: String, narrowedTo view: MailView? = nil) async throws -> SearchAnswer {
		var params: [(String, String)] = [("q", query), ("limit", String(SearchCount.cap))]
		if let view, !view.filters.isEmpty { params += view.filters + [("scope", "view")] }
		let asked = Date()
		let body = try await api.get(["api", "conversations"], query: params)
		let page = try JSON.data(ConversationPage.self, from: body)
		try Task.checkCancellation()
		// Kept so an opened result reads like any row; a store that cannot keep them never hides
		// the results (m3-17).
		try? store.save(page.conversations)
		try? keepReadMarks(askedAt: asked)
		return SearchAnswer(
			results: page.conversations.map(SearchResult.init(summary:)),
			hasMore: page.hasMore ?? (page.nextCursor != nil),
			query: page.search?.query,
			correctedFrom: page.search?.correctedFrom,
			suggestion: page.search?.suggestion)
	}

	/// Attachment bytes, kept in Caches so cached threads still show inline images offline.
	public func attachment(_ attachment: Attachment) async throws -> URL {
		let directory = store.directory.appendingPathComponent("attachments", isDirectory: true)
			.appendingPathComponent(APIClient.encode(attachment.emailId), isDirectory: true)
			.appendingPathComponent(APIClient.encode(attachment.id), isDirectory: true)
		let name = (attachment.filename ?? "attachment")
			.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
		let file = directory.appendingPathComponent(name.isEmpty ? "attachment" : name)
		if FileManager.default.fileExists(atPath: file.path) { return file }
		let data = try await api.get(["api", "emails", attachment.emailId, "attachments", attachment.id])
		try Task.checkCancellation()
		try store.saveAttachment(data, to: file)
		return file
	}
}
