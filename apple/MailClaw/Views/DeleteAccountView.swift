import MailClawKit
import SwiftUI

/// Settings → Account → Delete account (SPEC §3): what happens, in plain words; the password again;
/// Cancel, the default; "Delete account" in the danger ink, as Trash. Pushed in the account sheet
/// (iPhone, the iPad popover), a sheet on the Mac's Settings window. A wrong password, a throttle or no
/// answer changes nothing here (D1-D4); success erases this identity and the sign-in screen says
/// "Your account is being deleted…" (AppModel+Account.swift).
struct DeleteAccountView: View {
	@Environment(AppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@Environment(\.dynamicTypeSize) private var typeSize
	/// The Mac's sheet draws its own title; pushed, the bar has it.
	var titled = false
	@State private var password = ""
	@State private var deleting = false
	@State private var failure: AccountFailure?
	@FocusState private var focused: Bool

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 12) {
				if titled {
					Text("Delete account")
						.font(.title2.weight(.mcTitle))
						.accessibilityAddTraits(.isHeader)
						.padding(.bottom, 4)
				}
				if let email = model.accountIdentity?.email {
					Text(email).foregroundStyle(.mcMuted).accessibilityIdentifier("delete-email")
				}
				Text("You’ll be signed out on every device at once.")
				Text("Your account and the data Grip holds for it are erased within 30 days.")
				Text("People you wrote to, or who wrote to you, keep their copies of that mail.")
				// The owner's mail is the whole mailbox (SPEC §3 runbook): its readers lose it too.
				if model.consent.server?.canDecide == true {
					Text("Everyone who reads this mailbox loses it too.")
				}
				VStack(alignment: .leading, spacing: 6) {
					Text("Password").font(.subheadline.weight(.medium))
					SecureField("", text: $password, prompt: Text("Your Grip password").foregroundStyle(.mcFaint))
						.textContentType(.password)
						.textFieldStyle(.plain)
						.focused($focused)
						.submitLabel(.done)
						.padding(.horizontal, 10)
						.frame(minHeight: 38)
						.background(.mcSheet, in: MCCorner.control.rect)
						.overlay(MCCorner.control.rect.strokeBorder(focused ? MCColor.mcFocus : .mcControl))
						.disabled(deleting)
						.accessibilityLabel("Password")
						.accessibilityIdentifier("delete-password")
				}
				.padding(.top, 8)
				if let failure {
					Text(Self.message(failure))
						.foregroundStyle(.mcNeg)
						.frame(maxWidth: .infinity, alignment: .leading)
						.accessibilityIdentifier("delete-error")
				}
				// The Mac draws its "Passwords…" AutoFill button under a focused password field: room for it.
				#if os(macOS)
				buttons.padding(.top, 40)
				#else
				buttons.padding(.top, 8)
				#endif
			}
			.fixedSize(horizontal: false, vertical: true)
			.frame(maxWidth: 520, alignment: .leading)
			.padding(titled ? 28 : 20)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.scrollBounceBehavior(.basedOnSize)
		.background(.mcSheet)
		.foregroundStyle(.mcText)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("delete-account")
		#if os(iOS)
		.navigationTitle("Delete account")
		.navigationBarTitleDisplayMode(.inline)
		.navigationBarBackButtonHidden(true)
		.toolbar {
			ToolbarItem(placement: .principal) {
				Text("Delete account").font(.headline).foregroundStyle(.mcText)
			}
		}
		#else
		.onExitCommand { if !deleting { dismiss() } }
		#endif
		// The password never outlives the screen (D10).
		.onDisappear { password = "" }
	}

	/// "Delete account" in the danger ink, set apart from Cancel, which is the default (Return, D8).
	/// Stacked at accessibility sizes. Chosen by the text size, not measured: in the iPad's popover,
	/// whose size follows its content, a measured choice never settled.
	@ViewBuilder private var buttons: some View {
		if typeSize.isAccessibilitySize {
			VStack(alignment: .leading, spacing: 14) {
				cancelButton
				deleteButton
			}
		} else {
			HStack(spacing: 16) {
				deleteButton
				Spacer(minLength: 16)
				cancelButton
			}
		}
	}

	private var deleteButton: some View {
		Button(deleting ? "Deleting…" : "Delete account") { submit() }
			.buttonStyle(.plain)
			.fontWeight(.medium)
			.foregroundStyle(.mcNeg)
			.padding(.vertical, 8)
			.contentShape(Rectangle())
			.opacity(password.isEmpty && !deleting ? 0.45 : 1)
			.disabled(password.isEmpty || deleting)
			.accessibilityIdentifier("delete-confirm")
	}

	private var cancelButton: some View {
		Button("Cancel") { dismiss() }
			.fontWeight(.semibold)
			.buttonStyle(MCOutlinedButtonStyle())
			.keyboardShortcut(.defaultAction)
			.disabled(deleting)
			.accessibilityIdentifier("delete-cancel")
	}

	private func submit() {
		guard !password.isEmpty, !deleting else { return }
		let attempt = password
		password = ""
		failure = nil
		focused = false
		deleting = true
		Task {
			let result = await model.deleteAccount(password: attempt)
			deleting = false
			failure = result
			// Done: this identity is erased; the Mac's sheet goes with it (iPhone and iPad: the
			// account sheet already went with the signed-in window).
			if result == nil { dismiss() }
		}
	}

	static func message(_ failure: AccountFailure) -> String {
		switch failure {
		case .wrongPassword: "That password isn’t right. Nothing was changed."
		case let .throttled(seconds):
			if let seconds, seconds > 0 {
				"Too many tries. Try again in \(max(1, Int((seconds / 60).rounded(.up)))) min."
			} else {
				"Too many tries. Try again later."
			}
		case .offline: "Couldn’t reach Grip. Check your connection and try again."
		case .signedOut: "You’re signed out. Sign in again to delete your account."
		default: "Grip couldn’t delete the account right now. Nothing was changed. Try again later."
		}
	}
}
