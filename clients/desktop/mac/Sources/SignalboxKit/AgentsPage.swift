import SwiftUI

/// Agent settings are local files a browser can't write, so this one setup step stays native.
/// The reviewed write itself happens in the shared TypeScript setup engine behind host.mjs.
struct AgentsPage: View {
  let model: PanelModel

  private static let agents: [(String, WritableKeyPath<AgentSelection, AgentChoice>, KeyPath<DesktopSnapshot.Configured, Bool>)] = [
    ("Codex", \.codex, \.codex), ("Claude Code", \.claude, \.claude),
  ]

  var body: some View {
    let presentation = model.presentation
    let configured = model.configured
    VStack(alignment: .leading, spacing: 0) {
      Header(title: "Connect your agents", back: { model.page = .home }, backTitle: model.homeTitle)
      VStack(alignment: .leading, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Connect your agents").font(.system(size: 15, weight: .semibold))
          Text(
            "Choose which settings to update. Unchecking a configured agent restores its previous settings."
          )
          .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 6)
        VStack(spacing: 8) {
          ForEach(Self.agents, id: \.0) { name, choice, isConfigured in
            row(name, choice: choice, configured: configured[keyPath: isConfigured], connected: presentation.connected)
          }
        }
        .padding(.horizontal, 6)
        HStack(spacing: 6) {
          Button("Review changes") { Task { await model.review(undo: false) } }
            .disabled(!model.canReview)
          if presentation.hasSetup {
            Button("Undo agent setup") { Task { await model.review(undo: true) } }
          }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.horizontal, 6)
        if model.reviewing { review }
        if let message = model.notice ?? (model.reviewing ? nil : model.message) {
          NoticeView(notice: message)
        }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 12)
    }
  }

  @ViewBuilder
  private func row(
    _ name: String, choice: WritableKeyPath<AgentSelection, AgentChoice>, configured: Bool, connected: Bool
  ) -> some View {
    let current = model.selection[keyPath: choice]
    HStack {
      Toggle(
        name,
        isOn: Binding(
          get: { current != .undo },
          set: { on in Task { await model.choose(on ? .connect : .undo, for: choice) } })
      )
      .toggleStyle(.checkbox)
      .disabled(!connected && !configured)
      Spacer()
      if configured && current != .undo {
        Picker(
          "\(name) settings",
          selection: Binding(
            get: { current },
            set: { value in Task { await model.choose(value, for: choice) } })
        ) {
          Text("Keep current settings").tag(AgentChoice.keep)
          Text("Use this connection").tag(AgentChoice.connect).disabled(!connected)
        }
        .labelsHidden()
        .fixedSize()
        .controlSize(.small)
      } else {
        Text(configured ? "Restore previous" : current == .connect ? "Use this connection" : "Not configured")
          .font(.system(size: 12)).foregroundStyle(.secondary)
      }
    }
  }

  private var review: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Review changes").font(.system(size: 13, weight: .semibold))
      Text("Only these managed settings will change. Backups are kept. Later unrelated edits stay yours.")
        .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
      if let preview = model.preview {
        ForEach(preview.files) { file in
          VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text(file.action == .keep ? "Keep" : file.action == .restore ? "Restore" : "Update")
                .font(.system(size: 12, weight: .semibold))
              Text(file.path).font(.system(size: 11, design: .monospaced)).lineLimit(1)
                .truncationMode(.middle)
            }
            if !file.fields.isEmpty {
              Text(file.fields.joined(separator: ", ")).font(.system(size: 11)).foregroundStyle(.secondary)
            }
          }
        }
      }
      if let error = model.snapshot?.error { Text(error).font(.system(size: 12)).foregroundStyle(.red) }
      HStack {
        Button("Apply changes") {
          if let id = model.preview?.id { Task { await model.perform(.setupApply(id: id)) } }
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.preview == nil)
        Button("Cancel") { Task { await model.perform(.cancelPreview) } }
          .buttonStyle(.bordered)
      }
      .controlSize(.small)
    }
    .card()
  }
}
