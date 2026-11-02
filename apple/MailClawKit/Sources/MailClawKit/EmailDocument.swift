import Foundation

/// Builds the document a message body is shown in (ticket 13). It never sanitizes by rewriting the
/// sender's HTML; the web view enforces safety: content JavaScript is off, a content rule list
/// blocks every http(s) load, and this document's CSP (first element of <head>) allows only inline
/// styles, `cid:` and `data:` images, plus http(s) images once the user taps "Load images".
public enum EmailDocument {
	/// How a plain-text body is set: the app theme's ink and link colours (CSS hex), its light or
	/// dark, in the reading face (New York).
	public struct TextStyle: Hashable, Sendable {
		public let ink: String
		public let link: String
		public let dark: Bool

		public init(ink: String, link: String, dark: Bool) {
			self.ink = ink
			self.link = link
			self.dark = dark
		}

		var css: String {
			let family = #"ui-serif,"New York",Georgia,serif"#
			return "body.mc-text{color-scheme:\(dark ? "dark" : "light");color:\(ink);font-family:\(family)}"
				+ "body.mc-text a{color:\(link)}"
		}
	}

	/// `zoom` (iPhone, the reader's text size; NI-14, L3): HTML mail is drawn this much larger and
	/// reflows to the view's own width, as browser zoom does: CSS `zoom` on the root, never a scale of a
	/// page laid out at the normal size (WKWebView.pageZoom did that: at AX5 a 390pt reader held a
	/// 1100pt-wide page, cropped at the right edge, iphone-r2-16). The base text is pinned to 17px
	/// so Dynamic Type counts once (`-apple-system-body` already follows it). Fixed widths still
	/// become 100% and long words break, so wide tables fit the width too.
	public static func html(
		for email: Email, hideQuoted: Bool, allowRemoteImages: Bool, text: TextStyle, zoom: Double = 1
	) -> String {
		if let html = email.htmlContent, !html.isEmpty {
			var css = hideQuoted ? "[data-mc-quoted=\"\(cssEscape(email.id))\"]{display:none!important}" : ""
			if abs(zoom - 1) > 0.001 {
				css += "html{zoom:\(String(format: "%.3f", zoom))}body.mc-html,body.mc-html-own-dark{font-size:17px}"
			}
			return wrap(
				html, kind: ownDark(html) ? "mc-html-own-dark" : "mc-html", allowRemoteImages: allowRemoteImages,
				extraCSS: css)
		}
		var body = email.textContent ?? ""
		if hideQuoted, let quote = email.quote, quote.hasQuoted {
			let utf16 = body as NSString
			body = quote.segments.filter { $0.kind == "new" }.compactMap { segment -> String? in
				let start = max(0, min(segment.start ?? 0, utf16.length))
				let end = max(start, min(segment.end ?? 0, utf16.length))
				return utf16.substring(with: NSRange(location: start, length: end - start))
			}.joined().trimmingCharacters(in: .whitespacesAndNewlines)
		}
		return wrap(linkify(escape(body)), kind: "mc-text", allowRemoteImages: false, extraCSS: text.css)
	}

	/// True when the HTML references images (or backgrounds) on other servers.
	public static func hasRemoteImages(_ email: Email) -> Bool {
		guard let html = email.htmlContent else { return false }
		return html.range(of: remotePattern, options: [.regularExpression, .caseInsensitive]) != nil
	}

	/// True when the sender wrote a dark version (a prefers-color-scheme: dark rule, or a color-scheme
	/// meta naming dark): that mail follows the app's chosen appearance (the web view is set to it);
	/// any other stays a light document.
	public static func ownDark(_ html: String) -> Bool {
		html.range(of: ownDarkPattern, options: [.regularExpression, .caseInsensitive]) != nil
	}

	private static let ownDarkPattern =
		#"prefers-color-scheme\s*:\s*dark|<meta[^>]+(color-scheme|supported-color-schemes)[^>]+dark"#

	private static let remotePattern =
		#"(<img[^>]+src\s*=\s*["']?\s*(https?:)?//)|(url\(\s*["']?\s*(https?:)?//)|(background\s*=\s*["']?\s*(https?:)?//)|(srcset\s*=\s*["']?\s*(https?:)?//)"#

	/// Measures the rendered content; run by the app in its own content world after load.
	public static let heightScript = """
		(() => { const r = document.getElementById('mc-root'); if (!r) { return document.documentElement.scrollHeight; }
		const b = r.getBoundingClientRect(); return Math.ceil(Math.max(r.scrollHeight, b.height) + Math.max(0, b.top) + 2); })()
		"""

	private static func wrap(_ body: String, kind: String, allowRemoteImages: Bool, extraCSS: String) -> String {
		let images = allowRemoteImages ? "cid: data: https: http:" : "cid: data:"
		let csp = "default-src 'none'; style-src 'unsafe-inline'; img-src \(images); font-src data:; "
			+ "media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
		return """
			<!doctype html><html><head>\
			<meta http-equiv="Content-Security-Policy" content="\(csp)">\
			<meta http-equiv="x-dns-prefetch-control" content="off">\
			<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\
			<meta name="referrer" content="no-referrer">\
			<style>\(baseCSS)\(extraCSS)</style></head>\
			<body class="\(kind)"><div id="mc-root">\(body)</div></body></html>
			"""
	}

	/// After the web's BASE_RENDER_CSS (ui/src/utils/email-render.ts): HTML mail is a light document
	/// even in dark mode (senders design for white), fitted to the width, unless the sender wrote its
	/// own dark version (mc-html-own-dark: no colours of ours, so theirs win). Plain text takes the
	/// app theme (TextStyle) and Dynamic Type.
	private static let baseCSS = """
		html,body{margin:0;padding:0;width:100%;max-width:100%;overflow-x:hidden;-webkit-text-size-adjust:100%}
		body.mc-html{color-scheme:light;background:#fff;color:#202124;font:-apple-system-body;font-family:-apple-system,system-ui,sans-serif;overflow-wrap:anywhere;word-break:break-word}
		body.mc-html-own-dark{color-scheme:light dark;font:-apple-system-body;font-family:-apple-system,system-ui,sans-serif;overflow-wrap:anywhere;word-break:break-word}
		body.mc-text{background:transparent;font:-apple-system-body}
		body.mc-text #mc-root{white-space:pre-wrap;overflow-wrap:anywhere}
		#mc-root{width:100%;max-width:100%;box-sizing:border-box}
		#mc-root *,#mc-root *::before,#mc-root *::after{box-sizing:border-box}
		#mc-root img,#mc-root video,#mc-root svg{max-width:100%;height:auto}
		#mc-root table{border-collapse:collapse;border-spacing:0;max-width:100%}
		#mc-root table[width],#mc-root table[style*="width"],#mc-root div[style*="width"],#mc-root center[style*="width"]{width:100%!important;max-width:100%!important}
		#mc-root td,#mc-root th{min-width:0!important;max-width:100%;word-break:break-word;overflow-wrap:anywhere}
		#mc-root pre,#mc-root code{white-space:pre-wrap;word-break:break-word}
		#mc-root figure{margin-left:0;margin-right:0;max-width:100%}
		#mc-root blockquote{margin-left:0;margin-right:0;padding-left:12px;border-left:3px solid rgba(128,128,128,.35)}
		"""

	private static func escape(_ text: String) -> String {
		text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
			.replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
	}

	private static func linkify(_ escaped: String) -> String {
		escaped.replacingOccurrences(
			of: #"https?://[^\s<>"]+[^\s<>".,;:!?)\]]"#, with: "<a href=\"$0\">$0</a>", options: .regularExpression)
	}

	private static func cssEscape(_ value: String) -> String {
		value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
	}
}
