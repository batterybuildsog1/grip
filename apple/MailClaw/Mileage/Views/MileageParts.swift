import SwiftUI

// Small pieces every Mileage screen shares. Words, spacing and borders only: the one drawn mark is
// L3's caret (Chevron, Views/Phone/InboxView.swift on iPhone; the same strokes here for the Mac).

/// L3's caret: two strokes, pointing down when open and right when closed.
struct MileageCaret: View {
	var open = false
	var body: some View {
		CaretShape()
			.stroke(style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
			.frame(width: 9, height: 5)
			.rotationEffect(.degrees(open ? 0 : -90))
			.opacity(0.6)
			.accessibilityHidden(true)
	}
}

private struct CaretShape: Shape {
	func path(in rect: CGRect) -> Path {
		var path = Path()
		path.move(to: CGPoint(x: rect.minX, y: rect.minY))
		path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
		path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
		return path
	}
}

/// An answer: words in an outline (Personal, Acme, Side Co; Reimbursable, Not), filled
/// ink when chosen. At least 44 points tall. A wide one fills its share of a `MileageButtonRow` and
/// wraps its words rather than shrink or cut them.
struct MileageChoice: PrimitiveButtonStyle {
	var chosen = false
	var wide = false

	func makeBody(configuration: Configuration) -> some View {
		configuration.keyed(Look(chosen: chosen, wide: wide))
	}

	private struct Look: ButtonStyle {
		let chosen: Bool
		let wide: Bool
		@Environment(\.isEnabled) private var isEnabled

		func makeBody(configuration: Configuration) -> some View {
			configuration.label
				.font(.body.weight(chosen ? .semibold : .regular))
				.foregroundStyle(.mcText)
				.lineLimit(wide ? nil : 2)
				.multilineTextAlignment(.center)
				.padding(.horizontal, wide ? 10 : 14)
				.padding(.vertical, 6)
				.frame(maxWidth: wide ? .infinity : nil, minHeight: 44)
				.background(configuration.isPressed ? MCColor.mcRaised : .mcSheet, in: MCCorner.control.rect)
				.overlay(MCCorner.control.rect.strokeBorder(chosen ? AnyShapeStyle(.mcText) : AnyShapeStyle(.mcControl),
					lineWidth: chosen ? 2 : 1))
				.opacity(isEnabled ? 1 : 0.45)
				.contentShape(MCCorner.control.rect)
		}
	}
}

/// The one filled button of the screen ("Yes, file it", "File"): the theme's primary.
struct MileagePrimary: PrimitiveButtonStyle {
	var wide = false

	func makeBody(configuration: Configuration) -> some View {
		configuration.keyed(Look(wide: wide))
	}

	private struct Look: ButtonStyle {
		let wide: Bool
		@Environment(\.isEnabled) private var isEnabled

		func makeBody(configuration: Configuration) -> some View {
			configuration.label
				.font(.body.weight(.semibold))
				.foregroundStyle(isEnabled ? MCColor.mcOnPrimary : .mcFaint)
				.multilineTextAlignment(.center)
				.padding(.horizontal, 18)
				.padding(.vertical, 6)
				.frame(maxWidth: wide ? .infinity : nil, minHeight: 44)
				.background(isEnabled ? MCColor.mcPrimary : .mcRaised, in: MCCorner.control.rect)
				.opacity(configuration.isPressed ? 0.82 : 1)
				.contentShape(MCCorner.control.rect)
		}
	}
}

/// Buttons side by side, each in its share of the width (`weights`, else equal; the prototype's bar is
/// 1 : 1.6 for Back and File as), while every one's words fit its share on one line; otherwise one per
/// row at full width, where long words wrap. CLEAN-SPEC: buttons stack before they truncate, at
/// every Dynamic Type size on the iPhone 17e and up (iphone-r1-04, iphone-r1-06).
struct MileageButtonRow: Layout {
	var weights: [CGFloat] = []
	var spacing: CGFloat = 10

	private func weight(_ index: Int) -> CGFloat { index < weights.count ? weights[index] : 1 }

	/// Each button's width in a row `width` wide, or nil when one's words don't fit its share.
	private func shares(_ width: CGFloat, _ subviews: Subviews) -> [CGFloat]? {
		let total = subviews.indices.reduce(CGFloat(0)) { $0 + weight($1) }
		let room = width - spacing * CGFloat(subviews.count - 1)
		let shares = subviews.indices.map { room * weight($0) / total }
		for (index, view) in subviews.enumerated() where view.sizeThatFits(.unspecified).width > shares[index] + 0.5 {
			return nil
		}
		return shares
	}

	/// The narrowest row that keeps every button's words on one line.
	private func idealWidth(_ subviews: Subviews) -> CGFloat {
		let total = subviews.indices.reduce(CGFloat(0)) { $0 + weight($1) }
		let widest = subviews.indices.map { subviews[$0].sizeThatFits(.unspecified).width * total / weight($0) }.max() ?? 0
		return widest + spacing * CGFloat(subviews.count - 1)
	}

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		guard !subviews.isEmpty else { return .zero }
		let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? idealWidth(subviews)
		if let shares = shares(width, subviews) {
			let height = subviews.indices.map { subviews[$0].sizeThatFits(ProposedViewSize(width: shares[$0], height: nil)).height }.max() ?? 0
			return CGSize(width: width, height: height)
		}
		let heights = subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)).height }
		return CGSize(width: width, height: heights.reduce(0, +) + spacing * CGFloat(subviews.count - 1))
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		if let shares = shares(bounds.width, subviews) {
			var x = bounds.minX
			for (index, view) in subviews.enumerated() {
				view.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(width: shares[index], height: bounds.height))
				x += shares[index] + spacing
			}
		} else {
			var y = bounds.minY
			for view in subviews {
				let height = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil)).height
				view.place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: bounds.width, height: height))
				y += height + spacing
			}
		}
	}
}

/// Buttons at their own width, left to right, wrapping to the next line when one doesn't fit (the
/// inline answers of the Mac and iPad sheet, which a narrow window makes narrow; ipad-r1-05).
struct MileageFlow: Layout {
	var spacing: CGFloat = 8

	private func lines(_ width: CGFloat, _ subviews: Subviews) -> [[(index: Int, size: CGSize)]] {
		var lines: [[(index: Int, size: CGSize)]] = [[]]
		var x: CGFloat = 0
		for (index, view) in subviews.enumerated() {
			var size = view.sizeThatFits(.unspecified)
			if size.width > width {
				size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
				size.width = min(size.width, width)
			}
			if !lines[lines.count - 1].isEmpty, x + spacing + size.width > width {
				lines.append([])
				x = 0
			}
			x += (lines[lines.count - 1].isEmpty ? 0 : spacing) + size.width
			lines[lines.count - 1].append((index, size))
		}
		return lines
	}

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		guard !subviews.isEmpty else { return .zero }
		let ideal = subviews.map { $0.sizeThatFits(.unspecified) }
		let oneLine = ideal.reduce(0) { $0 + $1.width } + spacing * CGFloat(subviews.count - 1)
		let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? oneLine
		let rows = lines(width, subviews)
		let height = rows.reduce(0) { $0 + ($1.map(\.size.height).max() ?? 0) } + spacing * CGFloat(rows.count - 1)
		let used = rows.map { $0.reduce(0) { $0 + $1.size.width } + spacing * CGFloat($0.count - 1) }.max() ?? 0
		return CGSize(width: min(width, max(used, 0)), height: height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		var y = bounds.minY
		for row in lines(bounds.width, subviews) {
			let height = row.map(\.size.height).max() ?? 0
			var x = bounds.minX
			for item in row {
				subviews[item.index].place(at: CGPoint(x: x, y: y + (height - item.size.height) / 2),
					proposal: ProposedViewSize(width: item.size.width, height: item.size.height))
				x += item.size.width + spacing
			}
			y += height + spacing
		}
	}
}

/// A label beside its content (the Mac's and iPad's answer rows: "File as", "Purpose", 100 pt wide)
/// while the content keeps `minContent`; in a narrower sheet the label goes above it. With the rows
/// wrapping (MileageFlow) the trip never needs more width than its sheet has (ipad-r1-05).
struct MileageLabeled: Layout {
	var labelWidth: CGFloat = 100
	var spacing: CGFloat = 14
	var minContent: CGFloat = 300

	private func beside(_ width: CGFloat) -> Bool { width - labelWidth - spacing >= minContent }

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		guard subviews.count == 2 else { return .zero }
		let label = subviews[0], content = subviews[1]
		let labelSize = label.sizeThatFits(ProposedViewSize(width: labelWidth, height: nil))
		guard let width = proposal.width, width.isFinite else {
			let ideal = content.sizeThatFits(.unspecified)
			return CGSize(width: labelWidth + spacing + ideal.width, height: max(labelSize.height, ideal.height))
		}
		if beside(width) {
			let size = content.sizeThatFits(ProposedViewSize(width: width - labelWidth - spacing, height: nil))
			return CGSize(width: width, height: max(labelSize.height, size.height))
		}
		let above = label.sizeThatFits(ProposedViewSize(width: width, height: nil))
		let size = content.sizeThatFits(ProposedViewSize(width: width, height: nil))
		return CGSize(width: width, height: above.height + 6 + size.height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		guard subviews.count == 2 else { return }
		let label = subviews[0], content = subviews[1]
		if beside(bounds.width) {
			let room = bounds.width - labelWidth - spacing
			let labelSize = label.sizeThatFits(ProposedViewSize(width: labelWidth, height: nil))
			let size = content.sizeThatFits(ProposedViewSize(width: room, height: nil))
			label.place(at: CGPoint(x: bounds.minX, y: bounds.midY - labelSize.height / 2),
				proposal: ProposedViewSize(width: labelWidth, height: labelSize.height))
			content.place(at: CGPoint(x: bounds.minX + labelWidth + spacing, y: bounds.midY - size.height / 2),
				proposal: ProposedViewSize(width: room, height: size.height))
		} else {
			let above = label.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
			label.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: above.height))
			let size = content.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
			content.place(at: CGPoint(x: bounds.minX, y: bounds.minY + above.height + 6),
				proposal: ProposedViewSize(width: bounds.width, height: size.height))
		}
	}
}

#if os(macOS)
/// The Mac's checkbox in the theme (Include the agent's guesses, Save it as a place, the drive back):
/// a box on --mc-sheet with the control's border, filled with the primary when on (as Rail's PickBox),
/// then its words. AppKit's checkbox kept a system grey (#e6e6e6) off state in every light theme
/// (mac-r2-01). No mark inside: fills and borders only. VoiceOver and the tests still read a checkbox.
struct MileageCheck: ToggleStyle {
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		let box = RoundedRectangle(cornerRadius: max(3, MCCorner.control.radius / 3), style: .continuous)
		Button { configuration.isOn.toggle() } label: {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				box.fill(configuration.isOn ? AnyShapeStyle(.mcPrimary) : AnyShapeStyle(.mcSheet))
					.overlay(box.strokeBorder(configuration.isOn ? AnyShapeStyle(.mcPrimary) : AnyShapeStyle(.mcControl)))
					.frame(width: 15, height: 15)
					.alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
				configuration.label
			}
			.opacity(isEnabled ? 1 : 0.45)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label } }
	}
}
#endif

/// A word that acts (Skip, See all, Spot-check): the accent, no box.
struct MileageWord: PrimitiveButtonStyle {
	var role: Role = .accent
	enum Role { case accent, neg, muted }

	func makeBody(configuration: Configuration) -> some View {
		configuration.keyed(Look(role: role))
	}

	private struct Look: ButtonStyle {
		let role: Role
		@Environment(\.isEnabled) private var isEnabled

		func makeBody(configuration: Configuration) -> some View {
			configuration.label
				.foregroundStyle(role == .neg ? AnyShapeStyle(.mcNeg) : role == .muted ? AnyShapeStyle(.mcMuted) : AnyShapeStyle(.mcAccent))
				.frame(minHeight: 44)
				.opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.45)
				.contentShape(Rectangle())
		}
	}
}

extension PrimitiveButtonStyleConfiguration {
	/// The button drawn by `look`, taking Return while it has keyboard focus (`MileageReturnKey`).
	func keyed<Look: ButtonStyle>(_ look: Look) -> some View {
		Button(role: role, action: trigger) { label }
			.buttonStyle(look)
			.modifier(MileageReturnKey())
	}
}

/// A Mileage control with keyboard focus (Tab, full keyboard access; an iPad keyboard) takes Return,
/// as CLEAN-SPEC asks of disclosures and buttons (Space or Enter), and while one has focus the Trip
/// menu's File gives Return up (mac-r2-05: Return on the focused Report opened the next question).
struct MileageReturnKey: ViewModifier {
	@FocusState private var focused: Bool

	func body(content: Content) -> some View {
		content
			.focused($focused)
			.keyboardShortcut(focused ? KeyboardShortcut(.return, modifiers: []) : nil)
			.focusedValue(\.mileageControlFocused, true)
	}
}

extension FocusedValues {
	/// A Mileage button or disclosure has keyboard focus: Return is its, not File's.
	@Entry var mileageControlFocused: Bool?
}

/// "Filed as Side Co · Undo", "Deleted · Undo", "Not saved: … · Retry now".
struct MileageToastView: View {
	@Environment(MileageReportModel.self) private var book
	var bottom: CGFloat = 18

	var body: some View {
		if let toast = book.toast {
			HStack(spacing: 14) {
				Text(toast.text)
					.lineLimit(2)
					.accessibilityIdentifier("mileage-toast-text")
				if let undo = toast.undo {
					Button("Undo") { Task { await book.undo(undo) } }
						.buttonStyle(.plain)
						.modifier(MileageReturnKey())
						.fontWeight(.semibold)
						.underline()
						.accessibilityIdentifier("mileage-toast-undo")
				}
				if toast.retry {
					Button("Retry now") { Task { await book.retry() } }
						.buttonStyle(.plain)
						.modifier(MileageReturnKey())
						.fontWeight(.semibold)
						.underline()
						.accessibilityIdentifier("mileage-toast-retry")
					Button("Dismiss") { book.toast = nil }
						.buttonStyle(.plain)
						.modifier(MileageReturnKey())
						.underline()
				}
			}
			.font(.callout)
			.foregroundStyle(.mcOnToast)
			.padding(.horizontal, 16)
			.padding(.vertical, 11)
			.background(.mcToast, in: MCCorner.box.rect)
			.mcFloatShadow()
			.padding(.horizontal, 16)
			.padding(.bottom, bottom)
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("mileage-toast")
		}
	}
}

enum MileageTime {
	/// "1:05 PM" in the report's time zone.
	static func clock(_ ms: Int64, zone: String) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US")
		formatter.timeZone = TimeZone(identifier: zone) ?? .current
		formatter.dateFormat = "h:mm a"
		return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
	}

	/// "Today", "Sat", "Oct 12": the trip's day as the rail and lists say it.
	static func day(_ date: String, today: String) -> String {
		if date == today { return "Today" }
		guard let day = parse(date), let now = parse(today) else { return date }
		let days = Calendar(identifier: .gregorian).dateComponents([.day], from: day, to: now).day ?? 99
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US")
		formatter.timeZone = TimeZone(identifier: "UTC")
		formatter.dateFormat = days < 7 && days > 0 ? "EEE" : "MMM d"
		return formatter.string(from: day)
	}

	/// "Saturday, Oct 24": a day heading in a company's list.
	static func heading(_ date: String, today: String) -> String {
		if date == today { return "Today" }
		guard let day = parse(date) else { return date }
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US")
		formatter.timeZone = TimeZone(identifier: "UTC")
		formatter.dateFormat = "EEEE, MMM d"
		return formatter.string(from: day)
	}

	/// "October 2026".
	static func month(_ month: String) -> String {
		guard let day = parse(month + "-01") else { return month }
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US")
		formatter.timeZone = TimeZone(identifier: "UTC")
		formatter.dateFormat = "MMMM yyyy"
		return formatter.string(from: day)
	}

	static func parse(_ date: String) -> Date? {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = TimeZone(identifier: "UTC")
		formatter.dateFormat = "yyyy-MM-dd"
		return formatter.date(from: date)
	}
}

/// A text field in the theme: the sheet, the control's border, the placeholder in the muted ink (not
/// the system's grey). `wraps` (the iPhone): it grows a line at a time and its placeholder wraps too,
/// so no Dynamic Type size cuts either; Return still ends the editing.
struct MileageTextField: View {
	let placeholder: String
	@Binding var text: String
	var wraps = false
	var minHeight: CGFloat = 44
	/// On the field itself: put outside, it also named the wrapped placeholder, which tests then found first.
	var id: String

	var body: some View {
		ZStack(alignment: .topLeading) {
			if wraps && text.isEmpty {
				Text(placeholder)
					.foregroundStyle(.mcMuted)
					.fixedSize(horizontal: false, vertical: true)
					.accessibilityHidden(true)
			}
			TextField(placeholder, text: $text.oneLine, prompt: Text(wraps ? "" : placeholder).foregroundStyle(.mcMuted),
				axis: wraps ? .vertical : .horizontal)
				.textFieldStyle(.plain)
				.foregroundStyle(.mcText)
				.mileageField()
				.accessibilityIdentifier(id)
		}
		.padding(.horizontal, 12)
		.padding(.vertical, wraps ? 10 : 0)
		.frame(minHeight: minHeight)
		.background(.mcSheet, in: MCCorner.control.rect)
		.overlay(MCCorner.control.rect.strokeBorder(.mcControl))
	}
}

extension Binding where Value == String {
	/// A one-line value in a field that may wrap as it grows (axis .vertical, for Dynamic Type): Return
	/// ends the editing instead of starting a new line.
	var oneLine: Binding<String> {
		Binding(get: { wrappedValue }, set: { value in
			guard value.contains("\n") else { wrappedValue = value; return }
			wrappedValue = value.replacingOccurrences(of: "\n", with: "")
			#if os(iOS)
			MainActor.assumeIsolated {
				_ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
			}
			#endif
		})
	}
}

extension View {
	/// A Mileage text field: while it has the keyboard, the Mac's single-key shortcuts type.
	func mileageField() -> some View { modifier(MileageFieldFocus()) }
}

private struct MileageFieldFocus: ViewModifier {
	@Environment(MileageReportModel.self) private var book
	@FocusState private var focused: Bool

	func body(content: Content) -> some View {
		content
			.focused($focused)
			.onChange(of: focused) { _, value in book.typing = value }
	}
}
