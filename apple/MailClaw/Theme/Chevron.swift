import SwiftUI

/// The menu chevron: the one mark kept (iOS draws one for menus), as two strokes, not a symbol.
struct Chevron: View {
	var body: some View {
		ChevronShape()
			.stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
			.opacity(0.6)
			.accessibilityHidden(true)
	}
}

private struct ChevronShape: Shape {
	func path(in rect: CGRect) -> Path {
		var path = Path()
		path.move(to: CGPoint(x: rect.minX, y: rect.minY))
		path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
		path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
		return path
	}
}

/// A menu's face: its current value in words, the chevron, on a --mc-raised control (the account
/// menu, the composer's From).
struct MenuLabel: View {
	let text: String
	var ink: MCColor = .mcText

	var body: some View {
		HStack(spacing: 8) {
			Text(text).lineLimit(1).foregroundStyle(ink)
			Chevron().frame(width: 9, height: 5).foregroundStyle(.mcMuted)
		}
		.padding(.horizontal, 10)
		.padding(.vertical, 5)
		.background(.mcRaised, in: MCCorner.control.rect)
		.contentShape(MCCorner.control.rect)
	}
}
