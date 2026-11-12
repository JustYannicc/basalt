import Foundation
import Observation

/// What the panel shows for one snapshot. Copy matches the Electron window it replaces.
public struct Presentation: Equatable, Sendable {
  public enum Status: Equatable, Sendable {
    case connected, offline, waiting, signInRequired, revoked, disconnected, starting
  }
  public var title: String
  public var detail: String
  public var status: Status
  public var statusLabel: String
  public var starting: Bool
  public var signingIn: Bool
  public var connected: Bool
  public var hasSetup: Bool
  public var modelAccess: Bool
  public var toolAccess: Bool

  public init(_ snapshot: DesktopSnapshot?) {
    let view = snapshot?.connection
    let offline = view?.health?.state == .offline
    let connected = view?.state == .connected && !offline
    let signing = snapshot?.phase == .signingIn
    let starting = snapshot == nil || snapshot?.phase == .starting
    let models = view?.capabilities.contains("models") ?? false
    let tools = view?.capabilities.contains("tools") ?? false
    self.starting = starting
    self.signingIn = signing
    self.connected = connected
    self.modelAccess = models
    self.toolAccess = tools
    self.hasSetup = (snapshot?.configured.claude ?? false) || (snapshot?.configured.codex ?? false)
    title =
      if starting { "Starting your connection" }
      else if signing { "Approve this device" }
      else if offline { "You're offline" }
      else if connected { "You're connected" }
      else if view?.state == .revoked { "This device was revoked" }
      else if view?.state == .disconnected || snapshot?.canReconnect == true { "Disconnected" }
      else { "Connect your models and tools" }
    detail =
      if signing { "Finish sign-in and choose a pool in your browser. Check that the code matches." }
      else if starting { "Your saved connection and agent settings are loading." }
      else if offline {
        "Your connection is unavailable. Check your network or server, then reconnect. Your saved sign-in is kept."
      } else if connected {
        "Your agents can use \(models && tools ? "your models and tools" : models ? "your models" : "your tools")."
      } else { "Sign in with your browser, or reconnect to resume a saved connection." }
    (status, statusLabel) =
      if starting { (.starting, "Starting") }
      else if signing { (.waiting, "Waiting for browser approval") }
      else if offline { (.offline, "Offline") }
      else if connected { (.connected, "Connected") }
      else if view?.state == .signInRequired { (.signInRequired, "Sign-in required") }
      else if view?.state == .revoked { (.revoked, "Access stopped") }
      else { (.disconnected, "Disconnected") }
  }
}

public enum Page: Equatable, Sendable { case home, connection, agents }

/// A panel message. Errors from the connection itself arrive in `DesktopSnapshot.error`.
public struct Notice: Equatable, Sendable {
  public var text: String
  public var isError: Bool
  public static func info(_ text: String) -> Notice { Notice(text: text, isError: false) }
  public static func error(_ text: String) -> Notice { Notice(text: text, isError: true) }
}

extension DesktopSnapshot.Configured {
  public static let none = Self(claude: false, codex: false)
}

@MainActor
@Observable
public final class PanelModel {
  public typealias Send = @MainActor (DesktopRequest, URL?) async throws -> DesktopReply

  public static let defaultServer = "https://app.signalbox.run"
  static let unresponsive = Notice.error(
    "The connection stopped responding. Quit and reopen Signalbox to recover.")
  public private(set) var snapshot: DesktopSnapshot?
  /// Stored so a poll that changes only health timestamps doesn't redraw the menu bar.
  public private(set) var presentation = Presentation(nil)
  public private(set) var busy = false
  public var page: Page = .home
  public var notice: Notice?
  public var preview: SetupPreview?
  /// The last list the server returned; a failed refresh keeps it rather than flashing empty.
  public private(set) var apps: AppSummary?
  public var appQuery = ""
  @ObservationIgnored private var appsLoading = false
  @ObservationIgnored private var appsGeneration = 0
  public var reviewing = false
  public var confirmRevoke = false
  public var selection = AgentSelection(claude: .undo, codex: .undo)
  public var server = PanelModel.defaultServer
  public let machineName: String
  /// The app shell points this at its host process once that exists.
  @ObservationIgnored public var send: Send
  @ObservationIgnored private var initialized = false
  @ObservationIgnored private var generation = 0

  public init(machineName: String, snapshot: DesktopSnapshot? = nil, send: @escaping Send) {
    self.machineName = machineName
    self.send = send
    if let snapshot { receive(snapshot) }
  }

  public var configured: DesktopSnapshot.Configured { snapshot?.configured ?? .none }

  /// The panel's own notice wins; otherwise the connection's last error shows.
  public var message: Notice? { notice ?? snapshot?.error.map(Notice.error) }

  /// The web app this device belongs to; the browser owns everything beyond this panel.
  public var webOrigin: URL {
    URL(string: snapshot?.connection?.origin ?? server) ?? URL(string: Self.defaultServer)!
  }

  public var canReview: Bool {
    return selection.claude == .connect || selection.codex == .connect
      || (configured.claude && selection.claude == .undo)
      || (configured.codex && selection.codex == .undo)
  }

  public func refresh() async {
    guard !busy else { return }
    generation += 1
    let current = generation
    do {
      let reply = try await send(.status, nil)
      if current == generation { receive(reply.snapshot) }
      if notice == Self.unresponsive { notice = nil }
    } catch {
      setNotice(Self.unresponsive)
    }
  }

  /// Only the open panel asks. A reply that lands after sign-out or revoke is dropped.
  public func refreshApps() async {
    guard presentation.connected, presentation.toolAccess else {
      if apps != nil { apps = nil }
      return
    }
    guard !appsLoading else { return }
    appsLoading = true
    defer { appsLoading = false }
    let generation = appsGeneration
    guard let reply = try? await send(.apps, nil), let next = reply.apps,
      generation == appsGeneration, snapshot?.canSignOut == true,
      snapshot?.connection?.state != .revoked
    else { return }
    if apps != next { apps = next }
  }

  public var listedApps: [AppSummary.App] {
    let all = apps?.apps ?? []
    let query = appQuery.trimmingCharacters(in: .whitespaces)
    return query.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(query) }
  }

  /// Apps open in the browser; one without accounts opens where accounts are connected.
  public func webURL(for app: AppSummary.App) -> URL? {
    guard let organization = apps?.organization else { return nil }
    var url = webOrigin.appending(path: "org").appending(path: organization).appending(path: "apps")
      .appending(path: app.id)
    if app.accounts == 0 { url.append(queryItems: [URLQueryItem(name: "view", value: "accounts")]) }
    return url
  }

  public func perform(_ request: DesktopRequest, file: URL? = nil) async {
    guard !busy else { return }
    busy = true
    generation += 1
    notice = nil
    defer { busy = false }
    do {
      let reply = try await send(request, file)
      receive(reply.snapshot)
      if let preview = reply.preview { self.preview = preview }
      switch request {
      case .setupApply where reply.snapshot.error == nil:
        preview = nil
        reviewing = false
        resetSelection(reply.snapshot.configured)
        notice = .info(
          "Agent settings updated. Restart the selected agents to use the change. Backups are kept.")
      case .cancelPreview:
        reviewing = false
        preview = nil
      case .revoke:
        confirmRevoke = false
      default: break
      }
    } catch {
      notice = .error("This action could not finish. Check the connection and try again.")
    }
  }

  public func review(undo: Bool) async {
    reviewing = true
    preview = nil
    await perform(undo ? .undoPreview : .setupPreview(selection))
  }

  public func choose(_ choice: AgentChoice, for agent: WritableKeyPath<AgentSelection, AgentChoice>) async {
    selection[keyPath: agent] = choice
    preview = nil
    reviewing = false
    await perform(.cancelPreview)
  }

  /// Shell-side failures, such as the host process exiting.
  public func setNotice(_ value: Notice?) {
    if notice != value { notice = value }
  }

  private func receive(_ value: DesktopSnapshot) {
    if snapshot != value { snapshot = value }
    let next = Presentation(value)
    if presentation != next { presentation = next }
    if !value.canSignOut || value.connection?.state == .revoked {
      appsGeneration += 1
      if apps != nil { apps = nil }
    }
    if !initialized && value.phase != .starting {
      initialized = true
      resetSelection(value.configured)
      if let origin = value.connection?.origin { server = origin }
    }
  }

  private func resetSelection(_ configured: DesktopSnapshot.Configured) {
    selection = AgentSelection(
      claude: configured.claude ? .keep : .undo, codex: configured.codex ? .keep : .undo)
  }
}

extension AppSummary.App {
  /// "2 accounts · Cloud", as the approved panel shows where an app's accounts run. Every account
  /// runs in the cloud until accounts on this Mac exist.
  public var detail: String {
    accounts == 0 ? "No accounts" : "\(accounts) account\(accounts == 1 ? "" : "s") · Cloud"
  }
}
