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

const saveDebounceMs = 2_000;
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
  private noteAbort: AbortController | null = null;
  private listeners = new Set<() => void>();
  private statusBar: HTMLElement | null = null;
  private schedule!: Debouncer<[], void>;

  get vaultName() {
    return this.app.vault.getName();
  }
  async importScope() {
    const files = (await this.local.files()).filter((file) => safePath(file.path));
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }

  async onload() {
    this.schedule = debounce(() => void this.syncNow(), saveDebounceMs, true);
    this.store = await openStore({
      load: () => this.loadData(),
      save: (data) => this.saveData(data),
    });
    this.local = createLocalVault<TFile>(this.app.vault, {
      writing: (path) => this.local?.changed(path),
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
    this.schedule?.cancel();
    this.clearPoll();
    this.noteAbort?.abort();
    this.listeners.clear();
    // close() aborts between batches; a sent-but-unconfirmed operation stays saved for receipt recovery.
    void this.controller?.close();
  }

  private start() {
    const touched = (path: string) => {
      this.local.changed(path);
      if (!safePath(path) || this.local.ignored(path)) return this.emit();
      this.schedule();
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
        this.schedule();
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
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.schedule();
    });
    this.registerDomEvent(window, "online", () => this.schedule());
    this.register(
      watchRemoteChanges({
        repeat: (callback, milliseconds) => {
          const timer = window.setInterval(callback, milliseconds);
          return () => window.clearInterval(timer);
        },
        available: () => document.visibilityState === "visible" && navigator.onLine,
        sync: () => this.schedule(),
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
    return describeStatus({
      status: this.controller?.status() ?? {
        state: "disconnected",
        queued: 0,
        conflicts: 0,
        unsupported: [],
        error: null,
        head: null,
        importId: null,
      },
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

  async syncNow() {
    const controller = this.controller;
    if (!controller) return;
    const state = controller.status().state;
    if (state === "disconnected" || state === "authorizing" || state === "paused") return;
    if (state === "syncing") {
      this.again = true;
      return;
    }
    try {
      await controller.sync();
      if (!controller.status().error) await this.store.markSynced(Date.now());
    } catch {
      // The controller keeps the failure in status().error; the UI shows it.
    }
    this.emit();
    if (this.again) {
      this.again = false;
      this.schedule();
    }
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
