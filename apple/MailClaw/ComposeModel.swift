import Foundation
import MailClawKit
import Observation
import UniformTypeIdentifiers

/// What to write: a reply, reply all or forward of a message, a saved draft, or new mail. A value,
/// so the Mac can open each composer in its own window (`WindowGroup(for:)`).
struct ComposeRequest: Codable, Hashable, Identifiable {
	/// Which draft: a conversation's reply ("reply:<id>", Reply and Reply all alike) or forward, a
	/// saved draft ("draft:<id>", a Drafts row), or a new message (each its own). Equal ids are the
	/// same request: the Mac brings that window forward instead of opening a second one.
	let id: String
	var kind: ComposeKind
	var emailId: String?
	var conversationId: String?
	/// A saved draft to edit (a Drafts row): its message id.
	var draftId: String?

	init(kind: ComposeKind, emailId: String? = nil, conversationId: String? = nil, draftId: String? = nil) {
		self.kind = kind
		self.emailId = emailId
		self.conversationId = conversationId
		self.draftId = draftId
		if let draftId { id = "draft:\(draftId)" }
		else if kind != .new, conversationId != nil { id = Self.slot(kind, conversationId) }
		else { id = "new:\(UUID().uuidString)" }
	}

	/// An open composer's request again (Mac: brings its window forward).
	init(reopening id: String) {
		self.id = id
		kind = .new
	}

	/// Where its message is kept on this device (KeptDraft.slot).
	static func slot(_ kind: ComposeKind, _ conversationId: String?) -> String {
		guard kind != .new, let conversationId else { return "new" }
		return kind == .forward ? "forward:\(conversationId)" : "reply:\(conversationId)"
	}

	static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
	func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// One message being written (r2 build spec, S5). Every edit is kept on this device at once
/// (DraftShelf) and a second later saved as a server draft; Send saves it, waits 5 seconds for Undo,
/// then sends the draft (the server's send key row lets a draft go out once). A failed send brings
/// the composer back and says so. Opening Reply, Forward or New again, or a Drafts row, brings the
/// kept message back (L3 S5: "Drafts are state"); sent or discarded, it never comes back.
@MainActor @Observable
final class ComposeModel: Identifiable {
	enum Saving: Equatable { case idle, saving, saved, failed(String) }
	enum Sending: Equatable { case idle, preparing, queued, sending, sent, failed(String) }

	struct Chip: Identifiable, Hashable {
		let address: String
		let name: String
		var id: String { address }
	}

	static let undoSeconds = 5.0

	let request: ComposeRequest
	nonisolated var id: String { request.id }
	private let api: ComposeAPI?
	private let shelf: DraftShelf?
	/// The selected account (nil: All accounts): a new message is From it.
	private let account: String?

	/// Reply becomes reply all with "Reply all (n)".
	private(set) var mode: ComposeKind
	var from = ""
	var to = ""
	var cc = ""
	var bcc = ""
	var subject = ""
	var body = ""
	/// The quoted original, or the forwarded message, sent under the typed text ("Quoted text").
	var quote = ""
	private(set) var hasQuote = false
	var showQuote = false
	var showCcBcc = false
	var editingRecipients = false
	private(set) var senders: [String] = []
	private(set) var source: ReplySource?
	private(set) var attachments: [DraftAttachment] = []
	private(set) var saving: Saving = .idle
	private(set) var sending: Sending = .idle
	/// One line above the message: what happened to this draft elsewhere, or why To and the quote
	/// are empty (the message couldn't be loaded).
	private(set) var problem: String?
	/// A saved draft's files couldn't be loaded here: they stay on the server untouched, so the
	/// composer offers no Attach or Remove.
	private(set) var filesLocked = false
	@ObservationIgnored var onSending: (@MainActor (Sending) -> Void)?

	private var others: [String] = []
	private var inReplyTo: String?
	private var references: String?
	private var attachmentsDirty = false
	/// The server draft; once sent, the sent message's id (the server keeps it).
	private(set) var draftId: String?
	private var revision = 0
	/// What the server has of this draft (nil: nothing, or not what is here).
	private var lastSaved: DraftFields?
	private var loaded = false
	/// This composer's copy on the device (KeptDraft.id), what it answers, and the message answered.
	@ObservationIgnored private var keptId = UUID()
	@ObservationIgnored private var slot: String
	@ObservationIgnored private var sourceId: String?
	/// Sent or discarded: nothing is saved or kept again.
	@ObservationIgnored private var finished = false
	@ObservationIgnored private var saveTask: Task<Void, Never>?
	@ObservationIgnored private var inFlight: Task<Bool, Never>?
	@ObservationIgnored private var sendTask: Task<Void, Never>?

	init(request: ComposeRequest, api: ComposeAPI?, shelf: DraftShelf? = nil, account: String? = nil) {
		self.request = request
		self.api = api
		self.shelf = shelf
		self.account = account
		mode = request.kind
		slot = ComposeRequest.slot(request.kind, request.conversationId)
		sourceId = request.emailId
	}

	var title: String {
		switch mode {
		case .new: "New message"
		case .reply: "Reply"
		case .replyAll: "Reply all"
		case .forward: "Forward"
		}
	}

	var isReply: Bool { mode == .reply || mode == .replyAll }
	var showsChips: Bool { isReply && !editingRecipients }

	var chips: [Chip] {
		(Self.addresses(to) + Self.addresses(cc) + Self.addresses(bcc)).map { address in
			Chip(address: address, name: source?.name(for: address) ?? Display.name(address: address, name: nil))
		}
	}

	/// The people "Reply all" adds that aren't on the reply yet.
	var replyAllAdds: [String] {
		guard mode == .reply else { return [] }
		let present = Set((Self.addresses(to) + Self.addresses(cc) + Self.addresses(bcc)).map { $0.lowercased() })
		return others.filter { !present.contains($0.lowercased()) }
	}

	var fields: DraftFields {
		DraftFields(
			from: from, to: Self.addresses(to), cc: Self.addresses(cc), bcc: Self.addresses(bcc), subject: subject,
			text: Reply.message(body: body, quote: hasQuote ? quote : nil), inReplyTo: inReplyTo,
			references: references)
	}

	var hasContent: Bool { fields.hasContent || !attachments.isEmpty }

	var canSend: Bool {
		guard api != nil, !Self.addresses(to).isEmpty, !from.isEmpty else { return false }
		switch sending {
		case .idle, .failed: return true
		default: return false
		}
	}

	/// The Undo is running or the server is sending: the composer steps aside.
	var isWaiting: Bool { sending == .queued || sending == .sending }

	var savingText: String {
		switch saving {
		case .idle: ""
		case .saving: "Saving…"
		case .saved: "Draft saved"
		case let .failed(reason): "Not saved: \(reason)"
		}
	}

	var saveFailed: Bool {
		if case .failed = saving { return true }
		return false
	}

	var sendProblem: String? {
		if case let .failed(reason) = sending { return reason }
		return nil
	}

	static func addresses(_ raw: String) -> [String] {
		raw.split(whereSeparator: { $0 == "," || $0 == ";" })
			.map { $0.trimmingCharacters(in: .whitespaces) }
			.filter { !$0.isEmpty }
	}

	// MARK: Loading

	/// This device's copy of the draft when there is one (checked against the server), else the
	/// saved draft a Drafts row names, else a fresh one: a reply's people and quote, From the account.
	func load() async {
		guard let api, !loaded else { return }
		senders = (try? await api.senders()) ?? []
		let kept = if let draftId = request.draftId { shelf?.find(draftId: draftId) }
			else { shelf?.find(slot: slot, account: account) }
		if let kept {
			restore(kept)
			await check(kept)
		} else if let draftId = request.draftId {
			await open(draftId)
		} else {
			await start()
		}
		loaded = true
		// Reply all on a kept reply adds the others, as the button would.
		if request.kind == .replyAll, mode == .reply { replyAll() }
		// Words the server hasn't seen (kept here, or typed while loading) are saved now.
		if fields != lastSaved || attachmentsDirty { edited() }
	}

	/// A fresh composer: a new message From the selected account; a reply or forward from the message.
	private func start() async {
		guard let api else { return }
		from = senders.first { $0.lowercased() == account?.lowercased() } ?? senders.first ?? ""
		if let emailId = request.emailId, request.kind != .new {
			do {
				let message = try await api.source(emailId)
				source = message
				let plan = Reply.plan(request.kind, source: message, own: senders)
				if let account = plan.from { from = account }
				to = plan.to.joined(separator: ", ")
				cc = plan.cc.joined(separator: ", ")
				others = plan.others
				subject = plan.subject
				inReplyTo = plan.inReplyTo
				references = plan.references
				quote = plan.quote
				hasQuote = true
			} catch {
				problem = "Couldn't load the message you're answering, so To and the quote are empty."
				editingRecipients = true
			}
		}
		lastSaved = fields
	}

	/// This device's copy, as it was left.
	private func restore(_ kept: KeptDraft) {
		release()
		keptId = kept.id
		claim()
		slot = kept.slot
		sourceId = kept.emailId
		mode = kept.mode
		from = kept.from
		to = kept.to
		cc = kept.cc
		bcc = kept.bcc
		showCcBcc = !kept.cc.isEmpty || !kept.bcc.isEmpty
		subject = kept.subject
		body = kept.body
		quote = kept.quote
		hasQuote = kept.hasQuote
		inReplyTo = kept.inReplyTo
		references = kept.references
		draftId = kept.draftId
		revision = kept.revision
		attachments = shelf?.files(kept.id) ?? []
		attachmentsDirty = kept.filesUnsaved
		lastSaved = kept.unsaved ? nil : fields
	}

	/// This device's copy against the server's. Sent or deleted there: done, unless this device holds
	/// words the server never saw (they stay, as a new draft). Newer there: when only the server
	/// changed, its words win (nothing here is newer); when both changed, this device's words become
	/// a new draft and the other version stays in Drafts. Neither is lost; no merge. Offline or
	/// unreadable: what this device holds.
	private func check(_ kept: KeptDraft) async {
		let restored = fields
		if isReply, let api, let sourceId, let message = try? await api.source(sourceId) {
			source = message
			others = Reply.plan(mode, source: message, own: senders).others
		}
		guard let api, let id = kept.draftId else { return }
		var server: ServerDraft?
		do {
			server = try await api.draft(id)
		} catch let error as APIError {
			guard case let .http(status, _) = error, status == 404 || status == 403 else { return }
		} catch {
			return
		}
		let changedHere = kept.unsaved || kept.filesUnsaved || fields != restored
		guard let server, server.isDraft else {
			if changedHere {
				detach("This draft was sent or deleted elsewhere. Your unsent words stay here as a new draft.")
			} else {
				shelf?.remove(kept.id)
				shelf?.release(kept.id)
				clear()
				if request.draftId != nil { problem = "That draft was already sent or deleted." }
				await start()
			}
			return
		}
		guard (server.draftRevision ?? 0) > kept.revision else { return }
		if changedHere {
			detach("This draft changed elsewhere. That version stays in Drafts; this one is saved as a new draft.")
		} else {
			await apply(server)
			keep()
		}
	}

	/// A saved draft from Drafts that this device holds no copy of: the server's.
	private func open(_ id: String) async {
		guard let api else { return }
		do {
			let server = try await api.draft(id)
			guard server.isDraft else {
				problem = "That draft was already sent or deleted."
				await start()
				return
			}
			mode = server.inReplyTo == nil ? .new : .reply
			slot = ComposeRequest.slot(mode, request.conversationId)
			await apply(server)
			keep()
		} catch {
			problem = "Couldn't open that draft: \(Self.describe(error))."
			await start()
		}
	}

	/// The server's version of the draft in place of what is here.
	private func apply(_ server: ServerDraft) async {
		from = server.fromAddress
		to = (server.toAddresses ?? []).joined(separator: ", ")
		cc = (server.ccAddresses ?? []).joined(separator: ", ")
		bcc = (server.bccAddresses ?? []).joined(separator: ", ")
		showCcBcc = !cc.isEmpty || !bcc.isEmpty
		subject = server.subject ?? ""
		// The quote is sent under the typed text: split it off again when it is still there.
		let text = server.textContent ?? ""
		if hasQuote, !quote.isEmpty, text.hasSuffix(quote) {
			body = String(text.dropLast(quote.count))
		} else {
			body = text
			quote = ""
			hasQuote = false
		}
		inReplyTo = server.inReplyTo
		references = server.referencesHeader
		draftId = server.id
		revision = server.draftRevision ?? 0
		attachments = []
		filesLocked = false
		if let api, let files = server.attachments, !files.isEmpty {
			do {
				for file in files { attachments.append(try await api.file(file)) }
			} catch {
				attachments = []
				filesLocked = true
				problem = "This draft's files couldn't be loaded here. They stay with the draft."
			}
		}
		attachmentsDirty = false
		lastSaved = fields
	}

	/// Keep what is here as a new draft: the one it came from is gone or changed elsewhere.
	private func detach(_ why: String) {
		draftId = nil
		revision = 0
		lastSaved = nil
		attachmentsDirty = !attachments.isEmpty
		problem = why
	}

	/// Back to an empty composer of the request's kind (a new copy on the device).
	private func clear() {
		release()
		keptId = UUID()
		claim()
		slot = ComposeRequest.slot(request.kind, request.conversationId)
		sourceId = request.emailId
		mode = request.kind
		(from, to, cc, bcc, subject, body, quote) = ("", "", "", "", "", "", "")
		hasQuote = false
		showCcBcc = false
		others = []
		inReplyTo = nil
		references = nil
		draftId = nil
		revision = 0
		attachments = []
		attachmentsDirty = false
	}

	// MARK: Editing

	func replyAll() {
		let adds = replyAllAdds
		guard !adds.isEmpty else { return }
		cc = (Self.addresses(cc) + adds).joined(separator: ", ")
		mode = .replyAll
	}

	/// Clearing the quote leaves it out of the message.
	func quoteEdited() {
		if quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { hasQuote = false }
	}

	func attach(_ urls: [URL]) {
		for url in urls {
			let scoped = url.startAccessingSecurityScopedResource()
			defer { if scoped { url.stopAccessingSecurityScopedResource() } }
			guard let data = try? Data(contentsOf: url) else { continue }
			let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
			attachments.append(
				DraftAttachment(filename: url.lastPathComponent, contentType: type, contentBase64: data.base64EncodedString()))
		}
		attachmentsDirty = true
		edited()
	}

	func removeAttachment(_ attachment: DraftAttachment) {
		attachments.removeAll { $0 == attachment }
		attachmentsDirty = true
		edited()
	}

	/// Any change: kept on this device now, saved as the server draft a second later (nothing until
	/// something was typed).
	func edited() {
		guard loaded, !finished, !isWaiting, sending != .preparing else { return }
		keep()
		guard fields != lastSaved || attachmentsDirty, hasContent || draftId != nil else { return }
		saving = .saving
		saveTask?.cancel()
		saveTask = Task { [weak self] in
			try? await Task.sleep(for: .seconds(1))
			guard !Task.isCancelled else { return }
			_ = await self?.save()
		}
	}

	/// This composer on the device as it is now, and whether the server has seen it. Nothing to keep
	/// (never saved, and nothing typed over what it opened with): no copy.
	private func keep() {
		guard let shelf, !finished else { return }
		guard draftId != nil || (hasContent && (fields != lastSaved || attachmentsDirty)) else {
			shelf.remove(keptId)
			return
		}
		shelf.keep(
			KeptDraft(
				id: keptId, slot: slot, mode: mode, emailId: sourceId, draftId: draftId, revision: revision,
				from: from, to: to, cc: cc, bcc: bcc, subject: subject, body: body, quote: quote, hasQuote: hasQuote,
				inReplyTo: inReplyTo, references: references, unsaved: fields != lastSaved,
				filesUnsaved: attachmentsDirty, updatedAt: .now),
			files: attachments)
	}

	/// The composer is on screen: its draft is never handed to a second one.
	func claim() {
		shelf?.claim(keptId, by: request.id)
	}

	/// The composer is gone (Cancel, its window closed): its draft can be opened again.
	func release() {
		shelf?.release(keptId)
	}

	/// Sent or discarded: off the device for good.
	private func finish() {
		finished = true
		shelf?.remove(keptId)
		shelf?.release(keptId)
	}

	/// One save at a time, in order: a second save waits for the first (no duplicate drafts).
	@discardableResult
	func save() async -> Bool {
		let previous = inFlight
		let task = Task { [weak self] () -> Bool in
			_ = await previous?.value
			return await self?.saveNow() ?? false
		}
		inFlight = task
		return await task.value
	}

	private func saveNow() async -> Bool {
		guard let api else { return false }
		var snapshot = fields
		if attachmentsDirty { snapshot.attachments = attachments }
		do {
			if let draftId {
				let saved = try await api.update(draftId, snapshot, revision: revision)
				revision = saved.draftRevision ?? revision + 1
			} else {
				let saved = try await api.create(snapshot)
				draftId = saved.id
				revision = saved.draftRevision ?? 0
			}
			if snapshot.attachments != nil { attachmentsDirty = false }
			snapshot.attachments = nil
			lastSaved = snapshot
			saving = .saved
			keep()
			return true
		} catch {
			saving = .failed(Self.describe(error))
			return false
		}
	}

	// MARK: Sending

	private func set(_ state: Sending) {
		guard state != sending else { return }
		sending = state
		onSending?(state)
	}

	func send() {
		guard canSend else { return }
		saveTask?.cancel()
		set(.preparing)
		sendTask = Task { [weak self] in
			guard let self else { return }
			guard await self.save(), let id = self.draftId, let api = self.api else {
				self.set(.failed("Not sent: the draft couldn't be saved first. \(self.savingText)"))
				return
			}
			self.set(.queued)
			try? await Task.sleep(for: .seconds(Self.undoSeconds))
			guard !Task.isCancelled, self.sending == .queued else { return }
			self.set(.sending)
			do {
				try await api.send(draftId: id)
				self.finish()
				self.set(.sent)
			} catch {
				self.set(.failed("Message not sent. \(Self.describe(error))"))
			}
		}
	}

	/// Inside the 5 seconds: nothing was sent, the composer is back as it was.
	func undo() {
		guard sending == .queued else { return }
		sendTask?.cancel()
		set(.idle)
	}

	// MARK: Leaving

	/// Cancel: the draft stays, here and on the server (saved first when it changed). False when it
	/// could not be saved (the words are still kept on this device).
	func close() async -> Bool {
		saveTask?.cancel()
		guard loaded, !finished else { return true }
		keep()
		guard hasContent || draftId != nil, fields != lastSaved || attachmentsDirty else { return true }
		return await save()
	}

	/// Discard: the server draft goes too, and this device's copy.
	func discard() async {
		saveTask?.cancel()
		finish()
		_ = await inFlight?.value
		if let draftId, let api { try? await api.delete(draftId: draftId) }
		draftId = nil
	}

	static func describe(_ error: Error) -> String {
		switch error as? APIError {
		case .offline?: "you're offline"
		case .http(409, _)?: "a newer version of this draft was saved elsewhere"
		case let .http(status, _)?: "the server returned \(status)"
		case let .rejected(message)?: message
		case .decoding?: "unexpected server response"
		case nil: "the server couldn't be reached"
		}
	}
}
