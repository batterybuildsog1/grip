import Foundation
import MailClawKit

/// Compose on iPhone (r2 S5): one sheet at a time (`composer`). Send hands it to `sending` while
/// its 5-second Undo runs; Undo or a failed send brings the sheet back with everything in it.
/// The Mac opens each composer in its own window instead (ComposeWindowRoot). Either way a closed
/// composer's message is kept on the device (`drafts`) and comes back when it is opened again.
extension AppModel {
	var composeAPI: ComposeAPI? { sync.map { ComposeAPI(api: $0.api) } }

	/// Reply, Reply All or Forward to the open conversation (the Mac toolbar and Message menu, S6).
	func replyRequest(_ kind: ComposeKind) -> ComposeRequest? {
		guard let id = selection else { return nil }
		return ComposeRequest(kind: kind, emailId: anchor(for: id), conversationId: id)
	}

	/// A Drafts row, or a conversation that is only a draft, opens its draft in the composer (iPhone:
	/// the sheet; Mac: a composer window, or the one that has it open), not in a reader. False for
	/// every other row.
	func openDraft(_ id: String) -> Bool {
		guard let row = visibleRows.first(where: { $0.id == id }), row.isDraft,
		      view.kind == .drafts || row.messageCount == 1, let draftId = row.displayEmailId else { return false }
		let request = ComposeRequest(kind: .new, conversationId: row.id, draftId: draftId)
		#if os(macOS)
		composeWindow = drafts?.openRequest(draftId: draftId).map(ComposeRequest.init(reopening:)) ?? request
		#else
		startCompose(request)
		#endif
		return true
	}

	func startCompose(_ request: ComposeRequest) {
		let model = ComposeModel(request: request, api: composeAPI, shelf: drafts, account: account)
		model.onSending = { [weak self, weak model] state in
			guard let self, let model else { return }
			self.sendingChanged(model, state)
		}
		composer = model
	}

	private func sendingChanged(_ model: ComposeModel, _ state: ComposeModel.Sending) {
		switch state {
		case .queued:
			if composer === model { composer = nil }
			sending = model
		case .sent:
			if sending === model { sending = nil }
			show("Sent")
		case .failed:
			if sending === model {
				sending = nil
				composer = model
				show("Not sent")
			}
		case .idle:
			// Undone: the sheet comes back.
			if sending === model {
				sending = nil
				composer = model
			}
		case .preparing, .sending:
			break
		}
	}

	/// A short line above the bottom edge ("Sent", "Not sent").
	func show(_ text: String) {
		notice = text
		Task { [weak self] in
			try? await Task.sleep(for: .seconds(4))
			if self?.notice == text { self?.notice = nil }
		}
	}
}
