import Foundation
import CoreLocation
import GRDB

/// The owner ledger is separate from a bounded capture checkpoint and an append-only sample
/// journal. A sample/after-state commits first; only then may the checkpoint advance. All rows
/// belong to this owner's protected database. Historical ledger blobs are never part of a fix.
@MainActor
final class MileageStore {
    struct Checkpoint: Codable {
        var owner: String
        var enabled: Bool
        var sequence: Int64
        var capture: MileageCaptureState
    }
    let root: URL
    let owner: String
    let url: URL
    var value: MileageSnapshot
    private let database: DatabaseQueue
    private var sequence: Int64 = 0
    private static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        return try encoder.encode(value)
    }
    #if DEBUG && targetEnvironment(simulator)
    enum InjectedCheckpointFailure: Error { case expected }
    var failCheckpointAfterNextSample = false
    #endif

    #if DEBUG
    enum InjectedSaveFailure: Error { case expected }
    var failNextSaveBeforeLedger = false
    #endif

    init(root: URL, owner: String) throws {
        self.root = root; self.owner = owner
        url = root.appendingPathComponent(owner + ".sqlite")
        value = MileageSnapshot(owner: owner)
        var attributes: [FileAttributeKey:Any] = [.posixPermissions:0o700]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: attributes)
        try FileManager.default.setAttributes(attributes,ofItemAtPath:root.path)
        var excluded = root; var resource = URLResourceValues(); resource.isExcludedFromBackup = true
        try excluded.setResourceValues(resource)
        if !FileManager.default.fileExists(atPath: url.path) {
            var fileAttributes = attributes; fileAttributes[.posixPermissions] = 0o600
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: fileAttributes) else {
                throw MileageFailure.message("Cannot create protected mileage storage")
            }
        }
        var configuration = Configuration(); configuration.label = "mailclaw.mileage"
        database = try DatabaseQueue(path: url.path, configuration: configuration)
        try database.writeWithoutTransaction { db in
            try db.execute(sql: "PRAGMA journal_mode=WAL")
            try db.execute(sql: "PRAGMA synchronous=FULL")
            try db.execute(sql: "PRAGMA secure_delete=ON")
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS sample_journal (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT NOT NULL,
                    received REAL NOT NULL, body BLOB NOT NULL, after_state BLOB);
                CREATE INDEX IF NOT EXISTS journal_samples ON sample_journal(journal_id,seq);
                CREATE INDEX IF NOT EXISTS journal_age ON sample_journal(received);
                CREATE TABLE IF NOT EXISTS route_outbox (
                    trip_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
                    point_count INTEGER NOT NULL, body BLOB, acknowledged INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(trip_id,chunk_index));
                CREATE TABLE IF NOT EXISTS deleted_trips (trip_id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS adopted_pilot_trips (trip_id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS pilot_adoption (id INTEGER PRIMARY KEY CHECK(id=1), destination_owner TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, measurement BLOB NOT NULL, manual BLOB);
                """)
        }
        try reloadDurableState()
        for suffix in ["","-wal","-shm"] {
            let path = url.path + suffix
            if FileManager.default.fileExists(atPath:path) {
                var fileAttributes: [FileAttributeKey:Any] = [.posixPermissions:0o600]
                #if os(iOS)
                fileAttributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
                #endif
                try FileManager.default.setAttributes(fileAttributes,ofItemAtPath:path)
            }
        }
    }
    /// Reconcile a failed commit with the ledger, checkpoint and journal already on disk, using
    /// this same DatabaseQueue. Never save speculative in-memory state from the failed operation.
    func recover() throws {
        try reloadDurableState(requireLedger: true)
    }
    private func reloadDurableState(requireLedger: Bool = false) throws {
        let saved: (Data?,Data?) = try database.read { db in
            (try Data.fetchOne(db,sql:"SELECT body FROM ledger WHERE id=1"),
             try Data.fetchOne(db,sql:"SELECT body FROM checkpoint WHERE id=1"))
        }
        if let ledger = saved.0 {
            value = try JSONDecoder().decode(MileageSnapshot.self, from: ledger)
            value.enabled = true // Compatibility key only; historical false is never an instruction.
            guard value.owner == owner else { throw MileageFailure.message("Owner mismatch; capture stopped") }
            guard let body = saved.1 else { throw MileageFailure.message("Missing mileage capture checkpoint; evidence kept") }
            let checkpoint = try JSONDecoder().decode(Checkpoint.self, from: body)
            guard checkpoint.owner == owner else { throw MileageFailure.message("Checkpoint owner mismatch") }
            value.capture = checkpoint.capture; value.enabled = true; sequence = checkpoint.sequence
            // Evidence may have committed just before process death and before its checkpoint.
            let tail: (Int64,Data)? = try database.read { db in
                guard let row = try Row.fetchOne(db,sql:"SELECT seq,after_state FROM sample_journal WHERE seq>? AND after_state IS NOT NULL ORDER BY seq DESC LIMIT 1",arguments:[checkpoint.sequence]) else { return nil }
                return (row["seq"],row["after_state"])
            }
            if let tail {
                let after = try JSONDecoder().decode(Checkpoint.self, from: tail.1)
                guard after.owner == owner else { throw MileageFailure.message("Journal owner mismatch") }
                value.capture = after.capture; value.enabled = true; sequence = tail.0
                value.capture.quality = "gap"; value.capture.last = nil
                try saveCapture()
            }
        } else {
            guard !requireLedger else { throw MileageFailure.message("Missing mileage ledger; recovery blocked") }
            try migrateLegacy()
        }
        // Replay a deletion whose barrier committed before its ledger save.
        for id in try deletedIDs() { try retireDeletedTrip(id) }
        try save()
    }
    private func compactCheckpoint() -> Checkpoint {
        var capture = value.capture; capture.samples = []
        return Checkpoint(owner:owner,enabled:true,sequence:sequence,capture:capture)
    }
    private func append(_ samples: [MileageSample], journalID: String, after: Data?) throws {
        let encoded = try samples.map { ($0.received,try Self.encode($0)) }
        sequence = try database.write { db in
            var last: Int64 = 0
            for (received,body) in encoded {
                try db.execute(sql:"INSERT INTO sample_journal(journal_id,received,body,after_state) VALUES(?,?,?,?)",arguments:[journalID,received,body,after])
                last = db.lastInsertedRowID
            }
            return last
        }
    }
    /// Production location entry: bounded state and one journal row per new fix. The two commits
    /// deliberately expose the crash boundary; replay uses the durable after-state, not distance
    /// recomputation, and clears its anchor before accepting another fix.
    func record(_ fix: CLLocation, received: Date, automotive: Bool, nonAutomotive: Bool) throws {
        guard value.capture.samples.isEmpty else { try saveCapture(); return try record(fix,received:received,automotive:automotive,nonAutomotive:nonAutomotive) }
        if value.capture.journalID == nil { value.capture.journalID = UUID().uuidString }
        MileageDetector.accept(fix,received:received,automotive:automotive,nonAutomotive:nonAutomotive,state:&value.capture)
        value.capture.sampleCount = (value.capture.sampleCount ?? 0) + value.capture.samples.count
        let samples = value.capture.samples
        let after = try Self.encode(compactCheckpoint())
        try append(samples,journalID:value.capture.journalID!,after:after)
        value.capture.samples = []
        #if DEBUG && targetEnvironment(simulator)
        if failCheckpointAfterNextSample && MileageModel.testMode {
            failCheckpointAfterNextSample = false
            throw InjectedCheckpointFailure.expected
        }
        #endif
        try saveCapture()
    }
    private func flushCaptureSamples() throws {
        // Direct detector fixtures and migration may supply a batch. A batch commits atomically,
        // so its after-state can never refer to only partially persisted sample evidence.
        if !value.capture.samples.isEmpty {
            if value.capture.journalID == nil { value.capture.journalID = UUID().uuidString }
            if value.capture.first == nil { value.capture.first = value.capture.samples.first(where: \.accepted) }
            if value.capture.latest == nil { value.capture.latest = value.capture.samples.last(where: \.accepted) }
            value.capture.sampleCount = (value.capture.sampleCount ?? 0) + value.capture.samples.count
            try append(value.capture.samples,journalID:value.capture.journalID!,after:Self.encode(compactCheckpoint()))
            value.capture.samples = []
        }
    }
    func saveCapture() throws {
        try flushCaptureSamples()
        let body = try Self.encode(compactCheckpoint())
        try database.write { db in
            try db.execute(sql:"INSERT OR REPLACE INTO checkpoint(id,body) VALUES(1,?)",arguments:[body])
        }
    }
    /// Revoke confirmation before gap finalization. This small transaction is independent of
    /// checkpoint/outbox saving, so a failed finalization cannot retain a confirmed ledger.
    func revokeConfirmation() throws {
        value.syncCursor = nil
        try database.write { db in
            guard let body = try Data.fetchOne(db, sql: "SELECT body FROM ledger WHERE id=1") else {
                throw MileageFailure.message("Missing mileage ledger; confirmation could not be revoked")
            }
            var ledger = try JSONDecoder().decode(MileageSnapshot.self, from: body)
            guard ledger.owner == owner else { throw MileageFailure.message("Confirmation owner mismatch") }
            ledger.syncCursor = nil; ledger.enabled = true
            try db.execute(sql: "UPDATE ledger SET body=? WHERE id=1", arguments: [try Self.encode(ledger)])
        }
    }
    /// Ledger/outbox writes occur only for ledger actions, migration, sync and finalization.
    func save() throws {
        for id in try deletedIDs() { try retireDeletedTrip(id) }
        try flushCaptureSamples()
        for index in value.evidence.indices where !value.evidence[index].samples.isEmpty {
            let id = value.evidence[index].journalID ?? UUID().uuidString
            try append(value.evidence[index].samples,journalID:id,after:nil)
            value.evidence[index].journalID = id; value.evidence[index].samples = []
        }
        var ledger = value; ledger.capture = MileageCaptureState(); ledger.enabled = true
        let body = try Self.encode(ledger)
        let checkpoint = try Self.encode(compactCheckpoint())
        let pending = try value.pending.map { trip -> (String,Data,Data?) in
            let measurement = try Self.encode(MileageMeasurement(trip))
            var manual: Data?
            if trip.source == "manual" {
                var object = try JSONSerialization.jsonObject(with:measurement) as! [String:Any]
                object["purpose"] = trip.purpose; object["treatment"] = "needs_review"; object["idempotency_key"] = trip.id
                manual = try JSONSerialization.data(withJSONObject:object,options:.sortedKeys)
            }
            return (trip.id,measurement,manual)
        }
        let ids = Set(value.pending.map(\.id))
        try database.write { db in
            try queueRoutes(in: db)
            #if DEBUG
            if failNextSaveBeforeLedger {
                failNextSaveBeforeLedger = false
                throw InjectedSaveFailure.expected
            }
            #endif
            for (id,measurement,manual) in pending {
                // Never UPDATE: an already queued UUID's bytes remain exactly as first committed.
                try db.execute(sql:"INSERT OR IGNORE INTO outbox(id,measurement,manual) VALUES(?,?,?)",arguments:[id,measurement,manual])
            }
            for id in try String.fetchAll(db,sql:"SELECT id FROM outbox") where !ids.contains(id) {
                try db.execute(sql:"DELETE FROM outbox WHERE id=?",arguments:[id])
            }
            try db.execute(sql:"INSERT OR REPLACE INTO ledger(id,body) VALUES(1,?)",arguments:[body])
            try db.execute(sql:"INSERT OR REPLACE INTO checkpoint(id,body) VALUES(1,?)",arguments:[checkpoint])
        }
    }
    func measurementBytes(for id: String) throws -> Data {
        guard let data = try database.read({ try Data.fetchOne($0,sql:"SELECT measurement FROM outbox WHERE id=?",arguments:[id]) }) else {
            throw MileageFailure.message("Pending measurement is not durably queued")
        }
        return data
    }
    /// LATE-START LB11, the one exception to "never UPDATE": the server refused this trip's start estimate
    /// (`INVALID_START_ESTIMATE`), so it stored nothing under the id. The estimate goes and the trip's
    /// measurement is frozen again without it; every other field is the pending original's.
    func dropStartEstimate(_ id: String) throws {
        guard let index = value.pending.firstIndex(where: { $0.id == id }), value.pending[index].start_estimate != nil else { return }
        value.pending[index].start_estimate = nil
        if let trip = value.trips.firstIndex(where: { $0.id == id }) { value.trips[trip].start_estimate = nil }
        let measurement = try Self.encode(MileageMeasurement(value.pending[index]))
        try database.write { try $0.execute(sql:"UPDATE outbox SET measurement=? WHERE id=?",arguments:[measurement,id]) }
        try save()
    }
    func manualBytes(for id: String) throws -> Data {
        guard let data = try database.read({ try Data.fetchOne($0,sql:"SELECT manual FROM outbox WHERE id=?",arguments:[id]) }) else {
            throw MileageFailure.message("Manual measurement is not durably queued")
        }
        return data
    }
    #if DEBUG && targetEnvironment(simulator)
    func diagnosticBackup(to destination: URL) throws {
        guard MileageModel.testMode, destination.deletingLastPathComponent() == root.deletingLastPathComponent(),
              destination.lastPathComponent.hasPrefix("long-capture-") else { throw MileageFailure.message("Isolated diagnostic export only") }
        if FileManager.default.fileExists(atPath:destination.path) { try FileManager.default.removeItem(at:destination) }
        try database.writeWithoutTransaction { try $0.execute(sql:"VACUUM INTO ?",arguments:[destination.path]) }
    }
    func maximumJournalRecordBytes() throws -> Int {
        try database.read { try Int.fetchOne($0,sql:"SELECT MAX(length(body)+COALESCE(length(after_state),0)) FROM sample_journal") ?? 0 }
    }
    #endif
    func checkpointBytes() throws -> Data {
        try database.read { try Data.fetchOne($0,sql:"SELECT body FROM checkpoint WHERE id=1") ?? Data() }
    }
    func ledgerBytes() throws -> Data {
        try database.read { try Data.fetchOne($0,sql:"SELECT body FROM ledger WHERE id=1") ?? Data() }
    }
    func readSamples(journalID: String) throws -> [MileageSample] {
        try database.read { db in
            try Data.fetchAll(db,sql:"SELECT body FROM sample_journal WHERE journal_id=? ORDER BY seq",arguments:[journalID])
                .map { try JSONDecoder().decode(MileageSample.self,from:$0) }
        }
    }
    func prune(now: Double) {
        let routes = (try? database.read { Set(try String.fetchAll($0,sql:"SELECT DISTINCT trip_id FROM route_outbox WHERE acknowledged=0")) }) ?? Set(value.evidence.map(\.tripID))
        let pending = Set(value.pending.map(\.id)).union(value.conflicts).union(routes)
        value.evidence.removeAll {
            guard !$0.unresolved && !pending.contains($0.tripID) && now-$0.ended > 30*86400 else { return false }
            do {
                if let journal = $0.journalID {
                    try database.write { try $0.execute(sql:"DELETE FROM sample_journal WHERE journal_id=?",arguments:[journal]) }
                }
                return true
            } catch { return false }
        }
        // Expired abandoned candidates have no finalized evidence record. Retain every active,
        // pending or unresolved journal; purge only unreferenced old rows and checkpoint the WAL.
        let retained = Set(value.evidence.compactMap(\.journalID)).union([value.capture.journalID].compactMap { $0 })
        do {
            let old = try database.read { try String.fetchAll($0,sql:"SELECT DISTINCT journal_id FROM sample_journal WHERE received<?",arguments:[now-30*86400]) }
            for journal in old where !retained.contains(journal) {
                try database.write { try $0.execute(sql:"DELETE FROM sample_journal WHERE journal_id=? AND received<?",arguments:[journal,now-30*86400]) }
            }
            if !old.isEmpty { try database.writeWithoutTransaction { try $0.execute(sql:"PRAGMA wal_checkpoint(TRUNCATE)") } }
        } catch { /* Keep unreadable evidence for a later cleanup attempt. */ }
    }
    struct RouteChunk {
        let tripID: String
        let index: Int
        let count: Int
        let pointCount: Int
        let body: Data
    }
    private struct RoutePoint: Encodable {
        let timestamp: Double; let received_at: Double
        let latitude: Double; let longitude: Double; let horizontal_accuracy: Double; let speed: Double
        let accepted: Bool; let reason: String
        init(_ sample: MileageSample) {
            timestamp = sample.time * 1000; received_at = sample.received * 1000
            latitude = sample.latitude; longitude = sample.longitude
            horizontal_accuracy = sample.accuracy; speed = sample.speed
            accepted = sample.accepted; reason = sample.reason
        }
    }
    private struct RouteBody: Encodable {
        let device_id: String; let chunk_index: Int; let chunk_count: Int; let points: [RoutePoint]
    }
    /// Freeze every journal point, including rejected/cached observations, in immutable chunks.
    /// Summary ACK never changes the separately persisted route payload or its retry identity.
    private func queueRoutes(in db: Database) throws {
        let deleted = Set(try String.fetchAll(db,sql:"SELECT trip_id FROM deleted_trips"))
        for evidence in value.evidence where !deleted.contains(evidence.tripID) {
            guard value.trips.contains(where: { $0.id == evidence.tripID && $0.source == "gps" && $0.deleted_at == nil }), let journal = evidence.journalID else { continue }
            if try Bool.fetchOne(db,sql:"SELECT EXISTS(SELECT 1 FROM route_outbox WHERE trip_id=?)",arguments:[evidence.tripID]) == true { continue }
            let sampleCount = try Int.fetchOne(db,sql:"SELECT COUNT(*) FROM sample_journal WHERE journal_id=?",arguments:[journal]) ?? 0
            guard sampleCount > 0 else { continue }
            let count = (sampleCount + 999) / 1000
            guard count <= 1000 else { throw MileageFailure.message("Route exceeds the supported 1,000,000-point limit; local evidence retained") }
            var sequence: Int64 = 0
            for index in 0..<count {
                // Bounded pages avoid materializing the full GPS track to freeze its chunks.
                let rows = try Row.fetchAll(db,sql:"SELECT seq,body FROM sample_journal WHERE journal_id=? AND seq>? ORDER BY seq LIMIT 1000",arguments:[journal,sequence])
                let points = try rows.map { row -> RoutePoint in
                    sequence = row["seq"]
                    return RoutePoint(try JSONDecoder().decode(MileageSample.self,from:row["body"]))
                }
                let body = try Self.encode(RouteBody(device_id:value.deviceID,chunk_index:index,chunk_count:count,points:points))
                try db.execute(sql:"INSERT INTO route_outbox(trip_id,chunk_index,chunk_count,point_count,body,acknowledged) VALUES(?,?,?,?,?,0)",arguments:[evidence.tripID,index,count,points.count,body])
            }
        }
    }
    private func deletedIDs() throws -> Set<String> {
        try database.read { Set(try String.fetchAll($0,sql:"SELECT trip_id FROM deleted_trips")) }
    }
    func pendingUploadCount() throws -> Int { try unsyncedTripIDs().count }
    /// Trips whose summary or any route chunk the server has not acknowledged yet.
    func unsyncedTripIDs() throws -> Set<String> {
        let routeIDs = try database.read { Set(try String.fetchAll($0,sql:"SELECT DISTINCT trip_id FROM route_outbox WHERE acknowledged=0")) }
        return routeIDs.union(value.pending.map(\.id))
    }
    func routeChunksReady(limit: Int = 1) throws -> [RouteChunk] {
        let blocked = Set(value.pending.map(\.id)).union(value.conflicts).union(try deletedIDs())
        let eligible = Set(value.trips.filter { $0.source == "gps" && $0.deleted_at == nil }.map(\.id)).subtracting(blocked)
        return try database.read { db in
            let cursor = try Row.fetchCursor(db,sql:"SELECT trip_id,chunk_index,chunk_count,point_count,body FROM route_outbox WHERE acknowledged=0 ORDER BY trip_id,chunk_index")
            var chunks: [RouteChunk] = []
            while let row = try cursor.next(), chunks.count < max(1,limit) {
                let id: String = row["trip_id"]
                guard eligible.contains(id) else { continue }
                chunks.append(RouteChunk(tripID:id,index:row["chunk_index"],count:row["chunk_count"],pointCount:row["point_count"],body:row["body"]))
            }
            return chunks
        }
    }
    func acknowledgeRoute(tripID: String, chunkIndex: Int) throws {
        try database.write { try $0.execute(sql:"UPDATE route_outbox SET acknowledged=1,body=NULL WHERE trip_id=? AND chunk_index=?",arguments:[tripID,chunkIndex]) }
    }
    /// Durable deletion barrier wins over both immutable outboxes and adoption replay.
    func retireDeletedTrip(_ id: String) throws {
        let journals = value.evidence.filter { $0.tripID == id }.compactMap(\.journalID)
        try database.write { db in
            try db.execute(sql:"INSERT OR IGNORE INTO deleted_trips(trip_id) VALUES(?)",arguments:[id])
            try db.execute(sql:"DELETE FROM route_outbox WHERE trip_id=?",arguments:[id])
            try db.execute(sql:"DELETE FROM outbox WHERE id=?",arguments:[id])
            for journal in journals { try db.execute(sql:"DELETE FROM sample_journal WHERE journal_id=?",arguments:[journal]) }
        }
        value.pending.removeAll { $0.id == id }; value.conflicts.removeAll { $0 == id }
        value.evidence.removeAll { $0.tripID == id }
        value.addresses?[id] = nil
        if let index = value.trips.firstIndex(where: { $0.id == id }) { value.trips[index].deleted_at = value.trips[index].deleted_at ?? Date().milliseconds }
    }
    /// Called only after /auth/me and mileage membership succeed. The offline namespace is
    /// unowned until this exact verified origin/account adopts it; another login cannot claim it.
    @discardableResult func adoptPilot(_ pilot: MileageStore, verifiedHost: URL, verifiedEmail: String) throws -> Bool {
        guard MileageIdentity.canAdoptPilot(host:verifiedHost,email:verifiedEmail),
              owner == MileageIdentity.key(host:verifiedHost,email:verifiedEmail), pilot.owner == OfflinePilot.owner else { return false }
        let claim = try pilot.database.read { try String.fetchOne($0,sql:"SELECT destination_owner FROM pilot_adoption WHERE id=1") }
        guard claim == nil || claim == owner else { throw MileageFailure.message("Offline pilot is already bound to another account") }
        if pilot.value.capture.tripID != nil {
            pilot.value.capture.quality = "gap"
            if let (trip,evidence) = MileageDetector.finalize(&pilot.value.capture,now:Date().timeIntervalSince1970) {
                pilot.value.evidence.append(evidence)
                if trip.ended_at > trip.started_at { pilot.value.trips.append(trip); pilot.value.pending.append(trip) }
            }
        }
        try pilot.save()
        let receipts = try database.read { Set(try String.fetchAll($0,sql:"SELECT trip_id FROM adopted_pilot_trips")) }
        let deleted = try deletedIDs()
        for trip in pilot.value.trips where !receipts.contains(trip.id) && !deleted.contains(trip.id) {
            // A pre-existing account UUID always wins, especially its reviewed/deleted state.
            if value.trips.contains(where: { $0.id == trip.id }) { continue }
            let measurement = try pilot.measurementBytes(for:trip.id)
            let sourceEvidence = pilot.value.evidence.first { $0.tripID == trip.id }
            let journal = "adopted-pilot-" + trip.id
            // Destination receipt, immutable source bytes and every sample commit together.
            // A process death before ledger save is replayable; receipt is checked against ledger below.
            try database.write { db in
                try db.execute(sql:"DELETE FROM sample_journal WHERE journal_id=?",arguments:[journal])
                if let sourceJournal = sourceEvidence?.journalID {
                    var afterSequence: Int64 = 0
                    while true {
                        let rows = try pilot.database.read { try Row.fetchAll($0,sql:"SELECT seq,received,body FROM sample_journal WHERE journal_id=? AND seq>? ORDER BY seq LIMIT 1000",arguments:[sourceJournal,afterSequence]) }
                        if rows.isEmpty { break }
                        for row in rows {
                            afterSequence = row["seq"]
                            let received: Double = row["received"]; let body: Data = row["body"]
                            try db.execute(sql:"INSERT INTO sample_journal(journal_id,received,body) VALUES(?,?,?)",arguments:[journal,received,body])
                        }
                    }
                }
                try db.execute(sql:"INSERT OR IGNORE INTO outbox(id,measurement,manual) VALUES(?,?,NULL)",arguments:[trip.id,measurement])
            }
            value.trips.append(trip); value.pending.append(trip)
            if let evidence = sourceEvidence { value.evidence.append(MileageEvidence(tripID:trip.id,ended:evidence.ended,unresolved:evidence.unresolved,samples:[],journalID:journal)) }
        }
        try save()
        // The durable destination ledger is the authority. Receipt survives server deletion;
        // source claim is written last, so either side of a crash retries only this owner.
        try database.write { db in
            for trip in pilot.value.trips { try db.execute(sql:"INSERT OR IGNORE INTO adopted_pilot_trips(trip_id) VALUES(?)",arguments:[trip.id]) }
        }
        try pilot.database.write { try $0.execute(sql:"INSERT OR IGNORE INTO pilot_adoption(id,destination_owner) VALUES(1,?)",arguments:[owner]) }
        return true
    }
    private func migrateLegacy() throws {
        let legacy = root.appendingPathComponent(owner + ".json")
        var legacyFiles: [URL] = []
        if FileManager.default.fileExists(atPath:legacy.path) {
            value = try JSONDecoder().decode(MileageSnapshot.self,from:Data(contentsOf:legacy))
            value.enabled = true
            guard value.owner == owner else { throw MileageFailure.message("Legacy owner mismatch") }
            legacyFiles.append(legacy)
            for index in value.evidence.indices {
                let file = root.appendingPathComponent(owner + "-evidence").appendingPathComponent(value.evidence[index].tripID + ".json")
                if FileManager.default.fileExists(atPath:file.path) {
                    let evidence = try JSONDecoder().decode(MileageEvidence.self,from:Data(contentsOf:file))
                    value.evidence[index].samples = evidence.samples
                    legacyFiles.append(file)
                }
            }
        }
        // No endpoint enrichment of pending UUIDs. Optional fields simply decode as absent.
        try save()
        // The database is now authoritative. Delete only files copied successfully above.
        for file in legacyFiles { try FileManager.default.removeItem(at:file) }
    }
}
