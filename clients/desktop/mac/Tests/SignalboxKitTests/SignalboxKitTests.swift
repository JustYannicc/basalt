import Foundation
import Testing

@testable import SignalboxKit

@Suite struct Contracts {
  @Test("decodes the host's snapshot shape") func decodesTheHostsSnapshotShape() throws {
    let line = #"""
      {"id":3,"reply":{"snapshot":{"phase":"signing-in","configured":{"claude":true,"codex":false},"canReconnect":false,"canSignOut":true,"authorization":{"url":"https://s.example/a","code":"BCDF-GHJK"},"connection":{"state":"sign-in-required","mode":"device","capabilities":["models"],"health":{"state":"offline","checkedAt":5}}},"preview":{"id":"p","files":[{"kind":"claude","path":"/x","action":"restore","fields":["a"]}]}}}
      """#
    guard case .reply(let id, let reply) = HostMessage.decode(line) else {
      Issue.record("Expected a reply")
      return
    }
    #expect(id == 3)
    #expect(reply.snapshot.phase == .signingIn)
    #expect(reply.snapshot.connection?.state == .signInRequired)
    #expect(reply.snapshot.connection?.health?.state == .offline)
    #expect(reply.preview?.files.first?.action == .restore)
  }

  @Test("separates failures from noise") func separatesFailuresFromNoise() {
    #expect(HostMessage.decode(#"{"id":4,"error":"failed"}"#) == .failed(4))
    #expect(HostMessage.decode(#"{"id":5,"error":"refused"}"#) == .failed(5))
    #expect(HostMessage.decode(#"{"error":"refused"}"#) == .ignored)
    #expect(HostMessage.decode("not json") == .ignored)
  }

  /// The same lines are decoded by host.ts's schema in clients/e2e/mac-host.test.ts.
  static let sharedLines: [String] = {
    let file = URL(filePath: #filePath).deletingLastPathComponent()
      .appending(path: "../../../host-messages.json").standardizedFileURL
    return (try? JSONDecoder().decode([String].self, from: Data(contentsOf: file))) ?? []
  }()

  static let sharedRequests: [(DesktopRequest, URL?)] = [
    (.status, nil), (.apps, nil), (.signIn(origin: "https://s.example"), nil),
    (.setupPreview(.init(claude: .connect, codex: .keep)), nil), (.setupApply(id: "p"), nil),
    (.cancelSignIn, nil), (.importDirect, URL(filePath: "/private/keys.json")),
  ]

  @Test("encodes exactly the lines the host schema accepts", arguments: 0..<7)
  func encodesTheSharedLines(index: Int) throws {
    let lines = Self.sharedLines
    try #require(lines.count == Self.sharedRequests.count)
    let (request, file) = Self.sharedRequests[index]
    let data = try HostMessage.encode(id: file == nil ? 1 : 2, request: request, file: file)
    #expect(String(decoding: data, as: UTF8.self) == lines[index] + "\n")
  }
}

@Suite struct Location {
  @Test("keeps the Electron profile path that keys the Keychain entry") func keepsTheElectronProfilePathThatKeysTheKeychainEntry() {
    let home = HostLocation.defaultHome(
      applicationSupport: URL(filePath: "/Users/alex/Library/Application Support", directoryHint: .isDirectory))
    #expect(home.path(percentEncoded: false) == "/Users/alex/Library/Application Support/Signalbox Client/connection/")
  }

  @Test("test profiles override home and agent config") func testProfilesOverrideHomeAndAgentConfig() {
    let bundle = Bundle.main
    let location = HostLocation.resolve(
      bundle: bundle, arguments: ["app", "--home", "/tmp/p", "--config-home", "/tmp/c"])
    #expect(location.home.path(percentEncoded: false) == "/tmp/p/")
    #expect(location.arguments.suffix(4) == ["--home", "/tmp/p/", "--config-home", "/tmp/c/"])
  }
}

@Suite struct Presentations {
  @Test("matches the Electron window's states", arguments: [
    (Fixture.starting, "Starting your connection", Presentation.Status.starting),
    (.signedOut, "Connect your models and tools", .disconnected),
    (.approval, "Approve this device", .waiting),
    (.connected, "You're connected", .connected),
    (.offline, "You're offline", .offline),
    (.revoked, "This device was revoked", .revoked),
    (.disconnected, "Disconnected", .disconnected),
  ])
  func matchesTheElectronWindowsStates(fixture: Fixture, title: String, status: Presentation.Status) {
    let presentation = Presentation(fixture.snapshot)
    #expect(presentation.title == title)
    #expect(presentation.status == status)
  }
}

@MainActor
@Suite struct Model {
  @Test("applying setup clears the review and resets choices") func applyingSetupClearsTheReviewAndResetsChoices() async {
    let configured = DesktopSnapshot(
      phase: .ready, configured: .init(claude: true, codex: false), canReconnect: true, canSignOut: true)
    var sent: [String] = []
    let model = PanelModel(machineName: "Mac", snapshot: Fixture.connectedNoAgents.snapshot) { request, _ in
      sent.append(request.action)
      return DesktopReply(snapshot: configured, preview: nil)
    }
    model.selection = .init(claude: .connect, codex: .undo)
    model.reviewing = true
    model.preview = SetupPreview(id: "p", files: [])
    await model.perform(.setupApply(id: "p"))
    #expect(sent == ["setup-apply"])
    #expect(!model.reviewing && model.preview == nil)
    #expect(model.selection == .init(claude: .keep, codex: .undo))
    #expect(model.notice == .info("Agent settings updated. Restart the selected agents to use the change. Backups are kept."))
  }

  @Test("a stopped host becomes a visible notice") func aStoppedHostBecomesAVisibleNotice() async {
    let model = PanelModel(machineName: "Mac") { _, _ in throw HostError.stopped }
    await model.refresh()
    #expect(model.notice?.isError == true)
    #expect(model.notice?.text.contains("stopped responding") == true)
    await model.perform(.reconnect)
    #expect(model.message?.text.contains("could not finish") == true)
  }

  @Test("a recovered host clears its stopped notice") func aRecoveredHostClearsItsStoppedNotice() async {
    var fail = true
    let model = PanelModel(machineName: "Mac") { _, _ in
      if fail { throw HostError.stopped }
      return DesktopReply(snapshot: Fixture.connected.snapshot, preview: nil)
    }
    await model.refresh()
    #expect(model.notice?.isError == true)
    fail = false
    await model.refresh()
    #expect(model.notice == nil)
  }

  @Test("the app list loads, filters and links into the browser") func appListLoadsFiltersAndLinks() async throws {
    let model = await Fixture.connected.loadedModel()
    let apps = try #require(model.apps)
    #expect(apps.apps.map(\.name) == ["Gmail", "GitHub", "Postgres", "Linear"])
    model.appQuery = "git"
    #expect(model.listedApps.map(\.id) == ["github"])
    let github = try #require(model.listedApps.first)
    #expect(model.webURL(for: github)?.absoluteString == "https://signalbox.example/org/org-1/apps/github")
    let linear = try #require(apps.apps.last)
    #expect(model.webURL(for: linear)?.absoluteString == "https://signalbox.example/org/org-1/apps/linear?view=accounts")
  }

  @Test("signing out drops the app list; a failed read keeps it") func appListLifecycle() async {
    var reply = DesktopReply(snapshot: Fixture.connected.snapshot, apps: Fixture.appList)
    var fail = false
    let model = PanelModel(machineName: "Mac", snapshot: Fixture.connected.snapshot) { _, _ in
      if fail { throw HostError.stopped }
      return reply
    }
    await model.refreshApps()
    #expect(model.apps == Fixture.appList)
    fail = true
    await model.refreshApps()
    #expect(model.apps == Fixture.appList)
    fail = false
    reply = DesktopReply(snapshot: Fixture.signedOut.snapshot)
    await model.perform(.signOut)
    #expect(model.apps == nil)
  }

  @Test("revoking drops the app list") func revokingDropsTheAppList() async {
    var reply = DesktopReply(snapshot: Fixture.connected.snapshot, apps: Fixture.appList)
    let model = PanelModel(machineName: "Mac", snapshot: Fixture.connected.snapshot) { _, _ in reply }
    await model.refreshApps()
    #expect(model.apps != nil)
    reply = DesktopReply(snapshot: Fixture.revoked.snapshot, apps: Fixture.appList)
    await model.perform(.revoke)
    #expect(model.apps == nil)
    await model.refreshApps()
    #expect(model.apps == nil)
  }

  @Test(
    "app rows say how many accounts an app has and where they run",
    arguments: [(0, "No accounts"), (1, "1 account · Cloud"), (2, "2 accounts · Cloud")])
  func appRowsSayHowManyAccountsAndWhereTheyRun(accounts: Int, detail: String) {
    #expect(AppSummary.App(id: "a", name: "A", accounts: accounts).detail == detail)
  }

  @Test("the panel is titled Apps once the app list is known")
  func panelTitleFollowsTheAppList() async {
    #expect(Fixture.signedOut.model().homeTitle == "Signalbox")
    #expect(await Fixture.connected.loadedModel().homeTitle == "Apps")
  }

  @Test("review is offered only when something would change") func reviewIsOfferedOnlyWhenSomethingWouldChange() {
    let model = Fixture.connected.model()
    #expect(model.selection == .init(claude: .keep, codex: .keep))
    #expect(!model.canReview)
    model.selection.codex = .undo
    #expect(model.canReview)
  }

  @Test("the web app follows the signed-in server") func theWebAppFollowsTheSignedinServer() {
    #expect(Fixture.connected.model().webOrigin.absoluteString == "https://signalbox.example")
    #expect(Fixture.signedOut.model().webOrigin.absoluteString == "https://signalbox.example")
  }
}
