import type { App } from "obsidian";
import type { AttachmentPort } from "../attachments.ts";
import type { DeviceConfig, DeviceController } from "../controller.ts";
import type { StatusView } from "../status.ts";

/** What the settings tab and modals need from the plugin. Keeps UI files free of lifecycle code. */
export interface SyncHost {
  app: App;
  vaultName: string;
  mobile: boolean;
  controller: DeviceController | null;
  attachments: AttachmentPort;
  view(): StatusView;
  importScope(): Promise<{ files: number; bytes: number }>;
  /** Last connect/approval failure, cleared when a new attempt starts. */
  authorizationError(): string | null;
  recovered(): readonly string[];
  syncNow(): Promise<void>;
  /** Starts device authorization for an accepted connect link and opens the approval page. */
  connect(config: DeviceConfig): Promise<void>;
  openApproval(): void;
  cancelAuthorization(): void;
  setPaused(paused: boolean): Promise<void>;
  disconnect(): Promise<void>;
  openConflicts(): void;
  /** Subscribe to any status change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
