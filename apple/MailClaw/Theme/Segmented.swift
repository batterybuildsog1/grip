import SwiftUI

/// A choice of a few words (Appearance: Light · Dark; the iPhone account sheet and the Mac Settings
/// window) in the theme's own colours. The system segmented control kept UIKit/AppKit greys and pure
/// black or white words (iphone-r2-14).
/// The track is --mc-raised; the choice in force sits on the sheet inside a --mc-control edge, in
/// the strong weight and full ink, the others muted: chosen by weight and ink, not hue, as the
/// web's account menu marks its choice. Every segment is as wide as the widest word. VoiceOver and
/// the UI tests read one button per word, the chosen one selected.
struct MCSegmented<Option: Hashable>: View {
	let options: [Option]
	@Binding var selection: Option
	let title: (Option) -> String
	#if os(iOS)
	@ScaledMetric(relativeTo: .body) private var height: CGFloat = 34
	#else
	private let height: CGFloat = 24
	#endif

	var body: some View {
		HStack(spacing: 2) {
			ForEach(options, id: \.self) { option in
				segment(option, on: option == selection)
			}
		}
		.padding(2)
		.background(.mcRaised, in: RoundedRectangle(cornerRadius: MCCorner.control.radius + 2, style: .continuous))
		// Like a bar's words: three in a row stop growing at the largest standard size.
		.mcBarText()
		.accessibilityElement(children: .contain)
	}

	private func segment(_ option: Option, on: Bool) -> some View {
		Button { selection = option } label: {
			ZStack {
				ForEach(options, id: \.self) { Text(title($0)).fontWeight(.semibold).hidden() }
					.accessibilityHidden(true)
				Text(title(option))
					.fontWeight(on ? .semibold : .regular)
					.foregroundStyle(on ? MCColor.mcText : MCColor.mcMuted)
			}
			.lineLimit(1)
			.padding(.horizontal, 12)
			.frame(maxWidth: .infinity, minHeight: height)
			.background {
				if on {
					MCCorner.control.rect.fill(.mcSheet)
						.overlay(MCCorner.control.rect.strokeBorder(.mcControl))
				}
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(title(option))
		.accessibilityAddTraits(on ? .isSelected : [])
	}
}
