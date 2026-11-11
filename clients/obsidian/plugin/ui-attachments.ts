import { FuzzySuggestModal, Setting, type App, type FuzzyMatch } from "obsidian";
import type { AttachmentPort } from "../attachments.ts";

export interface AttachmentEntry {
  path: string;
  bytes: number;
  local: boolean;
  pinned: boolean;
}

/** The optional manual controls. Each control shows only when the port provides its method. */
interface ManualPort {
  entries?(): readonly AttachmentEntry[];
  download?(path: string, signal: AbortSignal): Promise<void>;
  evict?(path: string): Promise<void>;
}

const manual = (port: AttachmentPort): ManualPort => port as AttachmentPort & ManualPort;

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
};

class AttachmentPicker extends FuzzySuggestModal<AttachmentEntry> {
  constructor(
    app: App,
    private readonly items: readonly AttachmentEntry[],
    options: { placeholder: string; empty: string; action: string },
    private readonly choose: (entry: AttachmentEntry) => void,
  ) {
    super(app);
    this.setPlaceholder(options.placeholder);
    this.emptyStateText = options.empty;
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: options.action },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }

  getItems(): AttachmentEntry[] {
    return [...this.items];
  }

  getItemText(entry: AttachmentEntry): string {
    return entry.path;
  }

  renderSuggestion(match: FuzzyMatch<AttachmentEntry>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    el.createDiv({ cls: "basalt-sync-muted", text: formatBytes(match.item.bytes) });
  }

  onChooseItem(entry: AttachmentEntry): void {
    this.choose(entry);
  }
}

/**
 * Download and remove-copy controls for on-demand devices. Lives on the settings tab so
 * in-flight downloads and failures survive the tab re-rendering on every status change.
 */
export class AttachmentControls {
  private downloads = new Map<string, AbortController>();
  private failures = new Map<string, string>();

  constructor(
    private readonly app: App,
    private readonly port: AttachmentPort,
    private readonly changed: () => void,
  ) {}

  render(container: HTMLElement) {
    const port = manual(this.port);
    // A full mirror keeps everything; there is nothing to fetch or remove by hand.
    if (this.port.mode() !== "on-demand" || !port.entries) return;
    const entries = port.entries();
    const local = entries.filter((entry) => entry.local);
    const used = local.reduce((total, entry) => total + entry.bytes, 0);

    const row = new Setting(container)
      .setName("Attachments on this device")
      .setDesc(
        `${local.length.toLocaleString("en-US")} of ${entries.length.toLocaleString("en-US")} downloaded · ${formatBytes(used)}. Signalbox keeps every file, so a removed copy downloads again when you open its note.`,
      );
    if (port.download)
      row.addButton((button) =>
        button.setButtonText("Download attachment").onClick(() => this.pickDownload()),
      );
    if (port.evict)
      row.addButton((button) =>
        button.setButtonText("Remove downloaded copy").onClick(() => this.pickEvict()),
      );

    for (const [path, download] of this.downloads)
      new Setting(container)
        .setClass("basalt-sync-pin")
        .setName(path)
        .setDesc("Downloading…")
        .addExtraButton((button) =>
          button
            .setIcon("x")
            .setTooltip("Cancel download")
            .onClick(() => download.abort()),
        );

    if (this.failures.size) {
      const box = container.createDiv({ cls: "basalt-sync-callout is-error" });
      box.createEl("strong", {
        text:
          this.failures.size === 1
            ? "1 attachment action failed"
            : `${this.failures.size} attachment actions failed`,
      });
      const list = box.createEl("ul", { cls: "basalt-sync-paths" });
      for (const [path, reason] of this.failures)
        list.createEl("li", { text: `${path}: ${reason}` });
      box.createEl("button", { text: "Clear" }).addEventListener("click", () => {
        this.failures.clear();
        this.changed();
      });
    }
  }

  private pickDownload() {
    const port = manual(this.port);
    const items = (port.entries?.() ?? []).filter(
      (entry) => !entry.local && !this.downloads.has(entry.path),
    );
    new AttachmentPicker(
      this.app,
      items,
      {
        placeholder: "Choose an attachment to download",
        empty: "Every attachment is already on this device.",
        action: "to download",
      },
      (entry) => void this.download(entry.path),
    ).open();
  }

  private pickEvict() {
    const port = manual(this.port);
    const blocked = this.blocked();
    const items = (port.entries?.() ?? []).filter(
      (entry) => entry.local && !entry.pinned && !blocked.has(entry.path),
    );
    new AttachmentPicker(
      this.app,
      items,
      {
        placeholder: "Choose a downloaded copy to remove from this device",
        empty:
          "Nothing to remove. Files in pinned folders and files not yet in Signalbox stay on this device.",
        action: "to remove this copy",
      },
      (entry) => void this.evict(entry.path),
    ).open();
  }

  /** Files whose only copy may be this one. Removing them could lose work. */
  private blocked() {
    const summary = this.port.summary();
    return new Set([...summary.unsynced, ...summary.failed.map((file) => file.path)]);
  }

  private async download(path: string) {
    const port = manual(this.port);
    if (!port.download || this.downloads.has(path)) return;
    const abort = new AbortController();
    this.downloads.set(path, abort);
    this.failures.delete(path);
    this.changed();
    try {
      await port.download(path, abort.signal);
    } catch (failure) {
      if (!abort.signal.aborted)
        this.failures.set(path, failure instanceof Error ? failure.message : String(failure));
    } finally {
      this.downloads.delete(path);
      this.changed();
    }
  }

  private async evict(path: string) {
    const port = manual(this.port);
    if (!port.evict) return;
    // Re-check at action time: pins, mode or sync state may have changed since the picker opened.
    const entry = port.entries?.().find((item) => item.path === path);
    const refusal =
      this.port.mode() !== "on-demand"
        ? "This device keeps every attachment."
        : !entry || !entry.local
          ? "This copy is already gone."
          : entry.pinned
            ? "It is in a pinned folder. Unpin the folder first."
            : this.blocked().has(path)
              ? "Signalbox doesn't have this file yet, so this copy is the only one."
              : null;
    this.failures.delete(path);
    if (refusal) this.failures.set(path, refusal);
    else
      try {
        await port.evict(path);
      } catch (failure) {
        this.failures.set(path, failure instanceof Error ? failure.message : String(failure));
      }
    this.changed();
  }
}
