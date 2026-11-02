import Foundation
import MailClawKit
import Observation

/// The owner's AI sorting switch, as the server holds it (Settings on the Mac, the Account sheet on
/// iPhone and iPad). AI sorting is on unless the owner turns it off (owner decision, 2026-10-30: on
/// by default, no consent screen), so nothing asks and nothing waits for it: the mail opens at once.
/// Nothing is kept on the device: it is read when a session starts and whenever the switch appears
/// (S4), and only a decoded answer from the server changes it, so a failure is never a change (S2, S3).
/// Failure list: docs/release-1.0/failure-modes-consent-delete-ui.md.
@MainActor @Observable
final class ConsentModel {
	/// The last good answer this session; nil until one arrives.
	private(set) var server: AIConsent?
	/// The latest read failed (nil once a read works).
	private(set) var readFailure: AccountFailure?
	private(set) var reading = false
	/// The change on its way (true = on): the switch waits for the acknowledgement.
	private(set) var saving: Bool?
	/// The last change that wasn't saved, and why. Cleared by a good save, or by a read that shows
	/// the change did land (an answer lost on the way back, S3).
	private(set) var failed: (allow: Bool, why: AccountFailure)?
	/// The session ended under a call (ACCOUNT_DELETED, or another 401): AppModel decides what follows.
	@ObservationIgnored var onSessionEnded: ((AccountFailure) -> Void)?

	private var api: APIClient?
	/// Bumped by every reset and every save: an answer to an older question is dropped.
	private var epoch = 0

	/// Settings' section: hidden once the server says this person can't decide (S1).
	var settingsShown: Bool { server?.canDecide ?? (readFailure != nil) }
	/// The switch: the server's state, or the change while it is being saved.
	var switchOn: Bool {
		if let saving { return saving }
		if readFailure == .unavailable { return false }
		return server?.state == .allowed
	}
	/// The switch can be moved: a good read, nothing on its way.
	var switchEnabled: Bool { saving == nil && readFailure == nil && server?.canDecide == true }

	/// A new session's client (sign-in, launch): read once, in the background (Settings shows its
	/// answer without a wait; nothing else waits for it).
	func attach(_ api: APIClient) {
		reset()
		self.api = api
		read()
	}

	/// Sign-out: nothing of this identity survives.
	func reset() {
		epoch += 1
		api = nil
		server = nil
		readFailure = nil
		reading = false
		saving = nil
		failed = nil
	}

	/// Asks the server again (the switch appearing, Try again, after a failed save).
	func read() {
		guard let api, !reading, saving == nil else { return }
		reading = true
		let asked = epoch
		Task {
			let answer: Result<AIConsent, AccountFailure>
			do throws(AccountFailure) { answer = .success(try await api.aiConsent()) } catch { answer = .failure(error) }
			guard asked == epoch else { return }
			reading = false
			switch answer {
			case let .success(consent):
				server = consent
				readFailure = nil
				if let failed, consent.state == (failed.allow ? .allowed : .declined) { self.failed = nil }
			case let .failure(why):
				if why == .accountDeleted || why == .signedOut {
					onSessionEnded?(why)
					return
				}
				readFailure = why
			}
		}
	}

	/// On or Off. Sent at the version of the server's last answer (the build holds none of its own);
	/// only the server's answer changes the state.
	func choose(_ allow: Bool) {
		guard let api, let version = server?.version, saving == nil else { return }
		epoch += 1
		let asked = epoch
		saving = allow
		failed = nil
		reading = false
		Task {
			do throws(AccountFailure) {
				let consent = try await api.setAIConsent(allow: allow, version: version)
				guard asked == epoch else { return }
				saving = nil
				server = consent
				readFailure = nil
			} catch {
				guard asked == epoch else { return }
				saving = nil
				switch error {
				case .accountDeleted, .signedOut:
					onSessionEnded?(error)
					return
				case .stale, .ownerOnly:
					break
				default:
					failed = (allow, error)
				}
				// What the server holds now: a lost answer may have landed (S3); a 409's new version or
				// a 403's owner says what the switch shows.
				read()
			}
		}
	}
}
