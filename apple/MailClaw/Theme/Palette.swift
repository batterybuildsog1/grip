import SwiftUI

// The theme: Grip, Light and Dark (2026-10-31: one theme; it replaces the selectable themes of
// 2026-10-26). The app icon as a surface: bone and ink. Every value below is
// `ui/src/styles/themes.css`, one to one (tests/e2e/theme-tokens.e2e.mjs checks it);
// docs/design/failure-modes-grip-only.md says what went and why. Change a value there first, then here.

/// Light (the default) or Dark: the app's own, not the system's (lead's call 1: no "match system").
enum MCAppearance: String, CaseIterable, Identifiable, Sendable {
	case light, dark

	var id: Self { self }
	var title: String { self == .dark ? "Dark" : "Light" }
	var colorScheme: ColorScheme { self == .dark ? .dark : .light }
}

/// `control` buttons, fields, chips, menus; `box` message boxes, Needs you, file cards; `sheet`
/// dialogs, the composer, phone sheets. Nearly square, as the envelope's.
enum MCCorner: Sendable {
	case control, box, sheet

	/// Corner radius in points (--mc-radius-control / -box / -sheet).
	var radius: CGFloat {
		switch self {
		case .control: 3
		case .box: 4
		case .sheet: 6
		}
	}

	/// A continuous rounded rectangle at this radius.
	var rect: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }
}

extension Font.Weight {
	/// Large titles (view name, thread subject): 700 (--mc-title-weight). Unread and buttons are
	/// `.semibold` (--mc-strong-weight).
	static let mcTitle: Font.Weight = .bold
}

/// The colour roles, named as the CSS custom properties (--mc-frame … --mc-focus).
enum MCRole: CaseIterable, Sendable {
	case frame, sheet, raised, border, rule, control, text, muted, faint
	case accent, accentSoft, onAccent, primary, onPrimary
	case neg, negSoft, onNeg, warn, warnSoft, mark, toast, onToast, scrim, focus
}

/// The theme in one mode.
struct MCPalette: Sendable {
	struct Shadow: Sendable {
		let color: Color
		let radius: CGFloat
		let y: CGFloat
	}

	private let colors: [MCRole: Color]
	private let hex: [MCRole: UInt32]
	/// --mc-shadow, for what floats (menus, dialogs, the composer, toasts); nothing at rest.
	let shadow: [Shadow]

	subscript(role: MCRole) -> Color { colors[role] ?? .clear }

	/// An opaque role as CSS ("#1b6c80"), for documents in a web view.
	func css(_ role: MCRole) -> String { String(format: "#%06x", hex[role] ?? 0) }

	fileprivate init(
		frame: UInt32, sheet: UInt32, raised: UInt32, border: UInt32, rule: UInt32, control: UInt32,
		text: UInt32, muted: UInt32, faint: UInt32, accent: UInt32, accentSoft: UInt32, onAccent: UInt32,
		primary: UInt32, onPrimary: UInt32, neg: UInt32, negSoft: UInt32, warn: UInt32, warnSoft: UInt32,
		mark: UInt32, toast: UInt32, onToast: UInt32, focus: UInt32,
		scrim: (UInt32, opacity: Double),
		shadow: [(y: CGFloat, blur: CGFloat, color: UInt32, opacity: Double)]
	) {
		hex = [.text: text, .accent: accent, .rule: rule, .sheet: sheet]
		colors = [
			.frame: Color(mcHex: frame), .sheet: Color(mcHex: sheet), .raised: Color(mcHex: raised),
			.border: Color(mcHex: border), .rule: Color(mcHex: rule), .control: Color(mcHex: control),
			.text: Color(mcHex: text), .muted: Color(mcHex: muted), .faint: Color(mcHex: faint),
			.accent: Color(mcHex: accent), .accentSoft: Color(mcHex: accentSoft),
			.onAccent: Color(mcHex: onAccent), .primary: Color(mcHex: primary),
			.onPrimary: Color(mcHex: onPrimary), .neg: Color(mcHex: neg), .negSoft: Color(mcHex: negSoft),
			// --mc-on-neg is --mc-on-accent (themes.css).
			.onNeg: Color(mcHex: onAccent),
			.warn: Color(mcHex: warn), .warnSoft: Color(mcHex: warnSoft), .mark: Color(mcHex: mark),
			.toast: Color(mcHex: toast), .onToast: Color(mcHex: onToast),
			.scrim: Color(mcHex: scrim.0, opacity: scrim.opacity), .focus: Color(mcHex: focus),
		]
		// CSS blur is about twice SwiftUI's shadow radius.
		self.shadow = shadow.map { Shadow(color: Color(mcHex: $0.color, opacity: $0.opacity), radius: $0.blur / 2, y: $0.y) }
	}
}

extension Color {
	/// An sRGB colour from a CSS hex triplet (0xRRGGBB).
	init(mcHex hex: UInt32, opacity: Double = 1) {
		self.init(
			.sRGB,
			red: Double((hex >> 16) & 0xff) / 255,
			green: Double((hex >> 8) & 0xff) / 255,
			blue: Double(hex & 0xff) / 255,
			opacity: opacity
		)
	}
}

// From themes.css; keep in the CSS order.
extension MCPalette {
	static let light = MCPalette(
		frame: 0xdcd4c3,
		sheet: 0xf2ece0,
		raised: 0xe8e1d3,
		border: 0xdbd3c3,
		rule: 0xe5dfd2,
		control: 0xbcb4a3,
		text: 0x141614,
		muted: 0x4a463d,
		faint: 0x59544b,
		accent: 0x141614,
		accentSoft: 0xd6cebd,
		onAccent: 0xf2ece0,
		primary: 0x141614,
		onPrimary: 0xf2ece0,
		neg: 0xa8231a,
		negSoft: 0xf5dcd5,
		warn: 0x7a4b00,
		warnSoft: 0xf2e1c0,
		mark: 0xf0d97c,
		toast: 0x141614,
		onToast: 0xf2ece0,
		focus: 0x141614,
		scrim: (0x141614, opacity: 0.36),
		shadow: [(y: 12, blur: 32, color: 0x141614, opacity: 0.16), (y: 2, blur: 6, color: 0x141614, opacity: 0.08)]
	)
	static let dark = MCPalette(
		frame: 0x080908,
		sheet: 0x141614,
		raised: 0x1e201d,
		border: 0x2b2d29,
		rule: 0x222420,
		control: 0x4a4b45,
		text: 0xf2ece0,
		muted: 0xc3bdb1,
		faint: 0xa59f94,
		accent: 0xf2ece0,
		accentSoft: 0x34322b,
		onAccent: 0x141614,
		primary: 0xf2ece0,
		onPrimary: 0x141614,
		neg: 0xf07d72,
		negSoft: 0x3b1d1a,
		warn: 0xe8b36a,
		warnSoft: 0x33270f,
		mark: 0x5b4c12,
		toast: 0x2b2d29,
		onToast: 0xf2ece0,
		focus: 0xf2ece0,
		scrim: (0x000000, opacity: 0.6),
		shadow: [(y: 12, blur: 32, color: 0x000000, opacity: 0.55), (y: 2, blur: 6, color: 0x000000, opacity: 0.4)]
	)
}
