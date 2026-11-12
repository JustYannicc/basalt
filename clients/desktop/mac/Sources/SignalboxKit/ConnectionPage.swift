import SwiftUI

struct ConnectionPage: View {
  @Bindable var model: PanelModel
  let actions: PanelActions

  var body: some View {
    let presentation = model.presentation
    let snapshot = model.snapshot
    let view = snapshot?.connection
    VStack(alignment: .leading, spacing: 0) {
      Header(title: "Connection", back: { model.page = .home }, backTitle: model.homeTitle)
      VStack(alignment: .leading, spacing: 12) {
        Text("Connection").font(.system(size: 15, weight: .semibold)).padding(.horizontal, 6)
        if view != nil {
          Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
            GridRow {
              Text("Account").foregroundStyle(.secondary)
              VStack(alignment: .leading, spacing: 1) {
                Text(
                  view?.display?.account.name.nonEmpty
                    ?? (view?.mode == .direct ? "Direct credentials" : "Account details unavailable"))
                if let display = view?.display, display.account.email != display.account.name {
                  Text(display.account.email).font(.system(size: 11)).foregroundStyle(.secondary)
                }
              }
            }
            GridRow {
              Text("Models from").foregroundStyle(.secondary)
              VStack(alignment: .leading, spacing: 2) {
                Text(modelsFrom(view, presentation))
                if view?.mode == .device {
                  Button("Choose pool in browser") {
                    Task { await model.perform(.signIn(origin: view?.origin ?? model.server)) }
                  }
                  .buttonStyle(.link)
                  .font(.system(size: 12))
                }
              }
            }
            GridRow {
              Text("Tools").foregroundStyle(.secondary)
              Text(
                presentation.toolAccess
                  ? "Your connected apps"
                  : presentation.connected
                    ? "Not included in this connection" : "Available after reconnecting")
            }
          }
          .padding(.horizontal, 6)
        }
        HStack(spacing: 6) {
          if snapshot?.canReconnect == true {
            Button("Reconnect") { Task { await model.perform(.reconnect) } }
              .disabled(presentation.connected)
          }
          if view?.state == .connected {
            Button("Disconnect") { Task { await model.perform(.disconnect) } }
          }
          if !presentation.connected && !presentation.signingIn {
            SignInButton(model: model)
          }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.horizontal, 6)
        Toggle("Open at login", isOn: actions.openAtLogin)
          .toggleStyle(.checkbox)
          .padding(.horizontal, 6)
        UpdateRow(updates: actions.updates)
          .padding(.horizontal, 6)
        DisclosureGroup("Connection details") {
          VStack(alignment: .leading, spacing: 8) {
            if let origin = snapshot?.localOrigin {
              Text("Models \(origin)/v1\nTools \(origin)/mcp")
                .font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
            }
            Text(
              "Each agent uses its own local credential. Remote credentials stay in the macOS Keychain."
            )
            .font(.system(size: 12)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            LabeledContent("Server address") {
              TextField("Server address", text: $model.server).labelsHidden()
                .textFieldStyle(.roundedBorder)
            }
            Button("Import a private direct-credentials file") {
              if let file = actions.chooseDirectFile() {
                Task { await model.perform(.importDirect, file: file) }
              }
            }
            .buttonStyle(.link).font(.system(size: 12))
          }
          .padding(.top, 6)
        }
        .padding(.horizontal, 6)
        if let message = model.message { NoticeView(notice: message) }
        if model.confirmRevoke {
          VStack(alignment: .leading, spacing: 8) {
            Text(
              "Revoke this device? Models and tools will stop working here. Your other devices stay connected."
            )
            .fixedSize(horizontal: false, vertical: true)
            HStack {
              Button("Revoke device", role: .destructive) { Task { await model.perform(.revoke) } }
              Button("Keep device") { model.confirmRevoke = false }
            }
            .controlSize(.small)
          }
          .card()
        } else if snapshot?.canSignOut == true && !presentation.signingIn {
          HStack {
            Button("Sign out") { Task { await model.perform(.signOut) } }
            if view?.mode == .device && snapshot?.canReconnect == true {
              Button("Revoke this device") { model.confirmRevoke = true }
                .foregroundStyle(.red)
            }
          }
          .buttonStyle(.plain)
          .font(.system(size: 12))
          .padding(.horizontal, 6)
        }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 12)
    }
  }

  private func modelsFrom(_ view: ConnectionView?, _ presentation: Presentation) -> String {
    if presentation.connected && !presentation.modelAccess { return "Not included in this connection" }
    if let pool = view?.display?.pool.name.nonEmpty { return pool }
    return view?.mode == .direct ? "Your direct key" : "Reconnect to load pool details"
  }
}

/// Updates install on their own; this is for checking now. Disabled while one is under way.
struct UpdateRow: View {
  let updates: AppUpdates
  var body: some View {
    HStack(spacing: 8) {
      Button("Check for Updates…") { updates.check() }
        .buttonStyle(.link)
        .font(.system(size: 12))
        .disabled(!updates.canCheck)
      Text("Version \(updates.version)")
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
    }
  }
}

extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}
