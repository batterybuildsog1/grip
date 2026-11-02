#if os(macOS)
	import AppKit
	import SwiftUI

	/// Whether MailClaw's window can be seen (A-P1-2). Another app taking focus beside the window
	/// changes nothing: mail stays readable, refreshing and unlocked. Each reason it can't be seen
	/// (the window closed, minimized, hidden, on another Space or fully covered; the screen locked
	/// or asleep; the user session switched away) covers mail and starts relock timing, and clears
	/// only on its own opposite event, so no activation or window event uncovers a locked screen.
	@MainActor final class MacVisibility {
		private enum Reason { case window, screenLocked, screenAsleep, session }
		private var reasons: Set<Reason> = []
		private var reported: Bool?
		private var changed: ((Bool) -> Void)?
		private weak var window: NSWindow?
		private var windowObservers: [NSObjectProtocol] = []

		init() {
			let workspace = NSWorkspace.shared.notificationCenter
			observe(workspace, NSWorkspace.screensDidSleepNotification, .screenAsleep, true)
			observe(workspace, NSWorkspace.screensDidWakeNotification, .screenAsleep, false)
			observe(workspace, NSWorkspace.sessionDidResignActiveNotification, .session, true)
			observe(workspace, NSWorkspace.sessionDidBecomeActiveNotification, .session, false)
			// A fixture run hears its own pair too; its test never posts the system's to every app.
			for prefix in ["com.apple."] + [LaunchOptions.fixtureScreenLockPrefix].compactMap({ $0 }) {
				let center = DistributedNotificationCenter.default()
				observe(center, .init(prefix + "screenIsLocked"), .screenLocked, true)
				observe(center, .init(prefix + "screenIsUnlocked"), .screenLocked, false)
			}
		}

		/// The window the root view is in (nil once it leaves); `changed` hears each flip.
		func attach(_ window: NSWindow?, changed: @escaping (Bool) -> Void) {
			self.changed = changed
			for observer in windowObservers { NotificationCenter.default.removeObserver(observer) }
			windowObservers = []
			self.window = window
			if let window {
				for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification] {
					windowObservers.append(
						NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) {
							[weak self] note in
							let closing = note.name == NSWindow.willCloseNotification
							MainActor.assumeIsolated { self?.windowChanged(closing: closing) }
						})
				}
			}
			windowChanged(closing: false)
		}

		private func windowChanged(closing: Bool) {
			let seen = window.map { $0.isVisible && $0.occlusionState.contains(.visible) } ?? false
			set(.window, closing || !seen)
		}

		private func observe(
			_ center: NotificationCenter, _ name: Notification.Name, _ reason: Reason, _ on: Bool
		) {
			_ = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
				MainActor.assumeIsolated { self?.set(reason, on) }
			}
		}

		private func set(_ reason: Reason, _ on: Bool) {
			if on { reasons.insert(reason) } else { reasons.remove(reason) }
			let visible = reasons.isEmpty
			guard let changed, visible != reported else { return }
			reported = visible
			changed(visible)
		}
	}

	/// Hands `MacVisibility` the window the root view is in.
	struct WindowReader: NSViewRepresentable {
		let attach: (NSWindow?) -> Void
		func makeNSView(context: Context) -> Reader { Reader(attach) }
		func updateNSView(_ view: Reader, context: Context) {}

		final class Reader: NSView {
			let attach: (NSWindow?) -> Void
			init(_ attach: @escaping (NSWindow?) -> Void) {
				self.attach = attach
				super.init(frame: .zero)
			}
			required init?(coder: NSCoder) { nil }
			override func viewDidMoveToWindow() { attach(window) }
		}
	}
#endif
