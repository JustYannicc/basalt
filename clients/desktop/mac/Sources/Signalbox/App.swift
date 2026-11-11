import AppKit
import ServiceManagement
import SignalboxKit
import SwiftUI

@main
struct SignalboxApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra {
      PanelView(model: delegate.shell.model, actions: delegate.shell.actions)
        .onAppear { delegate.shell.panelVisible(true) }
        .onDisappear { delegate.shell.panelVisible(false) }
    } label: {
      MenuBarIcon(model: delegate.shell.model)
    }
    .menuBarExtraStyle(.window)
  }
}

/// Its own view, so status changes redraw only the icon, not the scene.
struct MenuBarIcon: View {
  let model: PanelModel
  var body: some View {
    let status = model.presentation
    Image(
      systemName: status.status == .connected
        ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash"
    )
    .accessibilityLabel("Signalbox, \(status.statusLabel)")
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let shell = Shell()

  func applicationDidFinishLaunching(_ notification: Notification) {
    // A write to a host that just exited must fail the request, not terminate the app.
    signal(SIGPIPE, SIG_IGN)
    shell.start()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    Task {
      await shell.stop()
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}

@MainActor
final class Shell {
  let location: HostLocation
  /// A separate --home is a test profile; it never registers the login item.
  let defaultProfile: Bool
  let model: PanelModel
  private var host: HostProcess?
  private var poller: Task<Void, Never>?
  private var appsTask: Task<Void, Never>?
  private var visible = false

  init() {
    location = HostLocation.resolve(bundle: .main, arguments: CommandLine.arguments)
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    defaultProfile = location.home == HostLocation.defaultHome(applicationSupport: support)
    model = PanelModel(machineName: Host.current().localizedName ?? "This Mac") { _, _ in
      throw HostError.stopped
    }
    model.send = { [weak self] request, file in
      guard let host = self?.host else { throw HostError.stopped }
      return try await host.send(request, file: file)
    }
  }

  var actions: PanelActions {
    PanelActions(
      open: { NSWorkspace.shared.open($0) },
      chooseDirectFile: {
        let panel = NSOpenPanel()
        panel.title = "Import direct credentials"
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        NSApp.activate()
        return panel.runModal() == .OK ? panel.url : nil
      },
      quit: { NSApp.terminate(nil) },
      openAtLogin: Binding(
        get: { SMAppService.mainApp.status == .enabled },
        set: { [weak self] in self?.setLoginItem($0) }))
  }

  func start() {
    // Agents need the connection after a restart, so the first launch opens at login; the
    // Connection page turns it off.
    if defaultProfile, !UserDefaults.standard.bool(forKey: "loginItemEnabledOnFirstLaunch") {
      UserDefaults.standard.set(true, forKey: "loginItemEnabledOnFirstLaunch")
      setLoginItem(true)
    }
    let process = HostProcess(location: location)
    process.onExit = { [weak self] in
      self?.host = nil
      self?.poller?.cancel()
      self?.appsTask?.cancel()
      self?.model.setNotice(.error("Signalbox's connection stopped. Quit and reopen Signalbox."))
    }
    do {
      try process.start()
      host = process
    } catch {
      model.setNotice(.error("Signalbox couldn't start its connection. Reinstall the app, then reopen it."))
      return
    }
    poll()
  }

  /// Opening the panel refreshes at once; while it's open, status follows every 2 seconds.
  func panelVisible(_ value: Bool) {
    visible = value
    if value, host != nil { poll() }
  }

  func stop() async {
    poller?.cancel()
    appsTask?.cancel()
    await host?.stop()
  }

  private func poll() {
    poller?.cancel()
    poller = Task { [weak self] in
      // The app list is a server read, so it refreshes on open and then every 30 seconds while
      // the panel stays open; a closed panel never asks for it.
      var appsRead = ContinuousClock.now - .seconds(60)
      while !Task.isCancelled, let self {
        await self.model.refresh()
        if self.visible, ContinuousClock.now - appsRead >= .seconds(30) {
          appsRead = .now
          // Its own task, so a slow server never holds up the status line.
          self.appsTask = Task { await self.model.refreshApps() }
        }
        try? await Task.sleep(for: self.visible ? .seconds(2) : .seconds(30))
      }
    }
  }

  private func setLoginItem(_ on: Bool) {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      model.setNotice(.error("Open at login couldn't change. Check Login Items in System Settings."))
    }
  }
}
