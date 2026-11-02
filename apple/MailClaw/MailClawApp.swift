import SwiftUI
#if os(macOS)
import UserNotifications
#endif
#if os(iOS)
import UIKit
#endif

@main
struct MailClawApp: App {
	@State private var model: AppModel
	@State private var theme = ThemeSettings()
	@State private var mileage: MileageModel
	/// The month's report and every owner write (V3): its own object, so mail never redraws for it.
	@State private var book: MileageReportModel
	@Environment(\.scenePhase) private var scenePhase
	#if os(macOS)
	@NSApplicationDelegateAdaptor private var appDelegate: AppDelegate
	/// Whether the window can be seen (readiness A-P1-2): what covers mail and times the relock.
	@State private var visibility = MacVisibility()
	#else
	/// Hands the APNs device token to NotificationCoordinator.
	@UIApplicationDelegateAdaptor private var appDelegate: MobileAppDelegate
	#endif

    init() {
        #if DEBUG && targetEnvironment(simulator)
        if MileageModel.testMode { UIView.setAnimationsEnabled(false) }
        #endif
        // One sign-in: Mileage runs on the mail session (AppModel hands it over and takes it back).
        let model = AppModel()
        let mileage = MileageModel()
        let book = MileageReportModel(mileage: mileage)
        model.connect(mileage)
        _model = State(initialValue: model)
        _mileage = State(initialValue: mileage)
        _book = State(initialValue: book)
    }

    var body: some Scene {
		#if os(macOS)
		// One window: the app's state (view, selection, search) is one AppModel, so a second
		// window only mirrored the first (d2-08). Per-window state comes with the redesign.
		// The window's visibility, not the scene phase, drives refresh and the lock (MacVisibility below).
		Window("Grip", id: "main") { root }
			.defaultSize(width: 1280, height: 820)
			.commands {
				WindowCommands()
				MailCommands(model: model)
			}
		// MailClaw > Settings (⌘,): the notification checkbox, the accounts, sign-in and the lock (r2 S6).
		Settings {
			SettingsView()
				.environment(model)
				.environment(mileage)
				.environment(book)
				.mcThemed(theme)
		}
		// Each composer in its own window (r2 S5): New message, Reply, Reply all, Forward.
		WindowGroup("New message", id: "compose", for: ComposeRequest.self) { $request in
			if let request {
				ComposeWindowRoot(request: request)
					.environment(model)
					.mcThemed(theme)
			}
		}
		.defaultSize(width: 560, height: 600)
		.restorationBehavior(.disabled)
		#else
		WindowGroup { root }
			// The whole app's phase: refresh on becoming active, then every 2 minutes, never in the
			// background. Mileage restores confirmed-owner capture independently.
			.onChange(of: scenePhase, initial: true) { _, phase in sceneChanged(phase) }
			// The rail window's keys and their menu: an iPad with a hardware keyboard (Mac S6 keys).
			.commands { MailCommands(model: model) }
		#endif
	}

	/// Active: uncover (and relock if the timeout passed), refresh. Inactive: cover; in the background
	/// the relock timer starts.
	private func sceneChanged(_ phase: ScenePhase) {
		if phase == .active {
			model.retrySession()
			model.lock.foreground()
		} else {
			model.lock.inactive(background: phase == .background)
		}
		model.setActive(phase == .active)
		if phase == .active { mileage.active() }
	}

	private var root: some View {
		Group {
			if model.lock.isLocked {
				LockedMailView()
			} else {
				// A new session discards the previous account's reader state.
				RootView().id(model.sessionGeneration)
			}
		}
		.opacity(model.lock.privacyCovered ? 0 : 1)
		.accessibilityHidden(model.lock.privacyCovered)
		.allowsHitTesting(!model.lock.privacyCovered)
		.overlay { if model.lock.privacyCovered { PrivacyCurtain() } }
		// Refreshes only while mail is readable: unlocked and not covered.
		.onChange(of: model.lock.isLocked) { _, locked in model.setActive(!locked) }
		.environment(model)
		.mcThemed(theme)
		.environment(mileage)
		.environment(book)
		.onAppear { WebRules.shared.warmUp() }
		#if os(macOS)
		.modifier(SettingsAtLaunch())
		// What can be seen, not which app has focus, covers mail and times the relock: mail beside
		// another app stays readable and refreshing (A-P1-2).
		.background(WindowReader { window in visibility.attach(window) { sceneChanged($0 ? .active : .background) } })
		// Coming back from another app refreshes at once (d2-09); it never uncovers.
		.onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
			model.setActive(true)
		}
		#else
		.task { await Self.pinWindowSize() }
		#endif
	}

	#if os(iOS)
	/// Test seam (Debug only; LaunchOptions.windowSize): real window geometry for Split View and Stage
	/// Manager sizes on the simulator. Size restrictions with minimum = maximum, which iPadOS honours
	/// for windowed apps (Settings > Multitasking: Windowed Apps or Stage Manager; ipad-e2e.sh).
	@MainActor private static func pinWindowSize() async {
		guard LaunchOptions.windowSizeWatched else { return }
		var pinned: CGSize?? = .none
		while !Task.isCancelled {
			let size = LaunchOptions.windowSize
			if pinned != .some(size), let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
			   let limits = scene.sizeRestrictions {
				limits.minimumSize = .zero
				limits.maximumSize = CGSize(width: 10_000, height: 10_000)
				if let size {
					limits.minimumSize = size
					limits.maximumSize = size
				}
				pinned = .some(size)
			}
			try? await Task.sleep(for: .milliseconds(400))
		}
	}
	#endif
}

#if os(macOS)
/// Like Mail: closing the window leaves the app running; the Dock icon and the Window menu bring
/// the one window back (d2-19). A `Window`-only app otherwise quits with its window. While it runs,
/// the app keeps checking Personal for notifications (AppModel+Notifications.swift).
final class AppDelegate: NSObject, NSApplicationDelegate {
	/// SwiftUI's split-view autosave: the r2 build (and the installed app) saved three columns
	/// under this key, which the L3 window's two would misread; the column keeps L3's own width.
	func applicationWillFinishLaunching(_ notification: Notification) {
		UserDefaults.standard.removeObject(forKey: "NSSplitView Subview Frames main, SidebarNavigationSplitView")
		// Before launch completes, so a banner click that launched the app is not missed.
		UNUserNotificationCenter.current().delegate = NotificationRouter.shared
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

/// A `Window` scene drops out of the Window menu once closed (d2-19): Window > MailClaw (⌘0, Mail's
/// Message Viewer key) shows the one window. ⌘N is New Message (MailCommands).
private struct WindowCommands: Commands {
	@Environment(\.openWindow) private var openWindow

	var body: some Commands {
		CommandGroup(replacing: .singleWindowList) {
			Button("Grip") { openWindow(id: "main") }
				.keyboardShortcut("0")
		}
	}
}
#endif
