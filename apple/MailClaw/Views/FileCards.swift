import MailClawKit
import SwiftUI
#if os(macOS)
import QuickLook
#endif

/// A message's files (round-2 spec S3): the whole name, wrapping (NM-11, NI-10), "PDF · 57 KB"
/// under it, no icons. A click downloads the file and opens Quick Look. Full width on iPhone; a
/// wrapping grid on the Mac, so every file stays reachable (d2-14).
struct FileCards: View {
	let attachments: [Attachment]
	let sync: MailSync
	@State private var previewURL: URL?
	@State private var downloading: String?
	@State private var failed: String?

	var body: some View {
		Group {
			#if os(iOS)
			VStack(alignment: .leading, spacing: 8) { cards }
			#else
			LazyVGrid(columns: [GridItem(.adaptive(minimum: 220, maximum: 380), spacing: 8, alignment: .leading)],
			          alignment: .leading, spacing: 8) { cards }
			#endif
		}
		#if os(macOS)
		.quickLookPreview($previewURL)
		#endif
	}

	private var cards: some View {
		ForEach(attachments) { attachment in
			Button { open(attachment) } label: { card(attachment) }
				.buttonStyle(.plain)
				.accessibilityElement(children: .combine)
				.accessibilityIdentifier("attachment")
		}
	}

	private func card(_ attachment: Attachment) -> some View {
		VStack(alignment: .leading, spacing: 2) {
			Text(attachment.filename ?? "Attachment")
				.font(.subheadline.weight(.medium))
				.multilineTextAlignment(.leading)
				.fixedSize(horizontal: false, vertical: true)
			Text(status(attachment))
				.font(.caption)
				.foregroundStyle(failed == attachment.id ? MCColor.mcWarn : .mcMuted)
		}
		.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
		.padding(.horizontal, 12)
		.padding(.vertical, 8)
		.foregroundStyle(.mcText)
		.background(.mcSheet, in: MCCorner.box.rect)
		.overlay { MCCorner.box.rect.strokeBorder(.mcBorder, lineWidth: 1) }
		.contentShape(MCCorner.box.rect)
	}

	private func status(_ attachment: Attachment) -> String {
		if downloading == attachment.id { return "Downloading…" }
		if failed == attachment.id { return "Couldn’t open · Try again" }
		return FileMeta.label(attachment)
	}

	private func open(_ attachment: Attachment) {
		guard downloading == nil else { return }
		downloading = attachment.id
		failed = nil
		let start = ContinuousClock.now
		Task {
			defer { downloading = nil }
			do {
				let url = try await sync.attachment(attachment)
				#if os(macOS)
				previewURL = url
				#else
				guard AttachmentPreview.shared.present(url) else {
					failed = attachment.id
					return
				}
				#endif
				if LaunchOptions.perfProbe {
					PerfProbe.shared.add("attachment_open_ms", ms: (ContinuousClock.now - start).milliseconds)
				}
			} catch {
				failed = attachment.id
			}
		}
	}
}

/// "PDF · 57 KB": the same words as the web (ui/src/utils/files.ts).
enum FileMeta {
	static func label(_ attachment: Attachment) -> String { "\(type(attachment)) · \(size(attachment.size))" }

	static func size(_ bytes: Int) -> String {
		if bytes >= 1_048_576 { return String(format: "%.1f MB", Double(bytes) / 1_048_576) }
		return "\(max(1, Int((Double(bytes) / 1024).rounded()))) KB"
	}

	static func type(_ attachment: Attachment) -> String {
		let mime = attachment.mimeType.lowercased().split(separator: ";").first.map(String.init) ?? ""
		let name = attachment.filename ?? ""
		if mime == "application/pdf" || name.lowercased().hasSuffix(".pdf") { return "PDF" }
		let ext = (name as NSString).pathExtension
		if !ext.isEmpty, ext.count <= 8 { return String(ext.uppercased().prefix(4)) }
		let sub = mime.split(separator: "/").dropFirst().first.map(String.init) ?? ""
		let word = sub.split(whereSeparator: { ".+-".contains($0) }).first.map(String.init) ?? ""
		return word.isEmpty ? "File" : String(word.uppercased().prefix(4))
	}
}

extension Email {
	/// The files a person would call attachments: not the images the HTML shows inline, not
	/// signature logos (image001.png), one per name and size (as ui/src/utils/files.ts).
	var files: [Attachment] {
		var seen = Set<String>()
		return listedAttachments.filter { attachment in
			let mime = attachment.mimeType.lowercased()
			let logo = ["image/png", "image/jpeg", "image/jpg", "image/gif"].contains(mime)
				&& (attachment.contentId != nil
					|| (attachment.filename ?? "").range(
						of: #"^(image|outlook)[-_]?\d*\.(png|jpe?g|gif)$"#, options: [.regularExpression, .caseInsensitive]) != nil)
			if logo || (attachment.disposition == "inline" && attachment.contentId != nil) { return false }
			return seen.insert("\(attachment.filename ?? "")|\(attachment.size)").inserted
		}
	}
}

#if os(iOS)
/// The system preview of a downloaded attachment. UIKit's document controller loads QuickLook only
/// when a preview opens; linking QuickLook (SwiftUI's quickLookPreview) cost ~0.9 s of every
/// launch before the first frame (m3-08).
@MainActor
final class AttachmentPreview: NSObject, @preconcurrency UIDocumentInteractionControllerDelegate {
	static let shared = AttachmentPreview()
	private var controller: UIDocumentInteractionController?

	func present(_ url: URL) -> Bool {
		let controller = UIDocumentInteractionController(url: url)
		controller.delegate = self
		self.controller = controller
		return controller.presentPreview(animated: true)
	}

	func documentInteractionControllerViewControllerForPreview(
		_ controller: UIDocumentInteractionController
	) -> UIViewController {
		let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
		var top = window?.rootViewController ?? UIViewController()
		while let presented = top.presentedViewController { top = presented }
		return top
	}

	func documentInteractionControllerDidEndPreview(_ controller: UIDocumentInteractionController) {
		self.controller = nil
	}
}
#endif
