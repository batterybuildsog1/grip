import Foundation
import MailClawKit
import Observation
import CoreLocation
#if os(iOS)
import UIKit
#endif

/// Capture, the owner's ledger and sync, on the app's one session (AppModel hands it over with
/// `use`): Mileage has no sign-in, no credential and no server address of its own.
@MainActor @Observable
final class MileageModel {
    private(set) var session: MileageSession?
    /// The server says this person is not a Mileage owner: one sentence, no sync, no capture.
    private(set) var notOwner = false
    private(set) var trips: [MileageTrip] = []
    private(set) var phase = "idle"
    private(set) var recording = false
    private(set) var pending = 0
    private(set) var conflicts = 0
    private(set) var health = "Not recording"
    private(set) var message = ""
    private(set) var busy = false
    private(set) var diagnostics = ""
    /// Trips whose summary or route the server has not acknowledged.
    private(set) var unsynced: Set<String> = []
    /// The last upload attempt failed and a retry is scheduled. Only then is the upload count shown.
    private(set) var failing = false
    /// Drives with no route to draw: hand-added, never uploaded, or the server has none (404).
    private(set) var routeless: Set<String> = []
    /// After every good sync: the report reads the month again (new drives, the server's names).
    @ObservationIgnored var onSynced: (() -> Void)?
    /// The session changed (signed out, or another one signed in): the report forgets the last owner's month.
    @ObservationIgnored var onSessionChanged: (() -> Void)?
    /// The Mileage server refused the session (401): AppModel signs the whole app out.
    @ObservationIgnored var onSessionRejected: (() -> Void)?
    /// Always + Precise location is missing while recording is on. `true` = only Settings can fix it.
    private(set) var permissionLost: Bool?
    /// The test probe's words (Debug test mode shows them): the parked-car circle as the monitor holds it,
    /// and this drive's start leg ("asking", "412 m", "none" (no continuity), "refused …", "no route", "failed").
    private(set) var circle = "none"
    private(set) var startLegNote = ""
    /// What started the last candidate ("circle", "motion", "location", "visit", "manual"): the test probe.
    private(set) var woke = ""
    private var estimating = false
    private var routes: [String: MileageRoute] = [:]
    private var syncAgain = false
    private var store: MileageStore?
    private var epoch = 0
    private var storageFailed = false
    private var storageRetryAt = Date.distantPast
    /// Retained if the initial open fails, so recovery still rejects pre-sign-in cached fixes.
    private var openingSignIn = false
    private var markerNeedsAttributes = false
    private var syncing = false
    private var retryTask: Task<Void, Never>?
    private var failures = 0
    private var retryAt = Date.distantPast
    private var throttledUntil = Date.distantPast
    private let geocoder = MileageGeocoders.make()
    private var geocoding = false
    private var geocodeThrottledUntil = Date.distantPast
    #if os(iOS)
    private let location = MileageLocation()
    #endif

    nonisolated static var testMode: Bool {
        if OfflinePilot.enabled { return false }
        #if DEBUG && (targetEnvironment(simulator) || os(macOS))
        let raw = ProcessInfo.processInfo.environment["MILEAGE_TEST_URL"] ?? ""
        let url = URL(string: raw)
        return UserDefaults.standard.bool(forKey: "MCMileageTest") && url?.scheme == "http" && ["127.0.0.1", "localhost"].contains(url?.host ?? "")
        #else
        return false
        #endif
    }
    /// Drives are recorded only on an iPhone (iPad/Mac UX walk P1-2, 2026-11-02): one phone in the car, one copy of
    /// each drive. An iPad or a Mac signed in to the same account shows, files and exports the iPhone's trips and
    /// never asks for location or motion. An iPad app on a Mac or a Vision Pro is `.pad` too.
    static var recordsHere: Bool {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .phone
        #else
        false
        #endif
    }
    var captureAvailable: Bool {
        guard Self.recordsHere, let store, !notOwner, !storageFailed else { return false }
        return OfflinePilot.enabled || (store.value.syncCursor != nil && (session != nil || captureOnly))
    }
    private var captureOnly = false
    private var captureOnlyOwner: String?
    #if os(iOS)
    /// Debug simulator seam for the lead's unreadable-Keychain E2E; never changes device behavior.
    static var protectedDataAvailable: Bool {
        #if DEBUG && targetEnvironment(simulator)
        if testMode && ProcessInfo.processInfo.environment["MILEAGE_TEST_PROTECTED_DATA_UNAVAILABLE"] == "1" { return false }
        #endif
        return UIApplication.shared.isProtectedDataAvailable
    }
    #endif
    private var markerFile: URL { root.appendingPathComponent("capture-owner") }
    private func captureOwner() throws -> String? {
        guard FileManager.default.fileExists(atPath: markerFile.path) else { return nil }
        let owner = String(data: try Data(contentsOf: markerFile), encoding: .utf8) ?? ""
        guard owner.count == 64, owner.allSatisfy({ "0123456789abcdef".contains($0) }) else {
            throw MileageFailure.message("Invalid capture owner marker")
        }
        return owner
    }
    private func removeCaptureOwner() throws {
        if FileManager.default.fileExists(atPath: markerFile.path) { try FileManager.default.removeItem(at: markerFile) }
    }
    private func keepCaptureOwner(_ owner: String) throws {
        #if os(iOS)
        if (try? captureOwner()) != owner {
            try Data(owner.utf8).write(to: markerFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            markerNeedsAttributes = true
        }
        if markerNeedsAttributes {
            try FileManager.default.setAttributes([.posixPermissions: 0o600,
                .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: markerFile.path)
            markerNeedsAttributes = false
        }
        #endif
    }
    private func stopForStorageFailure(_ error: Error) {
        if !storageFailed {
            // Drop any response using the state that failed to commit.
            epoch += 1; syncing = false; syncAgain = false
            retryTask?.cancel(); retryTask = nil
            storageRetryAt = .distantPast
        }
        storageFailed = true; recording = false; permissionLost = nil
        message = "Capture stopped: local storage could not be saved. \(error.localizedDescription)"
        // Keep the marker: a later locked launch must be able to retry this confirmed ledger.
        #if os(iOS)
        location.stop()
        #endif
        health = "Not recording"
        writePilotStatus()
    }
    /// One attempt per lifecycle trigger, with a short cooldown after another failed attempt.
    /// The existing queue reloads durable state; a failed initial open can be retried from identity.
    private func recoverStorage(trigger: String) {
        guard storageFailed, !notOwner, Date() >= storageRetryAt else { return }
        #if os(iOS)
        if captureOnly && Self.protectedDataAvailable { return }
        #endif
        guard store != nil || session != nil || captureOnly || OfflinePilot.enabled else { return }
        storageRetryAt = Date().addingTimeInterval(5)
        print("Mileage: retrying local storage after \(trigger)")
        do {
            if let store {
                try store.recover()
                try prepareStore(signingIn: openingSignIn)
            } else if let session {
                try open(session, signingIn: openingSignIn)
            } else if OfflinePilot.enabled {
                try open(owner: OfflinePilot.owner)
            } else if captureOnly, let owner = captureOnlyOwner,
                      FileManager.default.fileExists(atPath: root.appendingPathComponent(owner + ".sqlite").path) {
                try open(owner: owner)
                if store?.value.syncCursor == nil { end() }
            }
            if !storageFailed { print("Mileage: local storage recovered after \(trigger)") }
        } catch { stopForStorageFailure(error) }
    }
    /// Called only after the confirmed ledger has committed. The point precedes enable, including
    /// capture-only locked relaunches, so a pending parked-circle event is not removed (LATE-START §2).
    private func startCapture() {
        #if os(iOS)
        guard captureAvailable, let store else { return }
        if session != nil && !OfflinePilot.enabled {
            do { try keepCaptureOwner(store.owner) }
            catch {
                // This marker authorizes a later locked launch, not this session's committed capture.
                print("Mileage: capture-owner marker failed; recording continues; retry on active/sync. \(error.localizedDescription)")
            }
        }
        if !recording {
            location.park(store.value.capture.parked, sync: false)
            recording = true
            location.enable(requestPermission: false)
            location.configure(phase: phase)
        }
        location.active()
        writePilotStatus()
        #endif
    }
    /// An unavailable Keychain is not sign-out. Only the non-secret marker can identify capture.
    private func restoreCaptureOnly() {
        #if os(iOS)
        guard Self.recordsHere, !Self.protectedDataAvailable, store == nil else { return }
        do {
            guard let owner = try captureOwner() else { location.stop(); return }
            guard FileManager.default.fileExists(atPath: root.appendingPathComponent(owner + ".sqlite").path) else {
                try removeCaptureOwner(); location.stop(); return
            }
            captureOnly = true; captureOnlyOwner = owner
            try open(owner: owner)
            guard store?.value.syncCursor != nil else { end(); return }
        } catch { stopForStorageFailure(error) }
        #endif
    }
    /// The ledger's folder (and, in a test run, the app session's: LaunchOptions.testSessionFile).
    nonisolated static var namespace: String {
        if OfflinePilot.enabled { return "mileage-offline-pilot-v1" }
        guard testMode else { return "mileage" }
        let run = UserDefaults.standard.string(forKey: "MCMileageRun") ?? "test"
        // Long enough for the QA runner's run, test and suffix: a cut-off suffix reuses another ledger.
        return "mileage-e2e-" + String(run.filter { $0.isLetter || $0.isNumber || $0 == "-" }.prefix(200))
    }
    private var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Self.namespace, isDirectory: true)
    }
    init() {
        MileageLegacyCredential.delete()
        #if os(iOS)
        location.onFix = { [weak self] fixes, automotive, other in self?.receive(fixes, automotive: automotive, nonAutomotive: other) }
        location.onWake = { [weak self] in self?.wake(source: $0) }
        location.onTick = { [weak self] in self?.tick() }
        location.onHealth = { [weak self] in self?.health = $0; self?.writePilotStatus() }
        location.onPermission = { [weak self] in self?.permissionLost = $0 }
        location.onCircle = { [weak self] in self?.circle = $0 }
        if !Self.recordsHere {
            // An iPad that ran build 12 recorded: its significant-change and visit monitoring and parked-car circle
            // outlive an update and would keep waking Grip for drives. Stop them and drop its marker, once per launch.
            do { try removeCaptureOwner() } catch { print("Mileage: capture-owner marker not removed. \(error.localizedDescription)") }
            location.stop()
        }
        #endif
        if OfflinePilot.enabled {
            do { try open(owner: OfflinePilot.owner) }
            catch { storageFailed = true; message = error.localizedDescription }
            writePilotStatus()
            return
        }
    }

    /// Same-owner session attachment reuses the capture-only store and its in-progress drive.
    func use(_ app: AppSession?, restored: Bool) {
        guard !OfflinePilot.enabled else { return }
        let next = app.map { MileageSession(credentials: $0.credentials, email: $0.email, expires: $0.expiresAt.milliseconds) }
        if let next, let session, next.credentials.identityTag == session.credentials.identityTag { return }
        if let next, captureOnly, let store, store.owner == next.owner {
            session = next; captureOnly = false; captureOnlyOwner = nil
            startCapture()
            onSessionChanged?()
            Task { await sync(force: true); await resolveAddresses() }
            return
        }
        if next == nil && restored && session == nil {
            #if os(iOS)
            guard !LaunchOptions.fixtureMode else { return }
            if Self.protectedDataAvailable {
                if captureOnly { end() } else {
                    do { try removeCaptureOwner() } catch { stopForStorageFailure(error) }
                    location.stop()
                }
            } else { restoreCaptureOnly() }
            #endif
            return
        }
        // Sign-out is explicit (restored false), including a session-less capture-only launch.
        if store != nil || session != nil || captureOnly || next == nil { end() }
        defer { onSessionChanged?() }
        guard let next else { return }
        epoch += 1; failures = 0; retryAt = .distantPast; throttledUntil = .distantPast; message = ""
        session = next; openingSignIn = !restored
        do {
            // A marker left for a different account must not survive while this owner awaits sync.
            if let kept = try captureOwner(), kept != next.owner { try removeCaptureOwner() }
            try open(next, signingIn: !restored)
        } catch { stopForStorageFailure(error) }
        Task { await sync(force: true); await resolveAddresses() }
    }

    /// Signed out (or another session): freeze and persist capture before the identity goes, then
    /// forget everything of this owner in memory. Even a full or damaged disk can't keep the session:
    /// the last durable capture stays owner-bound. Compatibility enabled keys always stay true.
    private func end() {
        var markerError: Error?
        do { try removeCaptureOwner() } catch { markerError = error }
        if let store {
            // Independent of marker unlink and finalization: a leftover marker must fail closed.
            do { try store.revokeConfirmation() } catch { stopForStorageFailure(error) }
            finish(reason: "gap")
            // No circle or estimated leg across the signed-out interval.
            MileageDetector.reset(&store.value.capture); store.value.capture.parked = nil
            _ = persist(captureOnly: true)
        }
        #if os(iOS)
        location.stop()
        #endif
        epoch += 1; retryTask?.cancel(); retryTask = nil
        session = nil; store = nil; trips = []; pending = 0; conflicts = 0
        routes = [:]; unsynced = []; failing = false; permissionLost = nil
        routeless = []; notOwner = false; storageFailed = false; diagnostics = ""
        recording = false; captureOnly = false; phase = "idle"; syncing = false; syncAgain = false; message = ""
        openingSignIn = false; captureOnlyOwner = nil; storageRetryAt = .distantPast
        health = "Not recording"
        if let markerError { stopForStorageFailure(markerError) }
    }

    /// A 401 for `client`'s session: the app signs out, unless that session is already gone.
    func rejected(_ client: MileageAPI) {
        guard let session, client.identity == session.credentials.identityTag else { return }
        onSessionRejected?()
    }
    /// The server says this person isn't an owner: stop syncing and say so (once per session).
    func refusedOwner(_ client: MileageAPI) {
        guard let session, client.identity == session.credentials.identityTag else { return }
        notOwner = true; failing = false; retryTask?.cancel(); retryTask = nil
        epoch += 1; syncing = false; syncAgain = false
        do { try store?.revokeConfirmation() } catch { stopForStorageFailure(error) }
        finish(reason: "gap")
        if let store {
            store.value.syncCursor = nil
            MileageDetector.reset(&store.value.capture); store.value.capture.parked = nil
            // Even if a prior save failed, attempt to durably revoke the old confirmation.
            do { try store.save() } catch { stopForStorageFailure(error) }
        }
        recording = false; permissionLost = nil
        #if os(iOS)
        location.stop()
        #endif
        do { try removeCaptureOwner() } catch { stopForStorageFailure(error) }
    }

    private func api(_ session: MileageSession) -> MileageAPI { MileageAPI(credentials: session.credentials) }
    /// The signed-in session's client, for the report and the owner's writes (MileageReportModel).
    var client: MileageAPI? {
        guard !OfflinePilot.enabled, let session, session.expires > Date().milliseconds else { return nil }
        return api(session)
    }
    /// The signed-in identity, for keeping per-owner files apart (the last report of each month).
    var owner: String? { session?.owner }
    var signedInEmail: String? { session?.email }
    /// Where the last good report of a month is kept for offline, beside the owner's ledger.
    func reportFile(_ month: String) -> URL? {
        guard let session else { return nil }
        return root.appendingPathComponent("report-" + session.owner.prefix(24) + "-" + month + ".json")
    }
    private func open(_ session: MileageSession, signingIn: Bool = false) throws {
        try open(owner: session.owner, signingIn: signingIn)
    }
    private func open(owner: String, signingIn: Bool = false) throws {
        store = try MileageStore(root: root, owner: owner)
        try prepareStore(signingIn: signingIn)
    }
    private func prepareStore(signingIn: Bool) throws {
        guard let newStore = store else { return }
        let openedAt = Date().timeIntervalSince1970
        if newStore.value.capture.tripID != nil {
            newStore.value.capture.quality = "gap"
            if let lastTime = newStore.value.capture.latest?.time ?? newStore.value.capture.last?.time ?? newStore.value.capture.samples.last(where: \.accepted)?.time,
               (signingIn || Date().timeIntervalSince1970 - lastTime > 180),
               let (trip, evidence) = MileageDetector.finalize(&newStore.value.capture, now: lastTime) {
                newStore.value.evidence.append(evidence)
                if trip.ended_at > trip.started_at {
                    newStore.value.trips.append(trip); newStore.value.pending.append(trip)
                }
            } else {
                // Never bridge the restart interval, even if shorter than 30 seconds.
                newStore.value.capture.last = nil
            }
        } else if newStore.value.capture.phase == "candidate",
                  Date().timeIntervalSince1970 - (newStore.value.capture.candidateSince ?? 0) > 90 {
            MileageDetector.reset(&newStore.value.capture)
        }
        if signingIn {
            // Fresh sign-in rejects cached fixes and continuity from the signed-out interval.
            MileageDetector.reset(&newStore.value.capture); newStore.value.capture.parked = nil
            newStore.value.capture.watermark = max(newStore.value.capture.watermark ?? openedAt, openedAt)
            newStore.value.capture.freshSignInBoundary = max(newStore.value.capture.freshSignInBoundary ?? openedAt, openedAt)
        }
        newStore.prune(now: Date().timeIntervalSince1970)
        try newStore.save()
        storageFailed = false; storageRetryAt = .distantPast; openingSignIn = false
        message = ""
        publish()
        startCapture()
        #if !os(iOS)
        health = "Automatic capture requires iPhone · review and sync available here"
        #endif
    }
    private func publish(captureOnly: Bool = false) {
        guard let store else { return }
        if !captureOnly {
            trips = store.value.trips.filter { $0.deleted_at == nil }.sorted { $0.started_at > $1.started_at }
            unsynced = (try? store.unsyncedTripIDs()) ?? Set(store.value.pending.map(\.id))
            pending = unsynced.count; conflicts = store.value.conflicts.count
        }
        phase = store.value.capture.phase
        writePilotStatus()
        #if DEBUG && targetEnvironment(simulator)
        if Self.testMode {
            let report: [String: Any] = ["phase": phase, "pending": pending, "trips": trips.count,
                "samples": store.value.capture.sampleCount ?? store.value.capture.samples.count, "meters": store.value.capture.distance,
                "circle": circle, "start_leg": startLegNote]
            if let data = try? JSONSerialization.data(withJSONObject: report, options: .sortedKeys) {
                try? data.write(to: root.appendingPathComponent("diagnostics.json"), options: .atomic)
            }
        }
        #endif
    }
    /// Bounded status only: no coordinates, account, token, trip contents or raw device logs.
    private func writePilotStatus() {
        guard OfflinePilot.enabled else { return }
        #if os(iOS)
        var status = location.pilotStatus
        status["offline"] = true; status["backend_authorized"] = false
        status["session_present"] = session != nil; status["capture_enabled"] = recording
        status["phase"] = phase; status["trip_count"] = trips.count
        status["storage_failed"] = storageFailed
        status["updated_at"] = ISO8601DateFormatter().string(from: Date())
        if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]),
           let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            try? data.write(to: cache.appendingPathComponent("mileage-offline-status.json"),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        #endif
    }
    @discardableResult private func persist(captureOnly: Bool = false) -> Bool {
        guard let store, !storageFailed else { return false }
        do {
            if captureOnly { try store.saveCapture() } else { try store.save() }
            publish(captureOnly: captureOnly); return true
        }
        catch { stopForStorageFailure(error); return false }
    }
    /// Account deletion (SPEC §3): this identity's ledger, routes, capture journal and kept reports
    /// leave the device, unsynced trips included (the account is gone). Its session ends first (as a
    /// sign-out does); nothing is sent, since the server already revoked every session. Another
    /// identity's ledger is untouched.
    func erase(host: URL, email: String) {
        let owner = MileageIdentity.key(host: host, email: email)
        if store?.owner == owner || session?.owner == owner {
            end()
            onSessionChanged?()
        }
        do { if try captureOwner() == owner { try removeCaptureOwner() } } catch { stopForStorageFailure(error) }
        let files = FileManager.default
        for name in [owner + ".sqlite", owner + ".sqlite-wal", owner + ".sqlite-shm", owner + ".json", owner + "-evidence"] {
            try? files.removeItem(at: root.appendingPathComponent(name))
        }
        let reports = "report-" + owner.prefix(24) + "-"
        for file in (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        where file.lastPathComponent.hasPrefix(reports) {
            try? files.removeItem(at: file)
        }
    }
    func active() {
        #if os(iOS)
        if captureOnly && Self.protectedDataAvailable { end() }
        #endif
        recoverStorage(trigger: "active")
        startCapture()
        Task { await sync(); await resolveAddresses() }
    }
    func allowAlways() {
        guard recording, captureAvailable else { return }
        #if os(iOS)
        location.allowAlways()
        #endif
    }
    func wake(source: String = "manual") {
        recoverStorage(trigger: "wake (\(source))")
        guard recording, captureAvailable, let store else { return }
        let was = store.value.capture.phase
        MileageDetector.candidate(&store.value.capture, now: Date().timeIntervalSince1970)
        if was != "candidate" && store.value.capture.phase == "candidate" { woke = source }
        guard persist(captureOnly: true) else { return }
        #if os(iOS)
        location.configure(phase: phase)
        #endif
    }
    private func receive(_ fixes: [CLLocation], automotive: Bool, nonAutomotive: Bool) {
        guard recording, captureAvailable, let store else { return }
        // Cached fixes from before fresh sign-in must not enter this owner's journal or route outbox.
        var fixes = fixes
        if let freshSignInBoundary = store.value.capture.freshSignInBoundary {
            fixes.removeAll { $0.timestamp.timeIntervalSince1970 <= freshSignInBoundary }
            guard !fixes.isEmpty else { return }
        }
        // A drive that went quiet for 180 s ended where it stopped, before these fixes arrived.
        if MileageDetector.due(store.value.capture, now: Date().timeIntervalSince1970) == .finish { finish() }
        let before = store.value.capture.phase
        var began = false
        do {
            for fix in fixes.sorted(by: { $0.timestamp < $1.timestamp }) {
                let was = store.value.capture.phase
                try store.record(fix, received: Date(), automotive: automotive, nonAutomotive: nonAutomotive)
                // LATE-START §3: the drive has just begun at this fix (M); ask for the leg from where it was parked.
                if was == "candidate" && store.value.capture.phase == "driving" {
                    store.value.capture.startLeg = MileageStartRule.leg(store.value.capture, trips: store.value.trips)
                    startLegNote = store.value.capture.startLeg == nil ? "none" : "asking"
                    began = true
                }
            }
            if began { try store.saveCapture() }
            publish(captureOnly: true)
        } catch { stopForStorageFailure(error); return }
        if before != phase {
            #if os(iOS)
            location.configure(phase: phase)
            #endif
        }
        tick()
    }
    /// LATE-START §3: Apple Maps' driving distance for the start leg, on the device. The answer is kept in
    /// the checkpoint and goes out with the trip; it is never added to the measured metres or the route.
    /// A failure to reach Apple tries again every 30 s while the drive lasts (6 tries); a drive that ends
    /// first has no estimate. An answer for a drive that has ended or been replaced is dropped.
    private func estimateStartLeg() async {
        guard !estimating, let store, !storageFailed, var leg = store.value.capture.startLeg,
              let trip = store.value.capture.tripID else { return }
        estimating = true; defer { estimating = false }
        let generation = epoch
        leg.attempts += 1; leg.lastAttempt = Date().timeIntervalSince1970
        store.value.capture.startLeg = leg
        guard persist(captureOnly: true) else { return }
        let answer = await MileageDirections.driving(from: CLLocationCoordinate2D(latitude: leg.fromLatitude, longitude: leg.fromLongitude),
                                                     to: CLLocationCoordinate2D(latitude: leg.toLatitude, longitude: leg.toLongitude))
        guard generation == epoch, self.store === store, !storageFailed, store.value.capture.tripID == trip, store.value.capture.startLeg != nil else { return }
        switch answer {
        case let .meters(meters):
            let estimate = MileageStartRule.estimate(meters: meters, leg: leg)
            store.value.capture.startEstimate = estimate; store.value.capture.startLeg = nil
            startLegNote = estimate.map { "\($0.meters) m" } ?? "refused \(Int(meters.rounded())) m over \(Int(leg.straight.rounded())) m"
        case .noRoute:
            store.value.capture.startLeg = nil; startLegNote = "no route"
        case .failed:
            if leg.attempts >= 6 { store.value.capture.startLeg = nil; startLegNote = "failed" }
        }
        _ = persist(captureOnly: true)
    }
    private func tick() {
        guard recording, captureAvailable, let store else { return }
        if let leg = store.value.capture.startLeg, !estimating, Date().timeIntervalSince1970 - (leg.lastAttempt ?? 0) >= 30 {
            Task { await estimateStartLeg() }
        }
        switch MileageDetector.due(store.value.capture, now: Date().timeIntervalSince1970) {
        case .abandonCandidate:
            MileageDetector.reset(&store.value.capture); _ = persist(captureOnly: true)
            #if os(iOS)
            location.configure(phase: phase)
            #endif
        case .finish: finish()
        case .none: break
        }
    }
    func finish(reason: String? = nil) {
        guard let store, !storageFailed else { return }
        if let reason { store.value.capture.quality = reason }
        if let (trip, evidence) = MileageDetector.finalize(&store.value.capture, now: Date().timeIntervalSince1970) {
            store.value.evidence.append(evidence)
            if trip.ended_at > trip.started_at {
                store.value.trips.append(trip); store.value.pending.append(trip)
            } else { message = "No measurable drive interval. Local evidence kept; add a manual trip if needed." }
        }
        guard persist() else { return }
        #if os(iOS)
        // The car is parked where the drive ended: its circle replaces the last one (LATE-START §2).
        location.park(store.value.capture.parked)
        location.configure(phase: phase)
        #endif
        Task { await sync(); await resolveAddresses() }
    }
    var loading: Bool { syncing && trips.isEmpty }
    func sync(force: Bool = false) async {
        recoverStorage(trigger: "sync")
        // Also retries a missing marker without requiring another sync page.
        startCapture()
        guard !OfflinePilot.enabled, let identity = session, !notOwner, let store, !storageFailed else { return }
        // A decision made during a running sync is uploaded by one more pass right after it.
        guard !syncing else { if force { syncAgain = true }; return }
        if Date() < throttledUntil || (!force && Date() < retryAt) { return }
        syncing = true
        let generation = epoch
        defer {
            if generation == epoch {
                syncing = false
                if syncAgain { syncAgain = false; Task { await sync(force: true) } }
            }
        }
        do {
            let client = api(identity)
            guard identity.expires > Date().milliseconds else { throw MileageFailure.server(401, "Session expired", nil) }
            struct Me: Decodable { let principal: String; let user: User; let session: Session
                struct User: Decodable { let email: String }
                struct Session: Decodable { let kind: String }
            }
            let me: Me = try await client.request("/api/auth/me")
            guard generation == epoch, session?.owner == identity.owner else { return }
            guard me.principal == "user", me.user.email.lowercased() == identity.email, me.session.kind == "app" else {
                throw MileageFailure.message("Session identity changed · sync blocked")
            }
            // Ordinary builds recover the original pilot namespace only for the configured,
            // freshly verified pilot owner (GripPilotOwnerEmail). No manual confirmation or credential inference.
            if !Self.testMode && MileageIdentity.canAdoptPilot(host:identity.host,email:me.user.email) {
                let pilotRoot = root.deletingLastPathComponent().appendingPathComponent("mileage-offline-pilot-v1",isDirectory:true)
                let pilotFile = pilotRoot.appendingPathComponent(OfflinePilot.owner + ".sqlite")
                let legacyFile = pilotRoot.appendingPathComponent(OfflinePilot.owner + ".json")
                if FileManager.default.fileExists(atPath:pilotFile.path) || FileManager.default.fileExists(atPath:legacyFile.path) {
                    let pilot = try MileageStore(root:pilotRoot,owner:OfflinePilot.owner)
                    _ = try store.adoptPilot(pilot,verifiedHost:identity.host,verifiedEmail:me.user.email)
                    guard persist() else { return }
                }
            }
            // Manual creation has its own idempotent endpoint; preserve its explicit purpose.
            for manual in store.value.pending.filter({ $0.source == "manual" }) {
                let saved: MileageTrip = try await client.request("/api/mileage/trips", method: "POST", body: store.manualBytes(for: manual.id))
                guard generation == epoch else { return }
                store.value.pending.removeAll { $0.id == manual.id }
                try merge([saved], in: store)
                guard persist() else { return }
            }
            var cursor = store.value.syncCursor
            for _ in 0..<20 {
                var original = Array(store.value.pending.filter { !store.value.conflicts.contains($0.id) }.prefix(50))
                // LATE-START LB11: a trip with a start estimate ends its batch, so a refused estimate names its trip.
                if let estimated = original.firstIndex(where: { $0.start_estimate != nil }) { original = Array(original.prefix(estimated + 1)) }
                let upload = try MileageAPI.uploadData(deviceID: store.value.deviceID,
                    measurements: original.map { try store.measurementBytes(for: $0.id) }, cursor: cursor)
                let response: MileageAPI.Sync
                do {
                    response = try await client.request("/api/mileage/sync", method: "POST", body: upload)
                } catch MileageFailure.invalidStartEstimate {
                    // Everything before it carried no estimate: the last trip's is the one refused (the server
                    // checks only a trip it stores for the first time). It goes; the trip is sent again with its
                    // recorded miles only.
                    guard generation == epoch, session?.owner == identity.owner else { return }
                    guard let refused = original.last, refused.start_estimate != nil else { throw MileageFailure.invalidStartEstimate }
                    try store.dropStartEstimate(refused.id)
                    guard persist() else { return }
                    continue
                }
                guard generation == epoch, session?.owner == identity.owner else { return }
                let sent = Set(original.map(\.id))
                // A tombstone may precede our cursor. Its conflict code alone is a durable
                // deletion barrier, even when this changes page contains no trip tombstone.
                for id in response.deletedIDs { try store.retireDeletedTrip(id) }
                let conflicting = Set(response.conflicts.map(\.id)).subtracting(response.deletedIDs)
                let accepted = Set(response.accepted.filter { sent.contains($0.id) && !conflicting.contains($0.id) }.map(\.id))
                store.value.pending.removeAll { accepted.contains($0.id) }
                for conflict in conflicting where !store.value.conflicts.contains(conflict) { store.value.conflicts.append(conflict) }
                try merge(response.trips, in: store)
                store.prune(now: Date().timeIntervalSince1970)
                guard persist() else { return }
                cursor = response.cursor
                store.value.syncCursor = cursor
                guard persist() else { return }
                startCapture()
                if response.has_more != true && (store.value.pending.isEmpty || accepted.isEmpty) { break }
            }
            // Full evidence is a separate immutable queue and can only start after the
            // summary ACK has been committed. Retry reuses exact chunk bytes after lost ACK.
            while let chunk = try store.routeChunksReady().first {
                do {
                    let ack: MileageAPI.RouteACK = try await client.request("/api/mileage/trips/\(chunk.tripID)/route",method:"POST",body:chunk.body)
                    guard generation == epoch, session?.owner == identity.owner else { return }
                    guard ack.trip_id == chunk.tripID, ack.chunk_index == chunk.index, ack.chunk_count == chunk.count, ack.point_count == chunk.pointCount else {
                        throw MileageFailure.message("Route acknowledgement does not match its durable chunk")
                    }
                    try store.acknowledgeRoute(tripID:chunk.tripID,chunkIndex:chunk.index)
                } catch MileageFailure.tripDeleted {
                    guard generation == epoch, session?.owner == identity.owner else { return }
                    try store.retireDeletedTrip(chunk.tripID)
                }
                guard persist() else { return }
            }
            try await uploadAddresses(client, store: store, generation: generation, owner: identity.owner)
            guard generation == epoch else { return }
            store.prune(now:Date().timeIntervalSince1970)
            guard persist() else { return }
            failures = 0; retryAt = .distantPast; failing = false
            Task { await resolveAddresses() }
            onSynced?()
            message = conflicts > 0 ? "Upload conflict · original measurement and evidence kept. Reconcile the server trip before claiming mileage." : "Synced · \(pending) pending"
        } catch MileageFailure.notOwner {
            guard generation == epoch else { return }
            refusedOwner(api(identity))
        } catch MileageFailure.server(401, _, _) {
            // The session ended on the server (revoked, expired): the app signs out; capture is kept.
            guard generation == epoch, let client = session.map(api) else { return }
            rejected(client)
        } catch {
            guard generation == epoch else { return }
            failures += 1; failing = true
            var delay = min(900, 5 * pow(2, Double(min(failures, 7))))
            if case MileageFailure.server(429, _, let requested) = error {
                delay = max(delay, requested ?? 60); throttledUntil = Date().addingTimeInterval(delay)
            }
            retryAt = Date().addingTimeInterval(delay)
            message = "\(error.localizedDescription). \(pending) pending · retry in \(Int(delay))s."
            retryTask?.cancel()
            retryTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self, self.epoch == generation else { return }
                await self.sync()
            }
        }
    }
    private func merge(_ incoming: [MileageTrip], in store: MileageStore) throws {
        for trip in incoming where trip.deleted_at != nil {
            try store.retireDeletedTrip(trip.id)
            if let index = store.value.trips.firstIndex(where: { $0.id == trip.id }) { store.value.trips[index] = trip }
            else { store.value.trips.append(trip) }
        }
        let pending = Set(store.value.pending.map(\.id)).union(store.value.conflicts)
        for trip in incoming where trip.deleted_at == nil && !pending.contains(trip.id) {
            if let index = store.value.trips.firstIndex(where: { $0.id == trip.id }) { store.value.trips[index] = trip }
            else { store.value.trips.append(trip) }
            if let i = store.value.evidence.firstIndex(where: { $0.tripID == trip.id }), trip.human_reviewed == true {
                store.value.evidence[i].unresolved = false
            }
        }
    }
    /// Sends this iPhone's Apple addresses for drives the server has acknowledged (`PUT
    /// /trips/:id/addresses`), at most ten a sync; retried on later syncs. A drive gone from the server
    /// (404, deleted) or an end it can't hold (422) is dropped; a server without addresses (503) or no
    /// network stops the pass until the next sync.
    private func uploadAddresses(_ client: MileageAPI, store: MileageStore, generation: Int, owner: String) async throws {
        let waiting = Set(store.value.pending.map(\.id)).union(store.value.conflicts)
        let due = (store.value.addresses ?? [:]).filter { id, entry in
            entry.uploaded != true && (entry.start != nil || entry.end != nil) && !waiting.contains(id)
                && store.value.trips.contains { $0.id == id && $0.deleted_at == nil && $0.revision != nil }
        }.keys.sorted().prefix(10)
        for id in due {
            guard let entry = store.value.addresses?[id] else { continue }
            var done = true
            do {
                let _: MileageAPI.AddressesSaved = try await client.request("/api/mileage/trips/\(id)/addresses", method: "PUT",
                    body: JSONEncoder().encode(MileageAPI.Addresses(start: entry.start, end: entry.end)))
            } catch MileageFailure.tripDeleted {
            } catch MileageFailure.unavailable { return
            } catch MileageFailure.server(let code, _, _) where (400..<500).contains(code) && ![401, 408, 429].contains(code) {
            } catch { done = false }
            guard generation == epoch, session?.owner == owner else { return }
            guard done else { return }
            // Only what was sent is marked: a lookup that added an end meanwhile is sent next time.
            if store.value.addresses?[id] == entry { store.value.addresses?[id]?.uploaded = true; guard persist() else { return } }
        }
    }

    // MARK: Apple addresses

    /// Only the iPhone looks addresses up (its own drives); the Mac and the web read them from the report.
    #if os(iOS)
    private static let geocodes = true
    #else
    private static let geocodes = false
    #endif

    /// Looks up Apple addresses for finished drives that have none yet: newest first, at most four
    /// drives a pass (Apple throttles), each failure waits longer before the next try (2 min doubling,
    /// at most an hour). Runs after a drive finishes, on foreground and after a good sync. Offline or
    /// failed: the end shows its coordinates until a later pass fills it. Pilot builds look up too.
    func resolveAddresses() async {
        guard Self.geocodes, !geocoding, Date() >= geocodeThrottledUntil, let store, !storageFailed else { return }
        geocoding = true; defer { geocoding = false }
        let generation = epoch, now = Date().timeIntervalSince1970
        func missing(_ trip: MileageTrip) -> [MileageEnd] {
            let known = store.value.addresses?[trip.id]
            return [MileageEnd.start, .end].filter { end in
                let point = end == .start ? (trip.start_lat, trip.start_lng) : (trip.end_lat, trip.end_lng)
                return point.0 != nil && point.1 != nil && known?[end] == nil && (end == .start ? trip.start_address : trip.end_address) == nil
            }
        }
        let due = store.value.trips.filter { trip in
            trip.deleted_at == nil && !missing(trip).isEmpty && (store.value.addresses?[trip.id]?.retryAt ?? 0) <= now
        }.sorted { $0.started_at > $1.started_at }.prefix(4)
        for trip in due {
            var entry = store.value.addresses?[trip.id] ?? MileageTripAddresses()
            var failed = false, throttled = false
            // Each end on its own: an end Apple can't name never blocks the other one.
            for end in missing(trip) {
                let lat = (end == .start ? trip.start_lat : trip.end_lat)!, lng = (end == .start ? trip.start_lng : trip.end_lng)!
                do { entry[end] = try await geocoder.resolve(latitude: lat, longitude: lng); entry.uploaded = nil } catch {
                    failed = true
                    if (error as? MileageGeocodeError) == .throttled { throttled = true; break }
                }
            }
            if failed {
                let attempts = (entry.attempts ?? 0) + 1
                entry.attempts = attempts
                entry.retryAt = Self.testMode ? nil : now + min(3600, 120 * pow(2, Double(attempts - 1)))
            } else { entry.attempts = nil; entry.retryAt = nil }
            // Signed out or switched owner while Apple answered: this belongs to no open ledger.
            guard generation == epoch, self.store === store, store.value.trips.contains(where: { $0.id == trip.id && $0.deleted_at == nil }) else { return }
            var all = store.value.addresses ?? [:]; all[trip.id] = entry; store.value.addresses = all
            guard persist() else { return }
            if throttled { geocodeThrottledUntil = Date().addingTimeInterval(120); return }
        }
    }

    /// The drive's own track for drawing: this iPhone's journal when it still has one, else the
    /// owner-only synced route, rejected fixes skipped. `nil` when the server can't be reached (the
    /// map says so and offers Try again); empty when there is no route (hand-added, never uploaded).
    /// Memory only; cleared on sign-out.
    func route(_ id: String) async -> MileageRoute? {
        if let known = routes[id] { return known }
        if routeless.contains(id) { return MileageRoute(points: []) }
        var route = MileageRoute(points: [])
        if let store, let journal = store.value.evidence.first(where: { $0.tripID == id })?.journalID,
           let samples = try? store.readSamples(journalID: journal) {
            route = MileageRoute(points: samples.filter(\.accepted).map {
                MileageRoute.Point(latitude: $0.latitude, longitude: $0.longitude, time: $0.time) })
        }
        if route.points.isEmpty, !OfflinePilot.enabled, let identity = session {
            let generation = epoch
            var cursor: String?
            do {
                for _ in 0..<50 {
                    let path = "/api/mileage/trips/\(id)/route" + (cursor.map { "?cursor=" + ($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "") } ?? "")
                    let page: MileageAPI.RoutePage = try await api(identity).request(path)
                    guard generation == epoch else { return nil }
                    route.points += page.points.filter { $0.accepted != false }.map {
                        MileageRoute.Point(latitude: $0.latitude, longitude: $0.longitude, time: $0.timestamp.map { $0 / 1000 }) }
                    cursor = page.next_cursor
                    if cursor == nil { break }
                }
            } catch MileageFailure.server(let code, _, _) where (400..<500).contains(code) && ![401, 408, 409, 429].contains(code) {
                route.points = [] // 404: no route was ever uploaded for this drive.
            } catch {
                return nil
            }
        }
        if route.points.count > 1 { routes[id] = route } else { routeless.insert(id) }
        return route
    }
    #if DEBUG && targetEnvironment(simulator)
    /// Test mode: the event a device delivers when the car leaves the parked-car circle (the simulator never does).
    func deliverCircleExit() {
        guard Self.testMode else { return }
        location.deliverCircleExit()
    }
    func runDiagnostics() {
        guard Self.testMode else { return }
        Task {
            do { diagnostics = try await MileageDiagnostics.run(root: root) }
            catch { diagnostics = "Safety check failed: \(error.localizedDescription)" }
        }
    }
    #endif
}

/// Summary serialization remains unchanged; full journal evidence has its own route endpoint.
struct MileageMeasurement: Encodable {
    let id: String; let started_at: Int64; let ended_at: Int64; let timezone: String
    let start_lat: Double?; let start_lng: Double?; let end_lat: Double?; let end_lng: Double?
    let distance_meters: Int; let origin: String; let destination: String
    let vehicle_id: String; let source: String; let quality: String
    /// LATE-START §3: absent unless set (old trips keep their bytes).
    let start_estimate: MileageStartEstimate?
    init(_ trip: MileageTrip) {
        id = trip.id; started_at = trip.started_at; ended_at = trip.ended_at; timezone = trip.timezone
        start_lat = trip.start_lat; start_lng = trip.start_lng; end_lat = trip.end_lat; end_lng = trip.end_lng
        distance_meters = trip.distance_meters; origin = trip.origin; destination = trip.destination
        vehicle_id = trip.vehicle_id ?? "default"; source = trip.source; quality = trip.quality
        start_estimate = trip.start_estimate
    }
}

/// A drive's track for the map, with each fix's time when known (the recording gap is the longest
/// silence between two fixes).
struct MileageRoute: Equatable, Sendable {
    struct Point: Equatable, Sendable {
        let latitude: Double
        let longitude: Double
        let time: Double?
        var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
    }
    var points: [Point]
}
