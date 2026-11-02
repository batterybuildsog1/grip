import Foundation
import MailClawKit
import Security

/// Mileage's view of the app's one session (AppModel): its server and bearer (never readable here),
/// who signed in, and until when. Mileage keeps no credential of its own.
struct MileageSession: Sendable {
    let credentials: Credentials
    let email: String
    let expires: Int64
    var host: URL { credentials.baseURL }
    var owner: String { MileageIdentity.key(host: host, email: email) }
}

/// Mileage's own Keychain item from builds before 1.0, when it had its own sign-in: a bearer that
/// nothing reads any more. Release deletes it at launch (Debug builds leave it: on a Mac they would
/// reach the installed app's item).
enum MileageLegacyCredential {
    static func delete() {
        #if !DEBUG
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "io.examplebusiness.mailclaw.mileage", kSecAttrAccount as String: "app-session"]
        SecItemDelete(query as CFDictionary)
        #endif
    }
}

/// Mileage endpoints only, plus `/api/auth/me` (sync checks who the session is), on the session's
/// own origin: `Credentials.authorize` adds the bearer only there, over HTTPS (Debug: loopback HTTP).
/// Never reads DeveloperConfig. Refuses redirects and cookies.
final class MileageAPI: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    struct Envelope<T: Decodable>: Decodable { let success: Bool; let data: T?; let error: Failure? }
    struct Failure: Decodable { let code: String; let message: String }
    struct ACK: Decodable { let id: String; let revision: Int }
    struct Conflict: Decodable { let id: String; let code: String? }
    struct Sync: Decodable {
        let accepted: [ACK]; let conflicts: [Conflict]; let trips: [MileageTrip]; let cursor: String?; let has_more: Bool?
        var deletedIDs: Set<String> { Set(conflicts.filter { $0.code == "TRIP_DELETED" }.map(\.id)) }
    }
    struct Empty: Decodable {}
    struct RouteACK: Decodable {
        let trip_id: String; let chunk_index: Int; let chunk_count: Int; let point_count: Int; let complete: Bool
    }
    static func uploadData(deviceID: String, measurements: [Data], cursor: String?) throws -> Data {
        // Embed the already committed object bytes verbatim; never re-encode a pending UUID.
        var data = Data("{\"device_id\":".utf8)
        data.append(try JSONEncoder().encode(deviceID)); data.append(Data(",\"trips\":[".utf8))
        for (index, measurement) in measurements.enumerated() {
            if index > 0 { data.append(44) }; data.append(measurement)
        }
        data.append(Data("],\"cursor\":".utf8)); data.append(try JSONEncoder().encode(cursor))
        data.append(125); return data
    }
    /// This iPhone's Apple addresses for a drive's ends (owner only; last write wins).
    struct Addresses: Encodable { let start: MileageAddress?; let end: MileageAddress? }
    struct AddressesSaved: Decodable { let trip_id: String }
    struct Delete: Encodable { let expected_revision: Int; let idempotency_key: String }
    struct Places: Decodable { let places: [MileagePlace] }
    /// Names one end of a stored drive; the server reads the endpoint itself.
    struct NamePlace: Encodable { let name: String; let trip_id: String; let end: String; let idempotency_key: String }
    struct RenamePlace: Encodable { let name: String; let idempotency_key: String }
    struct Deleted: Decodable { let id: String }
    /// One page of the owner-only synced route; rejected fixes are never drawn.
    struct RoutePage: Decodable {
        /// `timestamp` in epoch ms; a phone's fixes carry fractions of a millisecond.
        struct Point: Decodable { let latitude: Double; let longitude: Double; let accepted: Bool?; let timestamp: Double? }
        let points: [Point]
        let next_cursor: String?
    }

    private let credentials: Credentials
    private var host: URL { credentials.baseURL }
    /// Which session this client signs with (a hash, never the token): a 401 ends only that one.
    var identity: String { credentials.identityTag }
    init(credentials: Credentials) {
        self.credentials = credentials
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }

    func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        guard !OfflinePilot.enabled else { throw MileageFailure.message("Offline pilot cannot access a backend") }
        guard path.hasPrefix("/api/mileage/") || path == "/api/auth/me" else {
            throw MileageFailure.message("Mileage cannot write to the mail API")
        }
        var request = try signed(path)
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20; configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw MileageFailure.message("Missing API response") }
        let envelope: Envelope<T>?
        do {
            envelope = try JSONDecoder().decode(Envelope<T>.self, from: data)
        } catch {
            // A success this app can't read is not "offline": say so (apple-r1-08).
            if (200..<300).contains(http.statusCode) { throw MileageFailure.unreadable(Self.field(error)) }
            envelope = nil
        }
        guard (200..<300).contains(http.statusCode), envelope?.success == true, let result = envelope?.data else {
            if envelope?.error?.code == "TRIP_DELETED" { throw MileageFailure.tripDeleted }
            // A person's session is refused only when they aren't a Mileage owner (src/mileage/auth.ts).
            if http.statusCode == 403, envelope?.error?.code == "FORBIDDEN" { throw MileageFailure.notOwner }
            if envelope?.error?.code == "MILEAGE_UNAVAILABLE" { throw MileageFailure.unavailable }
            if envelope?.error?.code == "INVALID_START_ESTIMATE" { throw MileageFailure.invalidStartEstimate }
            throw MileageFailure.server(http.statusCode, envelope?.error?.message ?? "Mileage server unavailable",
                http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init))
        }
        return result
    }
    /// Where a decode failed, for the log: "data.trips.3.gap.meters: null".
    static func field(_ error: Error) -> String {
        guard let error = error as? DecodingError else { return error.localizedDescription }
        let path: (DecodingError.Context) -> String = { context in
            context.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
        }
        switch error {
        case let .valueNotFound(_, context): return path(context) + ": null"
        case let .keyNotFound(key, context): return (path(context) + "." + key.stringValue) + ": missing"
        case let .typeMismatch(_, context): return path(context) + ": " + context.debugDescription
        case let .dataCorrupted(context): return path(context) + ": " + context.debugDescription
        @unknown default: return error.localizedDescription
        }
    }
    /// A file the server sends as itself, not in the JSON envelope (`GET /exports`): its bytes and
    /// the name in its Content-Disposition.
    func download(_ path: String) async throws -> (data: Data, filename: String) {
        guard !OfflinePilot.enabled, path.hasPrefix("/api/mileage/exports") else {
            throw MileageFailure.message("Mileage downloads only exports")
        }
        let request = try signed(path)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 60; configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw MileageFailure.message("Missing API response") }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? JSONDecoder().decode(Envelope<Empty>.self, from: data)
            throw MileageFailure.server(http.statusCode, envelope?.error?.message ?? "Export failed", nil)
        }
        let disposition = http.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let name = disposition.components(separatedBy: "filename=").last?
            .trimmingCharacters(in: CharacterSet(charactersIn: "\" ;")) ?? ""
        return (data, name.isEmpty || !disposition.contains("filename=") ? "mileage.csv" : name)
    }
    /// A request for `path` on the session's origin, carrying its bearer.
    private func signed(_ path: String) throws -> URLRequest {
        let base = host.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base + path) else { throw MileageFailure.message("Invalid API address") }
        var request = URLRequest(url: url)
        do { try credentials.authorize(&request) } catch { throw MileageFailure.message("Mileage needs the HTTPS server you signed in to") }
        return request
    }
}
