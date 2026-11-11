import AppKit
import SignalboxKit
import SwiftUI

// Renders every fixture state offscreen to PNGs. The window is never ordered in, so nothing
// appears on screen; system materials need a visible window, so the panel uses its solid
// window background here.
let output = URL(filePath: CommandLine.arguments.dropFirst().first ?? "snapshots", directoryHint: .isDirectory)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

@MainActor
func render(_ fixture: Fixture, dark: Bool) throws {
  let actions = PanelActions(
    open: { _ in }, chooseDirectFile: { nil }, quit: {}, openAtLogin: .constant(true))
  let root = PanelView(model: fixture.model(), actions: actions)
    .background(Color(nsColor: .windowBackgroundColor))
  let hosting = NSHostingView(rootView: root)
  let size = hosting.fittingSize
  let window = NSWindow(
    contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered,
    defer: false)
  window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
  window.contentView = hosting
  hosting.frame = NSRect(origin: .zero, size: size)
  hosting.layoutSubtreeIfNeeded()
  guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
    throw CocoaError(.fileWriteUnknown)
  }
  hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw CocoaError(.fileWriteUnknown)
  }
  try png.write(to: output.appending(path: "\(fixture.rawValue)-\(dark ? "dark" : "light").png"))
}

for fixture in Fixture.allCases {
  for dark in [false, true] { try render(fixture, dark: dark) }
}
print("Rendered \(Fixture.allCases.count * 2) snapshots to \(output.path(percentEncoded: false))")
