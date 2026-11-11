import Foundation

/// Synthetic panel states for snapshots and tests. No real account, host or credential.
public enum Fixture: String, CaseIterable, Sendable {
  case starting, signedOut, approval, connected, connectedNoAgents, offline, revoked, disconnected
  case connection, revokeConfirm, agentsReview, failure

  static let display = ConnectionView.Display(
    account: .init(name: "Alex Example", email: "alex@example.com", emailVerified: true),
    pool: .init(id: "pool-1", name: "Alex's pool"), pools: [.init(id: "pool-1", name: "Alex's pool")])

  static func view(_ state: ConnectionView.State, health: ConnectionView.Health.State = .online)
    -> ConnectionView
  {
    ConnectionView(
      state: state, mode: .device, capabilities: ["models", "tools"], display: display,
      origin: "https://signalbox.example", health: .init(state: health, checkedAt: 0))
  }

  public var snapshot: DesktopSnapshot {
    let both = DesktopSnapshot.Configured(claude: true, codex: true)
    let none = DesktopSnapshot.Configured(claude: false, codex: false)
    let local = "http://127.0.0.1:58215"
    return switch self {
    case .starting:
      .init(phase: .starting, configured: none, canReconnect: false, canSignOut: false)
    case .signedOut:
      .init(phase: .ready, configured: none, canReconnect: false, canSignOut: false)
    case .approval:
      .init(
        phase: .signingIn, configured: none, canReconnect: false, canSignOut: false,
        authorization: .init(url: "https://signalbox.example/device?code=BCDF-GHJK", code: "BCDF-GHJK"))
    case .connected, .connection, .revokeConfirm, .agentsReview:
      .init(
        connection: Self.view(.connected), phase: .ready, configured: both, canReconnect: true,
        canSignOut: true, localOrigin: local)
    case .connectedNoAgents:
      .init(
        connection: Self.view(.connected), phase: .ready, configured: none, canReconnect: true,
        canSignOut: true, localOrigin: local)
    case .offline:
      .init(
        connection: Self.view(.connected, health: .offline), phase: .ready, configured: both,
        canReconnect: true, canSignOut: true, localOrigin: local)
    case .revoked:
      .init(
        connection: Self.view(.revoked), phase: .ready, configured: both, canReconnect: false,
        canSignOut: true)
    case .disconnected:
      .init(
        connection: Self.view(.disconnected), phase: .ready, configured: both, canReconnect: true,
        canSignOut: true)
    case .failure:
      .init(
        connection: Self.view(.disconnected), phase: .ready, configured: both, canReconnect: true,
        canSignOut: true,
        error:
          "The connection action could not finish. Check your sign-in and unlock your credential store, then retry.")
    }
  }

  @MainActor
  public func model() -> PanelModel {
    let snapshot = snapshot
    let model = PanelModel(machineName: "Alex's MacBook", snapshot: snapshot) { _, _ in
      DesktopReply(snapshot: snapshot, preview: nil)
    }
    model.server = "https://signalbox.example"
    switch self {
    case .connection: model.page = .connection
    case .revokeConfirm:
      model.page = .connection
      model.confirmRevoke = true
    case .agentsReview:
      model.page = .agents
      model.selection = .init(claude: .connect, codex: .keep)
      model.reviewing = true
      model.preview = SetupPreview(
        id: "preview-1",
        files: [
          .init(kind: "claude", path: "~/.claude.json", action: .update, fields: ["mcpServers.signalbox"]),
          .init(kind: "claude", path: "~/.claude/settings.json", action: .update, fields: ["env.ANTHROPIC_BASE_URL"]),
          .init(kind: "codex", path: "~/.codex/config.toml", action: .keep, fields: []),
        ])
    default: break
    }
    return model
  }
}
