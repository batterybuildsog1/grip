#if DEBUG && targetEnvironment(simulator)
import Foundation
import CoreLocation
import CryptoKit

/// Prewritten changed-input failures at the existing native safety/store seam:
/// - legacy summary without endpoints must decode; never enrich an already pending UUID;
/// - newly captured endpoints must be paired and derive only from accepted fixes;
/// - 10,000 new fixes must retain every sample without growing the checkpoint or rewriting ledger;
/// - evidence committed before a failed checkpoint must recover once, with a gap and no bridge;
/// - frozen upload bytes must survive reopening, classification edits and retries unchanged;
/// - same-ms manual times and over-ceiling distances must be rejected before networking.
@MainActor
enum MileagePersistenceChecks {
    // Written before the start-zone fix: a stored zone must survive the real checkpoint path,
    // even when finalization happens in a zone on the other side of the June/July date boundary.
    private static func timezoneChecks(root: URL) throws -> [String] {
        func require(_ condition: @autoclosure () throws -> Bool, _ name: String) throws {
            guard try condition() else { throw MileageFailure.message(name) }
        }
        let directory = root.appendingPathComponent("timezone-safety")
        try? FileManager.default.removeItem(at: directory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let instant = ISO8601DateFormatter().date(from: "2026-07-01T00:30:00Z")!
        func localDate(_ date: Date, zone: String) -> String {
            let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: zone)!
            formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from: date)
        }
        let currentZone = TimeZone.current.identifier
        let expectedDate = localDate(instant, zone: currentZone) == "2026-07-01" ? "2026-06-30" : "2026-07-01"
        let savedZone = expectedDate == "2026-06-30" ? "America/Los_Angeles" : "Pacific/Kiritimati"
        try require(savedZone != currentZone && localDate(instant, zone: savedZone) == expectedDate,
                    "timezone_fixture_crosses_local_rate_date")
        var capture = MileageCaptureState()
        MileageDetector.candidate(&capture, now: instant.timeIntervalSince1970 - 5)
        for offset in [-5,0,5] {
            let date = instant.addingTimeInterval(Double(offset))
            let point = CLLocation(coordinate: .init(latitude: 37 + Double(offset) * 0.00014, longitude: -122),
                altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5, course: 0, speed: 16, timestamp: date)
            MileageDetector.accept(point, received: date, automotive: true, nonAutomotive: false, state: &capture)
        }
        let startedObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(capture)) as! [String:Any]
        // Supply an explicit saved start zone without changing the simulator's system zone.
        var savedObject = startedObject; savedObject["startTimezone"] = savedZone
        let store = try MileageStore(root: directory, owner: "synthetic-timezone")
        store.value.capture = try JSONDecoder().decode(MileageCaptureState.self,
            from: JSONSerialization.data(withJSONObject: savedObject))
        try store.saveCapture()
        let reopened = try MileageStore(root: directory, owner: "synthetic-timezone")
        let trip = MileageDetector.finalize(&reopened.value.capture, now: instant.timeIntervalSince1970 + 10)!.0
        try require(trip.timezone == savedZone, "persisted_start_timezone_survives_reopen_finalize")
        try require(localDate(Date(timeIntervalSince1970: Double(trip.started_at)/1000), zone: trip.timezone) == expectedDate,
                    "start_timezone_keeps_2026_rate_boundary_date")
        try require(startedObject["startTimezone"] as? String == currentZone, "detector_records_zone_at_driving_start")
        try require(trip.distance_meters == Int(capture.distance.rounded()) && trip.quality == capture.quality,
                    "timezone_preserves_observed_distance_quality")
        var legacyObject = savedObject; legacyObject.removeValue(forKey: "startTimezone")
        var legacy = try JSONDecoder().decode(MileageCaptureState.self,
            from: JSONSerialization.data(withJSONObject: legacyObject))
        legacy.quality = "gap" // Existing interrupted-capture behavior; unknown zone is not invented.
        let legacyTrip = MileageDetector.finalize(&legacy, now: instant.timeIntervalSince1970 + 10)!.0
        try require(legacyTrip.timezone == currentZone && legacyTrip.quality == "gap",
                    "legacy_missing_start_timezone_keeps_fallback_gap")
        let manual = synthetic(meters: 100, purpose: "Synthetic zone check", start: instant, end: instant.addingTimeInterval(60))
        try require(manual.timezone == currentZone, "manual_keeps_explicit_current_zone_semantics")
        let tripObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(trip))
        let report: [String:Any] = ["simulator_current_zone":currentZone,"saved_start_zone":savedZone,
            "expected_local_date":expectedDate,"finalized_trip":tripObject,"legacy_fallback_gap":true,"manual_current_zone":true]
        try JSONSerialization.data(withJSONObject: report, options:[.prettyPrinted,.sortedKeys])
            .write(to:root.appendingPathComponent("timezone-checks.json"),options:.atomic)
        return ["persisted_start_timezone", "timezone_2026_rate_boundary_date", "legacy_optional_capture_timezone", "manual_current_timezone"]
    }
    static func run(root: URL) async throws -> [String] {
        func require(_ condition: @autoclosure () throws -> Bool, _ name: String) throws {
            guard try condition() else { throw MileageFailure.message(name) }
        }
        let timezonePassed = try timezoneChecks(root: root)
        let directory = root.appendingPathComponent("persistence-safety")
        try? FileManager.default.removeItem(at: directory)
        let store = try MileageStore(root: directory, owner: "synthetic-long-drive")
        let now = Date().timeIntervalSince1970
        // A substantial old ledger must not be serialized or written on every new location fix.
        store.value.trips = (0..<1000).map { _ in
            synthetic(meters: 100, purpose: "Synthetic retained ledger", start: Date(timeIntervalSince1970: now-100), end: Date(timeIntervalSince1970: now-50))
        }
        store.value.enabled = true
        MileageDetector.candidate(&store.value.capture, now: now)
        try store.save()
        let originalLedger = try store.ledgerBytes()
        var sizes: [Int] = []
        func location(_ index: Int) -> CLLocation {
            CLLocation(coordinate: .init(latitude: 37.0 + Double(index) * 0.00014, longitude: -122.0), altitude: 0,
                       horizontalAccuracy: 5, verticalAccuracy: 5, course: 0, speed: 16,
                       timestamp: Date(timeIntervalSince1970: now + Double(index)))
        }
        for index in 0..<10000 {
            // Five-second candidate fixes, then one-second driving samples.
            let time = index == 0 ? 0 : index + 4
            try store.record(location(time), received: Date(timeIntervalSince1970: now + Double(time)), automotive: true, nonAutomotive: false)
            if index % 100 == 0 { await Task.yield() }
            if [10,100,1000,9999].contains(index) { sizes.append(try store.checkpointBytes().count) }
        }
        let maximumJournalRecord = try store.maximumJournalRecordBytes()
        try require(maximumJournalRecord < 8192, "journal_record_size_bounded")
        try require(sizes.allSatisfy { $0 < 4096 }, "checkpoint_size_must_stay_below_4KiB")
        try require(try store.ledgerBytes() == originalLedger, "GPS_fix_must_not_rewrite_ledger")
        let journalID = store.value.capture.journalID!
        try require(try store.readSamples(journalID: journalID).count == 10000, "every_long_drive_sample_survives")
        try store.diagnosticBackup(to:root.appendingPathComponent("long-capture-proof.sqlite"))
        let previousDistance = store.value.capture.distance
        store.failCheckpointAfterNextSample = true
        do {
            try store.record(location(10004), received: Date(timeIntervalSince1970: now+10004), automotive: true, nonAutomotive: false)
            throw MileageFailure.message("checkpoint_fault_was_not_exercised")
        } catch MileageStore.InjectedCheckpointFailure.expected {}
        let recovered = try MileageStore(root: directory, owner: "synthetic-long-drive")
        let recoveredCapture = try JSONSerialization.jsonObject(with: JSONEncoder().encode(recovered.value.capture)) as! [String:Any]
        try require(recoveredCapture["startTimezone"] as? String == TimeZone.current.identifier,
                    "start_timezone_survives_journal_tail_recovery")
        try require(try recovered.readSamples(journalID: journalID).count == 10001, "evidence_before_checkpoint_survives")
        try require(recovered.value.capture.quality == "gap" && recovered.value.capture.last == nil, "tail_recovery_marks_gap_and_clears_anchor")
        try require(recovered.value.capture.distance >= previousDistance, "durable_tail_measurement_retained")
        let recoveredDistance = recovered.value.capture.distance
        try recovered.record(location(10003), received: Date(timeIntervalSince1970: now+10005), automotive: true, nonAutomotive: false)
        try require(recovered.value.capture.distance == recoveredDistance, "cached_tail_cannot_duplicate_segment")
        try recovered.record(location(10006), received: Date(timeIntervalSince1970: now+10006), automotive: true, nonAutomotive: false)
        try require(recovered.value.capture.distance == recoveredDistance, "restart_does_not_bridge_uncaptured_interval")
        let result = MileageDetector.finalize(&recovered.value.capture, now: now+10006)!
        recovered.value.trips.append(result.0); recovered.value.pending.append(result.0); recovered.value.evidence.append(result.1)
        try recovered.save()
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MileageMeasurement(result.0))) as! [String:Any]
        try require(object["start_lat"] as? Double == 37.0 && object["start_lng"] as? Double == -122.0,
                    "first_accepted_endpoint_required")
        try require(object["end_lat"] as? Double == location(10006).coordinate.latitude && object["end_lng"] as? Double == -122.0,
                    "last_accepted_endpoint_required")
        try require(object["samples"] == nil && object["route"] == nil && object["points"] == nil, "no_raw_route_in_summary")
        let bytes = try recovered.measurementBytes(for: result.0.id)
        let reopened = try MileageStore(root: directory, owner: "synthetic-long-drive")
        try require(try reopened.measurementBytes(for: result.0.id) == bytes, "immutable_outbox_bytes_after_restart")
        // Legacy pending UUIDs must remain endpoint-free: their original measurement cannot change.
        var legacy = result.0
        legacy.id = "legacy-pending"
        var old = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as! [String:Any]
        for field in ["start_lat","start_lng","end_lat","end_lng"] { old.removeValue(forKey: field) }
        let decoded = try JSONDecoder().decode(MileageTrip.self, from: JSONSerialization.data(withJSONObject: old))
        reopened.value.pending.append(decoded); try reopened.save()
        reopened.value.pending[0].distance_meters += 1 // A local mutation cannot replace the queued original.
        reopened.value.pending[0].timezone = "Pacific/Kiritimati"
        try reopened.save()
        try require(try reopened.measurementBytes(for: result.0.id) == bytes, "pending_original_bytes_cannot_be_replaced")
        let oldBytes = try reopened.measurementBytes(for: decoded.id)
        let oldObject = try JSONSerialization.jsonObject(with: oldBytes) as! [String:Any]
        try require(oldObject["start_lat"] == nil && oldObject["end_lat"] == nil, "legacy_pending_endpoints_not_backfilled")
        try require(try MileageStore(root: directory, owner: "synthetic-long-drive").measurementBytes(for: decoded.id) == oldBytes,
                    "legacy_pending_bytes_frozen")
        // Exercise the actual old owner JSON-file migration, including an active sample array.
        var legacySnapshot = MileageSnapshot(owner: "legacy-file-owner")
        legacySnapshot.pending = [decoded]; legacySnapshot.trips = [decoded]
        MileageDetector.candidate(&legacySnapshot.capture, now: now)
        for index in [0,5] {
            MileageDetector.accept(location(index),received:Date(timeIntervalSince1970:now+Double(index)),automotive:true,nonAutomotive:false,state:&legacySnapshot.capture)
        }
        var legacyObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacySnapshot)) as! [String:Any]
        var captureObject = legacyObject["capture"] as! [String:Any]
        for key in ["first","latest","journalID","sampleCount","startTimezone"] { captureObject.removeValue(forKey:key) }
        legacyObject["capture"] = captureObject
        let legacyFile = directory.appendingPathComponent("legacy-file-owner.json")
        try JSONSerialization.data(withJSONObject:legacyObject).write(to:legacyFile,options:.atomic)
        let migrated = try MileageStore(root:directory,owner:"legacy-file-owner")
        let migratedCapture = try JSONSerialization.jsonObject(with: JSONEncoder().encode(migrated.value.capture)) as! [String:Any]
        try require(migratedCapture["startTimezone"] == nil, "legacy_active_timezone_remains_unknown_after_migration")
        try require(try migrated.readSamples(journalID:migrated.value.capture.journalID!).count == 2, "legacy_active_samples_migrate")
        try require(try migrated.measurementBytes(for:decoded.id) == oldBytes, "legacy_pending_file_payload_unchanged")
        try require(!FileManager.default.fileExists(atPath:legacyFile.path), "legacy_file_retired_only_after_commit")
        try reopened.diagnosticBackup(to:root.appendingPathComponent("long-capture-recovered.sqlite"))
        let report: [String:Any] = ["samples_written":10000,"checkpoint_bytes":sizes,"checkpoint_limit_bytes":4096,"max_journal_record_bytes":maximumJournalRecord,
            "historical_ledger_unchanged":true,"append_checkpoint_fault_recovered":true,"immutable_outbox_bytes":true,
            "paired_endpoints":true,"no_raw_route_in_summary":true,"legacy_json_file_migrated":true,"ledger_sha256":SHA256.hash(data:originalLedger).map {String(format:"%02x",$0)}.joined()]
        try JSONSerialization.data(withJSONObject: report, options:[.prettyPrinted,.sortedKeys]).write(to: root.appendingPathComponent("persistence-checks.json"),options:.atomic)
        try? FileManager.default.removeItem(at: directory)
        return timezonePassed + ["bounded_long_capture", "all_samples_durable", "append_checkpoint_recovery", "immutable_upload_bytes", "legacy_optional_endpoints", "paired_summary_endpoints"]
    }
    /// A hand-made trip summary as older ledgers hold them (V3 deleted Add trip; old ledgers keep theirs).
    private static func synthetic(meters: Int, purpose: String, start: Date, end: Date) -> MileageTrip {
        MileageTrip(id: UUID().uuidString, started_at: start.milliseconds, ended_at: end.milliseconds,
                    timezone: TimeZone.current.identifier, distance_meters: meters, origin: "", destination: "",
                    vehicle_id: "default", source: "manual", quality: "manual", purpose: purpose, treatment: "needs_review")
    }
}
#endif
