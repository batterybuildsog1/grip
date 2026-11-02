import SwiftUI

// The theme API every view uses (one theme, Grip, Light and Dark: Palette.swift):
//   .foregroundStyle(.mcMuted)  .background(.mcSheet)  .tint(.mcPrimary)
//   MCCorner.box.radius, MCCorner.box.rect, .weight(.mcTitle)
//   @Environment(\.mcPalette) var palette → palette[.accent] where a Color is needed
//   .mcReadingFont(.body) on people's mail and the compose body; .mcFloatShadow() on what floats.
// Each colour resolves from the environment where it is drawn, so a change of appearance re-renders
// it without a reload.

/// A colour token: resolves to the theme in the current light/dark.
struct MCColor: ShapeStyle {
	let role: MCRole

	func resolve(in environment: EnvironmentValues) -> Color {
		environment.mcPalette[role]
	}
}

extension ShapeStyle where Self == MCColor {
	/// Window ground: Mac sidebar and toolbar, the area around the sheet.
	static var mcFrame: MCColor { MCColor(role: .frame) }
	/// The main surface: list, reader, phone background.
	static var mcSheet: MCColor { MCColor(role: .sheet) }
	/// One step off the sheet: hover, collapsed message, input fill.
	static var mcRaised: MCColor { MCColor(role: .raised) }
	/// Message boxes, cards, inputs.
	static var mcBorder: MCColor { MCColor(role: .border) }
	/// Row separators.
	static var mcRule: MCColor { MCColor(role: .rule) }
	/// Button and field borders.
	static var mcControl: MCColor { MCColor(role: .control) }
	/// Ink: running text, senders, subjects.
	static var mcText: MCColor { MCColor(role: .text) }
	/// Secondary text: snippets, meta (replaces `.secondary`).
	static var mcMuted: MCColor { MCColor(role: .muted) }
	/// Tertiary text: counts, hints, still 4.5:1 (replaces `.tertiary`).
	static var mcFaint: MCColor { MCColor(role: .faint) }
	/// Links, the unread mark, the keyboard cursor, the selected edge.
	static var mcAccent: MCColor { MCColor(role: .accent) }
	/// Fill of the open/selected row, and of the phone's "Next in Personal" well.
	static var mcAccentSoft: MCColor { MCColor(role: .accentSoft) }
	static var mcOnAccent: MCColor { MCColor(role: .onAccent) }
	/// The one filled button per screen (Reply, Send, New message).
	static var mcPrimary: MCColor { MCColor(role: .primary) }
	static var mcOnPrimary: MCColor { MCColor(role: .onPrimary) }
	/// Destructive words (Trash, Discard), "urgent" (replaces `.red`).
	static var mcNeg: MCColor { MCColor(role: .neg) }
	static var mcNegSoft: MCColor { MCColor(role: .negSoft) }
	static var mcOnNeg: MCColor { MCColor(role: .onNeg) }
	/// "Couldn't load" words; `mcWarnSoft` its box.
	static var mcWarn: MCColor { MCColor(role: .warn) }
	static var mcWarnSoft: MCColor { MCColor(role: .warnSoft) }
	/// Search-hit highlight behind text.
	static var mcMark: MCColor { MCColor(role: .mark) }
	/// Toast/banner ground; `mcOnToast` its text (an Undo there is mcOnToast, never mcAccent).
	static var mcToast: MCColor { MCColor(role: .toast) }
	static var mcOnToast: MCColor { MCColor(role: .onToast) }
	/// Backdrop under sheets and dialogs.
	static var mcScrim: MCColor { MCColor(role: .scrim) }
	/// Keyboard focus ring.
	static var mcFocus: MCColor { MCColor(role: .focus) }
}

extension EnvironmentValues {
	/// The theme in the light/dark this view is drawn in.
	var mcPalette: MCPalette { colorScheme == .dark ? .dark : .light }
}

extension Font {
	/// The reading face at a text style (Dynamic Type kept): New York (--mc-font-native-read).
	static func mcReading(_ style: Font.TextStyle = .body) -> Font {
		.system(style, design: .serif)
	}
}

extension View {
	/// The root of every scene (main window, Settings, composer windows): the app's own light/dark
	/// and the accent tint. Pass the one `ThemeSettings` the app holds.
	func mcThemed(_ settings: ThemeSettings) -> some View {
		modifier(Themed(settings: settings))
	}

	/// `.tint(.mcPrimary)`: SwiftUI's own `tint(_: S?)` can't infer a token through the optional.
	func tint(_ token: MCColor) -> some View {
		tint(Optional(token))
	}

	/// People's mail and the compose body in the reading face.
	func mcReadingFont(_ style: Font.TextStyle = .body) -> some View {
		modifier(ReadingFont(style: style))
	}

	/// The theme's shadow (--mc-shadow), only for what floats: menus, dialogs, toasts, the composer.
	func mcFloatShadow() -> some View {
		modifier(FloatShadow())
	}
}

private struct Themed: ViewModifier {
	let settings: ThemeSettings

	func body(content: Content) -> some View {
		content
			.tint(.mcAccent)
			.environment(settings)
			.preferredColorScheme(settings.appearance.colorScheme)
	}
}

private struct ReadingFont: ViewModifier {
	@ScaledMetric(relativeTo: .body) private var serifLeading: CGFloat = 5
	let style: Font.TextStyle

	/// New York reads best with more leading (about 1.55 at body size, T2 NOTES).
	func body(content: Content) -> some View {
		content
			.font(.mcReading(style))
			.lineSpacing(serifLeading)
	}
}

private struct FloatShadow: ViewModifier {
	@Environment(\.mcPalette) private var palette

	func body(content: Content) -> some View {
		let near = palette.shadow.last
		let far = palette.shadow.first
		content
			.shadow(color: near?.color ?? .clear, radius: near?.radius ?? 0, y: near?.y ?? 0)
			.shadow(color: far?.color ?? .clear, radius: far?.radius ?? 0, y: far?.y ?? 0)
	}
}

extension View {
	/// A bar pinned to the bottom of a phone screen (search and New; Archive · Reply · More; the
	/// composer's Attach · Discard): the sheet, under a hairline in --mc-control. Opaque, no glass.
	func mcBottomBar() -> some View {
		mcBarText()
			.background(.mcSheet)
			.overlay(alignment: .top) { Rectangle().fill(.mcControl).frame(height: 0.5) }
	}

	/// Words in a bar pinned to a phone screen's edge stop growing at the largest standard text size,
	/// as the system's bars do (HIG; L3's accessibility frames draw the bars at regular size): at AX5
	/// "Reply" broke one letter per line and the bar took 383 of 844pt (iphone-r1-07). The reader
	/// is never capped; a long press on a bar's word shows it large (`accessibilityShowsLargeContentViewer`).
	func mcBarText() -> some View {
		dynamicTypeSize(...DynamicTypeSize.xxxLarge)
	}
}

/// The one filled button per screen (Reply, Send, New message): --mc-primary with its own label
/// colour, a capsule on iPhone bars, the control radius elsewhere. `wide`: the column's full width
/// and a 44 pt target, its words wrapping at accessibility sizes (Sign in); disabled it stays the
/// filled button, faded, so it never reads as one more field.
struct MCPrimaryButtonStyle: ButtonStyle {
	var capsule = false
	var wide = false
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		// Disabled (Send with no recipient) stays legible: faint words on the raised fill.
		let filled = isEnabled || wide
		configuration.label
			.fontWeight(.semibold)
			.foregroundStyle(filled ? MCColor.mcOnPrimary : .mcFaint)
			.lineLimit(wide ? nil : 1)
			.multilineTextAlignment(.center)
			.fixedSize(horizontal: !wide, vertical: true)
			.frame(maxWidth: wide ? .infinity : nil, minHeight: wide ? 32 : nil)
			.padding(.horizontal, capsule ? 18 : 14)
			.padding(.vertical, capsule ? 9 : 6)
			.background(
				filled ? MCColor.mcPrimary : .mcRaised,
				in: RoundedRectangle(cornerRadius: capsule ? 999 : MCCorner.control.radius, style: .continuous))
			.opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : (wide ? 0.4 : 1))
			.contentShape(Rectangle())
	}
}

/// A secondary button: words on the sheet in a --mc-control outline (Reply · Reply all · Forward,
/// Done, Quoted text).
struct MCOutlinedButtonStyle: ButtonStyle {
	var capsule = false
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		let shape = RoundedRectangle(cornerRadius: capsule ? 999 : MCCorner.control.radius, style: .continuous)
		configuration.label
			.foregroundStyle(.mcText)
			.padding(.horizontal, 12)
			.padding(.vertical, 6)
			.background(configuration.isPressed ? MCColor.mcRaised : .mcSheet, in: shape)
			.overlay(shape.strokeBorder(.mcControl))
			.opacity(isEnabled ? 1 : 0.45)
			.contentShape(shape)
	}
}

extension View {
	/// Rows of a list on the sheet: the sheet behind each row, separators in --mc-rule. Pair with
	/// `.scrollContentBackground(.hidden).background(.mcSheet)` on the list.
	func mcRows(_ palette: MCPalette) -> some View {
		listRowBackground(Rectangle().fill(.mcSheet))
			.listRowSeparatorTint(palette[.rule])
	}
}

/// A button that is words in the accent (Try again, Did you mean, Show trimmed text): keeps the
/// accent even inside a container whose text is ink or a status colour.
struct MCLinkButtonStyle: ButtonStyle {
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.foregroundStyle(.mcAccent)
			.opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.45)
			.contentShape(Rectangle())
	}
}
