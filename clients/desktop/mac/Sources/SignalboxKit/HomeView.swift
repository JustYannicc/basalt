import SwiftUI

struct HomeView: View {
  let model: PanelModel
  let actions: PanelActions

  var body: some View {
    let presentation = model.presentation
    let snapshot = model.snapshot
    VStack(alignment: .leading, spacing: 0) {
      // The approved panel is titled Apps once there is a list to show.
      Header(title: model.apps == nil ? "Signalbox" : "Apps") {
        Text(model.machineName).font(.system(size: 12)).foregroundStyle(.secondary)
      }
      VStack(alignment: .leading, spacing: 10) {
        if !presentation.connected {
          VStack(alignment: .leading, spacing: 4) {
            Text(presentation.title).font(.system(size: 15, weight: .semibold))
            Text(presentation.detail).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(.horizontal, 6)
        }
        if presentation.signingIn {
          Approval(model: model)
        } else if !presentation.starting && !presentation.connected {
          HStack(spacing: 6) {
            // A saved sign-in resumes with Reconnect; signing in again is the fallback.
            if snapshot?.canReconnect == true {
              Button("Reconnect") { Task { await model.perform(.reconnect) } }
                .buttonStyle(.borderedProminent)
              SignInButton(model: model).buttonStyle(.bordered)
            } else {
              SignInButton(model: model).buttonStyle(.borderedProminent)
            }
          }
          .controlSize(.regular)
          .padding(.horizontal, 6)
        }
        if !presentation.starting && !presentation.signingIn {
          if model.apps != nil { AppList(model: model, actions: actions) }
          if snapshot?.canSignOut == true {
            // The web app's root opens this account's Apps, where adding an app starts.
            Button("Add app…") { actions.open(model.webOrigin) }
              .buttonStyle(.bordered)
              .controlSize(.small)
              .padding(.horizontal, 6)
              .help("Opens Apps in your browser")
          }
          VStack(spacing: 0) {
            if presentation.connected || presentation.hasSetup {
              NavRow(symbol: "terminal", title: "Connect your agents", detail: agentsDetail) {
                model.page = .agents
              }
            }
            NavRow(symbol: "network", title: "Connection", detail: connectionDetail) {
              model.page = .connection
            }
          }
        }
        if let message = model.message, !model.reviewing { NoticeView(notice: message) }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 10)
    }
  }

  private var agentsDetail: String {
    return switch (model.configured.claude, model.configured.codex) {
    case (true, true): "Claude Code and Codex use this connection"
    case (true, false): "Claude Code uses this connection"
    case (false, true): "Codex uses this connection"
    case (false, false): "Set up Claude Code or Codex"
    }
  }

  private var connectionDetail: String {
    guard let view = model.snapshot?.connection else { return "Not signed in" }
    if let display = view.display { return "\(display.account.email) · \(display.pool.name)" }
    return view.mode == .direct ? "Direct credentials" : model.presentation.statusLabel
  }
}

struct Approval: View {
  let model: PanelModel
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let authorization = model.snapshot?.authorization {
        HStack(spacing: 6) {
          Text("Confirmation code")
          Text(authorization.code)
            .font(.system(size: 15, weight: .semibold, design: .monospaced))
            .textSelection(.enabled)
        }
        Text(authorization.url)
          .font(.system(size: 11)).foregroundStyle(.secondary)
          .textSelection(.enabled).lineLimit(2)
        Button("Open browser") { Task { await model.perform(.openApproval) } }
          .buttonStyle(.borderedProminent)
      } else {
        Text("Preparing browser approval…").foregroundStyle(.secondary)
      }
      Button("Cancel sign-in") { Task { await model.perform(.cancelSignIn) } }
        .buttonStyle(.plain).foregroundStyle(.secondary)
    }
    .card()
  }
}

/// The read-only app summary. Rows open the app in the browser, where all editing happens.
struct AppList: View {
  @Bindable var model: PanelModel
  let actions: PanelActions

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if !(model.apps?.apps.isEmpty ?? true) {
        TextField("Search apps", text: $model.appQuery)
          .textFieldStyle(.roundedBorder)
          .padding(.horizontal, 6)
          .padding(.bottom, 2)
      }
      if model.listedApps.isEmpty {
        Text(model.appQuery.isEmpty ? "No apps yet." : "No apps match.")
          .font(.system(size: 12)).foregroundStyle(.secondary)
          .padding(.horizontal, 6).padding(.vertical, 4)
      }
      ScrollView {
        VStack(spacing: 0) {
          ForEach(model.listedApps) { app in
            NavRow(
              symbol: nil, letter: String(app.name.prefix(1)).uppercased(), title: app.name,
              detail: app.detail,
              trailing: app.accounts == 0 ? "Connect" : "›"
            ) {
              if let url = model.webURL(for: app) { actions.open(url) }
            }
          }
        }
      }
      .frame(maxHeight: 240)
      .scrollBounceBehavior(.basedOnSize)
    }
  }
}
