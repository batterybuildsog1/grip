#if os(iOS)
import MailClawKit
import SwiftUI

/// What the iPhone stack pushes over the inbox.
enum PhoneRoute: Hashable {
	case thread(String)
	/// Mileage: one trip per screen, stepping through the queue it was opened from.
	case mileageTrip(String, MileageReportModel.Queue)
	/// Mileage: a company's full list, the spot-check list.
	case mileageList(MileageReportModel.Queue)
	case mileageSettings
}

/// iPhone (design r2 §4 S1): one `NavigationStack`. Its root is the inbox (search replaces its
/// list in place, r2 S4); threads are pushed, so Back is the system's. A note tap, a deep link or a
/// notification selects in code, which pushes the thread; popping clears the selection so the same
/// row opens again.
struct PhoneRootView: View {
	@Environment(AppModel.self) private var model
	@Environment(MileageReportModel.self) private var book
	@State private var path: [PhoneRoute] = []
	@FocusState private var pane: Pane?

	var body: some View {
		NavigationStack(path: $path) {
			InboxView(path: $path)
				.navigationDestination(for: PhoneRoute.self) { route in
					switch route {
					case let .thread(id):
						if let sync = model.sync {
							ThreadView(id: id, anchor: model.anchor(for: id), sync: sync, pane: $pane)
								.id(id)
						}
					case let .mileageTrip(id, queue):
						MileagePhoneTrip(id: id, queue: queue)
					case let .mileageList(queue):
						MileagePhoneList(queue: queue)
					case .mileageSettings:
						MileagePhoneSettings()
					}
				}
		}
		// Mileage chooses in its model (a card's "See all", an answer moving on, a list's row): the
		// open trip takes the pushed trip's place, so Back returns to where it was opened from.
		.onChange(of: book.open, initial: true) { _, open in
			guard let open else {
				if case .mileageTrip = path.last { path.removeLast() }
				return
			}
			let route = PhoneRoute.mileageTrip(open.trip, open.queue)
			guard path.last != route else { return }
			if case .mileageTrip = path.last { path[path.count - 1] = route } else { path.append(route) }
		}
		.onChange(of: book.list) { _, list in
			if let list { path.append(.mileageList(list)); book.list = nil }
		}
		.onChange(of: book.showSettings) { _, shown in
			if shown { path.append(.mileageSettings); book.showSettings = false }
		}
		// Signed out of Mileage (Settings' Sign out): back to the month, which is the sign-in form
		// now, rather than Settings over it (apple-r1-07).
		.onChange(of: book.signedIn) { _, signedIn in
			guard !signedIn else { return }
			path.removeAll { route in
				switch route {
				case .mileageSettings, .mileageTrip, .mileageList: true
				case .thread: false
				}
			}
		}
		// A conversation chosen in code (a note, a banner, "Next in", Archive's next one) takes the
		// open thread's place, so Back always returns to the list; none left, the list comes back.
		.onChange(of: model.selection, initial: true) { _, selection in
			guard let selection else {
				if case .thread = path.last { path.removeLast() }
				return
			}
			guard path.last != .thread(selection) else { return }
			if case .thread = path.last { path[path.count - 1] = .thread(selection) } else { path.append(.thread(selection)) }
		}
		.onChange(of: path) { _, path in
			if case let .thread(id) = path.last {
				if model.selection != id { model.selection = id }
			} else if model.selection != nil {
				model.selection = nil
			}
			// Back from a trip: nothing is open.
			if case let .mileageTrip(id, queue) = path.last {
				if book.open?.trip != id { book.open = .init(trip: id, queue: queue) }
			} else if book.open != nil {
				book.open = nil
			}
		}
		.overlay(alignment: .bottom) { ToastView() }
	}
}

/// The undo toast of the last mutation, above the bottom bar (design r2 §5).
struct ToastView: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		if let toast = model.toast {
			HStack(spacing: 14) {
				Text(toast.text)
					.lineLimit(2)
					.frame(maxWidth: .infinity, alignment: .leading)
					.accessibilityIdentifier("toast")
				if toast.undoable {
					Button("Undo") { model.runToastUndo() }
						.fontWeight(.semibold)
						.underline()
						.foregroundStyle(.mcOnToast)
						.accessibilityIdentifier("toast-undo")
				}
				// A failure stays until dismissed (S7).
				if toast.isError {
					Button("Dismiss") { model.dismissToast() }
						.foregroundStyle(.mcOnToast)
						.opacity(0.8)
				}
			}
			.font(.subheadline)
			.foregroundStyle(.mcOnToast)
			.padding(.horizontal, 16)
			.padding(.vertical, 13)
			.background(MCCorner.box.rect.fill(.mcToast))
			.mcFloatShadow()
			.padding(.horizontal, 16)
			.padding(.bottom, 72)
			.id(toast.id)
			.transition(.move(edge: .bottom).combined(with: .opacity))
		}
	}
}
#endif
