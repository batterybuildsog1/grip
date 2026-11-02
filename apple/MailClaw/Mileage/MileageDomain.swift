import Foundation
import CoreLocation
import CryptoKit
import MailClawKit

/// Immutable measurement summary. Full journal uploads use a separate acknowledged route queue.
struct MileageTrip: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var started_at: Int64
    var ended_at: Int64
    var timezone: String
    var distance_meters: Int
    var measured_distance_meters: Int?
    var start_lat: Double?
    var start_lng: Double?
    var end_lat: Double?
    var end_lng: Double?
    var origin: String
    var destination: String
    var vehicle_id: String?
    var source: String
    var quality: String
    var category_id: String?
    var purpose: String
    var treatment: String
    var revision: Int?
    var human_reviewed: Bool?
    var deleted_at: Int64?
    var updated_at: Int64?
    /// Read-only: the Apple addresses this owner's iPhone uploaded for the two ends.
    var start_address: MileageAddress?
    var end_address: MileageAddress?
    /// LATE-START §3: the start the phone didn't record, estimated by Apple Maps from where the car was
    /// parked. Never part of `distance_meters` or the route. Encoded only when set, so a trip without
    /// one keeps the exact bytes it always had.
    var start_estimate: MileageStartEstimate?
}
/// Apple Maps' driving distance from where the car was parked (P) to where this drive's metering began
/// (LATE-START §3, the JSON is fixed). Set by the phone at upload; the owner can remove it, never type one.
struct MileageStartEstimate: Codable, Equatable, Sendable {
    var meters: Int
    var method = "apple_maps_driving"
    var from_trip_id: String
    var reason = "parked_continuity"
}
/// Where the last drive on this iPhone ended (LATE-START §2, §3): the parked-car circle's centre and the
/// start leg's P. Kept in the capture checkpoint; a new drive's end replaces it, Record drives off forgets it.
struct MileageParked: Codable, Equatable, Sendable {
    var tripID: String
    var latitude: Double
    var longitude: Double
    /// The trip's `ended_at` (epoch ms).
    var endedAt: Int64
}
/// The start leg a drive asks Apple Maps for: continuity held when the drive began. From P to M, the fix
/// where metering began (candidate fixes are never metered, so the leg covers everything unmeasured).
struct MileageStartLeg: Codable, Equatable, Sendable {
    var fromTripID: String
    var fromLatitude: Double
    var fromLongitude: Double
    var toLatitude: Double
    var toLongitude: Double
    var attempts = 0
    var lastAttempt: Double?
    var straight: CLLocationDistance {
        CLLocation(latitude: fromLatitude, longitude: fromLongitude).distance(from: CLLocation(latitude: toLatitude, longitude: toLongitude))
    }
}
/// LATE-START §3's rules, on the phone. The server checks the trip ids again.
enum MileageStartRule {
    static let maxGap: Int64 = 12 * 3600 * 1000
    static let maxDistance: CLLocationDistance = 2000
    static let lateDistance: CLLocationDistance = 150
    static let maxMeters = 5000
    static let maxRatio = 3.0
    /// The leg to ask for when a drive has just begun (candidate → driving), or nil when continuity
    /// doesn't hold: the previous trip on this device ended at P and is still there, no other trip lies
    /// between P's end and this start, Q (the first accepted fix) is within 2 km of P and under 12 h after.
    /// Then only when the drive started late (`delayed_start`, every phone drive) or Q is over 150 m from P.
    static func leg(_ state: MileageCaptureState, trips: [MileageTrip]) -> MileageStartLeg? {
        guard let parked = state.parked, let q = state.first, let m = state.last, let started = state.started,
              state.phase == "driving" else { return nil }
        let start = Int64(started * 1000)
        guard trips.contains(where: { $0.id == parked.tripID && $0.deleted_at == nil }),
              !trips.contains(where: { $0.id != parked.tripID && $0.deleted_at == nil && $0.ended_at > parked.endedAt && $0.started_at < start })
        else { return nil }
        let fromP = q.location.distance(from: CLLocation(latitude: parked.latitude, longitude: parked.longitude))
        let gap = Int64(q.time * 1000) - parked.endedAt
        guard fromP <= maxDistance, gap >= 0, gap < maxGap, state.quality == "delayed_start" || fromP > lateDistance else { return nil }
        return MileageStartLeg(fromTripID: parked.tripID, fromLatitude: parked.latitude, fromLongitude: parked.longitude,
                               toLatitude: m.latitude, toLongitude: m.longitude)
    }
    /// Apple's driving metres as the estimate, or nil: over 5 km, or over 3× the straight line.
    static func estimate(meters: Double, leg: MileageStartLeg) -> MileageStartEstimate? {
        guard meters.isFinite, meters >= 0, meters <= Double(maxMeters), meters <= maxRatio * leg.straight else { return nil }
        return MileageStartEstimate(meters: Int(meters.rounded()), from_trip_id: leg.fromTripID)
    }
}
/// An owner-named place (`GET /api/mileage/places`): Settings lists, renames and removes them.
struct MileagePlace: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    let lat: Double
    let lng: Double
    let radius_m: Double
}
enum MileageEnd: String, Sendable { case start, end }
struct MileageSample: Codable, Sendable {
    var time: Double
    var received: Double
    var latitude: Double
    var longitude: Double
    var accuracy: Double
    var speed: Double
    var accepted: Bool = false
    var reason: String = ""
    var location: CLLocation { CLLocation(latitude: latitude, longitude: longitude) }
}
struct MileageEvidence: Codable, Sendable {
    var tripID: String
    var ended: Double
    var unresolved: Bool
    var samples: [MileageSample]
    var journalID: String?
}
struct MileageCaptureState: Codable, Sendable {
    var phase = "idle"
    // Independent of the distance anchor: a restart may clear `last` but cached fixes
    // older than the latest accepted observation must never be metered a second time.
    var watermark: Double?
    // Persist across resets and restored-session relaunches so cached pre-sign-in fixes
    // cannot enter this owner's journal or route outbox. Optional: old checkpoints decode.
    var freshSignInBoundary: Double?
    var tripID: String?
    var started: Double?
    // Captured with `started`, not at finalization. Nil means a legacy start zone is unknown.
    var startTimezone: String?
    var candidateSince: Double?
    var settlingSince: Double?
    var last: MileageSample?
    var first: MileageSample?
    var latest: MileageSample?
    var journalID: String?
    var sampleCount: Int?
    var distance: Double = 0
    var quality = "delayed_start"
    var samples: [MileageSample] = []
    /// Motion said walking since the last accepted fix: the car is parked, so the next fix's distance
    /// is the owner on foot, not a missing piece of the drive. Optional: old checkpoints decode.
    var walking: Bool?
    /// LATE-START: where the last drive ended (kept across resets, like the watermark), the start leg this
    /// drive is asking Apple Maps for, and Apple's accepted answer. Optional: old checkpoints decode.
    var parked: MileageParked?
    var startLeg: MileageStartLeg?
    var startEstimate: MileageStartEstimate?
}
struct MileageSnapshot: Codable {
    var owner: String
    var deviceID = UUID().uuidString
    /// Required by builds <= 11. Compatibility only: never a recording preference.
    var enabled = true
    var capture = MileageCaptureState()
    var trips: [MileageTrip] = []
    // Pending holds the exact immutable original upload, including across uncertain ACKs.
    var pending: [MileageTrip] = []
    var evidence: [MileageEvidence] = []
    var conflicts: [String] = []
    var syncCursor: String?
    /// Apple addresses looked up on this iPhone, by trip id.
    var addresses: [String: MileageTripAddresses]?
}
extension Date {
    var milliseconds: Int64 { Int64((timeIntervalSince1970 * 1000).rounded()) }
}

enum MileageIdentity {
    /// The offline pilot's migration requires an explicit operator build identity: never the demo instance or a
    /// test server, whatever the session's origin.
    static func canAdoptPilot(host: URL, email: String) -> Bool {
        guard let owner = Bundle.main.object(forInfoDictionaryKey: "GripPilotOwnerEmail") as? String,
              !owner.isEmpty, email.lowercased() == owner.lowercased(), host.scheme?.lowercased() == "https",
              host.host?.lowercased() == ServerConfig.hosted.host()?.lowercased(), host.port == nil || host.port == 443,
              host.user == nil, host.password == nil, host.query == nil, host.fragment == nil,
              host.path.isEmpty || host.path == "/" else { return false }
        return true
    }
    static func key(host: URL, email: String) -> String {
        var origin = URLComponents(url: host, resolvingAgainstBaseURL: false)!
        origin.scheme = origin.scheme?.lowercased(); origin.host = origin.host?.lowercased()
        origin.path = ""; origin.query = nil; origin.fragment = nil
        if origin.scheme == "https" && origin.port == 443 { origin.port = nil }
        let identity = (origin.string ?? host.absoluteString) + "|" + email.lowercased()
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Pure persisted detector. Caller commits after every event, before allowing sync.
enum MileageDetector {
    static func reset(_ state: inout MileageCaptureState, phase: String = "idle") {
        let watermark = state.watermark ?? state.latest?.time ?? state.last?.time ?? state.samples.last(where: \.accepted)?.time
        let parked = state.parked
        let freshSignInBoundary = state.freshSignInBoundary
        state = MileageCaptureState(); state.watermark = watermark; state.phase = phase; state.parked = parked
        state.freshSignInBoundary = freshSignInBoundary
    }
    static func candidate(_ state: inout MileageCaptureState, now: Double) {
        guard state.phase == "idle" || state.phase == "finalized" else { return }
        reset(&state, phase: "candidate"); state.candidateSince = now
    }
    static func accept(_ fix: CLLocation, received: Date, automotive: Bool, nonAutomotive: Bool,
                       state: inout MileageCaptureState) {
        let now = received.timeIntervalSince1970
        var sample = MileageSample(time: fix.timestamp.timeIntervalSince1970, received: now,
            latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude,
            accuracy: fix.horizontalAccuracy, speed: fix.speed)
        func reject(_ reason: String) {
            sample.reason = reason; state.samples.append(sample)
            // An unusable/cached observation is not evidence of a missing segment. The next
            // usable fix (or restart handling) determines whether a real gap occurred.
            guard state.phase == "driving" || state.phase == "settling" else { return }
            if reason == "jump" {
                // An impossible jump still marks the route suspect, without counting that segment.
                state.quality = "gap"; state.last = nil
            } else if reason == "non_automotive" {
                // Walking after parking: the drive is settling, not interrupted. The anchor stays, so
                // a brief misread mid-drive still meters the next real fix within 30 s.
                state.phase = "settling"; state.walking = true
                if state.settlingSince == nil { state.settlingSince = sample.time }
            }
        }
        guard CLLocationCoordinate2DIsValid(fix.coordinate), fix.horizontalAccuracy.isFinite,
              fix.speed.isFinite, sample.time.isFinite,
              fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 65 else { reject("accuracy"); return }
        guard now - sample.time <= 20, sample.time - now <= 5 else { reject("stale"); return }
        if let watermark = state.watermark ?? state.latest?.time ?? state.last?.time ?? state.samples.last(where: \.accepted)?.time,
           sample.time <= watermark { reject("out_of_order"); return }
        guard !nonAutomotive else { reject("non_automotive"); return }
        if let previous = state.last {
            let seconds = sample.time - previous.time
            let distance = fix.distance(from: previous.location)
            guard distance / seconds <= 60, fix.speed <= 60 else { reject("jump"); return }
            if state.phase == "candidate" {
                if seconds >= 4, seconds <= 30, distance >= max(45, previous.accuracy + sample.accuracy),
                   (automotive && distance / seconds >= 5 || distance / seconds >= 10), fix.speed < 0 || fix.speed >= 5 {
                    state.phase = "driving"; state.tripID = UUID().uuidString
                    // Candidate positions are evidence only: do not meter the coarse start.
                    state.started = sample.time; state.startTimezone = TimeZone.current.identifier; state.distance = 0
                }
            } else if state.phase == "driving" || state.phase == "settling" {
                if seconds > 30 {
                    // iOS sends nothing while the car stands still (10 m distance filter). Silence that
                    // ends within a stop's radius, or after the owner walked off, was a stop: driving
                    // again if this fix is pulling away, else settling from when the fixes stopped.
                    // Silence that ends far away is a real interruption (tunnel, killed service): a
                    // gap. Neither hop is ever metered.
                    if state.walking != true && distance <= stopRadius(previous, sample) && fix.speed >= 2 {
                        state.phase = "driving"; state.settlingSince = nil
                    } else if state.walking == true || distance <= stopRadius(previous, sample) {
                        state.phase = "settling"
                        if state.settlingSince == nil { state.settlingSince = previous.time }
                    } else {
                        state.quality = "gap"
                    }
                } else if distance >= max(5, (previous.accuracy + sample.accuracy) / 2), distance / seconds >= 1.8, (fix.speed >= 2 || (fix.speed < 0 && distance / seconds >= 5)) {
                    state.distance += distance
                    state.phase = "driving"; state.settlingSince = nil
                } else {
                    state.phase = "settling"
                    if state.settlingSince == nil { state.settlingSince = sample.time }
                }
            }
        }
        sample.accepted = true; sample.reason = "accepted"
        state.samples.append(sample); state.last = sample; state.latest = sample; state.watermark = sample.time
        state.walking = nil
        if state.first == nil { state.first = sample }
    }
    /// How far the next fix may be from the last one after a silence and still be the same stop:
    /// both fixes' error, one distance-filter step and the pull-away, with a 50 m floor.
    static func stopRadius(_ previous: MileageSample, _ next: MileageSample) -> Double {
        max(50, previous.accuracy + next.accuracy + 20)
    }
    enum Due: Equatable { case none, abandonCandidate, finish }
    /// What the 5-second clock (and every delivery) owes the capture now. A candidate that never
    /// became a drive in 90 s is abandoned; a drive settling for 180 s, or silent for 180 s (parked:
    /// iOS sends nothing while the car stands still), finishes normally. Silence is never a gap.
    static func due(_ state: MileageCaptureState, now: Double) -> Due {
        if state.phase == "candidate" { return now - (state.candidateSince ?? now) > 90 ? .abandonCandidate : .none }
        guard state.phase == "driving" || state.phase == "settling" else { return .none }
        if let stop = state.settlingSince, now - stop >= 180 { return .finish }
        if let last = state.latest?.time ?? state.last?.time ?? state.samples.last(where: \.accepted)?.time, now - last >= 180 { return .finish }
        return .none
    }
    static func finalize(_ state: inout MileageCaptureState, now: Double) -> (MileageTrip, MileageEvidence)? {
        guard let id = state.tripID, let started = state.started else {
            reset(&state); return nil
        }
        let ended = max(started, state.latest?.time ?? state.last?.time ?? state.samples.last(where: \.accepted)?.time ?? started)
        let trip = MileageTrip(id: id, started_at: Int64(started * 1000), ended_at: Int64(ended * 1000),
            timezone: state.startTimezone ?? TimeZone.current.identifier, distance_meters: Int(state.distance.rounded()),
            start_lat: state.first?.latitude, start_lng: state.first?.longitude,
            end_lat: state.latest?.latitude, end_lng: state.latest?.longitude,
            origin: "", destination: "", vehicle_id: "default", source: "gps", quality: state.quality,
            purpose: "", treatment: "needs_review", start_estimate: state.startEstimate)
        let evidence = MileageEvidence(tripID: id, ended: ended, unresolved: true, samples: state.samples, journalID: state.journalID)
        reset(&state, phase: "finalized")
        // The car is parked where the drive ended: the next drive's P (no end recorded: no P).
        state.parked = trip.end_lat.flatMap { lat in trip.end_lng.map { MileageParked(tripID: id, latitude: lat, longitude: $0, endedAt: trip.ended_at) } }
        return (trip, evidence)
    }
}

enum MileageFailure: Error, LocalizedError {
    /// The one quiet sentence a non-owner sees in place of Mileage.
    static let notOwnerText = "Mileage isn’t on for this account."
    case message(String)
    case tripDeleted
    /// The server has no such storage yet (e.g. known places before migration 004).
    case unavailable
    case server(Int, String, Double?)
    /// The server answered (2xx) but this app can't read what it sent (`where`: the field, for the log).
    case unreadable(String)
    /// This signed-in person is not one of the server's Mileage owners (403 FORBIDDEN).
    case notOwner
    /// The server refused an upload's start estimate (400 `INVALID_START_ESTIMATE`, LATE-START §3).
    case invalidStartEstimate
    var errorDescription: String? {
        switch self {
        case .message(let text): text
        case .tripDeleted: "Trip deleted on server"
        case .unavailable: "Mileage server unavailable (503)"
        case .server(let code, let text, _): "\(text) (\(code))"
        case .unreadable(let detail): "This app couldn't read the server's answer (\(detail))"
        case .notOwner: MileageFailure.notOwnerText
        case .invalidStartEstimate: "The server refused a start estimate (400)"
        }
    }
}
