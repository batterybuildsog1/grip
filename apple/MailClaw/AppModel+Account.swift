import Foundation
import MailClawKit

/// Account deletion (SPEC §3; API.md). The server disables the account at once; this device then
/// erases the identity: Mileage's local store first, then the sign-out wipe (Keychain session, the
/// identity's mail store with its attachments and kept drafts, notification registration). Nothing
/// local changes on a wrong password, a throttle or no answer (failure modes D1-D5).
extension AppModel {
	/// After Delete account on this device (SPEC §3), on the sign-in screen.
	static let deletionSentence = "Your account is being deleted. Its data will be erased within 30 days."
	/// On the sign-in screen for an account deleted elsewhere: an old bearer's 401 ACCOUNT_DELETED, or
	/// the right password's 403 ACCOUNT_DELETED at sign-in (API.md).
	static let accountDeletedLine = "This account is being deleted."

	/// Delete account's button: nil when done (this identity is erased and the sentence shows),
	/// otherwise why nothing changed.
	func deleteAccount(password: String) async -> AccountFailure? {
		guard let api = sync?.api, accountIdentity != nil else { return .signedOut }
		do throws(AccountFailure) {
			_ = try await api.deleteAccount(password: password)
		} catch .accountDeleted {
			// An earlier attempt landed and its answer was lost (D5): done all the same.
		} catch let .server(status, _) where (200..<300).contains(status) {
			// Accepted, with a body this build can't read: the server has acted, so it is done.
		} catch {
			return error
		}
		await accountDeleted(because: Self.deletionSentence)
		return nil
	}

	/// The account is being deleted (here, or on another device: an old bearer gets 401
	/// ACCOUNT_DELETED). Erases this identity: Mileage's store, then the sign-out wipe, whose sign-in
	/// screen says why.
	func accountDeleted(because reason: String = AppModel.accountDeletedLine) async {
		guard !signingOut else { return }
		if let identity = accountIdentity { eraseMileage(host: identity.origin, email: identity.email) }
		await signOut(because: reason)
	}

	/// A refresh or an account call was refused (401/403): one account call tells a deleted account
	/// (the sentence and the erase) from a session that simply ended (sign-out, as before).
	func sessionRejected() async {
		guard accountIdentity != nil, !signingOut, let api = sync?.api else { return }
		do throws(AccountFailure) {
			_ = try await api.aiConsent()
		} catch .accountDeleted {
			return await accountDeleted()
		} catch {}
		await signOut(because: Self.sessionEnded)
	}
}
