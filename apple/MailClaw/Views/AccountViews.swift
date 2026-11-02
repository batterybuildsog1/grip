import MailClawKit
import SwiftUI

/// Signed out: the whole window (iPhone, iPad, Mac). The wordmark, Email and Password (iCloud
/// Keychain fills and saves them: `.username`, `.password`), the error, Sign in (the one filled
/// button), and the two public pages in small words. No server address: the email picks it
/// (`ServerConfig.origin(forEmail:)`). iPhone (compact width): the error and Sign in sit in the bottom
/// inset, which always rides above the keyboard (at AX5 an inline Sign in stayed under it: the content
/// had nothing left to scroll). iPad and Mac: one centred column, Sign in under the fields.
struct SignInView: View {
	@Environment(AppModel.self) private var model
	@Environment(\.mcPalette) private var palette
	#if os(iOS)
	@Environment(\.horizontalSizeClass) private var widthClass
	#endif
	@State private var email = ""
	@State private var password = ""
	@FocusState private var field: Field?
	private enum Field: Hashable { case email, password }
	private var busy: Bool { model.signingIn || model.signingOut }
	private var canSubmit: Bool {
		!busy && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
	}
	private var pinned: Bool {
		#if os(iOS)
		widthClass == .compact
		#else
		false
		#endif
	}

	var body: some View {
		ScrollViewReader { scroller in
			ScrollView {
				form.padding(.vertical, 24)
			}
			// Short content sits in the upper third; long content (AX5) starts at the top and scrolls.
			.defaultScrollAnchor(UnitPoint(x: 0.5, y: 0.3), for: .alignment)
			.scrollDismissesKeyboard(.interactively)
			// The field being typed in clears the keyboard and the pinned Sign in (the system's own scrolling
			// clears only the keyboard). Again once the keyboard has settled. A jump: a tap during an animated
			// scroll only stops it.
			.onChange(of: field) { _, now in
				guard let now else { return }
				scroller.scrollTo(now, anchor: .bottom)
				Task { @MainActor in
					try? await Task.sleep(for: .milliseconds(600))
					if field == now { scroller.scrollTo(now, anchor: .bottom) }
				}
			}
			// On the scroll view: further out it would rename the pinned Sign in too.
			.accessibilityIdentifier("signed-out")
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			if pinned {
				// The app's bottom bar: the sheet under a hairline, its words capped at the largest standard
				// size as system bars are (a long press on Sign in shows it large).
				VStack(alignment: .leading, spacing: 12) { action }
					.frame(maxWidth: 360, alignment: .leading)
					.padding(.horizontal, 28)
					.padding(.vertical, 12)
					.frame(maxWidth: .infinity)
					.mcBottomBar()
			}
		}
		.onChange(of: model.signInError) { _, message in
			if let message { AccessibilityNotification.Announcement(message).post() }
		}
		.background(.mcSheet)
		.foregroundStyle(.mcText)
		#if os(macOS)
		// The window's toolbar band in the sheet's own colour: the system's material showed as a pale
		// band over Grip's bone sheet and a grey one over its black (grip-themes G07).
		.toolbarBackground(palette[.sheet], for: .windowToolbar)
		#endif
	}

	private var form: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text("Grip")
				.font(.largeTitle.weight(.mcTitle))
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)
				.padding(.bottom, 28)
			input("Email", .email) {
				TextField("Email", text: $email, prompt: Text(""))
					.textContentType(.username)
					#if os(iOS)
					.keyboardType(.emailAddress)
					.textInputAutocapitalization(.never)
					#endif
					.autocorrectionDisabled()
					.submitLabel(.next)
					.onSubmit { field = .password }
					.accessibilityIdentifier("sign-in-email")
			}
			.padding(.bottom, 16)
			input("Password", .password) {
				SecureField("Password", text: $password, prompt: Text(""))
					.textContentType(.password)
					.submitLabel(.go)
					.onSubmit { submit() }
					.accessibilityIdentifier("sign-in-password")
			}
			if !pinned {
				VStack(alignment: .leading, spacing: 14) { action }
					.padding(.top, 22)
			}
			links.padding(.top, 22)
		}
		.disabled(model.signingOut)
		.frame(maxWidth: 360, alignment: .leading)
		.padding(.horizontal, 28)
		.frame(maxWidth: .infinity)
	}

	/// The error (if any) over Sign in.
	@ViewBuilder private var action: some View {
		if let error = model.signInError {
			Text(error)
				.foregroundStyle(.mcNeg)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityIdentifier("sign-in-error")
		}
		Button(model.signingIn ? "Signing in…" : "Sign in") { submit() }
			.buttonStyle(MCPrimaryButtonStyle(wide: true))
			.disabled(!canSubmit || model.signingOut)
			#if os(macOS)
			.keyboardShortcut(.defaultAction)
			#endif
			.accessibilityShowsLargeContentViewer()
			.accessibilityIdentifier("sign-in-submit")
	}

	/// "Privacy policy · Support", in the system browser; stacked when they don't fit on one line.
	private var links: some View {
		// Underlined: a link must not depend on colour alone (Grip's accent is ink).
		let privacy = Link(destination: PublicLinks.privacy) { Text("Privacy policy").underline() }
			.accessibilityIdentifier("sign-in-privacy")
		let support = Link(destination: PublicLinks.support) { Text("Support").underline() }
			.accessibilityIdentifier("sign-in-support")
		return ViewThatFits(in: .horizontal) {
			HStack(spacing: 8) {
				privacy
				Text("·").foregroundStyle(.mcFaint).accessibilityHidden(true)
				support
			}
			VStack(alignment: .leading, spacing: 8) { privacy; support }
		}
		.font(.footnote)
		.tint(.mcAccent)
	}

	/// A field under its label: the raised fill in the control's corner, the focus colour around it
	/// while it has the keyboard.
	private func input<Content: View>(_ title: String, _ which: Field, @ViewBuilder content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.mcMuted)
				.accessibilityHidden(true)
			content()
				.textFieldStyle(.plain)
				.focused($field, equals: which)
				.disabled(busy)
				.padding(.horizontal, 12)
				.padding(.vertical, 10)
				.frame(minHeight: 44)
				.background(.mcRaised, in: MCCorner.control.rect)
				.overlay(MCCorner.control.rect.strokeBorder(field == which ? AnyShapeStyle(.mcFocus) : AnyShapeStyle(.mcControl)))
				.contentShape(MCCorner.control.rect)
				// The padding around the words takes the keyboard too.
				.simultaneousGesture(TapGesture().onEnded { field = which })
		}
		.id(which)
	}

	private func submit() {
		guard canSubmit else { return }
		let attempt = password
		password = ""
		field = nil
		Task { await model.signIn(email: email, password: attempt) }
	}
}

/// Signed in, but this device can't keep mail (d2-21): said where the list would be, never the
/// sign-in form. The offline pilot (no account) says mail is off.
struct MailUnavailableView: View {
	@Environment(AppModel.self) private var model
	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if let storeError = model.storeError {
				Text("Can’t open mail on this device").font(.headline)
				Text(storeError).foregroundStyle(.mcMuted).fixedSize(horizontal: false, vertical: true)
			} else {
				Text("Mail is off in this build.").foregroundStyle(.mcMuted)
			}
		}
		.padding(28)
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityIdentifier("store-error")
	}
}

/// Sign-in and the lock, words only: a section of the account sheet (iPhone, iPad popover) and of
/// the Mac's Settings window. The signed-in address, "Lock Grip" and its delay, Lock now, and
/// Sign out. Turning the lock off asks for Face ID or the passcode first.
struct SessionSettings: View {
	@Environment(AppModel.self) private var model
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		let lock = model.lock
		if let email = model.sessionEmail {
			Text(email).textSelection(.enabled).accessibilityIdentifier("session-email")
		}
		if lock.isConfigured {
			Toggle(
				"Lock Grip",
				isOn: Binding(get: { lock.enabled }, set: { value in Task { await lock.setEnabled(value) } })
			)
			#if os(macOS)
			.toggleStyle(.checkbox)
			#endif
			.disabled(lock.authenticating)
			.accessibilityIdentifier("lock-enabled")
			if lock.enabled {
				LabeledContent("Lock after") {
					MCSegmented(options: LockDelay.allCases, selection: Binding(
						get: { LockDelay(rawValue: lock.timeout) ?? .five },
						set: { lock.setTimeout($0.rawValue) }
					)) { $0.title }
						.fixedSize()
						.accessibilityIdentifier("lock-timeout")
				}
				Button("Lock now") {
					dismiss()
					lock.lockNow()
				}
				.accessibilityIdentifier("lock-now")
			}
			if let error = lock.error { Text(error).foregroundStyle(.mcMuted) }
		}
		if model.sync != nil {
			Button("Sign out", role: .destructive) {
				dismiss()
				Task { await model.signOut() }
			}
			.disabled(model.signingOut)
			.accessibilityIdentifier("sign-out")
		}
	}
}

/// The lock's delays after MailClaw leaves the screen.
enum LockDelay: Int, CaseIterable, Identifiable {
	case now = 0, one = 60, five = 300, fifteen = 900
	var id: Int { rawValue }
	var title: String {
		switch self {
		case .now: "Now"
		case .one: "1 min"
		case .five: "5 min"
		case .fifteen: "15 min"
		}
	}
}

struct LockedMailView: View {
	@Environment(AppModel.self) private var model
	var body: some View {
		ScrollView {
			VStack(spacing: 20) {
				Text("Grip is locked").font(.title2.bold()).accessibilityAddTraits(
					.isHeader)
				if let error = model.lock.error {
					Text(error).multilineTextAlignment(.center).fixedSize(
						horizontal: false, vertical: true)
				}
				Button("Unlock") { Task { await model.lock.unlock() } }
					.buttonStyle(.borderedProminent).controlSize(.large)
					.disabled(model.lock.authenticating).accessibilityIdentifier(
						"unlock-mail"
					)
					.keyboardShortcut(.defaultAction)
				if model.lock.authenticating { ProgressView("Unlocking…") }
				Button("Sign in again") { Task { await model.signOut() } }.disabled(
					model.signingOut)
			}.padding(28).frame(maxWidth: 380).frame(maxWidth: .infinity)
		}.defaultScrollAnchor(.center, for: .alignment)
			.scrollDismissesKeyboard(.never)
	}
}

struct PrivacyCurtain: View {
	var body: some View {
		Color.clear.overlay { Text("Grip").font(.title2.weight(.semibold)).foregroundStyle(.mcMuted) }
			.background(.mcFrame).ignoresSafeArea().accessibilityLabel("Grip")
	}
}
