import MailClawKit
import SwiftUI

/// Settings' switch: the server's state; a change waits for its acknowledgement (S2).
struct ConsentToggle: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		let consent = model.consent
		Toggle(
			"Allow AI sorting",
			isOn: Binding(get: { consent.switchOn }, set: { on in if on != consent.switchOn { consent.choose(on) } })
		)
		#if os(macOS)
		.toggleStyle(.checkbox)
		#endif
		.disabled(!consent.switchEnabled)
		.accessibilityIdentifier("settings-ai-sorting")
		// Opening Settings reads the state again: changed on another device, it shows here (S4).
		.task { consent.read() }
	}
}

/// Under the switch: one line of what is sent, the privacy link, and what went wrong if anything did.
struct ConsentNotes: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		let consent = model.consent
		VStack(alignment: .leading, spacing: 8) {
			Text("New mail’s sender, subject, attachment names and the first part of its text go to OpenAI to sort it.")
				.foregroundStyle(.mcMuted)
				.fixedSize(horizontal: false, vertical: true)
			if let status {
				Text(status.text)
					.foregroundStyle(status.isError ? MCColor.mcNeg : .mcMuted)
					.fixedSize(horizontal: false, vertical: true)
					.accessibilityIdentifier("settings-ai-status")
				if status.retry {
					Button("Try again") { consent.read() }
						.fontWeight(.medium)
						.buttonStyle(MCLinkButtonStyle())
						.disabled(consent.reading)
						.accessibilityIdentifier("settings-ai-retry")
				}
			}
			PublicLink(title: "Privacy policy", url: PublicLinks.privacy, id: "settings-ai-privacy")
		}
	}

	private var status: (text: String, isError: Bool, retry: Bool)? {
		let consent = model.consent
		if consent.saving != nil { return ("Saving…", false, false) }
		if let failed = consent.failed {
			let still = consent.server?.state == .allowed ? "on" : "off"
			let turning = "turn AI sorting \(failed.allow ? "on" : "off")"
			let why = failed.why == .offline ? "Couldn’t \(turning): no connection." : "Grip couldn’t \(turning)."
			return ("\(why) It’s still \(still).", true, true)
		}
		switch consent.readFailure {
		case .unavailable?: return ("AI sorting is off: Grip couldn’t read this setting.", true, true)
		case let why?: return ("Couldn’t check this setting: \(why == .offline ? "no connection" : "Grip didn’t answer").", true, true)
		case nil: return nil
		}
	}
}

/// A public page (privacy, support) in the accent, underlined: a link without colour alone.
struct PublicLink: View {
	let title: String
	let url: URL
	let id: String
	@Environment(\.openURL) private var openURL

	var body: some View {
		Button { openURL(url) } label: { Text(title).underline() }
			.fontWeight(.medium)
			.buttonStyle(MCLinkButtonStyle())
			.accessibilityAddTraits(.isLink)
			.accessibilityIdentifier(id)
	}
}
