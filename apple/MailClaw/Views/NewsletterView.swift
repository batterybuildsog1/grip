import MailClawKit
import SwiftUI

/// A newsletter, receipt or notice (round-2 spec S3): the subject, one sender line (name, "to me",
/// date; Dim email and Unsubscribe under the date, L3), then the sender's HTML edge to edge with no
/// card around it, then its files. Mail with its own dark CSS follows the chosen appearance; a
/// light-only mail can be dimmed in dark (NI-16), here or from the iPhone's More (one `dim`).
struct NewsletterView: View {
	let email: Email
	let subject: String?
	@Binding var allowImages: Bool
	@Binding var dim: Bool
	let sync: MailSync?
	let onBodyLoaded: () -> Void
	@Environment(\.colorScheme) private var colorScheme

	/// One message, bulk (ThreadText.isBulk, as the web's isBulk in ui/src/utils/thread-text.ts).
	static func shows(_ detail: ConversationDetail) -> Email? {
		guard detail.conversation.messageCount == 1, detail.emails.count == 1, let email = detail.emails.first,
		      ThreadText.isBulk(email, category: detail.conversation.category) else { return nil }
		return email
	}

	private var offerDim: Bool {
		colorScheme == .dark && !EmailDocument.ownDark(email.htmlContent ?? "")
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text(subject?.isEmpty == false ? subject! : (email.subject ?? "(no subject)"))
				.font(.title2.weight(.mcTitle))
				.fixedSize(horizontal: false, vertical: true)
				.textSelection(.enabled)
				.padding(.horizontal, 20)
				.padding(.top, 12)
				.accessibilityIdentifier("thread-subject")
			senderLine
				.padding(.horizontal, 20)
				.padding(.top, 10)
			if Documents.shared.hasRemoteImages(email), !allowImages {
				HStack(spacing: 6) {
					Text("Images are off.").foregroundStyle(.mcMuted)
					Button("Load Images") { allowImages = true }
						.fontWeight(.semibold)
						.buttonStyle(MCLinkButtonStyle())
						.accessibilityIdentifier("load-images")
				}
				.font(.subheadline)
				.padding(.horizontal, 20)
				.padding(.top, 8)
			}
			EmailBodyView(
				email: email, hideQuoted: false, allowImages: allowImages, sync: sync, edgeToEdge: true,
				dim: dim && offerDim, onLoaded: onBodyLoaded)
				.padding(.top, 12)
			let files = email.files
			if !files.isEmpty, let sync {
				FileCards(attachments: files, sync: sync)
					.padding(.horizontal, 20)
					.padding(.top, 14)
			}
		}
		.padding(.bottom, 24)
		.foregroundStyle(.mcText)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("newsletter-reader")
	}

	private var senderLine: some View {
		VStack(alignment: .leading, spacing: 2) {
			// Name and date on one line while they fit, else stacked (NI-13: the date is never cut).
			ViewThatFits(in: .horizontal) {
				HStack(alignment: .firstTextBaseline) {
					Text(email.senderName).font(.headline).lineLimit(1)
					Spacer(minLength: 8)
					newsletterDate.lineLimit(1)
				}
				VStack(alignment: .leading, spacing: 2) {
					Text(email.senderName).font(.headline).fixedSize(horizontal: false, vertical: true)
					newsletterDate.fixedSize(horizontal: false, vertical: true)
				}
			}
			// "to me", and at the right Dim email and Unsubscribe while they fit; under "to me" when
			// they don't (a failure's reason, accessibility sizes).
			ViewThatFits(in: .horizontal) {
				HStack(alignment: .firstTextBaseline) {
					toMe
					Spacer(minLength: 8)
					actions
				}
				VStack(alignment: .leading, spacing: 4) {
					toMe
					actions
				}
			}
		}
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("newsletter-head")
	}

	private var toMe: some View {
		Text("to me")
			.font(.subheadline)
			.foregroundStyle(.mcMuted)
	}

	private var actions: some View {
		HStack(alignment: .firstTextBaseline, spacing: 14) {
			if offerDim {
				Button(dim ? "Undim email" : "Dim email") { dim.toggle() }
					.fontWeight(.medium)
					.buttonStyle(MCLinkButtonStyle())
					.accessibilityIdentifier("dim-email")
			}
			if email.listUnsubscribe?.isEmpty == false {
				UnsubscribeControl(emailId: email.id)
			}
		}
		.font(.subheadline)
	}

	private var newsletterDate: some View {
		Text(ThreadText.fullDate(email.date))
			.font(.subheadline)
			.foregroundStyle(.mcMuted)
			.accessibilityIdentifier("message-date")
	}
}
