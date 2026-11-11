import SwiftUI

/// Things only the app shell can do: open the browser, pick a file, quit, own the login item.
public struct PanelActions {
  public var open: @MainActor (URL) -> Void
  public var chooseDirectFile: @MainActor () -> URL?
  public var quit: @MainActor () -> Void
  public var openAtLogin: Binding<Bool>
  public init(
    open: @escaping @MainActor (URL) -> Void,
    chooseDirectFile: @escaping @MainActor () -> URL?,
    quit: @escaping @MainActor () -> Void,
    openAtLogin: Binding<Bool>
  ) {
    self.open = open
    self.chooseDirectFile = chooseDirectFile
    self.quit = quit
    self.openAtLogin = openAtLogin
  }
}

/// The menu-bar panel. Editing, tools, workflows and sharing stay in the web app; every row here
/// either shows status, sets up this Mac's agents or hands off to the browser.
public struct PanelView: View {
  @Bindable var model: PanelModel
  let actions: PanelActions

  public init(model: PanelModel, actions: PanelActions) {
    self.model = model
    self.actions = actions
  }

  public var body: some View {
    VStack(spacing: 0) {
      Group {
        switch model.page {
        case .home: HomeView(model: model, actions: actions)
        case .connection: ConnectionPage(model: model, actions: actions)
        case .agents: AgentsPage(model: model)
        }
      }
      .frame(maxWidth: .infinity, alignment: .topLeading)
      Divider()
      Footer(model: model, actions: actions)
    }
    .frame(width: 380)
    .font(.system(size: 13))
    .disabled(model.busy)
    .onKeyPress(.escape) {
      guard model.page != .home else { return .ignored }
      model.page = .home
      return .handled
    }
  }
}

struct Header<Trailing: View>: View {
  let title: String
  var back: (() -> Void)?
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack {
      if let back {
        Button(action: back) {
          Label("Signalbox", systemImage: "chevron.left").font(.system(size: 12))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Back")
      } else {
        Text(title).font(.system(size: 14, weight: .semibold))
      }
      Spacer()
      trailing
    }
    .padding(.horizontal, 14)
    .padding(.top, 14)
    .padding(.bottom, 10)
  }
}

extension Header where Trailing == EmptyView {
  init(title: String, back: (() -> Void)? = nil) {
    self.init(title: title, back: back) { EmptyView() }
  }
}

struct StatusDot: View {
  let filled: Bool
  var body: some View {
    Circle()
      .strokeBorder(.foreground, lineWidth: filled ? 0 : 1)
      .background(Circle().fill(filled ? AnyShapeStyle(.foreground) : AnyShapeStyle(.clear)))
      .frame(width: 6, height: 6)
      .accessibilityHidden(true)
  }
}

struct StatusLine: View {
  let presentation: Presentation
  var body: some View {
    HStack(spacing: 5) {
      StatusDot(filled: presentation.status == .connected)
      Text(presentation.statusLabel)
    }
    .font(.system(size: 12))
    .foregroundStyle(.secondary)
    .accessibilityElement(children: .combine)
  }
}

struct NavRow: View {
  var symbol: String?
  var letter: String?
  let title: String
  let detail: String
  var trailing = "›"
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Group {
          if let symbol { Image(systemName: symbol) } else { Text(letter ?? "").fontWeight(.semibold) }
        }
        .frame(width: 28, height: 28)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
        .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 1) {
          Text(title).lineLimit(1)
          Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer(minLength: 4)
        Text(trailing).foregroundStyle(.secondary).font(.system(size: trailing == "›" ? 13 : 12))
      }
      .padding(8)
      .frame(minHeight: 48)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowStyle())
  }
}

struct RowStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    RowBody(configuration: configuration)
  }
  private struct RowBody: View {
    let configuration: ButtonStyleConfiguration
    @State private var hovering = false
    var body: some View {
      configuration.label
        .background(
          RoundedRectangle(cornerRadius: 6).fill(
            Color.primary.opacity(configuration.isPressed ? 0.12 : hovering ? 0.06 : 0))
        )
        .onHover { hovering = $0 }
    }
  }
}

struct NoticeView: View {
  let notice: Notice
  var body: some View {
    Text(notice.text)
      .font(.system(size: 12))
      .foregroundStyle(notice.isError ? AnyShapeStyle(Color.red) : AnyShapeStyle(.primary))
      .lineSpacing(2)
      .card()
  }
}

struct SignInButton: View {
  let model: PanelModel
  var origin: String?
  var body: some View {
    Button("Sign in with your browser") {
      Task { await model.perform(.signIn(origin: origin ?? model.server)) }
    }
  }
}

extension View {
  /// The soft inset panel r2 uses for approval, review, confirmations and notices.
  func card() -> some View {
    padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 7))
  }
}

struct Footer: View {
  let model: PanelModel
  let actions: PanelActions
  var body: some View {
    HStack(spacing: 4) {
      Button {
        model.page = .connection
      } label: {
        StatusLine(presentation: model.presentation)
      }
      .buttonStyle(.plain)
      .padding(.leading, 6)
      .help("Connection details")
      Spacer()
      Button("Open Signalbox ↗") { actions.open(model.webOrigin) }
        .buttonStyle(.plain)
        .font(.system(size: 12))
        .padding(.horizontal, 6)
      Button("Quit") { actions.quit() }
        .buttonStyle(.plain)
        .font(.system(size: 12))
        .padding(.horizontal, 6)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 7)
    .frame(minHeight: 36)
  }
}
