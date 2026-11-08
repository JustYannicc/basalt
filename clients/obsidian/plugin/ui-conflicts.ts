import { Modal } from "obsidian";
import type { BinaryVersion, ConflictChoice } from "../attachments.ts";
import type { SyncHost } from "./host.ts";
import type { Conflict } from "../types.ts";
import { conflictSides } from "../conflict-sides.ts";

type Side = { kind: "text"; text: string | null } | { kind: "binary"; info: BinaryVersion | null };
type Pick = "device" | "cloud" | "combined";

interface FileState {
  path: string;
  deviceAt: string;
  cloudAt: string;
  binary: boolean;
  device: Side | null;
  cloud: Side | null;
  failure: string | null;
  pick: Pick | null;
  combined: string;
}

const previewLimit = 100_000;
const isBinary = (path: string) => !path.toLowerCase().endsWith(".md");

/**
 * Shows both retained versions of every conflicting path and requires an explicit choice for
 * each one. Nothing is chosen by default, and nothing is applied until every path has a choice.
 */
export class ConflictModal extends Modal {
  private files = new Map<string, FileState[]>();
  private failures = new Map<string, string>();
  private busy = new Set<string>();

  constructor(private readonly host: SyncHost) {
    super(host.app);
  }

  onOpen() {
    this.setTitle("Choose what to keep");
    this.modalEl.addClass("basalt-sync-conflicts");
    this.contentEl.addClass("basalt-sync-modal");
    for (const conflict of this.host.controller?.conflicts() ?? []) void this.load(conflict);
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private async load(conflict: Conflict) {
    const controller = this.host.controller;
    if (!controller) return;
    const states: FileState[] = conflict.conflicts.map((file) => ({
      path: file.path,
      ...conflictSides(file),
      binary: isBinary(file.path),
      device: null,
      cloud: null,
      failure: null,
      pick: null,
      combined: "",
    }));
    this.files.set(conflict.ref, states);
    await Promise.all(
      states.map(async (file) => {
        try {
          const versions = await Promise.all(
            [file.deviceAt, file.cloudAt].map(
              (at) => this.host.attachments.describeVersion?.(file.path, at) ?? null,
            ),
          );
          file.binary ||= versions.some((version) => version?.external === true);
          const side = async (at: string, info: BinaryVersion | null): Promise<Side> =>
            file.binary
              ? {
                  kind: "binary",
                  info,
                }
              : { kind: "text", text: await controller.version(file.path, at) };
          [file.device, file.cloud] = await Promise.all([
            side(file.deviceAt, versions[0] ?? null),
            side(file.cloudAt, versions[1] ?? null),
          ]);
          if (file.device.kind === "text") file.combined = file.device.text ?? "";
        } catch (failure) {
          file.failure = failure instanceof Error ? failure.message : String(failure);
        }
      }),
    );
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    const conflicts = this.host.controller?.conflicts() ?? [];
    if (!conflicts.length) {
      contentEl.createEl("p", { text: "Nothing needs a choice. Every version is in Basalt." });
      return;
    }
    contentEl.createEl("p", {
      cls: "basalt-sync-muted",
      text: "Both versions stay in Basalt's history whatever you choose. Pick one for every file, then apply.",
    });
    for (const conflict of conflicts) this.renderConflict(conflict);
  }

  private renderConflict(conflict: Conflict) {
    const files = this.files.get(conflict.ref) ?? [];
    const group = this.contentEl.createDiv({ cls: "basalt-sync-conflict" });
    for (const file of files) this.renderFile(group, file);

    const binary = files.some((file) => file.binary);
    const mixed = this.host.attachments.resolveMixed;
    const ready =
      files.length === conflict.conflicts.length &&
      files.every((file) => file.pick !== null && !file.failure && file.device && file.cloud);
    if (binary && !mixed)
      group.createDiv({
        cls: "basalt-sync-callout is-warn",
        text: "This change includes attachments. Both versions are kept in Basalt; choosing between attachment versions becomes available once attachment sync is on this device.",
      });
    const failure = this.failures.get(conflict.ref);
    if (failure) group.createDiv({ cls: "basalt-sync-callout is-error", text: failure });

    const actions = group.createDiv({ cls: "modal-button-container" });
    const apply = actions.createEl("button", {
      cls: "mod-cta",
      text: this.busy.has(conflict.ref)
        ? "Applying…"
        : files.length > 1
          ? `Apply ${files.length} choices`
          : "Apply choice",
    });
    apply.disabled = !ready || (binary && !mixed) || this.busy.has(conflict.ref);
    apply.addEventListener("click", () => void this.apply(conflict, files));
  }

  private renderFile(parent: HTMLElement, file: FileState) {
    const box = parent.createDiv({ cls: "basalt-sync-file" });
    box.createEl("h4", { text: file.path });
    if (file.failure) {
      box.createDiv({
        cls: "basalt-sync-callout is-error",
        text: `Couldn't load both versions: ${file.failure}`,
      });
      return;
    }
    const panes = box.createDiv({ cls: "basalt-sync-panes" });
    this.renderSide(panes, "This device", file.device);
    this.renderSide(panes, "In Basalt", file.cloud);

    const choices = box.createDiv({
      cls: "basalt-sync-choices",
      attr: { role: "radiogroup", "aria-label": `Keep for ${file.path}` },
    });
    const options: [Pick, string][] = [
      ["device", "Keep this device's"],
      ["cloud", "Keep Basalt's"],
    ];
    if (!file.binary) options.push(["combined", "Write a combined version"]);
    for (const [pick, label] of options) {
      const button = choices.createEl("button", {
        text: label,
        cls: file.pick === pick ? "mod-cta" : "",
        attr: { role: "radio", "aria-checked": String(file.pick === pick) },
      });
      button.disabled = !file.device || !file.cloud;
      button.addEventListener("click", () => {
        file.pick = pick;
        this.render();
      });
    }
    if (file.pick === "combined") {
      const area = box.createEl("textarea", {
        cls: "basalt-sync-combined",
        attr: { rows: "10", "aria-label": `Combined ${file.path}` },
      });
      area.value = file.combined;
      area.addEventListener("input", () => {
        file.combined = area.value;
      });
    }
  }

  private renderSide(parent: HTMLElement, label: string, side: Side | null) {
    const pane = parent.createDiv({ cls: "basalt-sync-pane" });
    pane.createDiv({ cls: "basalt-sync-pane-label", text: label });
    if (!side) return pane.createDiv({ cls: "basalt-sync-muted", text: "Loading…" });
    if (side.kind === "binary")
      return pane.createDiv({
        cls: "basalt-sync-muted",
        text: side.info
          ? `${side.info.mime ?? "File"} · ${side.info.bytes.toLocaleString("en-US")} bytes`
          : "Attachment. Details appear once attachment sync is on this device.",
      });
    if (side.text === null)
      return pane.createDiv({ cls: "basalt-sync-muted", text: "Deleted here" });
    const pre = pane.createEl("pre", { text: side.text.slice(0, previewLimit) });
    if (side.text.length > previewLimit)
      pane.createDiv({
        cls: "basalt-sync-muted",
        text: "Preview shortened. The full version is kept.",
      });
    return pre;
  }

  private async apply(conflict: Conflict, files: FileState[]) {
    const controller = this.host.controller;
    if (!controller) return;
    // Refuse if the conflict changed under us; the person re-reviews instead of applying stale choices.
    if (
      !controller
        .conflicts()
        .some((current) => current.ref === conflict.ref && current.oid === conflict.oid)
    ) {
      this.failures.set(
        conflict.ref,
        "This conflict changed while you were reviewing. Reopen to see the latest versions.",
      );
      return this.render();
    }
    const text = (side: Side | null) => (side?.kind === "text" ? side.text : null);
    const choices: ConflictChoice[] = files.map((file) =>
      file.binary
        ? {
            path: file.path,
            kind: "version",
            at: file.pick === "device" ? file.deviceAt : file.cloudAt,
          }
        : {
            path: file.path,
            kind: "text",
            content:
              file.pick === "combined"
                ? file.combined
                : text(file.pick === "device" ? file.device : file.cloud),
          },
    );
    this.busy.add(conflict.ref);
    this.failures.delete(conflict.ref);
    this.render();
    try {
      if (files.some((file) => file.binary))
        await this.host.attachments.resolveMixed?.(conflict.ref, choices);
      else
        await controller.resolve(
          conflict.ref,
          choices.map((choice) => ({
            path: choice.path,
            content: choice.kind === "text" ? choice.content : null,
          })),
        );
      this.files.delete(conflict.ref);
    } catch (failure) {
      this.failures.set(conflict.ref, failure instanceof Error ? failure.message : String(failure));
    } finally {
      this.busy.delete(conflict.ref);
    }
    this.render();
  }
}
