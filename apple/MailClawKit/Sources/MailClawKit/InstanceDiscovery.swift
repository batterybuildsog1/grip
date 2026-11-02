import Foundation
import CryptoKit

/// Discovery is used for explicit sign-in only. Bearers and saved sessions never reach a directory.
/// The signed envelope's exact bytes are cached and reverified with the app's pinned Ed25519 key.
public actor InstanceDiscovery {
    public static let shared = InstanceDiscovery()
    public static let directoryURL = ServerConfig.configuredURL("GripDirectoryURL", fallback: "https://directory.grip.invalid/lookup")
    /// Distribution pins are signed-bundle metadata, never fetched from the directory.
    public static let publicKeys: [String: String] = {
        guard let text = Bundle.main.object(forInfoDictionaryKey: "GripDirectoryPublicKeys") as? String,
              let data = text.data(using: .utf8),
              let keys = try? JSONDecoder().decode([String: String].self, from: data),
              !keys.isEmpty, keys.values.allSatisfy({ Data(base64Encoded: $0)?.count == 32 })
        else { return [:] }
        return keys
    }()

    public struct Result: Sendable {
        public let origin: URL
        /// Directory authenticates exact-address lookups, returning that same login response once.
        let login: Data?
    }
    struct Envelope: Codable, Sendable { let payload: String; let signature: String }
    struct Route: Decodable {
        let version: Int; let subject: String; let api_origin: String
        let issued_at: Double; let expires_at: Double; let key_id: String
    }
    struct CacheEntry: Codable { let envelope: Envelope?; let origin: String; let fetched: Double }
    private let cacheURL: URL?
    private let keys: [String: String]
    private let directory: URL
    private let transport: HTTPTransport
    private var cache: [String: CacheEntry] = [:]

    public init(cacheURL: URL? = nil, keys: [String: String] = InstanceDiscovery.publicKeys,
                directory: URL = InstanceDiscovery.directoryURL) {
        self.init(cacheURL: cacheURL, keys: keys, directory: directory, transport: HTTPTransport())
    }
    // Internal transport seam for the standalone E2E; official clients always use the initializer above.
    init(cacheURL: URL?, keys: [String: String], directory: URL, transport: HTTPTransport) {
        self.transport = transport
        self.keys = keys
        self.directory = directory
        self.cacheURL = cacheURL ?? FileManager.default.urls(for: .applicationSupportDirectory,
            in: .userDomainMask).first?.appendingPathComponent("Grip/discovery-v1.json")
        if let url = self.cacheURL, let data = try? Data(contentsOf: url), data.count <= 262144,
           let stored = try? JSONDecoder().decode([String: CacheEntry].self, from: data) { cache = stored }
    }

    static func normalized(_ email: String) throws -> String {
        let s = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = s.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, s.utf8.count <= 254, !parts[0].isEmpty,
              parts[0].allSatisfy({ $0.isASCII && !$0.isWhitespace && !$0.isNewline }),
              parts[0].range(of: #"^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$"#, options: .regularExpression) != nil,
              (validHost(String(parts[1])) || parts[1] == ServerConfig.demoDomain) else { throw APIError.rejected("Invalid email address") }
        return s
    }
    static func validHost(_ host: String) -> Bool {
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        return host.utf8.count <= 253 && labels.count >= 2 &&
            labels.allSatisfy { $0.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#,
                                        options: .regularExpression) != nil } &&
            host.range(of: #"^[0-9.]+$"#, options: .regularExpression) == nil &&
            !["localhost", "local", "internal", "test", "invalid", "example", "onion"].contains(String(labels.last!))
    }
    /// JSONDecoder accepts duplicate keys; reject ambiguous publisher/signer documents first.
    static func uniqueKeys(_ data: Data) -> Bool {
        let bytes = Array(data)
        var objects: [Set<String>] = []
        var i = 0
        while i < bytes.count {
            if bytes[i] == 123 { objects.append([]) }
            else if bytes[i] == 125 { if !objects.isEmpty { objects.removeLast() } }
            else if bytes[i] == 34 {
                let start = i
                i += 1
                while i < bytes.count {
                    if bytes[i] == 92 { i += 2; continue }
                    if bytes[i] == 34 { break }
                    i += 1
                }
                guard i < bytes.count else { return false }
                var next = i + 1
                while next < bytes.count && [9, 10, 13, 32].contains(bytes[next]) { next += 1 }
                if next < bytes.count && bytes[next] == 58 {
                    guard !objects.isEmpty,
                          let names = try? JSONSerialization.jsonObject(with: Data([91] + bytes[start...i] + [93])) as? [String],
                          let name = names.first,
                          objects[objects.count - 1].insert(name).inserted else { return false }
                }
            }
            i += 1
        }
        return true
    }
    static func validatedOrigin(_ text: String) throws -> URL {
        guard let u = URL(string: text), let h = u.host, validHost(h),
              u.port == nil || u.port == 443 else { throw APIError.rejected("Invalid discovery server") }
        return try ServerEndpoint.validate(u)
    }
    private func verified(_ envelope: Envelope, subject: String, now: Date) throws -> (URL, Double) {
        guard let payload = Data(base64Encoded: envelope.payload), payload.count <= 4096,
              let signature = Data(base64Encoded: envelope.signature), signature.count == 64,
              Self.uniqueKeys(payload),
              let route = try? JSONDecoder().decode(Route.self, from: payload),
              route.version == 1, route.subject == subject,
              let pin = keys[route.key_id], let keyBytes = Data(base64Encoded: pin),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes),
              key.isValidSignature(signature, for: payload),
              route.issued_at <= now.timeIntervalSince1970 + 60,
              route.issued_at <= route.expires_at,
              route.expires_at - route.issued_at <= 86400,
              route.expires_at > now.timeIntervalSince1970 else {
            throw APIError.rejected("Couldn't verify Grip discovery")
        }
        return (try Self.validatedOrigin(route.api_origin), route.expires_at)
    }
    private func cached(_ s: String, now: Date, fresh: Bool) -> URL? {
        guard let entry = cache[s], entry.fetched <= now.timeIntervalSince1970,
              now.timeIntervalSince1970 - entry.fetched < (fresh ? 3600 : 86400) else { return nil }
        if let envelope = entry.envelope {
            return try? verified(envelope, subject: s, now: now).0
        }
        guard !["gmail.com", "googlemail.com"].contains(String(s.split(separator: "@").last ?? "")) else { return nil }
        return try? Self.validatedOrigin(entry.origin)
    }
    private func save(_ s: String, origin: URL, envelope: Envelope?, now: Date) {
        // Bound persisted metadata. No passwords or session tokens are saved here.
        if cache.count >= 256 { cache.removeAll() }
        cache[s] = CacheEntry(envelope: envelope, origin: origin.absoluteString, fetched: now.timeIntervalSince1970)
        guard let url = cacheURL else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let bytes = try? JSONEncoder().encode(cache) {
            try? bytes.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }
    private func invalidate(_ s: String) {
        cache.removeValue(forKey: s)
        if let url = cacheURL, let data = try? JSONEncoder().encode(cache) { try? data.write(to: url, options: .atomic) }
    }

    public func resolve(email: String, password: String, now: Date = Date()) async throws -> Result {
        let s = try Self.normalized(email)
        let fixed = ServerConfig.origin(forEmail: s)
        if fixed != ServerConfig.discoveryRequired { return Result(origin: fixed, login: nil) }
        if let hit = cached(s, now: now, fresh: true) { return Result(origin: hit, login: nil) }
        let domain = String(s.split(separator: "@")[1])
        // gmail.com cannot authorize any customer's whole domain. Owned domains bypass our service.
        if !["gmail.com", "googlemail.com"].contains(domain) {
            var request = URLRequest(url: URL(string: "https://\(domain)/.well-known/grip.json")!)
            request.timeoutInterval = 5
            do {
                // Only a valid manifest is authoritative. Anything else (a redirect, which is never
                // followed; a site's HTML page for every path; 401/403/404/5xx; malformed JSON) means
                // the domain publishes no Grip file, and the signed directory decides.
                let (data, http) = try await transport.boundedExchange(request, maximum: 4096, bodyForStatuses: [200])
                struct Manifest: Decodable { let version: Int; let domain: String; let api_origin: String }
                if http.statusCode == 200, http.mimeType == "application/json", Self.uniqueKeys(data),
                   let m = try? JSONDecoder().decode(Manifest.self, from: data),
                   m.version == 1, m.domain == domain,
                   let origin = try? Self.validatedOrigin(m.api_origin) {
                    save(s, origin: origin, envelope: nil, now: now)
                    return Result(origin: origin, login: nil)
                }
            } catch APIError.offline {
                if let hit = cached(s, now: now, fresh: false) { return Result(origin: hit, login: nil) }
            } catch APIError.rejected {
                // A page over the manifest cap or a broken TLS answer is no manifest either.
            } catch { invalidate(s); throw error }
        }
        var request = URLRequest(url: directory)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The Grip app password (never Google's app password) authorizes an exact-address answer.
        request.httpBody = try JSONEncoder().encode(["subject": s, "password": password])
        do {
            let (data, http) = try await transport.boundedExchange(request, maximum: 16384, bodyForStatuses: [200])
            if http.statusCode >= 500, let hit = cached(s, now: now, fresh: false) {
                return Result(origin: hit, login: nil)
            }
            guard http.statusCode == 200, http.mimeType == "application/json", Self.uniqueKeys(data),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let route = object["route"] else { throw APIError.rejected("Couldn't sign in to Grip") }
            let envelope = try JSONDecoder().decode(Envelope.self, from: JSONSerialization.data(withJSONObject: route))
            let (origin, _) = try verified(envelope, subject: s, now: now)
            let login = try object["login"].map { try JSONSerialization.data(withJSONObject: $0) }
            save(s, origin: origin, envelope: envelope, now: now)
            return Result(origin: origin, login: login)
        } catch APIError.offline {
            if let hit = cached(s, now: now, fresh: false) { return Result(origin: hit, login: nil) }
            throw APIError.offline
        } catch { invalidate(s); throw error }
    }
}
