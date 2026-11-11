import Foundation

/// Where the app finds its profile and the bundled runtime.
public struct HostLocation: Sendable, Equatable {
  public var node: URL
  public var script: URL
  public var home: URL
  public var configHome: URL
  /// Test runs turn this off so a test server's approval page never opens a browser.
  public var opensBrowser = true

  /// The Electron app's userData was "Signalbox Client". The keychain account is the SHA-256 of
  /// this exact path, so changing it would lose the saved sign-in.
  public static func defaultHome(applicationSupport: URL) -> URL {
    applicationSupport.appending(path: "Signalbox Client", directoryHint: .isDirectory)
      .appending(path: "connection", directoryHint: .isDirectory)
  }

  /// `--home` and `--config-home` select a separate profile, as the Electron app's flags did.
  public static func resolve(bundle: Bundle, arguments: [String], fileManager: FileManager = .default)
    -> HostLocation
  {
    func flag(_ name: String) -> URL? {
      guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return nil
      }
      return URL(filePath: arguments[index + 1], directoryHint: .isDirectory).standardizedFileURL
    }
    let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let resources = bundle.resourceURL ?? bundle.bundleURL
    return HostLocation(
      node: bundle.bundleURL.appending(path: "Contents/Helpers/signalbox-node"),
      script: resources.appending(path: "connection/host.mjs"),
      home: flag("--home") ?? defaultHome(applicationSupport: support),
      configHome: flag("--config-home") ?? fileManager.homeDirectoryForCurrentUser)
  }

  public var arguments: [String] {
    [script.path(percentEncoded: false), "--home", home.path(percentEncoded: false),
     "--config-home", configHome.path(percentEncoded: false)] + (opensBrowser ? [] : ["--no-browser"])
  }
}

public enum HostError: Error, Equatable { case stopped, refused }

/// Owns the host.mjs process. Requests and replies are newline-delimited JSON matched by id.
@MainActor
public final class HostProcess {
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private var nextId = 0
  private var pending: [Int: CheckedContinuation<DesktopReply, any Error>] = [:]
  private var reader: Task<Void, Never>?
  private(set) public var running = false
  public var onExit: (() -> Void)?

  public init(location: HostLocation, environment: [String: String] = ProcessInfo.processInfo.environment) {
    process.executableURL = location.node
    process.arguments = location.arguments
    process.environment = environment
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
  }

  public func start() throws {
    // The reader's end of stdout, not process exit, finishes the host, so replies written just
    // before exiting still arrive.
    try process.run()
    running = true
    let handle = output.fileHandleForReading
    reader = Task { [weak self] in
      do {
        for try await line in handle.bytes.lines { self?.receive(line) }
      } catch {}
      self?.finish()
    }
  }

  public func send(_ request: DesktopRequest, file: URL? = nil) async throws -> DesktopReply {
    guard running else { throw HostError.stopped }
    nextId += 1
    let id = nextId
    let data = try HostMessage.encode(id: id, request: request, file: file)
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      do {
        try input.fileHandleForWriting.write(contentsOf: data)
      } catch {
        pending.removeValue(forKey: id)?.resume(throwing: HostError.stopped)
      }
    }
  }

  /// Closing stdin makes the host stop the connection it started, then exit.
  public func stop() async {
    guard running else { return }
    try? input.fileHandleForWriting.close()
    let deadline = Date.now.addingTimeInterval(8)
    while process.isRunning && Date.now < deadline { try? await Task.sleep(for: .milliseconds(50)) }
    if process.isRunning { process.terminate() }
    finish()
  }

  private func receive(_ line: String) {
    switch HostMessage.decode(line) {
    case .reply(let id, let reply): pending.removeValue(forKey: id)?.resume(returning: reply)
    case .failed(let id): pending.removeValue(forKey: id)?.resume(throwing: HostError.refused)
    case .ignored: break
    }
  }

  private func finish() {
    guard running else { return }
    running = false
    for continuation in pending.values { continuation.resume(throwing: HostError.stopped) }
    pending.removeAll()
    onExit?()
  }
}

public enum HostMessage: Equatable {
  case reply(Int, DesktopReply)
  case failed(Int)
  case ignored

  private struct Outgoing: Encodable {
    var id: Int
    var request: DesktopRequest
    var file: String?
  }

  public static func encode(id: Int, request: DesktopRequest, file: URL?) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    var data = try encoder.encode(
      Outgoing(id: id, request: request, file: file?.path(percentEncoded: false)))
    data.append(0x0A)
    return data
  }

  public static func decode(_ line: String) -> HostMessage {
    struct Incoming: Decodable {
      var id: Int?
      var reply: DesktopReply?
      var error: String?
    }
    guard let value = try? JSONDecoder().decode(Incoming.self, from: Data(line.utf8)) else {
      return .ignored
    }
    guard let id = value.id else { return .ignored }
    if let reply = value.reply { return .reply(id, reply) }
    return value.error == nil ? .ignored : .failed(id)
  }
}
