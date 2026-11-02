import MailClawKit
import SwiftUI

/// One message of a thread in a bordered box (round-2 S2). Closed: name, first line, date (one
/// line on a Mac, two on iPhone). Open: name and date, the recipients button that reveals full
/// addresses, the new text only with the rest behind "Show trimmed text", attachments. People's
/// mail reads as text in the system font; bulk and HTML-only mail keep their HTML.
struct MessageBox: View {
	let email: Email
	let people: ThreadPeople
	/// The conversation's category, for messages that carry none of their own.
	let category: String?
	let expanded: Bool
	/// "Show original" from the thread's More menu (iPhone).
	let showOriginal: Bool
	let dim: Bool
	@Binding var allowImages: Bool
	let sync: MailSync?
	let onToggle: () -> Void
	let onBodyLoaded: () -> Void
	@State private var showTrimmed = false
	@State private var showAddresses = false
	@State private var originalHere = false
	@State private var hovering = false
	@State private var dimHere = false
	@Environment(\.colorScheme) private var colorScheme
	/// Accessibility text sizes (NI-13): the header stacks name / recipients / date, nothing cut.
	@Environment(\.dynamicTypeSize) private var typeSize
	@Environment(\.usesRail) private var usesRail

	private var parts: ThreadText.Parts { PartsCache.shared.parts(email) }
	private var asText: Bool { ThreadText.readsAsText(email, parts: parts, category: category) && !(showOriginal || originalHere) }
	private var canShowOriginal: Bool { email.htmlContent?.isEmpty == false && ThreadText.readsAsText(email, parts: parts, category: category) }
	private var htmlTrims: Bool { !asText && !(showOriginal || originalHere) && email.quote?.hasQuoted == true }
	private var canTrim: Bool { asText ? !parts.hidden.isEmpty : htmlTrims }
	private var unread: Bool { !email.isOutbound && email.readAt == nil }

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Button(action: onToggle) { expanded ? AnyView(openHeader) : AnyView(closedLine) }
				.buttonStyle(.plain)
				.accessibilityIdentifier(expanded ? "message-header-expanded" : "message-header-collapsed")
			if expanded {
				Button { showAddresses.toggle() } label: {
					Text(people.recipients(email))
						.font(.subheadline)
						.foregroundStyle(.mcMuted)
						.underline(pattern: .dot, color: palette[.control])
						.multilineTextAlignment(.leading)
				}
				.buttonStyle(.plain)
				.accessibilityIdentifier("message-recipients")
				.accessibilityValue(showAddresses ? "shown" : "hidden")
				if typeSize.isAccessibilitySize { fullDate }
				if showAddresses { AddressesView(email: email, people: people) }
				// A newsletter inside a longer conversation unsubscribes from its own box (the web's).
				if email.listUnsubscribe?.isEmpty == false, ThreadText.isBulk(email, category: category) {
					UnsubscribeControl(emailId: email.id).font(.subheadline)
				}
				messageBody
				toggles
				let files = email.files
				if !files.isEmpty, let sync {
					FileCards(attachments: files, sync: sync)
				}
			}
		}
		.padding(.horizontal, 14)
		.padding(.vertical, expanded ? 14 : 11)
		.frame(maxWidth: .infinity, alignment: .leading)
		.foregroundStyle(.mcText)
		.background(.mcSheet, in: MCCorner.box.rect)
		.overlay(MCCorner.box.rect.strokeBorder(hovering && !expanded ? MCColor.mcControl : .mcBorder))
		.onHover { hovering = $0 }
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("message-card")
	}

	private var closedLine: some View {
		let sender = Text(people.sender(email)).fontWeight(unread ? .bold : .semibold)
		let line = Text(ThreadText.firstLine(email, parts: parts)).foregroundStyle(.mcMuted)
		let date = Text(ThreadText.shortDate(email.date)).font(.subheadline).foregroundStyle(.mcMuted)
		return Group {
			if usesRail {
				HStack(alignment: .firstTextBaseline, spacing: 14) {
					sender.lineLimit(1).frame(maxWidth: 170, alignment: .leading)
					line.lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
					date.lineLimit(1)
				}
			} else {
				VStack(alignment: .leading, spacing: 2) {
					if typeSize.isAccessibilitySize {
						sender.lineLimit(3)
						date
					} else {
						ViewThatFits(in: .horizontal) {
							HStack(alignment: .firstTextBaseline) {
								sender.lineLimit(1)
								Spacer(minLength: 8)
								date.lineLimit(1)
							}
							VStack(alignment: .leading, spacing: 2) {
								sender.lineLimit(1)
								date
							}
						}
					}
					line.font(.subheadline).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
				}
			}
		}
		.contentShape(Rectangle())
	}

	/// Name and date on one line; on two when they don't fit; at accessibility sizes the name alone,
	/// its recipients and date following on their own lines (`axDate`). The date is never cut.
	private var openHeader: some View {
		Group {
			if typeSize.isAccessibilitySize {
				HStack(alignment: .firstTextBaseline) { draftMark; name.fixedSize(horizontal: false, vertical: true) }
			} else {
				ViewThatFits(in: .horizontal) {
					HStack(alignment: .firstTextBaseline) {
						draftMark
						name.lineLimit(1)
						Spacer(minLength: 8)
						fullDate.lineLimit(1)
					}
					VStack(alignment: .leading, spacing: 2) {
						HStack(alignment: .firstTextBaseline) { draftMark; name.lineLimit(2) }
						fullDate
					}
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	@ViewBuilder private var draftMark: some View {
		if email.isDraft { Text("Draft").font(.headline).foregroundStyle(.mcNeg) }
	}

	private var name: some View { Text(people.sender(email)).font(.headline) }

	private var fullDate: some View {
		Text(ThreadText.fullDate(email.date))
			.font(.subheadline)
			.foregroundStyle(.mcMuted)
			.fixedSize(horizontal: false, vertical: true)
			.accessibilityIdentifier("message-date")
	}

	@ViewBuilder private var messageBody: some View {
		if asText {
			Text(Linked.text(parts.shown))
				.mcReadingFont(.body)
				.textSelection(.enabled)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityIdentifier("message-body")
				.accessibilityValue("loaded")
				.onAppear(perform: onBodyLoaded)
			if showTrimmed, !parts.hidden.isEmpty {
				Text(Linked.text(parts.hidden))
					.mcReadingFont(.callout)
					.foregroundStyle(.mcMuted)
					.textSelection(.enabled)
					.fixedSize(horizontal: false, vertical: true)
					.padding(.leading, 12)
					.overlay(alignment: .leading) { Rectangle().fill(.mcRule).frame(width: 2) }
					.accessibilityIdentifier("message-trimmed")
			}
		} else {
			if Documents.shared.hasRemoteImages(email), !allowImages {
				RemoteImagesBanner { allowImages = true }
			}
			EmailBodyView(
				email: email, hideQuoted: htmlTrims && !showTrimmed, allowImages: allowImages, sync: sync,
				dim: (dim || dimHere) && offerDim, onLoaded: onBodyLoaded)
		}
	}

	@ViewBuilder private var toggles: some View {
		let original = canShowOriginal && macHover
		let dimming = macDim
		if canTrim || original || dimming {
			HStack(spacing: 18) {
				if canTrim {
					Button(showTrimmed ? "Hide trimmed text" : "Show trimmed text") { showTrimmed.toggle() }
						.accessibilityIdentifier("toggle-trimmed")
				}
				if original {
					Button(originalHere ? "Show as text" : "Show original") { originalHere.toggle() }
						.accessibilityIdentifier("toggle-original")
				}
				if dimming {
					Button(dimHere ? "Undim email" : "Dim email") { dimHere.toggle() }
						.accessibilityIdentifier("dim-email")
				}
			}
			.buttonStyle(MCLinkButtonStyle())
			.font(.subheadline)
		}
	}

	@Environment(\.mcPalette) private var palette

	/// A light-only HTML mail in dark: "Dim email" tones it down (NI-16). A mail with its own dark
	/// version follows the chosen appearance instead.
	private var offerDim: Bool {
		!asText && colorScheme == .dark && !EmailDocument.ownDark(email.htmlContent ?? "")
	}

	/// The rail window (Mac, iPad) offers "Dim email" under each such mail (iPhone: the More menu).
	private var macDim: Bool { usesRail && offerDim && email.htmlContent?.isEmpty == false }

	/// "Show original": the Mac shows it while the pointer is over the message, an iPad always (a
	/// pointer isn't promised); the iPhone has it in the More menu.
	private var macHover: Bool {
		#if os(macOS)
		hovering || originalHere
		#else
		usesRail
		#endif
	}
}

/// A folded run of messages: count, who wrote, when. Opens in place.
struct MessageStackView: View {
	let kind: TimelineItem.Stack
	let emails: [Email]
	let people: ThreadPeople
	let onOpen: () -> Void
	@State private var hovering = false

	private var names: String {
		var seen = Set<String>()
		return emails.map(people.sender).filter { seen.insert($0).inserted }.joined(separator: ", ")
	}

	private var range: String {
		guard let first = emails.first, let last = emails.last else { return "" }
		let (from, to) = (ThreadText.monthDay(first.date), ThreadText.monthDay(last.date))
		return from == to ? from : "\(from) – \(to)"
	}

	var body: some View {
		Button(action: onOpen) {
			HStack(spacing: 12) {
				Text("\(emails.count)")
					.font(.subheadline.weight(.semibold))
					.padding(.horizontal, 7)
					.frame(minWidth: 26, minHeight: 26)
					.overlay(Capsule().strokeBorder(.mcControl))
				Text(names).foregroundStyle(.mcMuted).lineLimit(1)
				Spacer(minLength: 8)
				Text(range).font(.subheadline).foregroundStyle(.mcMuted).lineLimit(1)
			}
			.foregroundStyle(.mcText)
			.padding(.horizontal, 14)
			.padding(.vertical, 11)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(.mcSheet, in: MCCorner.box.rect)
			.overlay(MCCorner.box.rect.strokeBorder(hovering ? MCColor.mcControl : .mcBorder))
			.background(alignment: .bottom) {
				// Two edges below, like a stack of cards.
				ZStack {
					MCCorner.box.rect.fill(.mcSheet).overlay(MCCorner.box.rect.strokeBorder(.mcBorder))
						.offset(y: 6).padding(.horizontal, 8)
					MCCorner.box.rect.fill(.mcSheet).overlay(MCCorner.box.rect.strokeBorder(.mcBorder))
						.offset(y: 3).padding(.horizontal, 4)
				}
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.onHover { hovering = $0 }
		.padding(.bottom, 6)
		.accessibilityIdentifier("message-stack")
		.accessibilityLabel(
			"Show \(emails.count) \(kind == .earlier ? "earlier" : "more") messages from \(names), \(range)")
	}
}

/// From, To, Cc, Reply to with full addresses (WD-06, NM-10, NI-09).
private struct AddressesView: View {
	let email: Email
	let people: ThreadPeople
	@Environment(AppModel.self) private var model

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			line("From", [email.fromAddress], given: email.fromName)
			line("To", email.recipients)
			line("Cc", email.ccAddresses ?? [])
			line("Reply to", email.replyToAddresses ?? [])
		}
		.font(.footnote)
		.textSelection(.enabled)
		.padding(10)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(.mcRaised, in: MCCorner.control.rect)
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier("message-addresses")
	}

	@ViewBuilder private func line(_ label: String, _ list: [String], given: String? = nil) -> some View {
		if !list.isEmpty {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(label).foregroundStyle(.mcMuted).frame(width: 60, alignment: .leading)
				Text(list.map { "\(person($0, given: given)) \(ThreadText.bareAddress($0))" }.joined(separator: ", "))
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}

	/// "Me" by the configured sender name (SENDER_NAMES_JSON, via /api/meta), else as the thread names it.
	private func person(_ raw: String, given: String?) -> String {
		let mine = people.isMe(raw) ? model.meta?.senderName(ThreadText.bareAddress(raw)) : nil
		return mine ?? people.name(raw, given: given)
	}
}

/// Links in people's text are tappable.
enum Linked {
	private static let detector = try? NSDataDetector(
		types: NSTextCheckingResult.CheckingType.link.rawValue)

	static func text(_ string: String) -> AttributedString {
		var out = AttributedString(string)
		guard let detector else { return out }
		for match in detector.matches(in: string, range: NSRange(string.startIndex..., in: string)) {
			guard let url = match.url, let range = Range<AttributedString.Index>(match.range, in: out) else { continue }
			out[range].link = url
		}
		return out
	}
}

/// Parts per message, so a body re-render doesn't rerun every cut.
@MainActor
final class PartsCache {
	static let shared = PartsCache()
	private var parts: [String: ThreadText.Parts] = [:]

	func parts(_ email: Email) -> ThreadText.Parts {
		let key = "\(email.id)|\(email.textContent?.utf8.count ?? -1)|\(email.quote?.newText.utf8.count ?? -1)"
		if let cached = parts[key] { return cached }
		if parts.count > 200 { parts.removeAll() }
		let value = ThreadText.parts(email)
		parts[key] = value
		return value
	}
}

private struct RemoteImagesBanner: View {
	let load: () -> Void

	var body: some View {
		HStack(spacing: 8) {
			Text("Remote images are hidden.")
				.font(.subheadline)
				.foregroundStyle(.mcMuted)
			Spacer(minLength: 4)
			Button("Load Images", action: load)
				.font(.subheadline.weight(.semibold))
				.buttonStyle(MCLinkButtonStyle())
				.accessibilityIdentifier("load-images")
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 8)
		.background(.mcRaised, in: MCCorner.control.rect)
	}
}
