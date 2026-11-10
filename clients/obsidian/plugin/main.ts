import { createBinaryClient } from "../binary.ts";
import { obsidianBinaryIo } from "./obsidian-binary.ts";
import { attachmentProxy } from "../attachment-proxy.ts";
import { safePath } from "../types.ts";
import {
  Notice,
  Platform,
  Plugin,
  TFolder,
  debounce,
  requireApiVersion,
  type Debouncer,
  type TFile,
} from "obsidian";
import { type AttachmentPort } from "../attachments.ts";
import { createController, type DeviceConfig, type DeviceController } from "../controller.ts";
import type { SyncHost } from "./host.ts";
import { parseConnectLink, protocolAction } from "../link.ts";
import { createLocalVault } from "../local-vault.ts";
import { obsidianHttp } from "./obsidian-http.ts";
import { describeStatus, type StatusView } from "../status.ts";
import { openStore, newDeviceId, type PluginStore } from "../store.ts";
import { ConflictModal } from "./ui-conflicts.ts";
import { ConnectModal } from "./ui-connect.ts";
import { BasaltSettingTab } from "./ui-settings.ts";
import { watchRemoteChanges } from "../remote-wake.ts";

// Like Git: edits pile up in the working tree and one checkpoint commits them all. A checkpoint
// runs after this long without edits, when Obsidian is hidden, or on Sync now.
const idleCheckpointMs = 3 * 60_000;
// Our own downloads fire vault events too; those aren't edits waiting to sync.
const ownWriteMs = 2_000;
const terminalAuthorization = /declined|expired|could not finish/iu;

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

export default class BasaltSyncPlugin extends Plugin implements SyncHost {
  controller: DeviceController | null = null;
  attachments!: AttachmentPort;
  readonly mobile = Platform.isMobile;
  private store!: PluginStore;
  private local!: ReturnType<typeof createLocalVault>;
  private failure: string | null = null;
  private authError: string | null = null;
  private pollTimer: number | null = null;
  private again = false;
  /** Paths edited since the last checkpoint started. */
  private dirty = new Set<string>();
  // Edits made while Obsidian was closed, or left by a failed checkpoint, have no vault event.
  // This stays set until a checkpoint succeeds, so they are never reported as synced.
  private needsCheckpoint = true;
  private active: Promise<void> | null = null;
  private ownWrites = new Map<string, number>();
  private noteAbort: AbortController | null = null;
  private listeners = new Set<() => void>();
  private statusBar: HTMLElement | null = null;
  private checkpointWhenIdle!: Debouncer<[], void>;

  get vaultName() {
    return this.app.vault.getName();
  }
  async importScope() {
    const files = (await this.local.files()).filter((file) => safePath(file.path));
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }

  async onload() {
    this.checkpointWhenIdle = debounce(() => void this.syncNow(), idleCheckpointMs, true);
    this.store = await openStore({
      load: () => this.loadData(),
      save: (data) => this.saveData(data),
    });
    this.local = createLocalVault<TFile>(this.app.vault, {
      writing: (path) => {
        this.ownWrites.set(path, Date.now());
        this.local?.changed(path);
      },
      recoveries: this.store.recoveries,
      transfers: this.store.transfers.get,
    });
    const proxy = attachmentProxy({
      current: () => this.controller?.attachments() ?? null,
      mode: Platform.isMobile ? "on-demand" : "full",
      pins: this.store.pins,
    });
    this.attachments = proxy.port;
    this.register(proxy.close);
    this.register(this.attachments.onChange(() => this.emit()));

    if (!requireApiVersion("1.12.3"))
      this.failure =
        "Update Obsidian to use Basalt Sync. It needs secure storage and bounded attachment writes.";
    else
      try {
        const storage = this.app.secretStorage;
        this.controller = await createController({
          http: obsidianHttp,
          local: this.local,
          states: (appId) => this.store.states(appId),
          secrets: {
            get: (id) => storage.getSecret(id),
            set: (id, value) => storage.setSecret(id, value),
          },
          key: this.store.secretKey,
          changed: proxy.notify,
          binary: async ({ appId, remote, signal, resolve }) =>
            createBinaryClient({
              text: this.local,
              io: obsidianBinaryIo(this, this.local, this.store, appId, signal),
              remote,
              store: this.store.binary(appId),
              pins: this.store.pins,
              mode: Platform.isMobile ? "on-demand" : "full",
              id: newDeviceId,
              signal,
              resolve,
              changed: proxy.notify,
            }),
        });
      } catch (failure) {
        // Saved state is left untouched on disk so a fixed plugin version can still read it.
        this.failure = `Saved sync data couldn't be read: ${message(failure)}`;
      }

    this.addSettingTab(new BasaltSettingTab(this, this));
    this.registerObsidianProtocolHandler(protocolAction, (params) => this.handleLink(params));
    if (!Platform.isMobile) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass("basalt-sync-statusbar");
      this.registerDomEvent(this.statusBar, "click", () => {
        if ((this.controller?.status().conflicts ?? 0) > 0) this.openConflicts();
        else void this.syncNow();
      });
    }
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({
      id: "review-conflicts",
      name: "Review conflicts",
      callback: () => this.openConflicts(),
    });
    this.addCommand({
      id: "toggle-pause",
      name: "Pause or resume sync",
      checkCallback: (checking) => {
        const state = this.controller?.status().state;
        if (!state || state === "disconnected" || state === "authorizing") return false;
        if (!checking) void this.setPaused(state !== "paused");
        return true;
      },
    });
    this.app.workspace.onLayoutReady(() => this.start());
    this.emit();
  }

  onunload() {
    this.checkpointWhenIdle?.cancel();
    this.clearPoll();
    this.noteAbort?.abort();
    this.listeners.clear();
    const controller = this.controller;
    // Best effort: Obsidian may quit before this finishes. Whatever doesn't land stays in the
    // working tree and the next checkpoint commits it; close() aborts between batches and a
    // sent-but-unconfirmed operation stays saved for receipt recovery.
    const last = (async () => {
      await this.active;
      if (this.pendingWork()) await this.syncNow();
    })();
    void Promise.race([last, new Promise((done) => window.setTimeout(done, 5_000))]).finally(
      () => void controller?.close(),
    );
  }

  private start() {
    const touched = (path: string) => {
      this.local.changed(path);
      const own = this.ownWrites.get(path);
      this.ownWrites.delete(path);
      if (!safePath(path) || this.local.ignored(path)) return this.emit();
      if (own !== undefined && Date.now() - own < ownWriteMs) return;
      this.dirty.add(path);
      this.checkpointWhenIdle();
      this.emit();
    };
    const { vault, workspace } = this.app;
    this.registerEvent(vault.on("create", (file) => touched(file.path)));
    this.registerEvent(vault.on("modify", (file) => touched(file.path)));
    this.registerEvent(vault.on("delete", (file) => touched(file.path)));
    this.registerEvent(
      vault.on("rename", (file, old) => {
        touched(old);
        touched(file.path);
      }),
    );
    this.registerEvent(
      workspace.on("file-open", (file) => {
        this.noteAbort?.abort();
        if (!file) return;
        this.noteAbort = new AbortController();
        this.attachments.noteOpened(file.path, this.noteAbort.signal).catch(() => this.emit());
        void this.pullNow();
      }),
    );
    this.registerEvent(
      workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder) || file.isRoot() || this.attachments.mode() !== "on-demand")
          return;
        const pinned = this.attachments.pins().includes(file.path);
        menu.addItem((item) =>
          item
            .setTitle(pinned ? "Stop keeping offline" : "Keep offline")
            .setIcon(pinned ? "pin-off" : "pin")
            .onClick(() => void this.attachments.setPinned(file.path, !pinned)),
        );
      }),
    );
    // Leaving Obsidian is the one moment phones reliably give us, so it always checkpoints.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.pullNow();
      else if (this.pendingWork()) void this.syncNow();
    });
    this.registerDomEvent(window, "online", () => {
      if (this.pendingWork()) void this.syncNow();
      else void this.pullNow();
    });
    this.register(
      watchRemoteChanges({
        repeat: (callback, milliseconds) => {
          const timer = window.setInterval(callback, milliseconds);
          return () => window.clearInterval(timer);
        },
        available: () => document.visibilityState === "visible" && navigator.onLine,
        // A failed checkpoint retries on the same slow cadence instead of waiting for an edit.
        pull: () => void (this.needsCheckpoint ? this.syncNow() : this.pullNow()),
      }),
    );
    if (this.controller?.authorization()) this.schedulePoll();
    void this.syncNow();
  }

  private handleLink(params: Record<string, string>) {
    if (!this.controller) return new Notice(this.failure ?? "Basalt Sync isn't ready yet.");
    try {
      new ConnectModal(this, parseConnectLink(params)).open();
    } catch (failure) {
      new Notice(message(failure));
    }
  }

  // SyncHost

  view(): StatusView {
    const status = this.controller?.status() ?? {
      state: "disconnected" as const,
      queued: 0,
      conflicts: 0,
      unsupported: [],
      error: null,
      head: null,
      importId: null,
    };
    return describeStatus({
      status: { ...status, queued: Math.max(status.queued, this.dirty.size) },
      attachments: this.attachments.summary(),
      recovered: this.local.recovered().length,
      lastSynced: this.store.lastSynced(),
      now: Date.now(),
      failure: this.failure,
    });
  }

  authorizationError() {
    return this.authError;
  }

  recovered() {
    return this.local.recovered();
  }

  /** A checkpoint: one commit holding every local change, pushed at once. */
  syncNow() {
    return this.work(false);
  }

  /** A fetch: cloud changes come down and nothing is committed. */
  pullNow() {
    return this.work(true);
  }

  private pendingWork() {
    return (
      this.dirty.size > 0 || this.needsCheckpoint || (this.controller?.status().queued ?? 0) > 0
    );
  }

  /** One piece of work at a time; a checkpoint asked for meanwhile runs right after it. */
  private work(fetchOnly: boolean): Promise<void> {
    if (this.active) {
      if (!fetchOnly) this.again = true;
      return this.active;
    }
    this.active = (async () => {
      let checkpoint = !fetchOnly;
      while (await this.once(checkpoint)) {
        if (!this.again) break;
        this.again = false;
        checkpoint = true;
      }
    })().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  /** Returns false when the device can't sync right now. */
  private async once(checkpoint: boolean) {
    const controller = this.controller;
    if (!controller) return false;
    const state = controller.status().state;
    if (state === "disconnected" || state === "authorizing" || state === "paused") return false;
    if (state === "syncing") {
      // A conflict resolution runs outside this queue. Wait for it rather than drop this request;
      // if something is still running, the next wake retries the checkpoint.
      await controller.sync().catch(() => {});
      if (controller.status().state === "syncing") {
        if (checkpoint) this.needsCheckpoint = true;
        return false;
      }
    }
    const taken = checkpoint ? [...this.dirty] : [];
    if (checkpoint) {
      this.checkpointWhenIdle.cancel();
      this.dirty.clear();
    }
    try {
      await (checkpoint ? controller.sync() : controller.pull());
    } catch {
      // The controller keeps the failure in status().error; the UI shows it.
    }
    const failed = !!controller.status().error;
    if (checkpoint) this.needsCheckpoint = failed;
    if (failed) for (const path of taken) this.dirty.add(path);
    else if (!this.pendingWork()) await this.store.markSynced(Date.now());
    this.emit();
    return true;
  }

  async connect(config: DeviceConfig) {
    if (!this.controller) throw new Error(this.failure ?? "Basalt Sync isn't ready yet.");
    this.authError = null;
    this.clearPoll();
    await this.controller.begin(config);
    this.openApproval();
    this.schedulePoll();
  }

  openApproval() {
    const url = this.controller?.authorization()?.url;
    // Obsidian hands external URLs from window.open to the system browser on desktop and mobile.
    if (url) window.open(url, "_blank");
  }

  cancelAuthorization() {
    this.clearPoll();
    this.controller?.cancel();
  }

  async setPaused(paused: boolean) {
    await this.controller?.pause(paused);
    if (!paused) await this.syncNow();
  }

  async disconnect() {
    this.clearPoll();
    await this.controller?.disconnect();
  }

  openConflicts() {
    new ConflictModal(this).open();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    if (this.statusBar) {
      const view = this.view();
      this.statusBar.setText(`Basalt: ${view.title}`);
      this.statusBar.setAttr("aria-label", view.detail);
      this.statusBar.toggleClass("is-warn", view.tone === "warn" || view.tone === "error");
    }
    for (const listener of this.listeners) listener();
  }

  private clearPoll() {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** RFC 8628 polling at the server's interval; the controller raises it on slow_down. */
  private schedulePoll() {
    this.clearPoll();
    const controller = this.controller,
      pending = controller?.authorization();
    if (!controller || !pending) return;
    if (Date.now() >= pending.expiresAt) {
      // Set before cancel(): cancel notifies listeners, and the connect modal reads the reason then.
      this.authError = "The approval request expired. Choose Connect Obsidian in Basalt again.";
      controller.cancel();
      return;
    }
    this.pollTimer = window.setTimeout(async () => {
      this.pollTimer = null;
      try {
        if (await controller.poll()) {
          new Notice(`${this.vaultName} is connected to Basalt.`);
          await this.syncNow();
          return;
        }
      } catch (failure) {
        if (terminalAuthorization.test(message(failure))) {
          this.authError = message(failure);
          controller.cancel();
          return;
        }
        // Network or parse failures are transient; keep polling until the code expires.
      }
      this.schedulePoll();
    }, pending.interval * 1000);
  }
}
