import Foundation
import CoreLocation
import MapKit

/// Apple's address for one end of a drive, and the point of interest there when one is close by.
/// Same shape as the server's read-time `start_address`/`end_address` (name ≤ 120, address ≤ 300).
struct MileageAddress: Codable, Equatable, Sendable {
    var name: String?
    var address: String

    /// An end nothing names: "40.7484, -73.9857" (always a dot, whatever the locale).
    static func coordinates(_ lat: Double, _ lng: Double) -> String { String(format: "%.4f, %.4f", lat, lng) }
    /// The nearest point of interest within `poiRadius` names the end; a farther one never does.
    static let poiRadius: CLLocationDistance = 75
    static func make(address: String, pois: [(name: String, meters: CLLocationDistance)]) -> MileageAddress? {
        let clean = { (text: String, limit: Int) -> String in
            String(text.replacingOccurrences(of: "\n", with: ", ").trimmingCharacters(in: .whitespacesAndNewlines).prefix(limit))
        }
        let address = clean(address, 300)
        guard !address.isEmpty else { return nil }
        let near = pois.filter { $0.meters <= poiRadius && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            .min { $0.meters != $1.meters ? $0.meters < $1.meters : $0.name < $1.name }
        return MileageAddress(name: near.map { clean($0.name, 120) }, address: address)
    }
}

/// This phone's lookups, per trip id, in the owner's ledger (`MileageSnapshot.addresses`).
struct MileageTripAddresses: Codable, Equatable, Sendable {
    var start: MileageAddress?
    var end: MileageAddress?
    /// Failed passes in a row, and when the next pass may try again (Apple throttles lookups).
    var attempts: Int?
    var retryAt: Double?
    /// The server has what is here (`PUT /trips/:id/addresses` answered); cleared when an end is added.
    var uploaded: Bool?
    subscript(_ end: MileageEnd) -> MileageAddress? {
        get { end == .start ? start : self.end }
        set { if end == .start { start = newValue } else { self.end = newValue } }
    }
}

enum MileageGeocodeError: Error { case noResult, throttled }

/// Reverse geocoding for drive ends. Apple only: `MKReverseGeocodingRequest` for the address and
/// `MKLocalPointsOfInterestRequest` for a nearby name. Never CLGeocoder, never another service.
@MainActor
protocol MileageGeocoding {
    func resolve(latitude: Double, longitude: Double) async throws -> MileageAddress
}

@MainActor
struct MileageAppleGeocoder: MileageGeocoding {
    func resolve(latitude: Double, longitude: Double) async throws -> MileageAddress {
        let location = CLLocation(latitude: latitude, longitude: longitude)
        guard let request = MKReverseGeocodingRequest(location: location) else { throw MileageGeocodeError.noResult }
        let items: [MKMapItem]
        do { items = try await request.mapItems } catch { throw Self.mapped(error) }
        guard let item = items.first,
              let text = item.addressRepresentations?.fullAddress(includingRegion: false, singleLine: true)
                ?? item.address?.shortAddress ?? item.address?.fullAddress else { throw MileageGeocodeError.noResult }
        // The name is optional: a failed points-of-interest search still leaves the address.
        var pois: [(name: String, meters: CLLocationDistance)] = []
        let nearby = MKLocalPointsOfInterestRequest(center: location.coordinate, radius: MileageAddress.poiRadius)
        // A parking lot is where the car stood, not where the owner went.
        nearby.pointOfInterestFilter = MKPointOfInterestFilter(excluding: [.parking])
        if let response = try? await MKLocalSearch(request: nearby).start() {
            pois = response.mapItems.compactMap { poi in poi.name.map { ($0, poi.location.distance(from: location)) } }
        }
        guard let found = MileageAddress.make(address: text, pois: pois) else { throw MileageGeocodeError.noResult }
        return found
    }
    private static func mapped(_ error: Error) -> Error {
        if let error = error as? MKError, error.code == .loadingThrottled { return MileageGeocodeError.throttled }
        return error
    }
}

#if DEBUG && (targetEnvironment(simulator) || os(macOS))
/// Test mode only: deterministic answers so the XCUITests never depend on Apple's servers.
/// `MILEAGE_TEST_GEOCODER_JSON` maps "lat,lng" (4 decimals) to `{"address", "pois": [{"name", "meters"}]}`;
/// any other point has no result, like an offline lookup. `MILEAGE_TEST_GEOCODER=apple` uses Apple.
@MainActor
struct MileageFixtureGeocoder: MileageGeocoding {
    struct Entry: Decodable { let address: String; let pois: [POI]?; struct POI: Decodable { let name: String; let meters: Double } }
    let table: [String: Entry]
    init(json: String) {
        table = (try? JSONDecoder().decode([String: Entry].self, from: Data(json.utf8))) ?? [:]
    }
    static func key(_ latitude: Double, _ longitude: Double) -> String { String(format: "%.4f,%.4f", latitude, longitude) }
    func resolve(latitude: Double, longitude: Double) async throws -> MileageAddress {
        guard let entry = table[Self.key(latitude, longitude)],
              let found = MileageAddress.make(address: entry.address, pois: (entry.pois ?? []).map { ($0.name, $0.meters) })
        else { throw MileageGeocodeError.noResult }
        return found
    }
}
#endif

enum MileageGeocoders {
    @MainActor static func make() -> any MileageGeocoding {
        #if DEBUG && (targetEnvironment(simulator) || os(macOS))
        let env = ProcessInfo.processInfo.environment
        if MileageModel.testMode && env["MILEAGE_TEST_GEOCODER"] != "apple" {
            return MileageFixtureGeocoder(json: env["MILEAGE_TEST_GEOCODER_JSON"] ?? "{}")
        }
        #endif
        return MileageAppleGeocoder()
    }
}

/// LATE-START §3: Apple Maps' driving distance between two points (`MKDirections`, automobile, on the
/// device). Apple only, test mode included: the estimate's `method` says so.
enum MileageDirections {
    enum Answer: Equatable { case meters(Double), noRoute, failed }
    @MainActor static func driving(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async -> Answer {
        let request = MKDirections.Request()
        request.source = MKMapItem(location: CLLocation(latitude: from.latitude, longitude: from.longitude), address: nil)
        request.destination = MKMapItem(location: CLLocation(latitude: to.latitude, longitude: to.longitude), address: nil)
        request.transportType = .automobile
        request.requestsAlternateRoutes = false
        do {
            let response = try await MKDirections(request: request).calculate()
            guard let route = response.routes.min(by: { $0.distance < $1.distance }) else { return .noRoute }
            return .meters(route.distance)
        } catch let error as MKError where error.code == .directionsNotFound {
            return .noRoute
        } catch {
            return .failed
        }
    }
}
