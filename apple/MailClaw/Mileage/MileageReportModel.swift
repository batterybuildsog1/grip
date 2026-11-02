import Foundation
import Observation

/// What the Mileage screens show and every owner write (V3 "Answer first"). The month's report is
/// read whole from the server (`GET /report`) and read again after each write, so every figure and
/// question on screen is the server's. Offline, the last report of the month shows with its time.
/// Writes go to the server first and say so when they fail; nothing is queued on the device except
/// the 5-second delete hold, which lives in memory only (quit inside it and nothing is deleted).
@MainActor @Observable
final class MileageReportModel {
	enum Status: Equatable {
		case idle, loading, live
		/// Showing the kept report: the server couldn't be reached.
		case offline
		/// Signed in, but this person isn't a Mileage owner: one quiet sentence (never a form).
		case notOwner
		case failed(String)
		/// The server answered but this app couldn't read the month (a field it doesn't expect):
		/// the kept report, if any, shows under "Couldn't read October" with Try again.
		case unreadable
	}

	/// Where an open trip came from: the rail on the Mac and the stack on iPhone step through it.
	enum Queue: Hashable {
		case needsYou
		case company(String)
		case spotCheck
		case search(String)
	}

	/// A trip open in the sheet (Mac, iPad regular) or pushed (iPhone, compact).
	struct Open: Hashable {
		let trip: String
		let queue: Queue
	}

	/// The answer being built for one trip: kept while you type, across re-renders and steps.
	struct Draft: Equatable {
		var company: String?
		var reimbursable: Bool?
		var purpose: String = ""
		/// File the drive back with the same answer (on by default).
		var alsoReturn = true
		/// A name for the end that matters, and whether it becomes a saved place.
		var name: String = ""
		var saveAsPlace = true
	}

	struct Toast: Identifiable, Equatable {
		let id = UUID()
		let text: String
		var undo: UndoAction?
		var retry = false
		static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
	}

	enum UndoAction: Equatable {
		/// POST /trips/:id/undo at the revision the server returned for the change.
		case server(trip: String, revision: Int)
		/// The delete hold: nothing was sent yet.
		case delete(trip: String)
	}

	let mileage: MileageModel
	private(set) var month: String
	private(set) var report: MileageReport?
	/// When the shown report was read from the server.
	private(set) var loadedAt: Date?
	private(set) var status: Status = .idle
	var open: Open?
	/// iPhone: a company's full list (by day) or the spot-check list, pushed over the report.
	var list: Queue?
	var showSettings = false
	var showExport = false
	/// Search trips: the words typed (the Mac toolbar's field, the iPhone's bottom field).
	var searchText = ""
	/// The search Return ran: its results fill the rail (Mac, iPad) or a list (iPhone).
	private(set) var submittedSearch: String?

	/// Return in Search trips: the results become a queue. Mac and iPad: the rail, the first one open;
	/// iPhone: a list in place of the report.
	func submitSearch(openFirst: Bool = true) {
		let text = searchText.trimmingCharacters(in: .whitespaces)
		guard !text.isEmpty else { cancelSearch(); return }
		submittedSearch = text
		guard openFirst else { return }
		if let first = search(text).first { open = Open(trip: first.id, queue: .search(text)) } else { open = nil }
	}

	func cancelSearch() {
		searchText = ""
		submittedSearch = nil
		if case .search = open?.queue { open = nil }
	}
	/// A Mileage field has the keyboard (search, purpose, a name): single keys type.
	var typing = false
	/// A trip's Details are open: remembered for the session, across j and k.
	var detailsOpen = false
	/// The month's Report is open (closed at first; not remembered across launches).
	var reportOpen = false
	/// Trips whose answer fields are open (Change on a guess or a filed trip).
	var changing: Set<String> = []
	var drafts: [String: Draft] = [:]
	/// The question the report's card shows after a Skip there (nil: the first one left).
	private(set) var deck: String?
	/// Trips leaving the screen: deleted after 5 s unless Undo.
	private(set) var deleting: Set<String> = []
	private(set) var saving: Set<String> = []
	var toast: Toast?
	/// The last write that didn't reach the server, kept to try again ("Retry now").
	private(set) var failed: (() async -> Void)?

	@ObservationIgnored private var holds: [String: Task<Void, Never>] = [:]
	/// A delete hold of the open trip: the trip it was (`was`) and the one that took its place
	/// (`now`), so Undo puts the deleted trip back on screen (apple-r1-03).
	@ObservationIgnored private var heldOpen: [String: (was: Open, now: Open?)] = [:]
	@ObservationIgnored private var toastTask: Task<Void, Never>?
	@ObservationIgnored private var loadTask: Task<Void, Never>?
	@ObservationIgnored private var sessionGeneration = 0

	init(mileage: MileageModel) {
		self.mileage = mileage
		month = LaunchOptions.mileageMonth ?? Self.currentMonth()
		mileage.onSynced = { [weak self] in self?.reload() }
		mileage.onSessionChanged = { [weak self] in self?.forget() }
	}

	static func currentMonth(_ now: Date = .now) -> String {
		let parts = Calendar(identifier: .gregorian).dateComponents([.year, .month], from: now)
		return String(format: "%04d-%02d", parts.year ?? 2026, parts.month ?? 1)
	}

	// MARK: Reading

	var signedIn: Bool { mileage.client != nil }
	/// The month and its switcher show: there is a month to show.
	var showsMonth: Bool { (signedIn || report != nil) && status != .notOwner }

	/// Reads the month (and keeps it for offline). A failed read keeps what is shown, or the kept
	/// copy, and says when it was read.
	func load(_ month: String? = nil) async {
		if let month, month != self.month {
			self.month = month
			report = nil
			loadedAt = nil
			open = nil
			deck = nil
		}
		let wanted = self.month
		if report == nil, let kept = keptReport(wanted) {
			report = kept.report
			loadedAt = kept.at
		}
		guard let client = mileage.client else {
			status = report == nil ? .idle : .offline
			return
		}
		if mileage.notOwner {
			status = .notOwner
			return
		}
		if report == nil { status = .loading }
		let generation = sessionGeneration
		func currentSession() -> Bool {
			generation == sessionGeneration && mileage.client?.identity == client.identity
		}
		do {
			let fresh: MileageReport = try await client.request("/api/mileage/report?month=\(wanted)")
			guard currentSession(), wanted == self.month else { return }
			report = fresh
			loadedAt = .now
			status = .live
			keep(fresh, month: wanted)
			openLaunchScreen()
		} catch MileageFailure.server(401, _, _) {
			guard currentSession() else { return }
			// The session ended on the server: the whole app signs out (one sign-in), and forgets this.
			mileage.rejected(client)
		} catch MileageFailure.notOwner {
			guard currentSession() else { return }
			report = nil
			status = .notOwner
			mileage.refusedOwner(client)
		} catch MileageFailure.unreadable(let detail) {
			guard currentSession(), wanted == self.month else { return }
			print("Mileage: couldn't read the report for \(wanted): \(detail)")
			status = .unreadable
			if report != nil { openLaunchScreen() }
		} catch {
			guard currentSession(), wanted == self.month else { return }
			status = report == nil ? .failed(Self.plain(error)) : .offline
			// Offline, a capture can still open its screen on the kept report.
			if report != nil { openLaunchScreen() }
		}
	}

	/// Debug: the screen named at launch (`MC_MILEAGE_SCREEN`), once the month is read, so each
	/// state can be captured without input.
	@ObservationIgnored private var launchScreen = LaunchOptions.mileageScreen

	private func openLaunchScreen() {
		guard let screen = launchScreen, let report else { return }
		launchScreen = nil
		// Comma-separated, applied in order: "trip:t002,details", "report", "trip:t005,change:t005".
		for step in screen.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }) {
			let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
			guard let kind = parts.first else { continue }
			let value = parts.count > 1 ? parts[1] : ""
			func queue(_ text: String) -> Queue {
				if text.hasPrefix("company:") { return .company(String(text.dropFirst(8))) }
				if text.hasPrefix("search:") { return .search(String(text.dropFirst(7))) }
				return text == "spot-check" ? .spotCheck : .needsYou
			}
			switch kind {
			case "trip":
				// "trip:" with no id (a malformed launch step) opens nothing rather than crashing.
				let pieces = value.split(separator: "@", maxSplits: 1).map(String.init)
				guard let id = pieces.first else { continue }
				open = Open(trip: id, queue: pieces.count > 1 ? queue(pieces[1]) : .needsYou)
			case "company": list = .company(value)
			case "rail-company":
				if let first = trips(in: .company(value)).first { open = Open(trip: first.id, queue: .company(value)) }
			case "spot-check": openSpotCheck(asList: value == "list")
			case "report": reportOpen = true
			case "details": detailsOpen = true
			case "change": changing.insert(value)
			case "settings": showSettings = true
			case "export": showExport = true
			case "search":
				searchText = value
				submitSearch(openFirst: !LaunchOptions.mileagePhoneLayout)
			case "delete": if let trip = report.trip(value) { open = Open(trip: value, queue: .needsYou); delete(trip) }
			case "skip": if let first = next { skip(first) }
			default: break
			}
		}
	}

	func reload() {
		loadTask?.cancel()
		loadTask = Task { await load() }
	}

	/// The trips shown: the report's, less any on the delete hold.
	var trips: [MileageReport.Trip] { (report?.trips ?? []).filter { !deleting.contains($0.id) } }

	/// "Needs you", in the server's order (Skip never reorders it).
	var needsYou: [MileageReport.Trip] {
		guard let report else { return [] }
		return report.queue.filter { !deleting.contains($0) }.compactMap(report.trip)
	}

	/// The question the report's card asks: the one Skip moved to, else the first one left.
	var next: MileageReport.Trip? {
		let left = needsYou
		return left.first { $0.id == deck } ?? left.first
	}

	func trips(in queue: Queue) -> [MileageReport.Trip] {
		switch queue {
		case .needsYou: return needsYou
		// A guess counts in its company's figures, so it is in that company's trips too (as on web).
		case let .company(id): return trips.filter { ($0.state == .proposal ? $0.proposal?.company_id : $0.company_id) == id }
		case .spotCheck:
			let shown = Set(trips.map(\.id))
			return (report?.spot_check ?? []).filter(shown.contains).compactMap { report?.trip($0) }
		case let .search(text): return search(text)
		}
	}

	/// Search trips (CLEAN-SPEC): the month's names, addresses and purposes, the agent's guessed
	/// purpose included, matched as the web matches them (`MileageView.tsx` `matches`): a field
	/// that holds the words typed. So every platform finds the same trips.
	func search(_ text: String) -> [MileageReport.Trip] {
		let query = text.trimmingCharacters(in: .whitespaces).lowercased()
		guard !query.isEmpty else { return [] }
		return trips.filter { trip in
			[trip.start.name, trip.end.name, trip.start.address, trip.end.address, trip.purpose, trip.proposal?.purpose]
				.contains { $0?.lowercased().contains(query) == true }
		}
	}

	/// The spot-check: the agent's trips, least sure first, in the rail (Mac) or a list (iPhone).
	func openSpotCheck(asList: Bool) {
		if asList { list = .spotCheck; return }
		if let first = trips(in: .spotCheck).first { open = Open(trip: first.id, queue: .spotCheck) }
	}

	/// Skip (apple-r1-05, the prototype's `skip()`): the one after it in the queue, wrapping to the
	/// first, and the queue keeps its order, so the second question says "2 of 6". The open trip
	/// moves on; on the report the card does.
	func skip(_ trip: MileageReport.Trip) {
		let queue = open?.trip == trip.id ? open?.queue : nil
		let ids = (queue.map(trips(in:)) ?? needsYou).map(\.id)
		guard let index = ids.firstIndex(of: trip.id), ids.count > 1 else { return }
		let following = ids[(index + 1) % ids.count]
		if let queue { open = Open(trip: following, queue: queue) } else { deck = following }
	}

	/// After an answer, Skip or Delete: the next trip of the open queue (the one after it, else the
	/// first left), or back to the report when none is left. `also` left the queue with it.
	func advance(from id: String, also: Set<String> = []) {
		guard let open, open.trip == id else { return }
		let all = trips(in: open.queue).map(\.id)
		let gone = also.union([id])
		let index = all.firstIndex(of: id) ?? -1
		let following = all.dropFirst(index + 1).first { !gone.contains($0) } ?? all.first { !gone.contains($0) }
		self.open = following.map { Open(trip: $0, queue: open.queue) }
	}

	/// j/k: the next or previous trip of the open queue.
	func step(_ offset: Int) {
		guard let open else { return }
		let list = trips(in: open.queue).map(\.id)
		guard let index = list.firstIndex(of: open.trip) else { return }
		let target = index + offset
		guard list.indices.contains(target) else { return }
		self.open = Open(trip: list[target], queue: open.queue)
	}

	func position(of id: String, in queue: Queue) -> (index: Int, count: Int)? {
		let list = trips(in: queue).map(\.id)
		return list.firstIndex(of: id).map { ($0, list.count) }
	}

	/// The answer being built: what you changed, else what the trip says now (Draft.from).
	func draft(_ trip: MileageReport.Trip) -> Draft { drafts[trip.id] ?? .from(trip) }

	// MARK: Writing

	/// What filing needs before it can go: a business trip's purpose, Acme's reimbursable.
	func missing(_ draft: Draft) -> String? {
		guard let company = report?.company(draft.company) else { return "Choose a company" }
		if company.split_reimbursable && draft.reimbursable == nil { return "Reimbursable or not?" }
		if company.treatment != "personal" && draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			return "Add a purpose"
		}
		return nil
	}

	/// Files a trip with its draft (Yes to the agent's guess when nothing was changed), and the drive
	/// back with it when that is on. Then the report is read again and the queue moves on.
	@discardableResult
	func file(_ trip: MileageReport.Trip, draft: Draft? = nil) async -> Bool {
		let draft = draft ?? self.draft(trip)
		guard missing(draft) == nil, let company = draft.company, !saving.contains(trip.id) else { return false }
		// Yes to the agent's guess: the draft is still exactly its guess (a hint on a question is not a guess to say yes to).
		let proposal = trip.state != .proposal ? nil : trip.proposal.flatMap { proposal in
			proposal.company_id == company && proposal.reimbursable == draft.reimbursable
				&& (proposal.purpose ?? "") == draft.purpose ? proposal.id : nil
		}
		let companies = report?.company(company)
		let back = draft.alsoReturn ? returnTrip(of: trip) : nil
		let file = MileageWrite.File(
			expected_revision: trip.revision, category_id: company,
			// Personal trips carry no purpose (V3 deleted the field there).
			purpose: companies?.treatment == "personal" ? "" : draft.purpose.trimmingCharacters(in: .whitespacesAndNewlines),
			reimbursable: companies?.split_reimbursable == true ? draft.reimbursable : nil,
			proposal_id: proposal,
			also: back.map { [MileageWrite.Also(trip_id: $0.id, expected_revision: $0.revision)] },
			idempotency_key: UUID().uuidString)
		let name = companies?.name ?? "it"
		let naming = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
		let namedEnd = naming.isEmpty ? nil : MileageAnswerLogic.unnamedEnd(trip)
		var body = file
		if let namedEnd, !draft.saveAsPlace {
			if namedEnd == .start { body.origin = naming } else { body.destination = naming }
		}
		let filed = await write(trip.id, done: back == nil ? "Filed as \(name)" : "Filed both as \(name)") { client in
			let saved: MileageWrite.Saved = try await client.request("/api/mileage/trips/\(trip.id)", method: "PATCH",
				body: JSONEncoder().encode(body))
			return saved.revision
		} after: { [weak self] in
			self?.drafts[trip.id] = nil
			if let back { self?.drafts[back.id] = nil }
			self?.advance(from: trip.id, also: Set([back?.id].compactMap { $0 }))
		}
		// "Name it" as a saved place: after filing (every trip there then shows the name).
		if filed, let end = namedEnd, draft.saveAsPlace {
			if let problem = await self.name(trip, end: end, as: naming) {
				show(Toast(text: "Filed, but the name wasn't saved: \(problem)"), seconds: 8)
			}
		}
		return filed
	}

	/// The drive back right after this trip in the queue (`return_of`), if it still needs you.
	func returnTrip(of trip: MileageReport.Trip) -> MileageReport.Trip? {
		trips.first { $0.return_of == trip.id && $0.needsYou }
	}

	/// Undo: the server puts the trip (and its drive back, if filed together) back as it was.
	func undo(_ action: UndoAction) async {
		toast = nil
		switch action {
		case let .delete(trip):
			holds[trip]?.cancel()
			holds[trip] = nil
			deleting.remove(trip)
			// Back to the trip you deleted, unless you have moved on since.
			if let held = heldOpen.removeValue(forKey: trip), open == held.now { open = held.was }
			show(Toast(text: "Kept"))
		case let .server(trip, revision):
			let body = MileageWrite.Undo(expected_revision: revision, idempotency_key: UUID().uuidString)
			_ = await write(trip, done: "Undone") { client in
				let _: MileageWrite.Undone = try await client.request("/api/mileage/trips/\(trip)/undo", method: "POST",
					body: JSONEncoder().encode(body))
				return nil
			} after: {}
		}
	}

	/// LATE-START §4, "Remove estimate": the trip counts its recorded miles only (`start_estimate: null` in the
	/// trip edit). The phone set the estimate; nobody can type one, so Undo is the only way back.
	func removeEstimate(_ trip: MileageReport.Trip) async {
		let body = MileageWrite.RemoveEstimate(expected_revision: trip.revision, idempotency_key: UUID().uuidString)
		_ = await write(trip.id, done: "Estimate removed") { client in
			let saved: MileageWrite.Saved = try await client.request("/api/mileage/trips/\(trip.id)", method: "PATCH",
				body: JSONEncoder().encode(body))
			return saved.revision
		} after: {}
	}

	/// Delete: the trip leaves the screen at once; the DELETE goes after 5 s unless Undo.
	func delete(_ trip: MileageReport.Trip) {
		deleting.insert(trip.id)
		if let was = open, was.trip == trip.id {
			advance(from: trip.id)
			heldOpen[trip.id] = (was, open)
		}
		show(Toast(text: "Deleted", undo: .delete(trip: trip.id)), seconds: 5)
		holds[trip.id] = Task { [weak self] in
			try? await Task.sleep(for: .seconds(5))
			guard !Task.isCancelled else { return }
			await self?.sendDelete(trip)
		}
	}

	private func sendDelete(_ trip: MileageReport.Trip) async {
		holds[trip.id] = nil
		heldOpen[trip.id] = nil
		let body = MileageAPI.Delete(expected_revision: trip.revision, idempotency_key: UUID().uuidString)
		let sent = await write(trip.id, done: nil) { client in
			do {
				let _: MileageWrite.Saved = try await client.request("/api/mileage/trips/\(trip.id)", method: "DELETE",
					body: JSONEncoder().encode(body))
			} catch MileageFailure.tripDeleted {}
			return nil
		} after: {}
		// Gone from the report once sent; back on screen (with the failure's toast) when it wasn't.
		_ = sent
		deleting.remove(trip.id)
		// The next sync retires the local journal through the server's tombstone.
		Task { await mileage.sync(force: true) }
	}

	/// One write: on success the report is read again and the toast offers Undo when the server
	/// returned the revision to undo; on failure the toast says so and keeps "Retry now".
	@discardableResult
	private func write(_ id: String, done: String?, _ call: @escaping (MileageAPI) async throws -> Int?,
	                   after: @escaping () -> Void) async -> Bool {
		guard let client = mileage.client else {
			show(Toast(text: "Sign in again to save this"), seconds: 6)
			return false
		}
		saving.insert(id)
		defer { saving.remove(id) }
		do {
			let revision = try await call(client)
			failed = nil
			after()
			if let done { show(Toast(text: done, undo: revision.map { UndoAction.server(trip: id, revision: $0) })) }
			await load()
			return true
		} catch MileageFailure.server(401, _, _) {
			// The session ended on the server: the app signs out.
			mileage.rejected(client)
			return false
		} catch MileageFailure.server(409, _, _) {
			// Changed elsewhere: read the month again, so the next answer goes at the trip's own revision.
			failed = nil
			show(Toast(text: "Not saved: \(Self.plain(MileageFailure.server(409, "", nil)))"), seconds: 8)
			await load()
			return false
		} catch {
			failed = { [weak self] in _ = await self?.write(id, done: done, call, after: after) }
			show(Toast(text: "Not saved: \(Self.plain(error))", retry: true), seconds: nil)
			return false
		}
	}

	func retry() async {
		guard let failed else { return }
		toast = nil
		await failed()
	}

	// MARK: Settings: rates, companies, places

	func putRate(from: String, centsPerMile: Double, source: String) async -> String? {
		let body = MileageWrite.Rate(tax_year: Int(from.prefix(4)) ?? 0, usd_per_mile: centsPerMile / 100,
			source: source, idempotency_key: UUID().uuidString)
		return await settingsWrite { client in
			let _: MileageWrite.Ignored = try await client.request("/api/mileage/rates/\(from)", method: "PUT",
				body: JSONEncoder().encode(body))
		}
	}

	func removeRate(from: String) async -> String? {
		await settingsWrite { client in
			let _: MileageWrite.Ignored = try await client.request("/api/mileage/rates/\(from)", method: "DELETE")
		}
	}

	func addCompany(name: String, treatment: String) async -> String? {
		let body = MileageWrite.Company(name: name, treatment: treatment, entity_id: Self.slug(name),
			idempotency_key: UUID().uuidString)
		return await settingsWrite { client in
			let _: MileageWrite.Ignored = try await client.request("/api/mileage/categories", method: "POST",
				body: JSONEncoder().encode(body))
		}
	}

	private(set) var places: [MileagePlace]?

	func loadPlaces() async {
		guard let client = mileage.client else { return }
		if let read: MileageAPI.Places = try? await client.request("/api/mileage/places") { places = read.places }
	}

	func renamePlace(_ id: String, name: String) async -> String? {
		let body = MileageAPI.RenamePlace(name: name, idempotency_key: UUID().uuidString)
		return await settingsWrite { client in
			let _: MileagePlace = try await client.request("/api/mileage/places/\(id)", method: "PATCH",
				body: JSONEncoder().encode(body))
		}
	}

	func removePlace(_ id: String) async -> String? {
		await settingsWrite { client in
			do {
				let _: MileageAPI.Deleted = try await client.request("/api/mileage/places/\(id)", method: "DELETE")
			} catch MileageFailure.server(404, _, _) {}
		}
	}

	/// Saves the place at one end of a trip under a name: every trip there shows it.
	func name(_ trip: MileageReport.Trip, end: MileageEnd, as name: String) async -> String? {
		await settingsWrite { client in
			let body = MileageAPI.NamePlace(name: name, trip_id: trip.id, end: end.rawValue, idempotency_key: UUID().uuidString)
			let _: MileagePlace = try await client.request("/api/mileage/places", method: "POST", body: JSONEncoder().encode(body))
		}
	}

	/// A Settings write: nil when saved (the report and places are read again), else why not.
	private func settingsWrite(_ call: (MileageAPI) async throws -> Void) async -> String? {
		guard let client = mileage.client else { return "Sign in again to save this" }
		do {
			try await call(client)
			await load()
			if places != nil { await loadPlaces() }
			return nil
		} catch MileageFailure.server(401, _, _) {
			mileage.rejected(client)
			return "Your sign-in ended."
		} catch {
			return Self.plain(error)
		}
	}

	// MARK: Export

	/// The month's log as the server writes it. The agent's guesses are left out unless asked for.
	func export(type: String, includeGuesses: Bool) async throws -> (data: Data, filename: String) {
		guard let client = mileage.client, let report else { throw MileageFailure.message("Sign in again to export") }
		var path = "/api/mileage/exports?type=\(type)&format=csv&from=\(report.from)&to=\(report.to)"
		if includeGuesses { path += "&include_proposals=1" }
		return try await client.download(path)
	}

	// MARK: Toast

	func show(_ toast: Toast, seconds: Double? = 6) {
		self.toast = toast
		toastTask?.cancel()
		guard let seconds else { return }
		let id = toast.id
		toastTask = Task { [weak self] in
			try? await Task.sleep(for: .seconds(seconds))
			guard !Task.isCancelled, self?.toast?.id == id else { return }
			self?.toast = nil
		}
	}

	// MARK: Offline copy

	private struct Kept: Codable { let report: MileageReport; let at: Date }

	private func keep(_ report: MileageReport, month: String) {
		guard let file = mileage.reportFile(month),
		      let data = try? JSONEncoder().encode(Kept(report: report, at: .now)) else { return }
		#if os(iOS)
		try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
		#else
		try? data.write(to: file, options: .atomic)
		#endif
	}

	private func keptReport(_ month: String) -> Kept? {
		guard let file = mileage.reportFile(month), let data = try? Data(contentsOf: file) else { return nil }
		return try? JSONDecoder().decode(Kept.self, from: data)
	}

	/// Signed out: nothing of the last owner's month stays on screen.
	func forget() {
		sessionGeneration += 1
		loadTask?.cancel(); loadTask = nil
		report = nil; loadedAt = nil; open = nil; drafts = [:]; deck = nil; places = nil
		status = .idle; toast = nil; failed = nil
		holds.values.forEach { $0.cancel() }
		holds = [:]; heldOpen = [:]; deleting = []
	}

	static func plain(_ error: Error) -> String {
		switch error {
		case MileageFailure.server(409, _, _): "This trip changed elsewhere. It has been read again."
		case MileageFailure.server(let code, let text, _) where (400..<500).contains(code): text
		case MileageFailure.unreadable: "This app couldn't read the server's answer."
		case let error as URLError where error.code == .notConnectedToInternet || error.code == .cannotConnectToHost
			|| error.code == .timedOut || error.code == .networkConnectionLost:
			"Couldn't reach Grip."
		default: error.localizedDescription
		}
	}

	private static func slug(_ name: String) -> String {
		let lowered = name.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
		return String(String(lowered).split(separator: "-").joined(separator: "-").prefix(40))
	}
}

/// Request and response bodies of the owner's V3 writes (docs/mileage/V3-CONTRACT.md).
enum MileageWrite {
	struct Also: Encodable { let trip_id: String; let expected_revision: Int }
	struct File: Encodable {
		let expected_revision: Int
		let category_id: String
		let purpose: String
		let reimbursable: Bool?
		let proposal_id: String?
		let also: [Also]?
		let idempotency_key: String
		/// "Name it" for this trip only (unticked "Save it as a place").
		var origin: String? = nil
		var destination: String? = nil
	}
	struct Undo: Encodable { let expected_revision: Int; let idempotency_key: String }
	/// `{expected_revision, idempotency_key, start_estimate: null}`: the null is sent, not left out.
	struct RemoveEstimate: Encodable {
		let expected_revision: Int
		let idempotency_key: String
		enum Keys: String, CodingKey { case expected_revision, idempotency_key, start_estimate }
		func encode(to encoder: Encoder) throws {
			var container = encoder.container(keyedBy: Keys.self)
			try container.encode(expected_revision, forKey: .expected_revision)
			try container.encode(idempotency_key, forKey: .idempotency_key)
			try container.encodeNil(forKey: .start_estimate)
		}
	}
	struct Rate: Encodable { let tax_year: Int; let usd_per_mile: Double; let source: String; let idempotency_key: String }
	struct Company: Encodable { let name: String; let treatment: String; let entity_id: String; let idempotency_key: String }
	/// The trip as saved: its new revision is what Undo sends.
	struct Saved: Decodable { let id: String; let revision: Int }
	/// Undo puts back the trip and every trip filed with it: `{ trips: [Trip] }`.
	struct Undone: Decodable { let trips: [Saved] }
	struct Ignored: Decodable {}
}
