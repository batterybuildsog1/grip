#if os(macOS)
import MailClawKit
import SwiftUI

/// MailClaw > Settings (⌘,), r2 S6: the notification checkbox, Appearance (applied at once; one theme,
/// Grip), the accounts, sign-in and the lock (SessionSettings), AI sorting (the
/// owner's), the privacy and support pages, and Delete account (SPEC §2, §3). Drawn like the iPhone's
/// account sheet: the frame behind, each section a box on the sheet, muted titles. (A grouped Form
/// kept AppKit's grey section boxes, with no way to colour them.)
struct SettingsView: View {
	/// Mileage's Report opens this window on its tab.
	@AppStorage("MCSettingsTab") private var tab = "general"

	var body: some View {
		// Two tabs, words only: MailClaw's own settings, and Mileage's (rates, companies, places).
		TabView(selection: $tab) {
			MailSettings()
				.tabItem { Text("General") }
				.tag("general")
			MileageSettingsView()
				.frame(width: 520, height: 560)
				.tabItem { Text("Mileage") }
				.tag("mileage")
				.accessibilityIdentifier("settings-mileage")
		}
	}
}

private struct MailSettings: View {
	@Environment(AppModel.self) private var model
	@Environment(ThemeSettings.self) private var theme
	@State private var deleting = false

	var body: some View {
		@Bindable var model = model
		@Bindable var theme = theme
		ScrollView {
			VStack(alignment: .leading, spacing: 18) {
				section("Notifications", id: "settings-notifications") {
					Toggle("New mail in Personal and Needs you", isOn: $model.notifyEnabled)
						.toggleStyle(.checkbox)
						.accessibilityIdentifier("settings-notify")
					rule
					Text("Newsletters, receipts and notices never notify. Banners, sounds and Focus follow System Settings.")
						.font(.callout)
						.foregroundStyle(.mcMuted)
						.fixedSize(horizontal: false, vertical: true)
					if model.notifyEnabled, model.notificationsDenied {
						rule
						Text("Banners are off for Grip in System Settings, Notifications.")
							.font(.callout)
							.foregroundStyle(.mcWarn)
							.fixedSize(horizontal: false, vertical: true)
					}
				}
				// The theme's own segmented words, not AppKit's grey track (iphone-r2-14, same leak).
				section(nil, id: "settings-look") {
					LabeledContent("Appearance") {
						MCSegmented(options: MCAppearance.allCases, selection: $theme.appearance) { $0.title }
							.fixedSize()
							.accessibilityIdentifier("settings-appearance")
					}
				}
				section("Accounts", id: "settings-accounts") {
					if model.accounts.isEmpty {
						Text("The accounts appear once Grip has loaded.")
							.foregroundStyle(.mcMuted)
					}
					ForEach(Array(model.accounts.enumerated()), id: \.element) { index, address in
						if index > 0 { rule }
						Text(address).textSelection(.enabled)
					}
				}
				if model.sync != nil {
					section("Sign-in", id: "settings-session") { SessionSettings() }
				}
				if model.sync != nil, model.consent.settingsShown {
					section("AI sorting", id: "settings-ai") {
						ConsentToggle()
						rule
						ConsentNotes().font(.callout)
					}
				}
				section(nil, id: "settings-pages") {
					PublicLink(title: "Privacy policy", url: PublicLinks.privacy, id: "settings-privacy")
					PublicLink(title: "Support", url: PublicLinks.support, id: "settings-support")
				}
				if model.accountIdentity != nil {
					section(nil, id: "settings-account") {
						Button("Delete account…") { deleting = true }
							.buttonStyle(.plain)
							.foregroundStyle(.mcNeg)
							.accessibilityIdentifier("settings-delete-account")
					}
				}
			}
			.padding(20)
		}
		.sheet(isPresented: $deleting) { DeleteAccountView(titled: true).frame(width: 460) }
		.task { if LaunchOptions.showDeleteAccount, model.accountIdentity != nil { deleting = true } }
		// Locked, the window shows nothing of the account. (Not "covered": that is the main window
		// out of sight, and Settings must work with it closed.)
		.opacity(model.lock.isLocked ? 0 : 1)
		.overlay { if model.lock.isLocked { PrivacyCurtain() } }
		.scrollContentBackground(.hidden)
		.background(.mcFrame)
		.foregroundStyle(.mcText)
		.frame(width: 480, height: 540)
	}

	/// A muted title over a box on the sheet.
	private func section<Content: View>(
		_ title: String?, id: String, @ViewBuilder content: () -> Content
	) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			if let title {
				Text(title)
					.font(.headline)
					.foregroundStyle(.mcMuted)
					.padding(.leading, 4)
			}
			VStack(alignment: .leading, spacing: 10) { content() }
				.padding(.horizontal, 14)
				.padding(.vertical, 12)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(.mcSheet, in: MCCorner.box.rect)
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier(id)
		}
	}

	private var rule: some View { Rectangle().fill(.mcRule).frame(height: 1) }
}

/// Opens Settings at launch under `-MCShowSettings YES` (Debug; LaunchOptions.showSettings), so the
/// window can be captured without a key press (nothing typed into a Mac someone is using).
struct SettingsAtLaunch: ViewModifier {
	@Environment(\.openSettings) private var openSettings

	func body(content: Content) -> some View {
		content.task { if LaunchOptions.showSettings { openSettings() } }
	}
}
#endif
