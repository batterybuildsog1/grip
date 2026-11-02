import Foundation
import Security
import LocalAuthentication

public struct AppSession: Codable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
 public let baseURL: URL
 public let email: String
 public let expiresAt: Date
 private let token: String
 /// Debug builds only: the session lives on a loopback test server (`ServerEndpoint`).
 let allowInsecureLoopback: Bool
 public init(baseURL:URL,email:String,token:String,expiresAt:Date,allowInsecureLoopback:Bool = false) throws {
  self.baseURL = try ServerEndpoint.validate(baseURL,allowInsecureLoopback:allowInsecureLoopback)
  self.email = email.trimmingCharacters(in:.whitespacesAndNewlines).lowercased()
  guard !self.email.isEmpty, !token.isEmpty else { throw APIError.decoding("Invalid session") }
  self.token = token
  self.expiresAt = expiresAt
  self.allowInsecureLoopback = allowInsecureLoopback
 }
 public var isValid: Bool { expiresAt > Date() && !token.isEmpty && (try? ServerEndpoint.validate(baseURL,allowInsecureLoopback:allowInsecureLoopback)) != nil }
 public var credentials: Credentials { Credentials(baseURL:baseURL,bearer:token,allowInsecureLoopback:allowInsecureLoopback) }
 public var cacheIdentity: String { baseURL.absoluteString + " " + email }
 public var description: String { "AppSession(\(baseURL.host() ?? "?"), token: <redacted>)" }
 public var debugDescription: String { description }
 public var customMirror: Mirror { Mirror(self,children:["baseURL":baseURL,"expiresAt":expiresAt]) }
}

/// Where the one app session is kept between launches.
public protocol SessionStore: Sendable {
 func loadSession() -> AppSession?
 func save(_ session: AppSession) throws
 func clear() throws
}

/// Device-only, non-synchronizing Keychain item. Passwords never persist; only the app session.
public struct KeychainSessionStore: CredentialSource, SessionStore {
 private let service: String
 private let accessGroup: String?
 public init(service:String = "io.examplebusiness.mailclaw.session", accessGroup: String? = nil) { self.service = service; self.accessGroup = accessGroup }
 private var query:[String:Any] {
  var query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"current",kSecUseDataProtectionKeychain as String:true]
  if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
  return query
 }
 public func loadSession() -> AppSession? {
  var request = query
  request[kSecReturnData as String] = true
  request[kSecMatchLimit as String] = kSecMatchLimitOne
  let context = LAContext()
  context.interactionNotAllowed = true
  request[kSecUseAuthenticationContext as String] = context
  var item:CFTypeRef?
  guard SecItemCopyMatching(request as CFDictionary,&item) == errSecSuccess,
    let data = item as? Data,
    let session = try? JSONDecoder().decode(AppSession.self,from:data), session.isValid else { return nil }
  return session
 }
 public func load() -> Credentials? { loadSession()?.credentials }
 public func save(_ session:AppSession) throws {
  guard session.isValid else { throw APIError.rejected("Session expired; sign in again") }
  let value = try JSONEncoder().encode(session)
  let changes:[String:Any] = [kSecValueData as String:value,kSecAttrAccessible as String:kSecAttrAccessibleWhenUnlockedThisDeviceOnly,kSecAttrSynchronizable as String:false]
  let updated = SecItemUpdate(query as CFDictionary,changes as CFDictionary)
  if updated == errSecItemNotFound {
   var item = query
   changes.forEach {item[$0.key] = $0.value}
   guard SecItemAdd(item as CFDictionary,nil) == errSecSuccess else { throw APIError.rejected("Couldn't save sign-in on this device") }
  } else if updated != errSecSuccess { throw APIError.rejected("Couldn't save sign-in on this device") }
 }
 public func clear() throws {
  let status = SecItemDelete(query as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { throw APIError.rejected("Couldn't remove sign-in from this device") }
 }
}

/// The existing server contract: password -> 90-day app session, revoke current session.
/// This API intentionally has no generic mail mutation method.
public struct SessionClient: Sendable {
 public let baseURL: URL
 private let allowInsecureLoopback: Bool
 private let transport = HTTPTransport()
 public init(baseURL:URL,allowInsecureLoopback:Bool = false) throws {
  self.baseURL = try ServerEndpoint.validate(baseURL,allowInsecureLoopback:allowInsecureLoopback)
  self.allowInsecureLoopback = allowInsecureLoopback
 }
 /// The session's own server: sign-out and device registration go where it signed in.
 public init(for session: AppSession) throws {
  try self.init(baseURL:session.baseURL,allowInsecureLoopback:session.allowInsecureLoopback)
 }
 public func login(email:String,password:String, discovery:InstanceDiscovery = .shared) async throws -> AppSession {
  if baseURL == ServerConfig.discoveryRequired {
   let found = try await discovery.resolve(email:email, password:password)
   let client = try SessionClient(baseURL:found.origin)
   if let login = found.login { return try client.loginResponse(login, email:email) }
   return try await client.login(email:email,password:password)
  }
  var request = URLRequest(url:baseURL.appendingPathComponent("api/auth/login"))
  request.httpMethod = "POST"
  request.setValue("application/json",forHTTPHeaderField:"Content-Type")
  request.setValue("application/json",forHTTPHeaderField:"Accept")
  request.httpBody = try JSONEncoder().encode(["email":email,"password":password])
  let data = try await transport.data(for:request, accountDeleted:true)
  return try loginResponse(data, email:email)
 }
 private func loginResponse(_ data:Data, email:String) throws -> AppSession {
  struct Response:Decodable {
   let token:String
   let session:Details
   let user:User
   struct Details:Decodable {let kind:String;let expiresAt:Double}
   struct User:Decodable {let email:String}
  }
  let reply = try JSON.data(Response.self,from:data)
  guard reply.session.kind == "app",reply.user.email.lowercased() == email.trimmingCharacters(in:.whitespacesAndNewlines).lowercased() else {throw APIError.decoding("Unexpected sign-in response")}
  let session = try AppSession(baseURL:baseURL,email:reply.user.email,token:reply.token,expiresAt:Date(timeIntervalSince1970:reply.session.expiresAt/1000),allowInsecureLoopback:allowInsecureLoopback)
  guard session.isValid else {throw APIError.rejected("Session expired; sign in again")}
  return session
 }
 public func logout(_ session:AppSession) async throws {
  // AppModel also revokes a just-created session when sign-in is cancelled or saving fails.
  // Its original client held the discovery marker; revocation must use the resolved session origin.
  if baseURL == ServerConfig.discoveryRequired {
   guard session.baseURL != ServerConfig.discoveryRequired else { throw APIError.rejected("Invalid sign-in server") }
   try await SessionClient(for:session).logout(session)
   return
  }
  guard session.baseURL == baseURL else {throw APIError.rejected("Server does not match sign-in")}
  var request = URLRequest(url:baseURL.appendingPathComponent("api/auth/logout"))
  request.httpMethod = "POST"
  request.setValue("Bearer \(session.credentials.bearer)",forHTTPHeaderField:"Authorization")
  _ = try await transport.data(for:request)
 }
}

#if DEBUG
/// Debug test harnesses only (fixture runs, Mileage test runs): the session as a 0600 file in the
/// run's own folder, because an ad hoc Mac build (and an unsigned simulator build) can't keep a Keychain item.
public struct FileSessionStore: SessionStore {
 public let file: URL
 public init(file: URL) { self.file = file }
 public func loadSession() -> AppSession? {
  guard let data = FileManager.default.contents(atPath: file.path),
   let session = try? JSONDecoder().decode(AppSession.self, from: data), session.isValid else { return nil }
  return session
 }
 public func save(_ session: AppSession) throws {
  guard session.isValid else { throw APIError.rejected("Session expired; sign in again") }
  try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
   attributes: [.posixPermissions: 0o700])
  try JSONEncoder().encode(session).write(to: file, options: .atomic)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
 }
 public func clear() throws {
  guard FileManager.default.fileExists(atPath: file.path) else { return }
  try FileManager.default.removeItem(at: file)
 }
}
#endif

// These narrowly scoped mutations never accept a caller-supplied account or arbitrary path.
extension SessionClient {
 public func registerDevice(_ session: AppSession, token: String, environment: String, platform: String) async throws {
  try await deviceRequest(session, method:"POST", body:["token":token,"env":environment,"platform":platform])
 }
 public func unregisterDevice(_ session: AppSession, token: String, environment: String) async throws {
  try await deviceRequest(session, method:"DELETE", body:["token":token,"env":environment])
 }
 private func deviceRequest(_ session: AppSession, method: String, body: [String:String]) async throws {
  guard session.baseURL == baseURL else { throw APIError.rejected("Server does not match sign-in") }
  var request = URLRequest(url:baseURL.appendingPathComponent("api/devices"))
  request.httpMethod = method
  request.setValue("Bearer \(session.credentials.bearer)",forHTTPHeaderField:"Authorization")
  request.setValue("application/json",forHTTPHeaderField:"Content-Type")
  request.httpBody = try JSONEncoder().encode(body)
  _ = try await transport.data(for:request)
 }
}

public struct NotificationMessage: Decodable, Sendable {
 public let id: String
 public let threadId: String?
 public let fromName: String?
 public let fromAddress: String
 public let subject: String?
}
extension APIClient {
 public func notificationMessage(id: String) async throws -> NotificationMessage {
  try JSON.data(NotificationMessage.self, from:await get(["api","emails",id]))
 }
}
