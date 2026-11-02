import MapKit
import SwiftUI

/// The street map beside a decision (V3 L5): Apple Maps with points of interest off, opening close
/// at street level on the end that matters (where the trip went, or where a drive back to a saved
/// place began) with its name, the route in the theme's accent, the stretch that wasn't recorded
/// dashed, and "Whole route". Apple's road shields stay; nothing else is drawn on it.
struct MileageMap: View {
	let trip: MileageReport.Trip
	/// The trip view lets you move the map on the Mac and iPad; the report's card and the iPhone
	/// keep it still, so a scroll never turns into a pan.
	var interactive = false
	var height: CGFloat = 220
	@Environment(MileageModel.self) private var mileage
	@Environment(\.mcPalette) private var palette
	@State private var route: MileageRoute?
	@State private var failed = false
	/// The route couldn't be read (offline): the streets still show, with Try again.
	@State private var routeMissing = false
	/// Debug captures open on the whole route with `MC_MILEAGE_SCREEN=…,whole`.
	@State private var whole = LaunchOptions.mileageScreen?.split(separator: ",").contains("whole") == true
	@State private var position: MapCameraPosition = .automatic

	var body: some View {
		ZStack(alignment: .bottomTrailing) {
			if failed {
				failure
			} else if nothingToShow {
				// No route and no place to centre on (iphone-r2-02): say so, not a map of a continent.
				Text("No route recorded for this trip.")
					.foregroundStyle(.mcMuted)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.horizontal, 16)
					.padding(.vertical, 14)
					.background(.mcRaised)
					.accessibilityIdentifier("mileage-map-none")
			} else if !hasPlace && route == nil {
				// Reading the route of a trip with no place yet: nothing to show until it comes.
				Rectangle().fill(.mcRaised)
			} else {
				map
				if routeMissing {
					HStack(spacing: 8) {
						Text("The route didn't load.").foregroundStyle(.mcText)
						Button("Try again") { Task { await load() } }
							.buttonStyle(MCLinkButtonStyle())
							.accessibilityIdentifier("mileage-map-retry")
					}
					.font(.callout)
					.padding(.horizontal, 10)
					.padding(.vertical, 6)
					.background(.mcSheet, in: MCCorner.control.rect)
					.overlay(MCCorner.control.rect.strokeBorder(.mcBorder))
					.padding(10)
					.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
					.accessibilityIdentifier("mileage-map-failed")
				}
				// One place and no route: the close-up is all there is.
				if points.count > 1 {
					Button(whole ? "Close up" : "Whole route") {
						whole.toggle()
						position = camera
					}
					.buttonStyle(MapWord())
					.modifier(MileageReturnKey())
					.padding(10)
					.accessibilityIdentifier("mileage-whole-route")
				}
			}
		}
		.frame(height: nothingToShow ? nil : height)
		.clipped()
		// Words on the map stop growing at the largest standard size, as a bar's do: at AX3 the label
		// and "Whole route" covered the street the map is there to show.
		.mcBarText()
		.task(id: trip.id) { await load() }
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("mileage-map")
	}

	private var map: some View {
		Map(position: $position, interactionModes: interactive ? .all : []) {
			if let route, route.points.count > 1 {
				let (drawn, gap) = Self.split(route, gap: trip.gap)
				ForEach(Array(drawn.enumerated()), id: \.offset) { _, part in
					MapPolyline(coordinates: part.map(\.coordinate))
						.stroke(palette[.accent], style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
				}
				if let gap {
					MapPolyline(coordinates: gap.map(\.coordinate))
						.stroke(palette[.accent], style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [2, 7]))
				}
			}
			if let place = placeEnd, let focus = place.coordinate {
				let label = labelAlignment(focus)
				Annotation("", coordinate: focus, anchor: .center) {
					Circle()
						.fill(palette[.accent])
						.overlay(Circle().strokeBorder(palette[.sheet], lineWidth: 2))
						.frame(width: 13, height: 13)
						.overlay(alignment: label) {
							Text(place.name ?? "")
								.font(.footnote.weight(.semibold))
								.foregroundStyle(.mcText)
								.lineLimit(1)
								.fixedSize()
								.padding(.horizontal, 8)
								.padding(.vertical, 3)
								.background(.mcSheet, in: MCCorner.control.rect)
								.overlay(MCCorner.control.rect.strokeBorder(.mcBorder))
								.offset(y: label.vertical == .top ? 18 : -18)
						}
				}
				.annotationTitles(.hidden)
			}
		}
		.mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll, showsTraffic: false))
		.mapControlVisibility(.hidden)
		.onAppear { position = camera }
		.onChange(of: route) { _, _ in position = camera }
	}

	/// "The map didn't load" with Try again: the trip and its answers are all still here.
	private var failure: some View {
		VStack(spacing: 8) {
			Text("The map didn't load.")
				.foregroundStyle(.mcMuted)
			Button("Try again") { Task { await load() } }
				.buttonStyle(MCLinkButtonStyle())
				.accessibilityIdentifier("mileage-map-retry")
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(.mcRaised)
		.accessibilityIdentifier("mileage-map-failed")
	}

	private func load() async {
		failed = false
		let read = await mileage.route(trip.id)
		// No route and no endpoints to centre on: nothing to draw. No route but endpoints: the streets.
		failed = read == nil && trip.start.coordinate == nil && trip.end.coordinate == nil
		routeMissing = read == nil
		route = read
	}

	/// The end that matters: where the trip went, or where a drive back to a saved place began.
	private var focusEnd: MileageReport.Trip.End {
		trip.return_of != nil && trip.end.name_source == "saved" ? trip.start : trip.end
	}

	/// The end the map shows: the one that matters, else the other when only it has coordinates.
	private var placeEnd: MileageReport.Trip.End? {
		[focusEnd, focusEnd == trip.end ? trip.start : trip.end].first { $0.coordinate != nil }
	}

	private var hasPlace: Bool { trip.start.coordinate != nil || trip.end.coordinate != nil }

	/// The route read (none uploaded, a 404) and no end has coordinates: no map at all.
	private var nothingToShow: Bool { !failed && !hasPlace && route.map { $0.points.count < 2 } == true }

	/// What there is to frame: the route, else the ends that have coordinates (no route uploaded).
	private var points: [CLLocationCoordinate2D] {
		if let route, route.points.count > 1 { return route.points.map(\.coordinate) }
		return [trip.start.coordinate, trip.end.coordinate].compactMap { $0 }
	}

	private var camera: MapCameraPosition { cameraRect.map { .rect($0) } ?? .automatic }

	/// The place's name sits toward the middle of the map from its dot, so it never runs off an edge
	/// (iphone-r1-09: on the whole route a destination at the right edge cut "100 Example Street, Springfield"):
	/// above the dot, or under it near the top; centred, or ending at the dot in the map's right part
	/// and starting at it in the left. MapKit only widens the rect to the map's shape, which moves
	/// the dot toward the middle, never past it.
	private func labelAlignment(_ focus: CLLocationCoordinate2D) -> Alignment {
		guard let rect = cameraRect, rect.width > 0, rect.height > 0 else { return .bottom }
		let point = MKMapPoint(focus)
		let x = (point.x - rect.minX) / rect.width, y = (point.y - rect.minY) / rect.height
		return Alignment(horizontal: x > 0.62 ? .trailing : x < 0.38 ? .leading : .center, vertical: y < 0.3 ? .top : .bottom)
	}

	/// What the map shows: the whole route, or the close-up on the end that matters.
	private var cameraRect: MKMapRect? {
		let points = points
		if whole, points.count > 1 { return Self.fitted(points) }
		guard let focus = placeEnd?.coordinate else { return nil }
		return Self.closeUp(focus, route: points)
	}

	/// Street level on the place, with how the drive reached it (mac-r1-01): the route's last
	/// kilometre into it (or first out of it, for a drive back's start), at least about 900 m
	/// across so the street names read. A fixed 1.4 km camera on a wide Mac map showed only the
	/// last few metres of the line.
	static func closeUp(_ focus: CLLocationCoordinate2D, route: [CLLocationCoordinate2D]) -> MKMapRect {
		let center = MKMapPoint(focus)
		var rect = MKMapRect(origin: center, size: MKMapSize(width: 0, height: 0))
		let points = route.map(MKMapPoint.init)
		if let near = points.indices.min(by: { points[$0].distance(to: center) < points[$1].distance(to: center) }),
		   points[near].distance(to: center) < 300 {
			for step in [-1, 1] {
				var index = near, driven = 0.0
				while points.indices.contains(index + step) {
					driven += points[index].distance(to: points[index + step])
					index += step
					guard driven <= 1000 else { break }
					rect = rect.union(MKMapRect(origin: points[index], size: MKMapSize(width: 0, height: 0)))
				}
			}
		}
		let least = 900 * MKMapPointsPerMeterAtLatitude(focus.latitude)
		let grow = (x: max(0, least - rect.width) / 2, y: max(0, least - rect.height) / 2)
		rect = rect.insetBy(dx: -grow.x, dy: -grow.y)
		return Self.roomForWords(rect.insetBy(dx: -rect.width * 0.12, dy: -rect.height * 0.15))
	}

	/// More room at the bottom, where "Whole route" sits, so a place at the bottom edge keeps its
	/// label clear of it.
	static func roomForWords(_ rect: MKMapRect) -> MKMapRect {
		MKMapRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height * 1.22)
	}

	static func fitted(_ points: [CLLocationCoordinate2D]) -> MKMapRect {
		var rect = MKMapRect.null
		for coordinate in points {
			let point = MKMapPoint(coordinate)
			rect = rect.union(MKMapRect(x: point.x, y: point.y, width: 0, height: 0))
		}
		let padX = max(rect.width * 0.15, 1500), padY = max(rect.height * 0.2, 1500)
		return roomForWords(rect.insetBy(dx: -padX, dy: -padY))
	}

	/// The recorded parts and the stretch that wasn't: the route points from the gap's `from_at` to
	/// its `to_at` are dashed (an older trip view without them: the longest silence between fixes).
	static func split(_ route: MileageRoute, gap: MileageReport.Trip.Gap?) -> ([[MileageRoute.Point]], [MileageRoute.Point]?) {
		let points = route.points
		guard let gap, points.count > 2 else { return ([points], nil) }
		if let from = gap.from_at.map({ Double($0) / 1000 }), let to = gap.to_at.map({ Double($0) / 1000 }),
		   // The last fix at or before the stretch starts, the first at or after it ends (whether or
		   // not the stretch's own points came back).
		   let first = points.lastIndex(where: { ($0.time ?? .infinity) <= from + 0.5 }),
		   let last = points.firstIndex(where: { ($0.time ?? -.infinity) >= to - 0.5 }), first < last {
			return ([Array(points[...first]), Array(points[last...])], Array(points[first...last]))
		}
		var widest: (index: Int, seconds: Double)?
		for index in 1..<points.count {
			guard let a = points[index - 1].time, let b = points[index].time else { continue }
			if b - a > (widest?.seconds ?? 30) { widest = (index, b - a) }
		}
		guard let cut = widest?.index else { return ([points], nil) }
		return ([Array(points[..<cut]), Array(points[cut...])], [points[cut - 1], points[cut]])
	}
}

/// A word on the map ("Whole route"): the sheet's colour under it so it reads on any street.
private struct MapWord: ButtonStyle {

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(.callout.weight(.semibold))
			.foregroundStyle(.mcText)
			.padding(.horizontal, 10)
			.padding(.vertical, 6)
			.background(.mcSheet, in: MCCorner.control.rect)
			.overlay(MCCorner.control.rect.strokeBorder(.mcBorder))
			.opacity(configuration.isPressed ? 0.7 : 1)
			.contentShape(MCCorner.control.rect)
	}
}
