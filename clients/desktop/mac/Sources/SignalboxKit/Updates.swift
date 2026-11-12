import Observation

/// What the panel knows about app updates. The app shell drives it from its updater, so the kit
/// never links one.
@MainActor
@Observable
public final class AppUpdates {
  public let version: String
  /// False while a check or an install is already under way.
  public var canCheck: Bool
  @ObservationIgnored public var check: @MainActor () -> Void

  public init(version: String, canCheck: Bool = false, check: @escaping @MainActor () -> Void = {}) {
    self.version = version
    self.canCheck = canCheck
    self.check = check
  }
}
