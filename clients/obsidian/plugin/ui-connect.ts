import { Modal } from "obsidian";
import type { SyncHost } from "./host.ts";
import type { ConnectRequest } from "../link.ts";
import { formatBytes } from "../status.ts";

type Scope =
  | { kind: "loading" }
  | { kind: "ready"; files: number; bytes: number }
  | { kind: "failed"; message: string };

/**
 * Opened by the `obsidian://signalbox-sync` link. Nothing is sent until the person confirms the
 * vault and server they see here, so a stray link can't quietly point the vault elsewhere.
 */
export class ConnectModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private phase: "confirm" | "approving" | "done" = "confirm";
  private error: string | null = null;
  /** True while `begin` is in flight; status is not "authorizing" yet. */
  private starting = false;
  /** What the first import would send, counted locally before anything leaves the device. */
  private importScopeState: Scope = { kind: "loading" };
  private closed = false;

  constructor(
    private readonly host: SyncHost,
    private readonly request: ConnectRequest,
  ) {
    super(host.app);
  }

  onOpen() {
    this.contentEl.addClass("basalt-sync-modal");
    this.unsubscribe = this.host.subscribe(() => this.render());
    void this.loadScope();
  }

  onClose() {
    this.closed = true;
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private async loadScope() {
    this.importScopeState = { kind: "loading" };
    this.render();
    try {
      const { files, bytes } = await this.host.importScope();
      this.importScopeState = { kind: "ready", files, bytes };
    } catch (failure) {
      this.importScopeState = {
        kind: "failed",
        message: failure instanceof Error ? failure.message : String(failure),
      };
    }
    if (!this.closed) this.render();
  }

  private render() {
    if (this.closed) return;
    const { contentEl, host, request } = this;
    const state = host.controller?.status().state;
    if (this.phase === "approving" && !this.starting && state !== "authorizing") {
      const failure = host.authorizationError();
      if (failure) {
        this.phase = "confirm";
        this.error = failure;
      } else if (state === "disconnected" || state === "paused" || state === undefined) {
        // Cancelled elsewhere. A successful poll always clears pause, so paused means the
        // earlier connection is still the one in place.
        this.close();
        return;
      } else this.phase = "done";
    }
    contentEl.empty();

    if (this.phase === "done") {
      this.setTitle("Vault connected");
      contentEl.createEl("p", {
        text: `${host.vaultName} now syncs with Basalt. The first sync starts now; keep Obsidian open until it finishes.`,
      });
      this.actions()
        .createEl("button", { text: "Done", cls: "mod-cta" })
        .addEventListener("click", () => this.close());
      return;
    }

    if (this.phase === "approving") {
      const pending = host.controller?.authorization();
      this.setTitle("Approve in your browser");
      contentEl.createEl("p", {
        text: "Your browser opened Basalt. Check that it shows this code, then approve.",
      });
      contentEl.createDiv({ cls: "basalt-sync-code is-large", text: pending?.code ?? "—" });
      contentEl.createEl("p", {
        cls: "basalt-sync-muted",
        text: "Waiting for approval. You can close this window; the request stays open until it expires.",
      });
      const actions = this.actions();
      actions
        .createEl("button", { text: "Open approval page", cls: "mod-cta" })
        .addEventListener("click", () => host.openApproval());
      actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
        host.cancelAuthorization();
        this.close();
      });
      return;
    }

    this.setTitle("Connect this vault to Basalt?");
    const rows = contentEl.createEl("dl", { cls: "basalt-sync-facts" });
    const row = (term: string, value: string) => {
      rows.createEl("dt", { text: term });
      rows.createEl("dd", { text: value });
    };
    row("Vault", host.vaultName);
    row("Basalt server", request.host);
    row("App", request.config.appSlug);
    const scope = this.importScopeState;
    row(
      "Includes",
      scope.kind === "ready"
        ? `All vault content · ${scope.files.toLocaleString("en-US")} ${scope.files === 1 ? "file" : "files"} · ${formatBytes(scope.bytes)}`
        : scope.kind === "loading"
          ? "Counting files…"
          : "Couldn't count files",
    );
    if (scope.kind === "failed")
      contentEl.createDiv({
        cls: "basalt-sync-callout is-error",
        text: `This vault's files couldn't be counted, so nothing was sent. ${scope.message}`,
      });
    contentEl.createEl("p", {
      cls: "basalt-sync-muted",
      text: host.mobile
        ? "Connect your Mac first so it imports the vault. This phone then joins the cloud copy and downloads attachments when you open a note."
        : "This Mac becomes the source: everything above uploads once, and the import resumes if interrupted. Phones join the cloud copy afterwards.",
    });

    if (request.vaultName && request.vaultName !== host.vaultName)
      contentEl.createDiv({
        cls: "basalt-sync-callout is-warn",
        text: `This link was made for the vault “${request.vaultName}”. You're in “${host.vaultName}”. Only continue if this is the vault you want in Basalt.`,
      });
    const current = host.controller?.config();
    if (current && current.connection !== request.config.connection)
      contentEl.createDiv({
        cls: "basalt-sync-callout is-warn",
        text: `This vault already syncs with ${new URL(current.connection).host}. Connecting pauses that sync; unsent changes stay on this device.`,
      });
    if (this.error) contentEl.createDiv({ cls: "basalt-sync-callout is-error", text: this.error });
    contentEl.createEl("p", {
      cls: "basalt-sync-muted",
      text: "Your browser opens next so you can approve this device. Basalt never asks for a password here.",
    });

    const actions = this.actions();
    if (scope.kind === "failed")
      actions
        .createEl("button", { text: "Count again" })
        .addEventListener("click", () => void this.loadScope());
    const connect = actions.createEl("button", { text: "Connect", cls: "mod-cta" });
    // Connect stays off until the person has seen what the first import includes.
    connect.disabled = scope.kind !== "ready";
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      this.error = null;
      this.phase = "approving";
      this.starting = true;
      try {
        await host.connect(request.config);
      } catch (failure) {
        this.phase = "confirm";
        this.error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        this.starting = false;
      }
      this.render();
    });
  }

  private actions() {
    return this.contentEl.createDiv({ cls: "modal-button-container" });
  }
}
