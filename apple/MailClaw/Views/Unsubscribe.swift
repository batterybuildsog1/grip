import SwiftUI

/// The sender's unsubscribe in a newsletter's head, or in a newsletter message's box inside a longer
/// conversation (L3 S3; the web's NewsletterReader and MessageBox). Unsubscribe → "Unsubscribing…" →
/// "Unsubscribed", or "Finish on the unsubscribe page" (the page has opened in the browser), or
/// "Couldn’t unsubscribe. <why>" with Try again: a failure never reads as done. Only for mail with
/// List-Unsubscribe; nothing is sent but for the tap (AppModel.unsubscribe).
struct UnsubscribeControl: View {
	let emailId: String
	@Environment(AppModel.self) private var app

	var body: some View {
		switch app.unsubscribeStep(emailId) {
		case .ready:
			link("Unsubscribe", id: "unsubscribe")
		case .working:
			status("Unsubscribing…")
		case .done:
			status("Unsubscribed")
		case .link:
			link("Finish on the unsubscribe page", id: "unsubscribe-finish")
		case let .failed(reason):
			HStack(alignment: .firstTextBaseline, spacing: 10) {
				Text("Couldn’t unsubscribe. \(reason)")
					.foregroundStyle(.mcNeg)
					.fixedSize(horizontal: false, vertical: true)
					.accessibilityIdentifier("unsubscribe-status")
				link("Try again", id: "unsubscribe-retry")
			}
		}
	}

	private func link(_ title: String, id: String) -> some View {
		Button(title) { app.unsubscribe(emailId) }
			.fontWeight(.medium)
			.buttonStyle(MCLinkButtonStyle())
			.accessibilityIdentifier(id)
	}

	private func status(_ text: String) -> some View {
		Text(text)
			.foregroundStyle(.mcMuted)
			.accessibilityIdentifier("unsubscribe-status")
	}
}

#if os(iOS)
/// The same tap from a newsletter's bottom bar (L3 S3: Unsubscribe · Archive · More). Its word says
/// how far it got; the head says why a failure failed.
struct UnsubscribeBarWord: View {
	let emailId: String
	@Environment(AppModel.self) private var app

	var body: some View {
		let step = app.unsubscribeStep(emailId)
		Button(Self.word(step)) { app.unsubscribe(emailId) }
			.tint(.mcText)
			.disabled(step == .working || step == .done)
			.frame(minWidth: 72)
			.accessibilityShowsLargeContentViewer()
			.accessibilityIdentifier("thread-unsubscribe")
	}

	private static func word(_ step: UnsubscribeStep) -> String {
		switch step {
		case .ready, .link: "Unsubscribe"
		case .working: "Unsubscribing…"
		case .done: "Unsubscribed"
		case .failed: "Try again"
		}
	}
}
#endif
