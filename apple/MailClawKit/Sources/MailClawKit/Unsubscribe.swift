import Foundation

/// What the sender's unsubscribe did (CLAUDE.md "Manual unsubscribe"): the server tries one-click,
/// then the mailto, else hands back the sender's page for the user to finish on.
public enum UnsubscribeOutcome: Sendable, Equatable {
	/// The one-click POST or the mailto went out.
	case unsubscribed
	/// Nothing was sent: the user finishes on the sender's page.
	case link(URL)
}

extension MailSync {
	private struct UnsubscribeAnswer: Decodable {
		let outcome: String?
		let url: String?
	}

	/// `POST /api/emails/:id/unsubscribe`, once per call, never retried: call it only for the user's
	/// own tap. A refusal throws with the server's reason (`APIError.rejected`), and so does any
	/// answer that isn't "unsubscribed" or a page to open, so a failure never reads as done. `{}` is
	/// the dry-writes answer (APIClient), the only success without an outcome.
	public func unsubscribe(emailId: String) async throws -> UnsubscribeOutcome {
		let body = try await api.write(.post, ["api", "emails", emailId, "unsubscribe"], reasons: true)
		let answer = try JSON.data(UnsubscribeAnswer.self, from: body)
		switch answer.outcome {
		case "unsubscribed", nil:
			return .unsubscribed
		case "link":
			guard let url = answer.url.flatMap(URL.init(string:)),
			      ["https", "http"].contains(url.scheme?.lowercased() ?? "")
			else { throw APIError.decoding("unsubscribe page") }
			return .link(url)
		default:
			throw APIError.decoding("unsubscribe outcome")
		}
	}
}
