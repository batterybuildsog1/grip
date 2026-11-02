import MailClawKit
import SwiftUI
import UniformTypeIdentifiers

/// The composer (r2 build spec, S5). iPhone: a full sheet, Cancel · title · Send; To as chips with
/// "Reply all (n)"; From (every sender); the message; Quoted text; Attach and Discard above the
/// keyboard. Mac: the same form in its own window. Words only, system controls.
struct ComposeView: View {
	@Bindable var model: ComposeModel
	/// Leaves the composer: after Cancel kept the draft, or Discard removed it.
	let done: () -> Void
	@State private var importing = false
	@FocusState private var bodyFocused: Bool
	/// The label column: "Subject" fits at the default size; a label never wraps or truncates (it
	/// wrapped as "Sub-ject" at 56, iPhone r1-08), a wider one only pushes its own field over.
	@ScaledMetric(relativeTo: .body) private var labelWidth: CGFloat = 66

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 0) {
					recipients
					rule
					row("From") {
						// Words only: a pop-up Picker checkmarked the sender (ipad-r2-03).
						Menu {
							ForEach(model.senders, id: \.self) { sender in
								MenuChoice(title: sender, current: sender == model.from) { model.from = sender }
							}
							if !model.senders.contains(model.from) { MenuChoice(title: model.from, current: true) {} }
						} label: {
							MenuLabel(text: model.from, ink: .mcAccent)
						}
						.menuStyle(.button)
						.buttonStyle(.plain)
						.menuIndicator(.hidden)
						.fixedSize()
						.accessibilityLabel("From")
						.accessibilityValue(model.from)
						.accessibilityIdentifier("compose-from")
						Spacer(minLength: 0)
					}
					rule
					if !model.isReply {
						row("Subject") {
							TextField("Subject", text: $model.subject, prompt: Self.prompt("Subject"))
								.accessibilityIdentifier("compose-subject")
						}
						rule
					}
					if let problem = model.problem {
						Text(problem)
							.font(.footnote)
							.foregroundStyle(.mcWarn)
							.padding(.horizontal, 16)
							.padding(.top, 10)
							.accessibilityIdentifier("compose-notice")
					}
					// What the reader writes is set like what they read (Grip: New York).
					let bodyPrompt = model.isReply ? "Write your reply" : "Message"
					#if os(macOS)
					MacTextArea(
						text: $model.body, prompt: bodyPrompt, minHeight: 136, focused: $bodyFocused,
						identifier: "compose-body")
						.mcReadingFont(.body)
						.padding(.horizontal, 11)
						.padding(.vertical, 12)
					#else
					TextField(bodyPrompt, text: $model.body, prompt: Self.prompt(bodyPrompt), axis: .vertical)
						.mcReadingFont(.body)
						.lineLimit(8...)
						.focused($bodyFocused)
						.padding(.horizontal, 16)
						.padding(.vertical, 12)
						.accessibilityIdentifier("compose-body")
					#endif
					quoted
					files
					if let problem = model.sendProblem {
						Text(problem)
							.font(.callout)
							.foregroundStyle(.mcWarn)
							.padding(.horizontal, 16)
							.padding(.vertical, 8)
							.accessibilityIdentifier("compose-error")
					}
				}
				.foregroundStyle(.mcText)
			}
			.textFieldStyle(.plain)
			.background(.mcSheet)
			.safeAreaInset(edge: .bottom) { accessory }
			.navigationTitle(model.title)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") {
						Task { if await model.close() { done() } }
					}
					.foregroundStyle(.mcAccent)
					.accessibilityIdentifier("compose-cancel")
				}
				.sharedBackgroundVisibility(.hidden)
				#if os(iOS)
				// The Mac's window title already says it.
				ToolbarItem(placement: .principal) {
					Text(model.title).font(.headline).foregroundStyle(.mcText)
				}
				#endif
				ToolbarItem(placement: .confirmationAction) {
					Button(model.sending == .preparing ? "Sending…" : "Send") { model.send() }
						.buttonStyle(MCPrimaryButtonStyle(capsule: Self.capsule))
						.disabled(!model.canSend)
						.keyboardShortcut(.return, modifiers: .command)
						.accessibilityIdentifier("compose-send")
				}
				// The one filled button stands alone: no glass around it (no glass anywhere).
				.sharedBackgroundVisibility(.hidden)
			}
		}
		.disabled(model.isWaiting)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("compose-view")
		.onChange(of: model.fields) { model.edited() }
		.onChange(of: model.quote) { model.quoteEdited() }
		.task {
			model.claim()
			await model.load()
			if model.isReply { bodyFocused = true }
		}
		// Gone (Cancel, Discard, a swipe, its window closed): the draft can be opened again. Not
		// while a send waits out its Undo: that composer comes back.
		.onDisappear {
			if !model.isWaiting, model.sending != .preparing { model.release() }
		}
		.fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
			if case let .success(urls) = result { model.attach(urls) }
		}
	}

	private func row<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: 12) {
			Text(label)
				.foregroundStyle(.mcMuted)
				.lineLimit(1)
				.fixedSize()
				.frame(minWidth: labelWidth, alignment: .leading)
				.accessibilityIdentifier("compose-label-\(label.lowercased())")
			content()
		}
		.padding(.horizontal, 16)
		.frame(minHeight: 48)
	}

	/// To: who it goes to, by name and address (WD-06); "Reply all (n)" adds the rest.
	@ViewBuilder private var recipients: some View {
		if model.showsChips {
			row("To") {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 6) {
						ForEach(model.chips) { chip in
							Text("\(Text(chip.name).fontWeight(.medium)) \(Text(chip.address).foregroundStyle(.mcMuted))")
								.font(.subheadline)
								.lineLimit(1)
								.padding(.horizontal, 10)
								.padding(.vertical, 4)
								.background(.mcRaised, in: Capsule())
						}
					}
				}
				.accessibilityElement(children: .combine)
				.accessibilityIdentifier("compose-to-chips")
				if !model.replyAllAdds.isEmpty {
					Button("Reply all (\(model.replyAllAdds.count + model.chips.count))") { model.replyAll() }
						.buttonStyle(MCLinkButtonStyle())
						.fixedSize()
						.accessibilityIdentifier("compose-reply-all")
				}
				Button("Edit") { model.editingRecipients = true }
					.buttonStyle(.borderless)
					.foregroundStyle(.mcMuted)
					.fixedSize()
			}
		} else {
			row("To") {
				address($model.to, "compose-to")
				if !model.showCcBcc {
					Button("Cc Bcc") { model.showCcBcc = true }.buttonStyle(.borderless).foregroundStyle(.mcMuted).fixedSize()
				}
			}
			if model.showCcBcc {
				rule
				row("Cc") { address($model.cc, "compose-cc") }
				rule
				row("Bcc") { address($model.bcc, "compose-bcc") }
			}
		}
	}

	private func address(_ text: Binding<String>, _ identifier: String) -> some View {
		TextField("Name or address", text: text, prompt: Self.prompt("Name or address"))
			#if os(iOS)
			.keyboardType(.emailAddress)
			.textInputAutocapitalization(.never)
			#endif
			.autocorrectionDisabled()
			.accessibilityIdentifier(identifier)
	}

	/// The quoted original (or the forwarded message): hidden until asked for, sent with the reply,
	/// left out once cleared.
	@ViewBuilder private var quoted: some View {
		if model.hasQuote {
			VStack(alignment: .leading, spacing: 8) {
				Button(model.showQuote ? "Hide quoted text" : (model.mode == .forward ? "Forwarded message" : "Quoted text")) {
					model.showQuote.toggle()
				}
				.buttonStyle(MCOutlinedButtonStyle(capsule: true))
				.font(.subheadline)
				.accessibilityIdentifier("compose-quoted-toggle")
				if model.showQuote {
					#if os(macOS)
					MacTextArea(text: $model.quote, prompt: "", minHeight: 20, identifier: "compose-quote")
						.mcReadingFont(.callout)
						.foregroundStyle(.mcMuted)
						.padding(.horizontal, -5)
					#else
					TextField("", text: $model.quote, axis: .vertical)
						.mcReadingFont(.callout)
						.foregroundStyle(.mcMuted)
						.accessibilityIdentifier("compose-quote")
					#endif
				}
			}
			.padding(.horizontal, 16)
			.padding(.bottom, 12)
		}
	}

	@ViewBuilder private var files: some View {
		if !model.attachments.isEmpty {
			VStack(alignment: .leading, spacing: 6) {
				ForEach(model.attachments, id: \.filename) { file in
					HStack(alignment: .firstTextBaseline) {
						Text(file.filename).fontWeight(.medium)
						Spacer(minLength: 8)
						if !model.filesLocked {
							Button("Remove") { model.removeAttachment(file) }.buttonStyle(.borderless).foregroundStyle(.mcMuted)
						}
					}
					.font(.callout)
				}
			}
			.padding(.horizontal, 16)
			.padding(.bottom, 12)
		}
	}

	/// Attach and Discard, above the keyboard; "Draft saved" between them.
	private var accessory: some View {
		HStack(spacing: 16) {
			// A saved draft whose files couldn't be loaded keeps them as they are on the server.
			if !model.filesLocked {
				Button("Attach") { importing = true }
					.foregroundStyle(.mcAccent)
					.accessibilityIdentifier("compose-attach")
			}
			Text(model.savingText)
				.font(.footnote)
				.foregroundStyle(model.saveFailed ? MCColor.mcWarn : .mcMuted)
				.accessibilityIdentifier("compose-save-state")
			Spacer()
			Button("Discard", role: .destructive) {
				Task {
					await model.discard()
					done()
				}
			}
			.foregroundStyle(.mcNeg)
			.accessibilityIdentifier("compose-discard")
		}
		.buttonStyle(.borderless)
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.mcBottomBar()
	}

	/// Placeholders in --mc-faint (4.5:1; the system's is lighter).
	private static func prompt(_ text: String) -> Text {
		Text(text).foregroundStyle(.mcFaint)
	}

	/// Rows are split by --mc-rule.
	private var rule: some View {
		Rectangle().fill(.mcRule).frame(height: 1)
	}

	/// Send is a capsule in the iPhone sheet's bar, the control radius in a Mac window's toolbar.
	private static var capsule: Bool {
		#if os(iOS)
		true
		#else
		false
		#endif
	}
}

/// "Sending… Undo" while a send waits out its 5 seconds.
struct SendingNotice: View {
	let model: ComposeModel

	var body: some View {
		if model.isWaiting {
			HStack(spacing: 16) {
				Text("Sending…")
				if model.sending == .queued {
					Button("Undo") { model.undo() }
						.buttonStyle(.plain)
						.fontWeight(.semibold)
						.underline()
						.accessibilityIdentifier("toast-undo")
				}
			}
			.foregroundStyle(.mcOnToast)
			.padding(.horizontal, 18)
			.padding(.vertical, 12)
			.background(.mcToast, in: MCCorner.box.rect)
			.mcFloatShadow()
			.accessibilityElement(children: .contain)
			.accessibilityIdentifier("sending-toast")
		}
	}
}

/// "Sent", "Not sent": a few seconds above the bottom edge.
struct NoticeView: View {
	let text: String

	var body: some View {
		Text(text)
			.foregroundStyle(.mcOnToast)
			.padding(.horizontal, 18)
			.padding(.vertical, 12)
			.background(.mcToast, in: MCCorner.box.rect)
			.mcFloatShadow()
			.accessibilityIdentifier("notice")
	}
}

/// New message ("New" in the iPhone's bottom bar).
struct NewMessageButton: View {
	@Environment(AppModel.self) private var app
	@Environment(\.openWindow) private var openWindow

	var body: some View {
		#if os(macOS)
		let title = "New message"
		#else
		let title = "New"
		#endif
		Button(title) { openWindow.compose(ComposeRequest(kind: .new), in: app) }
			.accessibilityIdentifier("new-message")
	}
}

#if os(macOS)
/// The Mac composer's body (and quoted text): a text editor, so Return starts a new paragraph. A
/// vertical TextField ended editing on Return and selected its text, so the next words replaced
/// the first paragraph (mac-r3-01; only Option-Return broke the line). The editor grows with its
/// words inside the composer's scroll: the same text, hidden and one line longer, sizes the box.
private struct MacTextArea: View {
	@Binding var text: String
	let prompt: String
	let minHeight: CGFloat
	var focused: FocusState<Bool>.Binding?
	let identifier: String

	var body: some View {
		ZStack(alignment: .topLeading) {
			Text(text + "\n ")
				.padding(.horizontal, 5)
				.frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
				.hidden()
				.accessibilityHidden(true)
			if text.isEmpty, !prompt.isEmpty {
				Text(prompt)
					.foregroundStyle(.mcFaint)
					.padding(.horizontal, 5)
					.allowsHitTesting(false)
					.accessibilityHidden(true)
			}
			editor
		}
	}

	@ViewBuilder private var editor: some View {
		let field = TextEditor(text: $text)
			.scrollContentBackground(.hidden)
			.scrollDisabled(true)
			.accessibilityLabel(prompt.isEmpty ? "Quoted text" : prompt)
			.accessibilityIdentifier(identifier)
		if let focused { field.focused(focused) } else { field }
	}
}
#endif

#if os(macOS)
/// A Mac composer window (`WindowGroup(for: ComposeRequest.self)`): Send keeps the window, says
/// "Sending… Undo" for 5 seconds, then closes once the server sent it.
struct ComposeWindowRoot: View {
	let request: ComposeRequest
	@Environment(AppModel.self) private var app
	@Environment(\.dismiss) private var dismiss
	@State private var model: ComposeModel?

	var body: some View {
		Group {
			if let model {
				ComposeView(model: model) { dismiss() }
					.overlay(alignment: .bottom) { SendingNotice(model: model).padding(.bottom, 56) }
					.onChange(of: model.sending) { _, state in
						if state == .sent {
							app.show("Sent")
							dismiss()
						}
					}
			} else {
				ProgressView()
			}
		}
		.frame(minWidth: 520, idealWidth: 560, minHeight: 480, idealHeight: 600)
		.onAppear { app.composerWindows += 1 }
		.task {
			if model == nil {
				model = ComposeModel(request: request, api: app.composeAPI, shelf: app.drafts, account: app.account)
			}
		}
		// Closed any way (Cancel, ⌘W, the close button): the draft stays, here and on the server.
		.onDisappear {
			app.composerWindows = max(0, app.composerWindows - 1)
			guard let model else { return }
			Task {
				_ = await model.close()
				model.release()
			}
		}
	}
}
#endif
