#if os(iOS)
import Foundation
@preconcurrency import CoreLocation
@preconcurrency import CoreMotion
import UIKit

/// iOS owns delivery/relaunch timing. This manager is created at app launch, even when Mileage
/// isn't onscreen, so persisted intent restores visits/significant-change and an interrupted drive.
@MainActor
final class MileageLocation: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let motion = CMMotionActivityManager()
    private var clock: Timer?
    private var hintDate = Date.distantPast
    private var automotive = false
    private var nonAutomotive = false
    private var enabled = false
    private var phase = "idle"
    private var monitoring = false
    /// Motion updates were started (recording on): only then are they stopped, since stopping them
    /// on a phone that never allowed motion asks for it (Sign out showed the motion prompt).
    private var motionStarted = false
    private var generation = 0
    var onFix: (([CLLocation], Bool, Bool) -> Void)?
    /// A wake, and what woke it: "circle", "motion", "location" or "visit".
    var onWake: ((String) -> Void)?
    var onTick: (() -> Void)?
    var onHealth: ((String) -> Void)?
    /// nil = fine (or recording off); false = iOS can still ask for Always; true = only Settings can fix it.
    var onPermission: ((Bool?) -> Void)?
    /// What the parked-car monitor holds, read back from it ("45.50481,-122.63959 100 m inside", "none").
    var onCircle: ((String) -> Void)?

    override init() {
        super.init(); manager.delegate = self
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        manager.distanceFilter = 10
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
    }
    func enable(requestPermission: Bool) {
        enabled = true
        if requestPermission { allowAlways() }
        startMotion(); configure(phase: phase); health()
    }
    /// iOS shows the Always upgrade prompt at most once; after that only Settings can grant it.
    private var askedAlways: Bool {
        get { UserDefaults.standard.bool(forKey: "MCMileageAskedAlways") }
        set { UserDefaults.standard.set(newValue, forKey: "MCMileageAskedAlways") }
    }
    private var canAskAlways: Bool {
        manager.authorizationStatus == .notDetermined || (manager.authorizationStatus == .authorizedWhenInUse && !askedAlways)
    }
    /// Sign-in's notification ask is out: iOS shows one system prompt at a time, so location and motion wait for its
    /// answer, then Grip asks at once (AppModel.notificationsAsked → MileageModel.active). iPad/Mac UX walk P1-5.
    private var anotherAskOut: Bool { NotificationCoordinator.current?.asking == true }
    func allowAlways() {
        guard enabled, UIApplication.shared.applicationState == .active, canAskAlways, !anotherAskOut else { return }
        askedAlways = true
        // Apple's provisional-Always flow also supports the first (Not Determined) request.
        manager.requestAlwaysAuthorization(); health()
    }
    func active() {
        guard enabled else { health(); return }
        if UIApplication.shared.applicationState == .active { allowAlways(); startMotion() }
        health()
    }
    func stop() {
        generation += 1
        enabled = false; monitoring = false; clock?.invalidate(); clock = nil
        manager.stopUpdatingLocation(); manager.stopMonitoringVisits(); manager.stopMonitoringSignificantLocationChanges()
        if motionStarted { motion.stopActivityUpdates(); motionStarted = false }
        hintDate = .distantPast; automotive = false; nonAutomotive = false
        parked = nil; syncCircle()
        health()
    }

    // MARK: The parked-car circle (LATE-START §2)

    /// Letters and digits only: CoreLocation refuses any other monitor name (an assertion, not an error).
    private static let monitorName = "MailClawParked"
    private static let circleID = "parked"
    private static let circleRadius: CLLocationDistance = 100
    private var parked: MileageParked?
    private var monitor: CLMonitor?
    /// Monitor calls run one after another: a removal never overtakes the add before it.
    private var circleChain: Task<Void, Never>?
    /// The circle last asked of the monitor (nil = none); `circleSynced` false until the first ask.
    private var circleApplied: MileageParked?
    private var circleSynced = false
    /// A condition may be in the monitor (it persists across launches): only then is one opened to remove it.
    private var circleMayExist: Bool {
        get { UserDefaults.standard.bool(forKey: "MCMileageCircle") }
        set { UserDefaults.standard.set(newValue, forKey: "MCMileageCircle") }
    }
    /// The car is parked at `point` (nil: nowhere known). One 100 m circle around it while recording is on
    /// with Always and Precise; leaving it wakes capture through `onWake`, as motion, visits and significant
    /// change do (they stay). A new point replaces the circle. `sync: false` only hands the point over
    /// (at launch, before `enable`), so a circle kept from the last run is never removed and re-added.
    func park(_ point: MileageParked?, sync: Bool = true) { parked = point; if sync { syncCircle() } }
    private func syncCircle(recheck: Bool = false) {
        // A new manager reads `.notDetermined` until its first authorization callback: decide nothing yet, or a
        // relaunch would remove the circle it was relaunched for (the callback calls this again).
        if enabled && manager.authorizationStatus == .notDetermined { return }
        let allowed = enabled && manager.authorizationStatus == .authorizedAlways && manager.accuracyAuthorization == .fullAccuracy
        let target = allowed ? parked : nil
        guard !circleSynced || target != circleApplied || recheck else { return }
        circleSynced = true; circleApplied = target
        // Nothing to remove and nothing to add: no monitor is opened.
        guard target != nil || circleMayExist || monitor != nil else { onCircle?("none"); return }
        let previous = circleChain
        circleChain = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            let monitor = await self.openMonitor()
            let record = await monitor.record(for: Self.circleID)
            let kept = record?.condition as? CLMonitor.CircularGeographicCondition
            if let target {
                // The same circle kept from the last run stays as it is, with its state and any event pending;
                // one CoreLocation stopped monitoring (`unmonitored`) is added again.
                if kept?.center.latitude != target.latitude || kept?.center.longitude != target.longitude || kept?.radius != Self.circleRadius
                    || record?.lastEvent.state == .unmonitored {
                    self.circleMayExist = true
                    // Adding under an identifier already held keeps the old condition: remove it first.
                    if kept != nil { await monitor.remove(Self.circleID) }
                    await monitor.add(CLMonitor.CircularGeographicCondition(
                        center: CLLocationCoordinate2D(latitude: target.latitude, longitude: target.longitude), radius: Self.circleRadius),
                        identifier: Self.circleID, assuming: .satisfied)
                }
            } else {
                if kept != nil { await monitor.remove(Self.circleID) }
                self.circleMayExist = false
            }
            await self.readCircle(monitor)
        }
    }
    /// One monitor for the app's life, opened when first needed: Mileage opens its owner at launch, so a
    /// relaunch for a circle event awaits the events again at once.
    private func openMonitor() async -> CLMonitor {
        if let monitor { return monitor }
        let opened = await CLMonitor(Self.monitorName)
        monitor = opened
        Task { [weak self] in
            do {
                for try await event in await opened.events {
                    guard let self else { return }
                    self.circleEvent(event.identifier, event.state)
                    await self.readCircle(opened)
                }
            } catch {
                self?.onCircle?("events failed")
            }
        }
        return opened
    }
    /// The monitor's event: leaving the parked-car circle wakes capture.
    private func circleEvent(_ identifier: String, _ state: CLMonitor.Event.State) {
        if identifier == Self.circleID, state == .unsatisfied, enabled { onWake?("circle") }
    }
    #if DEBUG && targetEnvironment(simulator)
    /// Test mode only. The simulator answers every `CLMonitor` condition with `conditionUnsupported`, so the exit
    /// never comes there: this hands the handler the event a device delivers when the car leaves the circle.
    func deliverCircleExit() { circleEvent(Self.circleID, .unsatisfied) }
    #endif
    private func readCircle(_ monitor: CLMonitor) async {
        guard let record = await monitor.record(for: Self.circleID),
              let circle = record.condition as? CLMonitor.CircularGeographicCondition else { onCircle?("none"); return }
        let event = record.lastEvent
        var state: String = switch event.state {
        case .satisfied: "inside"
        case .unsatisfied: "left"
        case .unmonitored: "unmonitored"
        default: "unknown"
        }
        // CoreLocation's reasons, when it isn't monitoring (the test probe shows them).
        let reasons = [("denied", event.authorizationDenied), ("denied-globally", event.authorizationDeniedGlobally),
                       ("restricted", event.authorizationRestricted), ("insufficiently-in-use", event.insufficientlyInUse),
                       ("accuracy-limited", event.accuracyLimited), ("unsupported", event.conditionUnsupported),
                       ("limit-exceeded", event.conditionLimitExceeded), ("no-persistence", event.persistenceUnavailable),
                       ("session-required", event.serviceSessionRequired), ("asking", event.authorizationRequestInProgress)]
            .filter(\.1).map(\.0)
        if !reasons.isEmpty { state += " (" + reasons.joined(separator: ",") + ")" }
        onCircle?(String(format: "%.5f,%.5f %.0f m ", circle.center.latitude, circle.center.longitude, circle.radius) + state)
    }
    func configure(phase: String) {
        self.phase = phase
        guard enabled else { return }
        syncCircle()
        guard manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse,
              manager.accuracyAuthorization == .fullAccuracy else {
            manager.stopUpdatingLocation(); manager.stopMonitoringVisits(); manager.stopMonitoringSignificantLocationChanges()
            monitoring = false; clock?.invalidate(); clock = nil
            health(); return
        }
        monitoring = true
        manager.startMonitoringVisits()
        if CLLocationManager.significantLocationChangeMonitoringAvailable() { manager.startMonitoringSignificantLocationChanges() }
        clock?.invalidate()
        if phase == "driving" || phase == "settling" {
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.startUpdatingLocation()
        } else {
            manager.stopUpdatingLocation()
            manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
            if phase == "candidate" { manager.requestLocation() }
        }
        guard ["candidate", "driving", "settling"].contains(phase) else { clock = nil; return }
        clock = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.enabled else { return }
                self.onTick?()
                if self.phase == "candidate" { self.manager.requestLocation() }
            }
        }
    }
    private func startMotion() {
        guard enabled, !motionStarted, CMMotionActivityManager.isActivityAvailable() else { return }
        let authorization = CMMotionActivityManager.authorizationStatus()
        guard authorization == .authorized
                || (authorization == .notDetermined && UIApplication.shared.applicationState == .active && !anotherAskOut) else { return }
        let generation = generation
        motionStarted = true
        motion.startActivityUpdates(to: .main) { [weak self] activity in
            Task { @MainActor in
                guard let self, self.enabled, self.generation == generation, let activity else { return }
                self.hintDate = activity.startDate
                self.automotive = activity.automotive && activity.confidence != .low
                self.nonAutomotive = (activity.walking || activity.running || activity.cycling) && !activity.automotive
                if self.automotive, self.enabled { self.onWake?("motion") }
                self.health()
            }
        }
    }
    var pilotStatus: [String: Any] {
        ["location_authorization": String(describing: manager.authorizationStatus),
         "location_authorization_raw": manager.authorizationStatus.rawValue,
         "precise_location": manager.accuracyAuthorization == .fullAccuracy,
         "motion_authorization": String(describing: CMMotionActivityManager.authorizationStatus()),
         "motion_authorization_raw": CMMotionActivityManager.authorizationStatus().rawValue,
         "motion_available": CMMotionActivityManager.isActivityAvailable(),
         "background_refresh_available": UIApplication.shared.backgroundRefreshStatus == .available,
         "low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled,
         "service_enabled": enabled, "idle_monitors_started": monitoring,
         "background_location_configured": manager.allowsBackgroundLocationUpdates]
    }
    func health() {
        var reasons: [String] = []
        let status = manager.authorizationStatus
        let fine = status == .authorizedAlways && manager.accuracyAuthorization == .fullAccuracy
        let settingsOnly = !canAskAlways || (status != .notDetermined && manager.accuracyAuthorization == .reducedAccuracy)
        onPermission?(!enabled || fine ? nil : settingsOnly)
        if !enabled { onHealth?("Not recording"); return }
        switch manager.authorizationStatus {
        case .notDetermined: reasons.append("Location permission needed")
        case .denied, .restricted: reasons.append("Location denied · enable in Settings")
        case .authorizedWhenInUse: reasons.append("When in Use only · allow Always for unattended starts")
        case .authorizedAlways: break
        @unknown default: reasons.append("Unknown location permission")
        }
        if manager.accuracyAuthorization == .reducedAccuracy { reasons.append("Precise Location off · automatic capture suspended") }
        if CMMotionActivityManager.authorizationStatus() == .denied { reasons.append("Motion denied · speed confirmation only") }
        if !CMMotionActivityManager.isActivityAvailable() { reasons.append("Motion unavailable · speed confirmation only") }
        if UIApplication.shared.backgroundRefreshStatus != .available { reasons.append("Background App Refresh unavailable · starts may be missed") }
        if ProcessInfo.processInfo.isLowPowerModeEnabled { reasons.append("Low Power Mode · starts may be delayed") }
        // The state first, then what limits it: location that can't deliver (not asked, denied, Precise off) is not recording.
        let usable = (status == .authorizedAlways || status == .authorizedWhenInUse) && manager.accuracyAuthorization == .fullAccuracy
        onHealth?(([usable ? "Recording drives" : "Not recording"] + reasons).joined(separator: "\n"))
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if enabled { configure(phase: phase); syncCircle(recheck: true) }; health()
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard enabled else { return }
        if phase == "idle" || phase == "finalized" { onWake?("location") }
        let fresh = Date().timeIntervalSince(hintDate) < 120
        onFix?(locations, fresh && automotive, fresh && nonAutomotive)
    }
    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard enabled else { return }
        if visit.departureDate != .distantFuture { onWake?("visit") }
        // Historical motion is a supporting hint after a coarse wake, never a distance source.
        if CMMotionActivityManager.authorizationStatus() == .authorized {
            let generation = generation
            motion.queryActivityStarting(from: Date().addingTimeInterval(-120), to: Date(), to: .main) { [weak self] activities, _ in
                Task { @MainActor in
                    guard let self, self.enabled, self.generation == generation, let last = activities?.last else { return }
                    self.hintDate = last.startDate; self.automotive = last.automotive && last.confidence != .low
                    self.nonAutomotive = (last.walking || last.running || last.cycling) && !last.automotive
                }
            }
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard enabled else { return }
        let text = (error as? CLError)?.code == .locationUnknown ? "Waiting for a usable GPS fix" : "Location failed · check permission and device settings"
        onHealth?(text)
    }
}
#endif
