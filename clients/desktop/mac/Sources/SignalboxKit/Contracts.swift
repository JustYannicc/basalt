import Foundation

// Mirrors clients/desktop/contracts.ts. host.mjs validates every request with the same schema.

public struct DesktopSnapshot: Codable, Equatable, Sendable {
  public enum Phase: String, Codable, Sendable { case starting, ready, signingIn = "signing-in" }
  public struct Configured: Codable, Equatable, Sendable {
    public var claude: Bool
    public var codex: Bool
    public init(claude: Bool, codex: Bool) {
      self.claude = claude
      self.codex = codex
    }
  }
  public struct Authorization: Codable, Equatable, Sendable {
    public var url: String
    public var code: String
    public init(url: String, code: String) {
      self.url = url
      self.code = code
    }
  }
  public var connection: ConnectionView?
  public var phase: Phase
  public var configured: Configured
  public var canReconnect: Bool
  public var canSignOut: Bool
  public var localOrigin: String?
  public var authorization: Authorization?
  public var error: String?

  public init(
    connection: ConnectionView? = nil, phase: Phase, configured: Configured,
    canReconnect: Bool, canSignOut: Bool, localOrigin: String? = nil,
    authorization: Authorization? = nil, error: String? = nil
  ) {
    self.connection = connection
    self.phase = phase
    self.configured = configured
    self.canReconnect = canReconnect
    self.canSignOut = canSignOut
    self.localOrigin = localOrigin
    self.authorization = authorization
    self.error = error
  }
}

public struct ConnectionView: Codable, Equatable, Sendable {
  public enum State: String, Codable, Sendable {
    case connected, disconnected, signInRequired = "sign-in-required", revoked
  }
  public enum Mode: String, Codable, Sendable { case direct, device }
  public struct Pool: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) {
      self.id = id
      self.name = name
    }
  }
  public struct Account: Codable, Equatable, Sendable {
    public var name: String
    public var email: String
    public var emailVerified: Bool
    public init(name: String, email: String, emailVerified: Bool) {
      self.name = name
      self.email = email
      self.emailVerified = emailVerified
    }
  }
  public struct Display: Codable, Equatable, Sendable {
    public var account: Account
    public var pool: Pool
    public var pools: [Pool]
    public init(account: Account, pool: Pool, pools: [Pool]) {
      self.account = account
      self.pool = pool
      self.pools = pools
    }
  }
  public struct Health: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case online, offline }
    public var state: State
    public var checkedAt: Int
    public init(state: State, checkedAt: Int) {
      self.state = state
      self.checkedAt = checkedAt
    }
  }
  public var state: State
  public var mode: Mode
  public var capabilities: [String]
  public var display: Display?
  public var origin: String?
  public var health: Health?

  public init(
    state: State, mode: Mode, capabilities: [String], display: Display? = nil,
    origin: String? = nil, health: Health? = nil
  ) {
    self.state = state
    self.mode = mode
    self.capabilities = capabilities
    self.display = display
    self.origin = origin
    self.health = health
  }
}

public struct SetupPreview: Codable, Equatable, Sendable {
  public struct File: Codable, Equatable, Sendable, Identifiable {
    public enum Action: String, Codable, Sendable { case update, restore, keep }
    public var kind: String
    public var path: String
    public var action: Action
    public var fields: [String]
    public var id: String { path }
    public init(kind: String, path: String, action: Action, fields: [String]) {
      self.kind = kind
      self.path = path
      self.action = action
      self.fields = fields
    }
  }
  public var id: String
  public var files: [File]
  public init(id: String, files: [File]) {
    self.id = id
    self.files = files
  }
}

public struct DesktopReply: Codable, Equatable, Sendable {
  public var snapshot: DesktopSnapshot
  public var preview: SetupPreview?
}

public enum AgentChoice: String, Codable, Sendable, CaseIterable { case connect, keep, undo }
public struct AgentSelection: Codable, Equatable, Sendable {
  public var claude: AgentChoice
  public var codex: AgentChoice
  public init(claude: AgentChoice, codex: AgentChoice) {
    self.claude = claude
    self.codex = codex
  }
}

public enum DesktopRequest: Equatable, Sendable, Encodable {
  case status, cancelSignIn, openApproval, disconnect, reconnect, signOut, revoke
  case undoPreview, cancelPreview, importDirect
  case signIn(origin: String)
  case setupPreview(AgentSelection)
  case setupApply(id: String)

  public var action: String {
    switch self {
    case .status: "status"
    case .cancelSignIn: "cancel-sign-in"
    case .openApproval: "open-approval"
    case .disconnect: "disconnect"
    case .reconnect: "reconnect"
    case .signOut: "sign-out"
    case .revoke: "revoke"
    case .undoPreview: "undo-preview"
    case .cancelPreview: "cancel-preview"
    case .importDirect: "import-direct"
    case .signIn: "sign-in"
    case .setupPreview: "setup-preview"
    case .setupApply: "setup-apply"
    }
  }

  private enum Keys: String, CodingKey { case action, origin, selection, id }
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: Keys.self)
    try container.encode(action, forKey: .action)
    switch self {
    case .signIn(let origin): try container.encode(origin, forKey: .origin)
    case .setupPreview(let selection): try container.encode(selection, forKey: .selection)
    case .setupApply(let id): try container.encode(id, forKey: .id)
    default: break
    }
  }
}
