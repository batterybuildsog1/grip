import Foundation
import MailClawKit
import UserNotifications

/// Banners for new mail in Personal and new Needs-you notes, and never for anything else (r2 S1/S6:
/// notifications on the Mac like any desktop mail app).
///
/// Mac: the app announces what its own Personal check finds while it runs, window open or
/// closed, like Mail. The spec's server push (APNs, `POST /api/devices`) is server work and
/// needs a signing team; when it lands, its payloads open conversations through the same
/// NotificationRouter.
/// iPhone and iPad: new notes only, and only while the app is in front (build 6: a code by email is
/// a note, and a note notifies). In the background or locked it needs that
/// push (build6/SCOPE-APNS.md).
extension AppModel {
	/// Mac, notifications on: keep checking Personal while the window is closed or elsewhere.
	var pollsForNotifications: Bool {
		#if os(macOS)
		return notifyEnabled && sync != nil
		#else
		return false
		#endif
	}

	/// At launch, and when the setting is turned on: ask once for permission to show banners.
	/// The answer arrives on a background queue, hence the explicitly @Sendable handler.
	func prepareNotifications() {
		#if os(macOS)
		guard notifyEnabled else { return }
		UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { @Sendable granted, _ in
			Task { @MainActor in self.notificationsDenied = !granted }
		}
		#endif
	}

	func notificationsChanged() {
		prepareNotifications()
		// Starts or stops the checks while the window is closed.
		setActive(isActive)
	}

	/// The background check: Personal in all accounts and the notes, then announce what is new.
	/// iPhone and iPad, in front on another view (or Mileage): the notes only, which Personal's own
	/// refresh doesn't ask for there.
	func checkForNewMail() async {
		guard let sync else { return }
		#if os(macOS)
		guard pollsForNotifications else { return }
		try? await sync.refreshNotes()
		guard (try? await sync.refresh(.personal)) != nil else { return }
		postNewMailNotifications()
		if view == .personal { reloadRows() } else { countPersonalUnread() }
		#else
		guard isActive, notifyEnabled, Self.fixtureNotes == nil,
			(try? await sync.refreshNotes()) != nil else { return }
		postNewMailNotifications()
		#endif
	}

	/// Compares the stored Personal list and notes with what was already announced. Unread,
	/// inbound mail newer than the mark notifies (Mac only); so does a note not seen before. At most
	/// five of each at once (after a long sleep, the list says the rest). The first check of a run
	/// takes stock and announces nothing; the iPhone announces only while in front.
	func postNewMailNotifications() {
		guard let store = sync?.store else { return }
		let rows = (try? store.rows(in: .personal, limit: 200)) ?? []
		let notes = (try? store.notes()) ?? []
		let newest = rows.map(\.latestAt).max() ?? 0
		defer {
			announcedThrough = max(announcedThrough ?? 0, newest)
			announcedNotes.formUnion(notes.map(\.id))
			if LaunchOptions.perfProbe { PerfProbe.shared.set("notify_primed", ms: 1) }
		}
		guard announcedThrough != nil, notifyEnabled else { return }
		#if os(macOS)
		let mark = announcedThrough ?? 0
		let mail = rows.filter { $0.latestAt > mark && $0.unread && !$0.isOutbound && !$0.isDraft }
		for row in mail.prefix(5) { NotificationRouter.post(row) }
		#else
		guard isActive else { return }
		#endif
		for note in notes.filter({ !announcedNotes.contains($0.id) }).prefix(5) { NotificationRouter.post(note) }
	}

	/// A banner was clicked: Personal, with that conversation open.
	func openFromNotification(_ id: String, emailId: String?) {
		if view.unscoped != .personal { select(.personal) }
		cancelSearch()
		open(id, anchor: emailId)
	}
}
