import MailClawKit
import SwiftUI
@preconcurrency import WebKit

/// A message body in a locked-down WKWebView (ticket 13, failure modes 4, 5, 7):
/// - content JavaScript off; a non-persistent data store shared by all bodies (no cookies);
/// - a content rule list blocks every http(s) load; "Load images" swaps in one that lets images by;
/// - the document's CSP repeats both rules (EmailDocument);
/// - `cid:` images come from the API through a scheme handler (the token never enters the page);
/// - links open in the browser; every other navigation, frame and form submission is cancelled;
/// - the view is as tall as its content and never scrolls itself; height is measured by a script in
///   the app's own content world, which page content cannot reach;
/// - on iPhone and iPad, HTML mail is zoomed with Dynamic Type (NI-14); plain text already follows it.
struct EmailBodyView: View {
	let email: Email
	let hideQuoted: Bool
	let allowImages: Bool
	let sync: MailSync?
	/// The newsletter reader runs the mail edge to edge, with no rounded card (round-2 spec S3).
	let edgeToEdge: Bool
	/// "Dim email": a light mail in dark mode, toned down (NI-16).
	let dim: Bool
	let onLoaded: () -> Void
	@State private var height: CGFloat
	@State private var loaded = false
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize
	@Environment(\.colorScheme) private var colorScheme
	@Environment(\.mcPalette) private var palette

	init(
		email: Email, hideQuoted: Bool, allowImages: Bool, sync: MailSync?, edgeToEdge: Bool = false,
		dim: Bool = false, onLoaded: @escaping () -> Void
	) {
		self.email = email
		self.hideQuoted = hideQuoted
		self.allowImages = allowImages
		self.sync = sync
		self.edgeToEdge = edgeToEdge
		self.dim = dim
		self.onLoaded = onLoaded
		_height = State(initialValue: BodyHeights.shared[email.id] ?? 80)
	}

	var body: some View {
		let isHTML = email.htmlContent?.isEmpty == false
		let text = EmailDocument.TextStyle(
			ink: palette.css(.text), link: palette.css(.accent), dark: colorScheme == .dark)
		BodyWebView(
			document: Documents.shared.html(
				for: email, hideQuoted: hideQuoted, allowImages: allowImages, text: text,
				zoom: isHTML ? TextZoom.factor(for: dynamicTypeSize) : 1),
			allowImages: allowImages,
			attachments: email.attachments ?? [],
			sync: sync,
			transparent: !isHTML,
			dark: colorScheme == .dark,
			onLoaded: { measured in
				height = measured
				BodyHeights.shared[email.id] = measured
				loaded = true
				onLoaded()
			})
			.frame(height: max(height, 24))
			.overlay {
				if dim { Color.black.opacity(0.18).allowsHitTesting(false) }
			}
			.clipShape(RoundedRectangle(cornerRadius: isHTML && !edgeToEdge ? MCCorner.control.radius : 0, style: .continuous))
			.overlay {
				if !loaded { ProgressView().controlSize(.small) }
			}
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("message-body")
			.accessibilityValue(loaded ? "loaded" : "loading")
	}
}

/// Built documents and remote-image scans per message: a body re-renders on every height or state
/// change, and a multi-megabyte message must not be rebuilt and regex-scanned each time.
@MainActor
final class Documents {
	static let shared = Documents()
	private var html: [String: String] = [:]
	private var remote: [String: Bool] = [:]

	/// Sign-out forgets every body built for the previous identity.
	func clear() { html.removeAll(); remote.removeAll() }

	func html(
		for email: Email, hideQuoted: Bool, allowImages: Bool, text: EmailDocument.TextStyle, zoom: CGFloat
	) -> String {
		// The quote split is in the key: the anchor-only response has none, the full thread's does (d2-11).
		// A plain-text body is set in the theme, so the theme is in its key too.
		let quote = email.quote.map { "\($0.hasQuoted)\($0.segments.count)" } ?? "-"
		let style = email.htmlContent?.isEmpty == false ? "" : "\(text.ink)\(text.link)\(text.dark)"
		let key = "\(email.id)|\(hideQuoted)|\(allowImages)|\(email.htmlContent?.utf8.count ?? -1)|\(quote)|\(style)|\(zoom)"
		if let cached = html[key] { return cached }
		if html.count > 24 { html.removeAll() }
		let document = EmailDocument.html(
			for: email, hideQuoted: hideQuoted, allowRemoteImages: allowImages, text: text, zoom: Double(zoom))
		html[key] = document
		return document
	}

	func hasRemoteImages(_ email: Email) -> Bool {
		if let cached = remote[email.id] { return cached }
		let value = EmailDocument.hasRemoteImages(email)
		remote[email.id] = value
		return value
	}
}

/// Last measured height per message, so reopening a thread does not jump.
@MainActor
final class BodyHeights {
	static let shared = BodyHeights()
	private var heights: [String: CGFloat] = [:]
	func clear() { heights.removeAll() }

	subscript(id: String) -> CGFloat? {
		get { heights[id] }
		set { heights[id] = newValue }
	}
}

#if os(iOS)
typealias PlatformRepresentable = UIViewRepresentable
#else
typealias PlatformRepresentable = NSViewRepresentable
#endif

/// HTML mail's zoom for the reader's text size (NI-14, L3): the body style's scale, so the mail grows
/// with the text around it up to AX5 (about 3.1). EmailDocument applies it as CSS zoom, which reflows
/// to the view's width (iphone-r2-16: WKWebView.pageZoom scaled a page laid out at the normal size).
enum TextZoom {
	static func factor(for size: DynamicTypeSize) -> CGFloat {
		#if os(iOS)
		let body = UIFontMetrics(forTextStyle: .body).scaledValue(
			for: 17, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size)))
		return min(max(body / 17, 0.85), 3.2)
		#else
		return 1
		#endif
	}
}

struct BodyWebView: PlatformRepresentable {
	let document: String
	let allowImages: Bool
	let attachments: [Attachment]
	let sync: MailSync?
	let transparent: Bool
	/// The app's chosen appearance, so a sender's prefers-color-scheme follows it, not the system's.
	let dark: Bool
	let onLoaded: (CGFloat) -> Void

	func makeCoordinator() -> BodyCoordinator { BodyCoordinator() }

	#if os(iOS)
	func makeUIView(context: Context) -> InertWebView { context.coordinator.makeWebView(transparent: transparent) }
	func updateUIView(_ view: InertWebView, context: Context) { context.coordinator.update(self) }
	#else
	func makeNSView(context: Context) -> InertWebView { context.coordinator.makeWebView(transparent: transparent) }
	func updateNSView(_ view: InertWebView, context: Context) { context.coordinator.update(self) }
	#endif
}

/// Never scrolls on its own: the thread scrolls. Re-measures when its width changes.
final class InertWebView: WKWebView {
	var onWidthChange: (() -> Void)?
	private var lastWidth: CGFloat = 0

	#if os(iOS)
	override func layoutSubviews() {
		super.layoutSubviews()
		widthMaybeChanged()
	}
	#else
	override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
	override func layout() {
		super.layout()
		widthMaybeChanged()
	}
	#endif

	private func widthMaybeChanged() {
		let width = bounds.width
		guard width > 0, abs(width - lastWidth) > 0.5 else { return }
		let first = lastWidth == 0
		lastWidth = width
		if !first { onWidthChange?() }
	}
}

@MainActor
final class BodyCoordinator: NSObject, WKNavigationDelegate {
	private var parent: BodyWebView?
	private weak var webView: InertWebView?
	private let cid = CIDSchemeHandler()
	private var shownDocument: String?
	private var shownAllowImages: Bool?
	private var loadGeneration = 0

	func makeWebView(transparent: Bool) -> InertWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = WebShared.dataStore
		configuration.defaultWebpagePreferences.allowsContentJavaScript = false
		#if os(iOS)
		// An iPad asks for desktop pages: laid out wide and shrunk to fit, which undid the text-size
		// zoom (ipad-r1-05). Mail lays out at the view's own width, as on iPhone.
		configuration.defaultWebpagePreferences.preferredContentMode = .mobile
		#endif
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
		configuration.setURLSchemeHandler(cid, forURLScheme: "cid")
		configuration.suppressesIncrementalRendering = true
		let webView = InertWebView(frame: .zero, configuration: configuration)
		webView.navigationDelegate = self
		webView.allowsLinkPreview = false
		#if os(iOS)
		webView.scrollView.isScrollEnabled = false
		webView.scrollView.bounces = false
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		webView.isOpaque = false
		webView.backgroundColor = .clear
		webView.scrollView.backgroundColor = .clear
		#else
		webView.setValue(false, forKey: "drawsBackground")
		#endif
		webView.onWidthChange = { [weak self] in self?.measure() }
		self.webView = webView
		return webView
	}

	func update(_ parent: BodyWebView) {
		self.parent = parent
		cid.attachments = parent.attachments
		cid.sync = parent.sync
		// Only on a change: setting an appearance re-styles the page, and this runs on every update.
		#if os(iOS)
		let style: UIUserInterfaceStyle = parent.dark ? .dark : .light
		if let webView, webView.overrideUserInterfaceStyle != style { webView.overrideUserInterfaceStyle = style }
		#else
		let name: NSAppearance.Name = parent.dark ? .darkAqua : .aqua
		if let webView, webView.appearance?.name != name { webView.appearance = NSAppearance(named: name) }
		#endif
		guard parent.document != shownDocument || parent.allowImages != shownAllowImages else { return }
		shownDocument = parent.document
		shownAllowImages = parent.allowImages
		loadGeneration += 1
		let generation = loadGeneration
		Task {
			let rules = await WebRules.shared.lists()
			guard generation == loadGeneration, let webView else { return }
			let controller = webView.configuration.userContentController
			controller.removeAllContentRuleLists()
			if let rule = parent.allowImages ? rules.images : rules.block { controller.add(rule) }
			webView.loadHTMLString(parent.document, baseURL: nil)
		}
	}

	private func measure() {
		guard let webView else { return }
		let generation = loadGeneration
		webView.evaluateJavaScript(EmailDocument.heightScript, in: nil, in: .defaultClient) { [weak self] result in
			MainActor.assumeIsolated {
				guard let self, generation == self.loadGeneration else { return }
				let height = (try? result.get()).flatMap { ($0 as? NSNumber)?.doubleValue } ?? 0
				self.parent?.onLoaded(CGFloat(max(height, 1)))
			}
		}
	}

	// MARK: WKNavigationDelegate

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		measure()
	}

	func webView(
		_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
		decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
	) {
		let url = action.request.url
		if action.navigationType == .linkActivated, let url, let scheme = url.scheme?.lowercased(),
		   ["http", "https", "mailto", "tel"].contains(scheme) {
			WebShared.openExternally(url)
			decisionHandler(.cancel)
			return
		}
		// Only our own loadHTMLString (about:blank, main frame) may load.
		let isOwnLoad = url?.absoluteString == "about:blank" && action.targetFrame?.isMainFrame == true
			&& action.navigationType == .other
		decisionHandler(isOwnLoad ? .allow : .cancel)
	}
}

/// Serves `cid:` inline images from the message's attachments via the API.
@MainActor
final class CIDSchemeHandler: NSObject, WKURLSchemeHandler {
	var attachments: [Attachment] = []
	var sync: MailSync?
	private var active = Set<ObjectIdentifier>()

	func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
		let key = ObjectIdentifier(task)
		let raw = task.request.url?.absoluteString ?? ""
		let wanted = (raw.dropFirst(4).removingPercentEncoding ?? String(raw.dropFirst(4)))
			.trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
		guard let sync, let url = task.request.url,
		      let attachment = attachments.first(where: { $0.bareContentId?.caseInsensitiveCompare(wanted) == .orderedSame })
		else {
			task.didFailWithError(URLError(.fileDoesNotExist))
			return
		}
		active.insert(key)
		nonisolated(unsafe) let task = task
		Task {
			defer { active.remove(key) }
			do {
				let file = try await sync.attachment(attachment)
				let data = try Data(contentsOf: file)
				guard active.contains(key) else { return }
				task.didReceive(URLResponse(
					url: url, mimeType: attachment.mimeType, expectedContentLength: data.count, textEncodingName: nil))
				task.didReceive(data)
				task.didFinish()
			} catch {
				guard active.contains(key) else { return }
				task.didFailWithError(error)
			}
		}
	}

	func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
		active.remove(ObjectIdentifier(task))
	}
}

@MainActor
enum WebShared {
	static let dataStore = WKWebsiteDataStore.nonPersistent()

	static func openExternally(_ url: URL) {
		#if os(iOS)
		UIApplication.shared.open(url)
		#else
		NSWorkspace.shared.open(url)
		#endif
	}
}

/// Two compiled content rule lists: block every network load, or block all but images.
@MainActor
final class WebRules {
	static let shared = WebRules()
	private var compiled: (block: WKContentRuleList?, images: WKContentRuleList?)?
	private var pending: Task<(block: WKContentRuleList?, images: WKContentRuleList?), Never>?

	// url-filter regexes have no alternation, hence one rule per scheme.
	private static let localSchemes = ["about:", "data:", "cid:"].map {
		#"{"trigger":{"url-filter":"^\#($0)"},"action":{"type":"ignore-previous-rules"}}"#
	}
	private static let blockAll = "[" + ([#"{"trigger":{"url-filter":".*"},"action":{"type":"block"}}"#] + localSchemes)
		.joined(separator: ",") + "]"
	private static let allowImages = "[" + ([#"{"trigger":{"url-filter":".*"},"action":{"type":"block"}}"#] + localSchemes
		+ [#"{"trigger":{"url-filter":"^https?://","resource-type":["image"]},"action":{"type":"ignore-previous-rules"}}"#])
		.joined(separator: ",") + "]"

	func warmUp() { Task { _ = await lists() } }

	func lists() async -> (block: WKContentRuleList?, images: WKContentRuleList?) {
		if let compiled { return compiled }
		if let pending { return await pending.value }
		let task = Task { @MainActor in
			let store = WKContentRuleListStore.default()
			let block = try? await store?.compileContentRuleList(forIdentifier: "mc-block-v2", encodedContentRuleList: Self.blockAll)
			let images = try? await store?.compileContentRuleList(forIdentifier: "mc-images-v2", encodedContentRuleList: Self.allowImages)
			assert(block != nil && images != nil, "content rule lists failed to compile")
			return (block: block ?? nil, images: images ?? nil)
		}
		pending = task
		let result = await task.value
		compiled = result
		return result
	}
}
