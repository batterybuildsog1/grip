import Foundation

/// All native credentials travel to an HTTPS origin, never a URL with embedded credentials,
/// path, query or fragment. The Debug fixture exception accepts only the loopback interface.
public enum ServerEndpoint {
 public static func validate(_ url: URL, allowInsecureLoopback: Bool = false) throws -> URL {
  guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
   let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
   parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/" else {
   throw APIError.rejected("Enter the server's HTTPS address")
  }
  var loopback = false
  #if DEBUG
  loopback = allowInsecureLoopback && ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host)
  #endif
  guard parts.scheme == "https" || (parts.scheme == "http" && loopback) else {
   throw APIError.rejected("Use an HTTPS server")
  }
  var canonical = parts
  canonical.path = ""
  guard let result = canonical.url else { throw APIError.rejected("Invalid server address") }
  return result
 }
}

/// Ephemeral requests have no shared cookies/cache and never forward credentials on redirects.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
 func urlSession(_ session: URLSession, task: URLSessionTask,
   willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
   completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class HTTPTransport: Sendable {
 private let session: URLSession
 init(configuration: URLSessionConfiguration = .ephemeral) {
  let config = configuration
  config.timeoutIntervalForRequest = 20
  config.urlCache = nil
  config.requestCachePolicy = .reloadIgnoringLocalCacheData
  config.httpCookieStorage = nil
  config.urlCredentialStorage = nil
  config.httpShouldSetCookies = false
  config.timeoutIntervalForResource = 20
  config.waitsForConnectivity = false
  session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
 }
 deinit { session.invalidateAndCancel() }

 /// The answer as it came, any status: the account calls read the server's `error.code` (Account.swift).
 func exchange(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
  let data: Data
  let response: URLResponse
  do { (data,response) = try await session.data(for: request) }
  catch let error as URLError {
   if error.code == .cancelled { throw CancellationError() }
   throw APIError.offline
  }
  guard let http = response as? HTTPURLResponse else { throw APIError.http(status:0,retryAfter:nil) }
  return (data, http)
 }

 /// Stream discovery responses with a hard decoded size cap, no cookies or redirects.
 func boundedExchange(_ request: URLRequest, maximum: Int,
   bodyForStatuses: Set<Int>? = nil) async throws -> (Data, HTTPURLResponse) {
  let bytes: URLSession.AsyncBytes
  let response: URLResponse
  do { (bytes, response) = try await session.bytes(for: request) }
  catch let error as URLError {
   if Task.isCancelled || error.code == .cancelled { throw CancellationError() }
   guard [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost,
          .cannotConnectToHost, .dnsLookupFailed].contains(error.code) else {
    throw APIError.rejected("Couldn't verify the discovery connection")
   }
   throw APIError.offline
  }
  guard let http = response as? HTTPURLResponse else { throw APIError.rejected("Invalid discovery response") }
  // Discovery needs only successful JSON bodies. A website's large 404/410/5xx page must
  // not exhaust the manifest cap before the resolver can choose its directory fallback.
  if let statuses = bodyForStatuses, !statuses.contains(http.statusCode) {
   bytes.task.cancel()
   return (Data(), http)
  }
  var data = Data()
  for try await byte in bytes {
   guard data.count < maximum else { throw APIError.rejected("Discovery response too large") }
   data.append(byte)
  }
  return (data, http)
 }

 /// `reasons`: any refusal that says why throws `.rejected(why)`, not only a 400 (`APIClient.write`).
 /// `accountDeleted`: a refusal coded ACCOUNT_DELETED throws `AccountFailure.accountDeleted` (sign-in).
 func data(for request: URLRequest, reasons: Bool = false, accountDeleted: Bool = false) async throws -> Data {
  let (data, http) = try await exchange(request)
  guard (200..<300).contains(http.statusCode) else {
   if accountDeleted, AccountFailure.from(status:http.statusCode, body:data, retryAfter:nil) == .accountDeleted { throw AccountFailure.accountDeleted }
   if http.statusCode == 400 || reasons, let message = APIClient.errorMessage(data) { throw APIError.rejected(message) }
   throw APIError.http(status:http.statusCode,retryAfter:http.value(forHTTPHeaderField:"Retry-After").flatMap(Double.init))
  }
  return data
 }
}
