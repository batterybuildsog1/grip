#if os(iOS)
import MailClawKit
import SwiftUI
import UserNotifications

/// The account sheet (design r2 §4 S1): All accounts and each address (changes the account, never
/// the view: WD-02), sign-in and the lock (SessionSettings), AI sorting (the owner's), the app's one
/// notification setting, Appearance (applied at once; one theme, Grip), the privacy
/// and support pages, and Delete account (SPEC §2, §3).
struct AccountSheet: View {
	@Environment(AppModel.self) private var model
	@Environment(ThemeSettings.self) private var theme
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openURL) private var openURL
	@State private var deleting = false
	@State private var detent: PresentationDetent = .medium

	var body: some View {
		@Bindable var model = model
		@Bindable var theme = theme
		NavigationStack {
			List {
				Section {
					choice("All accounts", account: nil)
					ForEach(model.accounts, id: \.self) { account in
						choice(account, account: account)
					}
				} header: {
					Text("Account").foregroundStyle(.mcMuted)
				} footer: {
					Text("Switching accounts keeps you in \(model.view.title).").foregroundStyle(.mcMuted)
				}
				.listRowBackground(Rectangle().fill(.mcSheet))
				if model.sync != nil {
					Section {
						SessionSettings()
					} header: {
						Text("Sign-in").foregroundStyle(.mcMuted)
					}
					.listRowBackground(Rectangle().fill(.mcSheet))
				}
				if model.sync != nil, model.consent.settingsShown {
					Section {
						ConsentToggle()
					} header: {
						Text("AI sorting").foregroundStyle(.mcMuted)
					} footer: {
						ConsentNotes().padding(.top, 2)
					}
					.listRowBackground(Rectangle().fill(.mcSheet))
				}
				Section {
					// The app's one notification setting (the Mac's Settings checkbox, S6).
					Toggle("New mail in Personal and Needs you", isOn: $model.notifyEnabled)
						.accessibilityIdentifier("settings-notify")
				} header: {
					Text("Notifications").foregroundStyle(.mcMuted)
				} footer: {
					Text("Newsletters, receipts and notices never notify. Sounds and lock screen follow \(UIDevice.current.model) Settings.").foregroundStyle(.mcMuted)
				}
				.listRowBackground(Rectangle().fill(.mcSheet))
				// The theme's own segmented words, not UIKit's grey control (iphone-r2-14).
				Section {
					MCSegmented(options: MCAppearance.allCases, selection: $theme.appearance) { $0.title }
						.accessibilityIdentifier("settings-appearance")
				} header: {
					Text("Appearance").foregroundStyle(.mcMuted)
				}
				.listRowBackground(Rectangle().fill(.mcSheet))
				Section {
					page("Privacy policy", PublicLinks.privacy, id: "settings-privacy")
					page("Support", PublicLinks.support, id: "settings-support")
				}
				.listRowBackground(Rectangle().fill(.mcSheet))
				if model.accountIdentity != nil {
					Section {
						Button { deleting = true } label: {
							Text("Delete account")
								.foregroundStyle(.mcNeg)
								.frame(maxWidth: .infinity, alignment: .leading)
								.contentShape(Rectangle())
						}
						.accessibilityIdentifier("settings-delete-account")
					}
					.listRowBackground(Rectangle().fill(.mcSheet))
				}
			}
			.navigationDestination(isPresented: $deleting) { DeleteAccountView() }
			.scrollContentBackground(.hidden)
			.background(.mcFrame)
			.foregroundStyle(.mcText)
			.navigationTitle("Account")
			.navigationBarTitleDisplayMode(.inline)
			// The title in the theme's ink, as the composer's (UIKit drew it pure black or white,
			// iphone-r3-09); the navigation title stays the bar's name for VoiceOver and the tests.
			.toolbar {
				ToolbarItem(placement: .principal) {
					Text("Account").font(.headline).foregroundStyle(.mcText)
				}
			}
		}
		// Half height to start; Delete account takes the whole height (its password and the keyboard).
		.presentationDetents([.medium, .large], selection: $detent)
		.onChange(of: deleting) { _, now in if now { detent = .large } }
		// A presented sheet keeps the light/dark it opened with; this one changes it, so it follows.
		.preferredColorScheme(theme.appearance.colorScheme)
		.accessibilityIdentifier("account-sheet")
		.onChange(of: model.notifyEnabled) { _, on in
			guard on else { return }
			Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
		}
	}

	/// A public page: its name, opened in the browser.
	private func page(_ title: String, _ url: URL, id: String) -> some View {
		Button { openURL(url) } label: {
			Text(title)
				.foregroundStyle(.mcText)
				.frame(maxWidth: .infinity, alignment: .leading)
				.contentShape(Rectangle())
		}
		.accessibilityAddTraits(.isLink)
		.accessibilityIdentifier(id)
	}

	private func choice(_ label: String, account: String?) -> some View {
		let selected = model.account == account
		return Button {
			model.select(account: account)
			dismiss()
		} label: {
			Text(label)
				.fontWeight(selected ? .semibold : .regular)
				.foregroundStyle(selected ? MCColor.mcAccent : .mcText)
				.frame(maxWidth: .infinity, alignment: .leading)
				.contentShape(Rectangle())
		}
		.accessibilityIdentifier("account-choice")
		.accessibilityAddTraits(selected ? .isSelected : [])
	}
}
#endif
