import MailClawKit
import SwiftUI

enum Pane: Hashable { case list, thread }

/// Mac and a regular-width iPad: the L3 Rail window (Mac/MacRootView.swift, S6). iPhone, a compact
/// iPad window (a narrow tile, a small Stage Manager window) and an iPad at accessibility text sizes:
/// one stack, the inbox then the thread (Phone/PhoneRootView.swift; r2 S1 and L3's "Next in"). Never
/// three panes. Crossing between them keeps the view, the open thread and the composer (AppModel).
struct RootView: View {
	@Environment(AppModel.self) private var model
	#if os(iOS)
	@Environment(\.horizontalSizeClass) private var widthClass
	@Environment(\.dynamicTypeSize) private var typeSize

	/// At accessibility sizes the one-line list and the 240pt rail can't hold the words; the stack's
	/// rows, reader and bars are proven at AX5 (RailPhoneTests).
	private var usesRail: Bool {
		UIDevice.current.userInterfaceIdiom == .pad && width == .regular && !typeSize.isAccessibilitySize
	}

	/// The window's width class, or the one a Debug launch forces (`-MCForceSizeClass compact`):
	/// XCUITest can't drive Split View or Stage Manager sizes.
	private var width: UserInterfaceSizeClass? {
		switch LaunchOptions.forcedSizeClass {
		case "compact": .compact
		case "regular": .regular
		default: widthClass
		}
	}
	#endif

	var body: some View {
		// Signed out: the sign-in screen alone (one sign-in for mail and Mileage, so the shell has
		// nothing to show). The offline pilot has no account and keeps the shell for Mileage.
		Group {
			if !model.signedIn && !OfflinePilot.enabled {
				SignInView()
			} else {
				#if os(macOS)
				MacRootView(sync: model.sync)
				#else
				if usesRail { MacRootView(sync: model.sync) } else { PhoneRootView() }
				#endif
			}
		}
		#if os(iOS)
		.environment(\.usesRail, usesRail)
		.environment(\.horizontalSizeClass, width)
		.background { WindowControlsInset().ignoresSafeArea() }
		#endif
		// Triage (S7): the Delete Forever confirm, on every platform.
		.triageConfirm()
		.overlay(alignment: .bottomTrailing) {
			if LaunchOptions.perfProbe { PerfProbeView() }
		}
		// Compose (r2 S5): the iPhone's sheet; "Sending… Undo", "Sent" and "Not sent" over the bottom.
		#if os(iOS)
		.sheet(item: Bindable(model).composer) { composer in
			ComposeView(model: composer) { model.composer = nil }
				.interactiveDismissDisabled(composer.hasContent)
		}
		#endif
		.overlay(alignment: .bottom) {
			VStack(spacing: 8) {
				if let sending = model.sending { SendingNotice(model: sending) }
				if let notice = model.notice { NoticeView(text: notice) }
			}
			.padding(.bottom, 72)
		}
	}
}

extension EnvironmentValues {
	/// The L3 Rail window (Mac, regular-width iPad) rather than the iPhone stack.
	@Entry var usesRail: Bool = {
		#if os(macOS)
		true
		#else
		false
		#endif
	}()
}

extension OpenWindowAction {
	/// A composer: its own window on the Mac (r2 S5), the sheet on iPhone and iPad.
	func compose(_ request: ComposeRequest, in model: AppModel) {
		#if os(macOS)
		callAsFunction(value: request)
		#else
		model.startCompose(request)
		#endif
	}
}

#if os(iOS)
/// An iPad window (Windowed Apps, Stage Manager) draws its close / minimise / tile controls over its
/// top leading corner, and every bar here is the app's own, so nothing would step aside for them: the
/// whole window starts below them (the window's corner-adapted safe area; zero in full screen). Set
/// on the root view controller, which the split view's columns and the stack both honour.
private struct WindowControlsInset: UIViewRepresentable {
	func makeUIView(context: Context) -> Probe { Probe() }
	func updateUIView(_ probe: Probe, context: Context) {}

	final class Probe: UIView {
		override func layoutSubviews() {
			super.layoutSubviews()
			// Measured on the window, which the root's own inset doesn't move.
			guard let window, let root = window.rootViewController else { return }
			let controls = window.layoutGuide(for: .safeArea(cornerAdaptation: .vertical)).layoutFrame.minY
			let inset = max(0, controls - window.safeAreaLayoutGuide.layoutFrame.minY)
			if root.additionalSafeAreaInsets.top != inset {
				DispatchQueue.main.async { root.additionalSafeAreaInsets.top = inset }
			}
		}
	}
}
#endif

/// Invisible: carries the timing samples to the UI test (`-MCPerfProbe YES` only).
struct PerfProbeView: View {
	var body: some View {
		let json = PerfProbe.shared.json
		Text(json)
			.font(.system(size: 1))
			.foregroundStyle(.clear)
			.frame(width: 2, height: 2)
			.allowsHitTesting(false)
			.accessibilityLabel(json)
			.accessibilityIdentifier("perf-probe")
	}
}
