// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Signalbox",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")
  ],
  targets: [
    .target(name: "SignalboxKit"),
    // Only the app links the updater; the kit, its tests and the snapshot renderer stay free of it.
    // The rpath is declared here, where the framework dependency is, so the built binary already
    // finds Contents/Frameworks; package.sh refuses a binary without it.
    .executableTarget(
      name: "Signalbox",
      dependencies: ["SignalboxKit", .product(name: "Sparkle", package: "Sparkle")],
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
    .executableTarget(name: "SignalboxSnapshots", dependencies: ["SignalboxKit"]),
    .testTarget(name: "SignalboxKitTests", dependencies: ["SignalboxKit"]),
  ],
  swiftLanguageModes: [.v6]
)
