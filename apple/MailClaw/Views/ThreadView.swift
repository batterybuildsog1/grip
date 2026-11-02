import MailClawKit
import SwiftUI

/// Loads one conversation: the stored copy first (instant), then the anchor message and the full
/// thread in parallel from the server; the full thread is stored for the next open (ThreadView
/// marks it read: AppModel.markOpenedRead). Then, when the thread's first message
/// answers one it doesn't hold, the split-off earlier conversation (WD-04; until server-side
/// thread linking lands, joined by subject and people as on the web).
@MainActor @Observable
final class ThreadModel {
	enum Source { case cache, network }
	/// Nothing to show: offline and never downloaded, gone from the server, or another failure.
	enum Failure: Equatable { case offline, gone, failed }

	let id: String
	let anchor: String?
	private let sync: MailSync
	private(set) var detail: ConversationDetail?
	private(set) var earlier: [Email] = []
	private(set) var source: Source?
	private(set) var problem: String?
	private(set) var failure: Failure?
	private(set) var loadingRest = false
	/// The server's whole thread has arrived (not the stored copy): its read state is current.
	private(set) var haveFull = false

	init(id: String, anchor: String?, sync: MailSync) {
		self.id = id
		self.anchor = anchor
		self.sync = sync
		if let cached = try? sync.store.thread(id: id) {
			detail = cached
			source = .cache
		}
	}

	func load() async {
		let cachedFirst = detail != nil
		let (sync, id, anchor) = (self.sync, self.id, self.anchor)
		failure = nil
		loadingRest = true
		defer { loadingRest = false }
		let full = Task.detached { () -> Result<ConversationDetail, APIError> in
			do { return .success(try await sync.threadFull(id: id, emailId: anchor)) }
			catch let error as APIError { return .failure(error) }
			catch { return .failure(.offline) }
		}
		if !cachedFirst {
			let first = Task.detached { try? await sync.threadAnchor(id: id, emailId: anchor) }
			Task { @MainActor in
				if let detail = await first.value, !self.haveFull { self.show(detail, source: .network) }
			}
		}
		switch await full.value {
		case let .success(detail):
			haveFull = true
			show(detail, source: cachedFirst ? .cache : .network)
			let before = await Task.detached { await Self.earlierConversation(detail, sync: sync) }.value
			earlier = before
		case let .failure(error):
			fail(error)
			if let detail { earlier = await Task.detached { await Self.earlierConversation(detail, sync: sync) }.value }
		}
	}

	private func show(_ detail: ConversationDetail, source: Source) {
		self.detail = detail
		if self.source == nil { self.source = source }
		problem = nil
		failure = nil
	}

	private func fail(_ error: APIError) {
		switch error {
		case .offline:
			problem = detail == nil ? nil : "Offline · showing the downloaded copy"
			if detail == nil { failure = .offline }
		case _ where error.isNotFound:
			problem = detail == nil ? nil : "This conversation was deleted."
			if detail == nil { failure = .gone }
		default:
			problem = nil
			if detail == nil { failure = .failed }
		}
	}

	/// Messages shown expanded unless the user toggles them: the anchor and the newest.
	var defaultExpanded: Set<String> {
		var ids = Set<String>()
		if let anchor { ids.insert(anchor) }
		if let anchor = detail?.anchorEmailId { ids.insert(anchor) }
		if let last = own.last?.id { ids.insert(last) }
		return ids
	}

	/// This thread's messages, oldest first.
	var own: [Email] { (detail?.emails ?? []).sorted { $0.receivedAt < $1.receivedAt } }

	/// The older conversation with the same subject that shares a person with this one and ended
	/// before it began; [] when there is none or it can't be looked up (GET only, nothing stored but
	/// the earlier thread itself).
	nonisolated private static func earlierConversation(_ detail: ConversationDetail, sync: MailSync) async -> [Email] {
		let emails = detail.emails.sorted { $0.receivedAt < $1.receivedAt }
		let subject = ThreadText.normalizeSubject(detail.conversation.subject ?? emails.first?.subject)
		guard !subject.isEmpty, ThreadText.answersMissingMessage(emails) else { return [] }
		let people = ThreadPeople(emails)
		let theirs = Set(emails.flatMap { [$0.fromAddress] + $0.recipients + ($0.ccAddresses ?? []) }
			.filter { !people.isMe($0) }
			.map { ThreadText.bareAddress($0).lowercased() })
		let startedAt = detail.conversation.startedAt ?? emails.first?.receivedAt ?? 0
		var phrase = subject.count > 150 ? String(subject.prefix(150)) : subject
		if subject.count > 150, let space = phrase.lastIndex(of: " ") { phrase = String(phrase[..<space]) }
		phrase = phrase.replacingOccurrences(of: "\"", with: " ").trimmingCharacters(in: .whitespaces)

		struct Page: Decodable {
			struct Body: Decodable { let conversations: [ConversationSummary] }
			let data: Body?
		}
		let decoder = JSONDecoder()
		decoder.keyDecodingStrategy = .convertFromSnakeCase
		guard let body = try? await sync.api.get(
			["api", "conversations"], query: [("q", "subject:\"\(phrase)\""), ("limit", "10")]),
		      let page = try? decoder.decode(Page.self, from: body).data else { return [] }
		let candidate = page.conversations
			.filter { summary in
				summary.id != detail.conversation.id
					&& ThreadText.normalizeSubject(summary.subject) == subject
					&& summary.latestMessageAt < startedAt
					&& (summary.participants ?? []).contains { theirs.contains(ThreadText.bareAddress($0.address).lowercased()) }
			}
			.max { $0.latestMessageAt < $1.latestMessageAt }
		guard let candidate, let earlier = try? await sync.threadFull(id: candidate.id, emailId: nil) else { return [] }
		return earlier.emails.sorted { $0.receivedAt < $1.receivedAt }
	}
}

/// The long thread (round-2 S2): the subject, then every message as a bordered box. A split-off
/// earlier conversation folds into one stack at the top; more than four messages show the first,
/// a stack of the middle and the last three, the newest open. In the rail window (Mac, iPad) it is a
/// reading column centred beside the rail, and its actions are the toolbar's alone (design-taste X4:
/// each said once; Reply filled there, Reply all and Forward in More). In the iPhone stack it ends in
/// "Next in Personal" (L3: the rail's phone form) over the bottom bar Archive · Reply · More; a lone
/// newsletter's bar is Unsubscribe · Archive · More (L3 S3).
struct ThreadView: View {
	@State private var model: ThreadModel
	@State private var toggled: [String: Bool] = [:]
	@State private var openStacks: Set<TimelineItem.Stack> = []
	@State private var allowImages = false
	@State private var cardRecorded = false
	@State private var bodyRecorded = false
	@State private var moreShown = false
	@State private var showOriginal: Set<String> = []
	@State private var dim = false
	@State private var notice: String?
	/// This open has asked the server to mark the conversation read (once per open).
	@State private var markedRead = false
	@ScaledMetric(relativeTo: .title2) private var subjectSize: CGFloat = 24
	private let pane: FocusState<Pane?>.Binding
	@Environment(AppModel.self) private var app
	@Environment(\.colorScheme) private var colorScheme
	@Environment(\.usesRail) private var usesRail
	@Environment(\.openWindow) private var openWindow
	#if os(iOS)
	@Environment(\.dismiss) private var dismiss
	#endif

	init(id: String, anchor: String?, sync: MailSync, pane: FocusState<Pane?>.Binding) {
		_model = State(initialValue: ThreadModel(id: id, anchor: anchor, sync: sync))
		self.pane = pane
	}

	private var people: ThreadPeople {
		ThreadPeople(model.earlier + model.own, participants: model.detail?.conversation.participants ?? [])
	}

	private var category: String? { model.detail?.conversation.category }

	/// Unfolded by hand, or holding a message that opens by default (one opened from a note).
	private var unfolded: Set<TimelineItem.Stack> {
		let own = model.own
		guard own.count > 4 else { return openStacks }
		let middle = Set(own[1..<(own.count - 3)].map(\.id))
		return model.defaultExpanded.isDisjoint(with: middle) ? openStacks : openStacks.union([.middle])
	}

	/// The newest message not from me (else the newest): what Reply answers.
	private var replyTarget: Email? {
		let own = model.own
		return own.last { !people.isMe($0.fromAddress) } ?? own.last
	}

	/// The newest people's message with HTML: what "Show original" in More swaps.
	private var originalCandidate: Email? {
		model.own.last { email in
			email.htmlContent?.isEmpty == false
				&& ThreadText.readsAsText(email, parts: PartsCache.shared.parts(email), category: category)
		}
	}

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView {
				VStack(alignment: .leading, spacing: 8) {
					// S3: a lone bulk message is read in the newsletter view, edge to edge.
					if let newsletter {
						NewsletterView(
							email: newsletter, subject: subject, allowImages: $allowImages, dim: $dim,
							sync: app.sync, onBodyLoaded: bodyLoaded)
							.id(newsletter.id)
					} else {
						header
						if let detail = model.detail {
							timeline(detail)
						} else if let failure = model.failure {
							NotDownloadedView(failure: failure, row: lastKnownRow) { Task { await model.load() } }
						}
					}
					#if os(iOS)
					// Reply sits in the bottom bar, Reply all and Forward in More; the end of a thread,
					// people's or a newsletter's, names the next conversation (L3).
					if model.detail != nil, !usesRail {
						NextInViewRow(id: model.id)
							.padding(.top, 22)
							.padding(.horizontal, newsletter == nil ? 0 : 12)
					}
					#endif
				}
				.padding(.horizontal, newsletter == nil ? 12 : 0)
				.padding(.bottom, 24)
				// L3's reading column: 760 (the web's) beside the rail, centred in the detail.
				.frame(maxWidth: usesRail ? 784 : 860, alignment: .leading)
				.frame(maxWidth: .infinity)
			}
			.background(.mcSheet)
			.overlay {
				if model.detail == nil, model.failure == nil { ProgressView() }
			}
			// Initial too: a stored thread is there from the first frame, and its network copy
			// usually has the same count.
			.onChange(of: model.detail?.emails.count, initial: true) { _, _ in scrollToAnchor(proxy) }
		}
		// On the reader alone: an identifier on the whole view renames the bars' and the notice's own.
		.accessibilityIdentifier("thread-view")
		.overlay(alignment: .bottom) {
			if let notice {
				Text(notice)
					.font(.subheadline)
					.foregroundStyle(.mcOnToast)
					.padding(.horizontal, 14)
					.padding(.vertical, 10)
					.background(.mcToast, in: MCCorner.box.rect)
					.mcFloatShadow()
					.padding(.bottom, 12)
					.accessibilityIdentifier("thread-notice")
					.task(id: notice) {
						try? await Task.sleep(for: .seconds(3))
						self.notice = nil
					}
			}
		}
		.focusable()
		.focused(pane, equals: .thread)
		.focusEffectDisabled()
		.onKeyPress(.escape) {
			pane.wrappedValue = .list
			#if os(iOS)
			app.selection = nil
			#else
			// The thread holds the keyboard, so the window's Esc (Back) never sees this key.
			app.back()
			#endif
			return .handled
		}
		#if os(iOS)
		// "‹ Personal" in words on a plain bar the subject scrolls away under (L3 S2), not the
		// system's glass back circle. The rail window's words are its toolbar's (MacRootView).
		.toolbar(.hidden, for: .navigationBar)
		.background { if !usesRail { EdgeSwipeBack() } }
		.safeAreaInset(edge: .top, spacing: 0) { if !usesRail { topBar } }
		.scrollEdgeEffectHidden(!usesRail, for: .top)
		.safeAreaInset(edge: .bottom) {
			if model.detail != nil, !usesRail { bottomBar }
		}
		.confirmationDialog("More", isPresented: $moreShown, titleVisibility: .hidden) { moreActions }
		#endif
		.task {
			// Opening marks it read (build 5): the row the list shows unread at once; one that
			// didn't when the server's thread says unread (below).
			markedRead = app.markOpenedRead(model.id)
			await model.load()
		}
		.onChange(of: model.haveFull) { _, full in
			guard full, !markedRead, let detail = model.detail else { return }
			markedRead = app.markOpenedRead(model.id, detail: detail)
		}
		// The rail window's words follow a lone newsletter: Archive filled, nothing to reply to (L3 S3).
		.onChange(of: newsletter?.id, initial: true) { _, id in app.newsletterOpen = id == nil ? nil : model.id }
		.onChange(of: model.detail == nil, initial: true) { _, isNil in
			guard !isNil, !cardRecorded else { return }
			cardRecorded = true
			let sample = model.source == .cache ? "open_card_cached_ms" : "open_card_network_ms"
			Perf.end("open_thread", key: "open:\(model.id)", sample: sample)
			StallWatch.shared.start()
		}
	}

	/// The subject and nothing else (no message count, no "N earlier messages" banner).
	private var header: some View {
		Text(subject)
			.font(.system(size: subjectSize, weight: .mcTitle))
			.foregroundStyle(.mcText)
			.fixedSize(horizontal: false, vertical: true)
			.textSelection(.enabled)
			#if os(iOS)
			.accessibilityAddTraits(.isHeader)
			#endif
			.accessibilityIdentifier("thread-subject")
			.padding(.horizontal, 4)
			.padding(.top, 12)
			.padding(.bottom, 6)
	}

	private var newsletter: Email? {
		guard let detail = model.detail, model.earlier.isEmpty else { return nil }
		return NewsletterView.shows(detail)
	}

	private var subject: String {
		let text = model.detail?.conversation.subject ?? lastKnownRow?.subject ?? ""
		return text.isEmpty ? "(no subject)" : text
	}

	/// What the list last knew of this conversation (NI-12: offline and not downloaded).
	private var lastKnownRow: ConversationRow? { app.visibleRows.first { $0.id == model.id } }

	@ViewBuilder private func timeline(_ detail: ConversationDetail) -> some View {
		let people = self.people
		ForEach(TimelineItem.plan(own: model.own, earlier: model.earlier, open: unfolded)) { item in
			switch item {
			case let .stack(kind, emails):
				MessageStackView(kind: kind, emails: emails, people: people) { openStacks.insert(kind) }
			case let .message(email):
				MessageBox(
					email: email,
					people: people,
					category: detail.conversation.category,
					expanded: isExpanded(email),
					showOriginal: showOriginal.contains(email.id),
					dim: dim,
					allowImages: $allowImages,
					sync: app.sync,
					onToggle: { toggled[email.id] = !isExpanded(email) },
					onBodyLoaded: bodyLoaded)
					.id(email.id)
			}
		}
		if model.loadingRest, (detail.remainingEmailCount ?? 0) > 0 {
			ProgressView().frame(maxWidth: .infinity).padding()
		}
		if let problem = model.problem {
			Text(problem)
				.font(.footnote)
				.foregroundStyle(.mcMuted)
				.padding(.vertical, 8)
				.accessibilityIdentifier("thread-problem")
		}
	}

	#if os(iOS)
	private var topBar: some View {
		HStack {
			Button { dismiss() } label: {
				HStack(spacing: 8) {
					Chevron()
						.rotationEffect(.degrees(90))
						.frame(width: 14, height: 8)
					Text(app.listName)
				}
				.frame(minHeight: 44)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.foregroundStyle(.mcText)
			.accessibilityShowsLargeContentViewer { Text(app.listName) }
			.accessibilityLabel("Back to \(app.listName)")
			.accessibilityIdentifier("thread-back")
			Spacer()
		}
		.padding(.horizontal, 16)
		.mcBarText()
		.background(.mcSheet, ignoresSafeAreaEdges: .top)
	}

	/// Its words stop at the largest standard size (`mcBottomBar`), so they stay whole at AX5. A lone
	/// newsletter has nothing to reply to: Unsubscribe (with List-Unsubscribe) · Archive, the filled
	/// one · More, as the web's thread bar.
	private var bottomBar: some View {
		HStack {
			if let newsletter {
				if newsletter.listUnsubscribe?.isEmpty == false {
					UnsubscribeBarWord(emailId: newsletter.id)
				} else {
					Color.clear.frame(width: 72, height: 1).accessibilityHidden(true)
				}
				Spacer()
				Button { act(.archive) } label: {
					Text("Archive").padding(.horizontal, 16)
				}
				.buttonStyle(MCPrimaryButtonStyle(capsule: true))
				.accessibilityShowsLargeContentViewer { Text("Archive") }
			} else {
				Button("Archive") { act(.archive) }
					.tint(.mcText)
					.frame(minWidth: 72)
					.accessibilityShowsLargeContentViewer()
				Spacer()
				Button { act(.reply) } label: {
					Text("Reply").padding(.horizontal, 16)
				}
				.buttonStyle(MCPrimaryButtonStyle(capsule: true))
				.accessibilityShowsLargeContentViewer { Text("Reply") }
				.accessibilityIdentifier("thread-reply")
			}
			Spacer()
			Button("More") { moreShown = true }
				.tint(.mcText)
				.frame(minWidth: 72)
				.accessibilityShowsLargeContentViewer()
				.accessibilityIdentifier("thread-more")
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 8)
		// A bar's word never breaks inside ("Unsub-scribe" at the capped size beside the filled
		// Archive on a 390pt phone): it shrinks a little on one line instead, and a long press still
		// shows it large (iphone-r1-07's rule).
		.lineLimit(1)
		.minimumScaleFactor(0.7)
		.mcBottomBar()
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("thread-bottom-bar")
	}

	/// A lone newsletter keeps Forward (a receipt to the bookkeeper) but has no Reply all.
	@ViewBuilder private var moreActions: some View {
		if newsletter == nil { Button("Reply all") { act(.replyAll) } }
		Button("Forward") { act(.forward) }
		Button("Mark unread") { act(.markUnread) }
		Button("Not Personal") { act(.notPersonal) }
		if let email = originalCandidate {
			Button(showOriginal.contains(email.id) ? "Show as text" : "Show original") { toggleOriginal(email.id) }
		}
		// A light-only HTML mail in dark (NI-16); a mail with its own dark version needs none.
		if colorScheme == .dark, model.own.contains(where: { email in
			email.htmlContent?.isEmpty == false && !EmailDocument.ownDark(email.htmlContent ?? "")
		}) {
			Button(dim ? "Undim email" : "Dim email") { dim.toggle() }
		}
		Button("Trash", role: .destructive) { act(.trash) }
	}
	#endif

	private func toggleOriginal(_ id: String) {
		if !showOriginal.insert(id).inserted { showOriginal.remove(id) }
	}

	private func act(_ action: ThreadAction) {
		let target: Email? = action == .forward ? model.own.last : replyTarget
		// Reply, Reply all and Forward open S5's composer: a sheet on iPhone, a window on the Mac.
		let kind: ComposeKind? = switch action {
		case .reply: .reply
		case .replyAll: .replyAll
		case .forward: .forward
		default: nil
		}
		if let kind {
			openWindow.compose(ComposeRequest(kind: kind, emailId: target?.id, conversationId: model.id), in: app)
			return
		}
		notice = app.threadAction(action, row: conversationRow)
	}

	/// The open conversation as the list knows it, else as the thread arrived (a note, a banner).
	private var conversationRow: ConversationRow? {
		lastKnownRow ?? app.rows.first { $0.id == model.id }
			?? model.detail.map { ConversationRow(summary: $0.conversation) }
	}

	private func isExpanded(_ email: Email) -> Bool {
		toggled[email.id] ?? model.defaultExpanded.contains(email.id)
	}

	private func bodyLoaded() {
		guard !bodyRecorded else { return }
		bodyRecorded = true
		let sample = model.source == .cache ? "open_body_cached_ms" : "open_body_network_ms"
		Perf.end("open_body", key: "body:\(model.id)", sample: sample)
	}

	private func scrollToAnchor(_ proxy: ScrollViewProxy) {
		let own = model.own
		guard own.count > 3, let target = model.anchor ?? model.detail?.anchorEmailId ?? own.last?.id else { return }
		proxy.scrollTo(target, anchor: .top)
	}
}

/// NI-12: offline (or refused) and not on this device: what the list last knew, and a way to retry.
private struct NotDownloadedView: View {
	let failure: ThreadModel.Failure
	let row: ConversationRow?
	let retry: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if let row {
				VStack(alignment: .leading, spacing: 4) {
					HStack(alignment: .firstTextBaseline) {
						Text(row.sender).font(.headline).lineLimit(1)
						Spacer(minLength: 8)
						Text(ThreadText.shortDate(row.date)).font(.subheadline).foregroundStyle(.mcMuted)
					}
					if !row.snippet.isEmpty {
						Text(row.snippet).font(.subheadline).foregroundStyle(.mcMuted).lineLimit(3)
					}
				}
				.padding(14)
				.frame(maxWidth: .infinity, alignment: .leading)
				.overlay(MCCorner.box.rect.strokeBorder(.mcBorder))
			}
			if failure == .gone {
				Text("This conversation is no longer available.").foregroundStyle(.mcMuted)
			} else {
				HStack(spacing: 6) {
					Text(failure == .offline ? "Not downloaded" : "Couldn’t load this conversation")
						.foregroundStyle(.mcWarn)
					Text("·").foregroundStyle(.mcFaint)
					Button("Try again", action: retry).buttonStyle(MCLinkButtonStyle())
				}
				.font(.subheadline.weight(.medium))
			}
		}
		.foregroundStyle(.mcText)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("thread-offline")
	}
}

#if os(iOS)
/// L3's rail on a phone: under the last message, the next conversation in the list, named, which
/// opens in this one's place. At the end of the list, a quiet line says so; a conversation that
/// isn't in the list (opened from a note or a banner) shows neither. A well, not a bordered card: as
/// the message cards' twin it read as one more message (build 6). Its tone is the accent tint, the
/// icon's flap in Light (build 7: it follows the theme). Words only; pressed, 12% of the accent over
/// it (the web's color-mix).
private struct NextInViewRow: View {
	@Environment(AppModel.self) private var app
	@Environment(\.dynamicTypeSize) private var typeSize
	let id: String

	var body: some View {
		let wraps = typeSize.isAccessibilitySize
		if let next = app.nextConversation(after: id) {
			Button { app.open(next.id) } label: {
				VStack(alignment: .leading, spacing: 2) {
					Text("Next in \(app.listName)")
						.font(.footnote.weight(.semibold))
						.foregroundStyle(.mcText)
					Text(next.sender)
						.font(.headline)
						.fontWeight(next.unread ? .semibold : .regular)
						.foregroundStyle(.mcText)
						.lineLimit(wraps ? nil : 1)
					Text(next.subject)
						.font(.subheadline)
						.foregroundStyle(.mcMuted)
						.lineLimit(wraps ? nil : 1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal, 16)
				.padding(.vertical, 12)
				.frame(minHeight: 64)
			}
			.buttonStyle(NextWellStyle())
			.accessibilityElement(children: .combine)
			.accessibilityIdentifier("next-in-view")
		} else if app.visibleRows.contains(where: { $0.id == id }) {
			Text("Last conversation in \(app.listName).")
				.font(.subheadline)
				.foregroundStyle(.mcMuted)
				.frame(maxWidth: .infinity)
				.accessibilityIdentifier("next-in-view-end")
		}
	}
}

private struct NextWellStyle: ButtonStyle {

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.background(MCCorner.box.rect.fill(.mcAccent.opacity(configuration.isPressed ? 0.12 : 0)))
			.background(MCCorner.box.rect.fill(.mcAccentSoft))
			.contentShape(MCCorner.box.rect)
	}
}
#endif

#if os(iOS)
/// The edge swipe back with the system bar hidden: SwiftUI switches the navigation controller's pop
/// gesture off with its bar. While a thread shows, it is on again (the stack is the inbox and this
/// thread); on leaving, the gesture gets its own delegate back.
private struct EdgeSwipeBack: UIViewControllerRepresentable {
	func makeUIViewController(context: Context) -> Hook { Hook() }
	func updateUIViewController(_ hook: Hook, context: Context) {
		DispatchQueue.main.async { hook.attach() }
	}

	final class Hook: UIViewController, UIGestureRecognizerDelegate {
		private weak var original: (any UIGestureRecognizerDelegate)?
		private weak var hooked: UIGestureRecognizer?

		/// SwiftUI may switch the gesture off again when it lays the bar out; each pass turns it on.
		func attach() {
			guard let gesture = navigationController?.interactivePopGestureRecognizer else { return }
			if hooked !== gesture {
				original = gesture.delegate
				hooked = gesture
			}
			if gesture.delegate !== self { gesture.delegate = self }
			gesture.isEnabled = true
		}

		override func didMove(toParent parent: UIViewController?) {
			super.didMove(toParent: parent)
			DispatchQueue.main.async { [weak self] in self?.attach() }
		}

		override func viewDidAppear(_ animated: Bool) {
			super.viewDidAppear(animated)
			attach()
		}

		override func viewWillDisappear(_ animated: Bool) {
			super.viewWillDisappear(animated)
			if let hooked, hooked.delegate === self { hooked.delegate = original }
			hooked = nil
		}

		func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
			(navigationController?.viewControllers.count ?? 0) > 1
		}
	}
}
#endif
