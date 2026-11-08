import { PluginSettingTab, Setting, setIcon, type Plugin } from "obsidian";
import type { SyncHost } from "./host.ts";
import { AttachmentControls } from "./ui-attachments.ts";
import { ConfirmModal, FolderPicker } from "./ui-pickers.ts";
import type { Tone } from "../status.ts";

const toneIcon: Record<Tone, string> = {
  ok: "check-circle",
  busy: "refresh-cw",
  warn: "alert-triangle",
  error: "cloud-off",
  muted: "circle-pause",
};

const listPreview = (parent: HTMLElement, paths: readonly string[], limit = 5) => {
  const list = parent.createEl("ul", { cls: "basalt-sync-paths" });
  for (const path of paths.slice(0, limit)) list.createEl("li", { text: path });
  if (paths.length > limit)
    list.createEl("li", {
      cls: "basalt-sync-more",
      text: `and ${(paths.length - limit).toLocaleString("en-US")} more`,
    });
};

export function renderHowItWorks(parent: HTMLElement) {
  const section = parent.createDiv({ cls: "basalt-sync-how" });
  section.createEl("h3", { text: "How sync works" });
  const items: [string, string][] = [
    [
      "Basalt holds the vault.",
      "Your agents read, search and edit the cloud copy, even with every device off.",
    ],
    [
      "Your Mac keeps everything.",
      "Every note and attachment stays on disk. Import from your Mac first.",
    ],
    [
      "Your phone fetches what you open.",
      "Notes sync everywhere. Attachments download when you open a note. Pinned folders stay fully offline.",
    ],
    [
      "Edit offline, sync when you return.",
      "Changes wait on this device until Obsidian is open and online.",
    ],
    [
      "Nothing is overwritten silently.",
      "When you and an agent change the same note, both versions are kept and you choose.",
    ],
    [
      "Deleted elsewhere? Kept here.",
      "Notes removed in Basalt move to the “Basalt recovered” folder instead of disappearing.",
    ],
  ];
  const list = section.createEl("ol");
  for (const [title, body] of items) {
    const item = list.createEl("li");
    item.createEl("strong", { text: title });
    item.createSpan({ text: ` ${body}` });
  }
}

export class BasaltSettingTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;
  // Held on the tab so in-flight downloads and failures survive re-renders. Downloads keep
  // running when settings close; the port owns their lifetime.
  private readonly attachmentControls: AttachmentControls;

  constructor(
    plugin: Plugin,
    private readonly host: SyncHost,
  ) {
    super(host.app, plugin);
    this.attachmentControls = new AttachmentControls(host.app, host.attachments, () => {
      if (this.containerEl.isConnected) this.render();
    });
  }

  display(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.host.subscribe(() => {
      if (this.containerEl.isConnected) this.render();
    });
    this.render();
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private render() {
    const { containerEl, host } = this;
    const controller = host.controller,
      status = controller?.status(),
      view = host.view(),
      config = controller?.config() ?? null;
    containerEl.empty();
    containerEl.addClass("basalt-sync-settings");

    const connected = !!status && status.state !== "disconnected" && status.state !== "authorizing";
    const intro = containerEl.createDiv({ cls: "basalt-sync-intro" });
    intro.createEl("h2", {
      text: connected ? `${host.vaultName} is connected` : "Keep this vault in Basalt",
    });
    intro.createEl("p", {
      text: connected
        ? "Basalt holds the authoritative copy. Your agents can use these notes while your devices are off."
        : "Sync this vault with Basalt so your agents can read, search and edit your notes, even with every device off.",
    });

    const statusRow = new Setting(containerEl)
      .setClass("basalt-sync-status")
      .setClass(`is-${view.tone}`);
    const name = createFragment((fragment) => {
      const title = fragment.createSpan({ cls: "basalt-sync-status-title" });
      setIcon(title.createSpan({ cls: "basalt-sync-status-icon" }), toneIcon[view.tone]);
      title.createSpan({ text: view.title });
    });
    statusRow.setName(name).setDesc(view.detail);

    if (!controller || !status) return this.renderHelp();

    if (status.state === "authorizing") {
      const pending = controller.authorization();
      if (pending) {
        statusRow.setDesc(
          createFragment((fragment) => {
            fragment.appendText("Approve this device in your browser. Check that it shows ");
            fragment.createEl("code", { cls: "basalt-sync-code", text: pending.code });
            fragment.appendText(".");
          }),
        );
        statusRow
          .addButton((button) =>
            button
              .setButtonText("Open approval page")
              .setCta()
              .onClick(() => host.openApproval()),
          )
          .addButton((button) =>
            button.setButtonText("Cancel").onClick(() => host.cancelAuthorization()),
          );
      }
    }

    if (status.state === "disconnected") {
      const error = host.authorizationError();
      if (error) containerEl.createDiv({ cls: "basalt-sync-callout is-error", text: error });
      new Setting(containerEl).setName("This vault").setDesc(host.vaultName);
      new Setting(containerEl)
        .setName("Connect from Basalt")
        .setDesc(
          "In Basalt, open your Obsidian app and choose Connect Obsidian. This vault opens here and asks you to approve in your browser. Start with your Mac.",
        );
      return this.renderHelp();
    }
    if (status.state === "authorizing") return this.renderHelp();

    if (status.state !== "paused")
      statusRow.addButton((button) =>
        button
          .setButtonText(status.state === "syncing" ? "Syncing…" : "Sync now")
          .setDisabled(status.state === "syncing")
          .onClick(() => void host.syncNow()),
      );

    if (status.conflicts > 0) {
      const box = containerEl.createDiv({ cls: "basalt-sync-callout is-warn" });
      box.createEl("strong", {
        text:
          status.conflicts === 1
            ? "1 conflict needs a choice"
            : `${status.conflicts} conflicts need a choice`,
      });
      box.createEl("p", {
        text: "Someone else changed the same notes. Both versions are saved in Basalt.",
      });
      box
        .createEl("button", { text: "Compare versions" })
        .addEventListener("click", () => host.openConflicts());
    }

    const summary = host.attachments.summary();
    const unsynced = [...new Set([...status.unsupported, ...summary.unsynced])];
    if (unsynced.length || summary.failed.length) {
      const box = containerEl.createDiv({ cls: "basalt-sync-callout is-warn" });
      box.createEl("strong", {
        text: `${(unsynced.length + summary.failed.length).toLocaleString("en-US")} files are not in Basalt yet`,
      });
      box.createEl("p", {
        text: "They stay on this device unchanged. Basalt picks them up once it can carry them.",
      });
      listPreview(box, [
        ...summary.failed.map((file) => `${file.path} — ${file.reason}`),
        ...unsynced,
      ]);
    }

    const recovered = host.recovered();
    if (recovered.length) {
      const box = containerEl.createDiv({ cls: "basalt-sync-callout" });
      box.createEl("strong", {
        text: `Kept ${recovered.length.toLocaleString("en-US")} files removed elsewhere`,
      });
      box.createEl("p", {
        text: "They were deleted in Basalt, so this device moved them to “Basalt recovered” instead of deleting them. These recovery copies never sync. Delete them when you're sure.",
      });
      listPreview(box, recovered);
    }

    new Setting(containerEl)
      .setName("This vault")
      .setDesc(`${host.vaultName} · ${config ? new URL(config.connection).host : "Basalt"}`);

    this.renderAttachments();

    new Setting(containerEl)
      .setName("Sync")
      .setDesc(
        status.state === "paused"
          ? "Paused. Edits stay on this device until you turn sync back on."
          : "Syncs when you save, open a note, start Obsidian or come back to it.",
      )
      .addToggle((toggle) =>
        toggle.setValue(status.state !== "paused").onChange((on) => void host.setPaused(!on)),
      );

    if (host.mobile)
      containerEl.createDiv({
        cls: "basalt-sync-note",
        text: "On a phone, sync runs while Obsidian is open. If the system pauses it, it catches up when you return.",
      });

    new Setting(containerEl)
      .setName("Disconnect this device")
      .setDesc(
        "Removes this device's access in Basalt. Local notes stay. Reconnect any time from Basalt.",
      )
      .addButton((button) =>
        button
          .setButtonText("Disconnect")
          .setClass("mod-warning")
          .onClick(() =>
            new ConfirmModal(host.app, {
              title: "Disconnect this device?",
              body: "Basalt removes this device's access. Notes on this device stay where they are. Unsent changes wait here until you reconnect.",
              confirm: "Disconnect",
              warning: true,
              run: () => host.disconnect(),
            }).open(),
          ),
      );

    this.renderHelp();
  }

  private renderAttachments() {
    const { containerEl, host } = this;
    if (host.attachments.mode() === "full") {
      new Setting(containerEl)
        .setName("Attachments")
        .setDesc("This device keeps every note and attachment.");
      return;
    }
    new Setting(containerEl)
      .setName("Offline folders")
      .setDesc(
        "Attachments download when you open a note. Pinned folders keep every attachment on this device.",
      )
      .addButton((button) =>
        button
          .setButtonText("Pin a folder")
          .onClick(() =>
            new FolderPicker(
              host.app,
              host.attachments.pins(),
              (folder) => void host.attachments.setPinned(folder, true),
            ).open(),
          ),
      );
    for (const folder of host.attachments.pins())
      new Setting(containerEl)
        .setClass("basalt-sync-pin")
        .setName(folder)
        .setDesc("Kept offline")
        .addExtraButton((button) =>
          button
            .setIcon("pin-off")
            .setTooltip("Stop keeping offline")
            .onClick(() => void host.attachments.setPinned(folder, false)),
        );
    this.attachmentControls.render(containerEl);
  }

  private renderHelp() {
    renderHowItWorks(this.containerEl);
  }
}
