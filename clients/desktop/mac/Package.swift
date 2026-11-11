// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Signalbox",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "SignalboxKit"),
    .executableTarget(name: "Signalbox", dependencies: ["SignalboxKit"]),
    .executableTarget(name: "SignalboxSnapshots", dependencies: ["SignalboxKit"]),
    .testTarget(name: "SignalboxKitTests", dependencies: ["SignalboxKit"]),
  ],
  swiftLanguageModes: [.v6]
)
