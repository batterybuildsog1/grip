#if DEBUG && targetEnvironment(simulator)
import Foundation
import CoreLocation

/// The UI E2E's safety fixture executes the same detector and disk path in an isolated directory.
/// This file and all its controls are absent from device and Release builds.
@MainActor
enum MileageDiagnostics {
    static func run(root: URL) async throws -> String {
        var passed: [String] = []
        func check(_ condition: @autoclosure () -> Bool, _ name: String) throws {
            guard condition() else { throw MileageFailure.message(name) }; passed.append(name)
        }
        let now = Date().timeIntervalSince1970
        func fix(_ seconds: Double, _ lat: Double = 37.795, accuracy: Double = 5, speed: Double = 16) -> CLLocation {
            CLLocation(coordinate: .init(latitude: lat, longitude: -122.3935), altitude: 0,
                       horizontalAccuracy: accuracy, verticalAccuracy: 5, course: 0, speed: speed,
                       timestamp: Date(timeIntervalSince1970: now + seconds))
        }
        func feed(_ state: inout MileageCaptureState, _ point: CLLocation, receipt: Double, walking: Bool = false) {
            MileageDetector.accept(point, received: Date(timeIntervalSince1970: now + receipt),
                                   automotive: false, nonAutomotive: walking, state: &state)
        }
        var state = MileageCaptureState(); MileageDetector.candidate(&state, now: now)
        feed(&state, fix(-100), receipt: 0)
        try check(state.last == nil && state.samples.last?.reason == "stale", "stale_fix")
        feed(&state, fix(0, accuracy: 150), receipt: 0)
        try check(state.last == nil && state.samples.last?.reason == "accuracy", "poor_accuracy")
        feed(&state, fix(0), receipt: 0, walking: true)
        try check(state.last == nil && state.samples.last?.reason == "non_automotive", "walking_control")
        feed(&state, fix(0), receipt: 0)
        feed(&state, fix(5, 40), receipt: 5)
        try check(state.phase == "candidate" && state.distance == 0 && state.samples.last?.reason == "jump", "impossible_jump")
        feed(&state, fix(5, 37.7957), receipt: 5)
        try check(state.phase == "driving" && state.distance == 0 && state.quality == "delayed_start", "delayed_start_not_invented")
        feed(&state, fix(10, 37.7964), receipt: 10)
        let observed = state.distance
        try check(observed > 70 && observed < 85, "observed_distance")
        feed(&state, fix(80, 37.797), receipt: 80)
        try check(state.distance == observed && state.quality == "gap", "gap_not_bridged")
        feed(&state, fix(79, 37.797), receipt: 80)
        try check(state.samples.last?.reason == "out_of_order", "out_of_order")
        let dir = root.appendingPathComponent("safety", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        let a = try MileageStore(root: dir, owner: "synthetic-a")
        a.value.capture = state; a.value.enabled = true
        try a.save()
        let restored = try MileageStore(root: dir, owner: "synthetic-a")
        try check(restored.value.capture.distance == observed && restored.value.capture.phase == "driving", "atomic_restart")
        restored.value.capture.last = nil // Same interrupted-distance baseline as real process restore.
        feed(&restored.value.capture, fix(75, 37.7968), receipt: 80)
        try check(restored.value.capture.last == nil && restored.value.capture.samples.last?.reason == "out_of_order",
                  "restart_rejects_cached_fix")
        feed(&restored.value.capture, fix(85, 37.798), receipt: 85)
        try check(restored.value.capture.distance == observed, "restart_does_not_bridge_gap")
        try restored.saveCapture()
        let finalized = MileageDetector.finalize(&restored.value.capture, now: now + 80)!
        MileageDetector.candidate(&restored.value.capture, now: now + 90)
        feed(&restored.value.capture, fix(84, 37.7979), receipt: 90)
        try check(restored.value.capture.last == nil && restored.value.capture.samples.last?.reason == "out_of_order",
                  "finalized_watermark_survives_new_candidate")
        restored.value.trips = [finalized.0]; restored.value.pending = [finalized.0]; restored.value.evidence = [finalized.1]
        try restored.save()
        let replay = try MileageStore(root: dir, owner: "synthetic-a")
        try check(replay.value.pending.first?.id == finalized.0.id, "offline_outbox_survives")
        let b = try MileageStore(root: dir, owner: "synthetic-b")
        try check(b.value.pending.isEmpty && b.value.trips.isEmpty, "owner_separation")
        replay.value.evidence[0].ended = now - 31 * 86400
        replay.prune(now: now)
        try check(replay.value.evidence.count == 1, "unresolved_retention")
        replay.value.pending = []; replay.value.evidence[0].unresolved = false
        replay.prune(now: now)
        try check(replay.value.evidence.count == 1, "unacknowledged_route_retention")
        // Summary review alone cannot retire evidence while its full route is still queued.
        for chunk in try replay.routeChunksReady(limit: 1000) {
            try replay.acknowledgeRoute(tripID: chunk.tripID, chunkIndex: chunk.index)
        }
        try replay.save()
        replay.prune(now: now)
        try check(replay.value.evidence.isEmpty, "reviewed_30_day_purge")
        try? FileManager.default.removeItem(at: dir)
        passed += try await MileagePersistenceChecks.run(root: root)
        let report = try JSONSerialization.data(withJSONObject: ["passed": passed], options: [.prettyPrinted, .sortedKeys])
        try report.write(to: root.appendingPathComponent("safety-checks.json"), options: .atomic)
        return "Safety checks passed · \(passed.count) cases"
    }
}
#endif
