import CryptoKit
import Foundation
import Security
import Testing

@testable import SignalboxKit

/// Drives the packaged runtime: SIGNALBOX_APP is a built Signalbox.app, SIGNALBOX_ORIGIN a native
/// test server that approves sign-in. Uses a temporary profile and never the default one.
@MainActor
@Suite(.enabled(if: ProcessInfo.processInfo.environment["SIGNALBOX_APP"] != nil))
struct HostIntegration {
  @Test("the packaged host signs in, revokes and signs out a test profile")
  func packagedHostLifecycle() async throws {
    let environment = ProcessInfo.processInfo.environment
    let app = URL(filePath: try #require(environment["SIGNALBOX_APP"]), directoryHint: .isDirectory)
    let origin = try #require(environment["SIGNALBOX_ORIGIN"])
    let home = FileManager.default.temporaryDirectory.appending(path: "signalbox-it-\(UUID().uuidString)")
    let config = FileManager.default.temporaryDirectory.appending(path: "signalbox-it-config-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
    defer {
      // A failed run must not leave its test entry in the login keychain. The host keys the
      // entry by the SHA-256 of the home path it resolves, which has no trailing slash.
      let path = home.path(percentEncoded: false)
      let account = SHA256.hash(data: Data((path.hasSuffix("/") ? String(path.dropLast()) : path).utf8))
        .map { String(format: "%02x", $0) }.joined()
      SecItemDelete(
        [kSecClass: kSecClassGenericPassword, kSecAttrService: "Signalbox Client",
         kSecAttrAccount: account] as CFDictionary)
      try? FileManager.default.removeItem(at: home)
      try? FileManager.default.removeItem(at: config)
    }
    var location = HostLocation(
      node: app.appending(path: "Contents/Helpers/signalbox-node"),
      script: app.appending(path: "Contents/Resources/connection/host.mjs"),
      home: home, configHome: config)
    location.opensBrowser = false
    var env = environment
    env["CLAUDE_CONFIG_DIR"] = config.appending(path: ".claude").path(percentEncoded: false)
    env["CODEX_HOME"] = config.appending(path: ".codex").path(percentEncoded: false)
    let host = HostProcess(location: location, environment: env)
    try host.start()
    let model = PanelModel(machineName: "Test Mac") { request, file in
      try await host.send(request, file: file)
    }
    func wait(_ check: (Presentation) -> Bool) async throws {
      for _ in 0..<300 {
        await model.refresh()
        if check(model.presentation) { return }
        try await Task.sleep(for: .milliseconds(100))
      }
      Issue.record("Never reached the state; last: \(String(describing: model.snapshot))")
    }
    try await wait { !$0.starting }
    #expect(model.presentation.title == "Connect your models and tools")
    await model.perform(.signIn(origin: origin))
    #expect(model.presentation.signingIn)
    try await wait { $0.connected }
    #expect(model.snapshot?.connection?.display?.account.email == "alex@example.com")
    #expect(model.snapshot?.localOrigin?.hasPrefix("http://127.0.0.1:") == true)
    await model.perform(.revoke)
    #expect(model.presentation.status == .revoked)
    await model.perform(.signOut)
    #expect(model.snapshot?.canSignOut == false)
    await host.stop()
    #expect(!host.running)
  }
}
