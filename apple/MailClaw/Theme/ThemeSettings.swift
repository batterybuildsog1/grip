import Foundation
import Observation

/// The theme's one setting (one theme, Grip): appearance Light | Dark (default Light),
/// per device, kept across relaunch and sign-out. A change re-renders in place: nothing is reloaded,
/// so an open thread, draft or scroll stays.
///
/// Stored in UserDefaults under `MCAppearance`. A launch argument (`-MCAppearance dark`) overrides
/// the stored value for that run without changing it. A Debug build stores under
/// `Debug.MCAppearance`: on a Mac it shares the installed app's defaults domain, and the installed app
/// reads `MCAppearance`. The old Theme setting's `MCTheme` / `Debug.MCTheme` is neither read, written
/// nor removed: it belongs to the build that wrote it, so a rollback finds its own value
/// (docs/design/failure-modes-grip-only.md GO02, GO04).
@MainActor @Observable
final class ThemeSettings {
	var appearance: MCAppearance {
		didSet { store.set(appearance.rawValue, forKey: Self.storedKey) }
	}

	@ObservationIgnored private let store: UserDefaults

	init(store: UserDefaults = .standard) {
		self.store = store
		let arguments = store.volatileDomain(forName: UserDefaults.argumentDomain)
		let value = arguments["MCAppearance"] as? String ?? store.string(forKey: Self.storedKey)
		appearance = value.flatMap(MCAppearance.init(rawValue:)) ?? .light
	}

	private static var storedKey: String {
		#if DEBUG
		"Debug.MCAppearance"
		#else
		"MCAppearance"
		#endif
	}
}
