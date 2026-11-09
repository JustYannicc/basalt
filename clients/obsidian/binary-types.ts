import type { AttachmentPort } from "./attachments.ts";
import type { LocalVault } from "./types.ts";
export interface BinaryIdentity {
  oid: string;
  bytes: number;
}
export interface FileInfo {
  at: string;
  path: string;
  blob: string;
  bytes: number;
  attachment: BinaryIdentity | null;
}
export interface UploadState extends BinaryIdentity {
  state: "uploading" | "present";
  upload: string;
  partBytes: number;
  parts: number;
  expiresAt: number;
  missing: readonly number[];
  next: number | null;
}
export interface RemoteBinary {
  info(input: { path: string; at: string }): Promise<FileInfo | null>;
  beginAttachment(
    input: BinaryIdentity & { operation: string; cursor?: number },
  ): Promise<UploadState>;
  uploadAttachmentPart(input: {
    upload: string;
    part: number;
    contentBase64: string;
  }): Promise<{ part: number; bytes: number }>;
  completeAttachment(input: {
    upload: string;
    cursor?: number;
  }): Promise<BinaryIdentity & { state: "present" | "verifying"; next: number | null }>;
  cancelAttachment(input: { upload: string; cursor?: number }): Promise<{ next: number | null }>;
  download(input: { path: string; at: string; offset: number; maxBytes: number }): Promise<{
    blob: string;
    bytes: number;
    offset: number;
    next: number | null;
    contentBase64: string;
  } | null>;
}
export interface BinarySnapshot {
  bytes: number;
  stamp: string;
  oid?: string;
}
export interface BinaryIo {
  pendingSnapshot?(path: string, id: string): Promise<BinarySnapshot | null>;
  snapshot(path: string): Promise<BinarySnapshot | null>;
  read(
    path: string,
    snapshot: BinarySnapshot,
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer>>;
  beginDownload(id: string): Promise<number>;
  readDownload(id: string, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
  appendDownload(id: string, offset: number, content: Uint8Array<ArrayBuffer>): Promise<void>;
  publishDownload(input: {
    id: string;
    path: string;
    expected: BinarySnapshot | null;
    signal?: AbortSignal;
  }): Promise<boolean>;
  removeDownload(id: string): Promise<void>;
  preserve(path: string, expected: BinarySnapshot): Promise<boolean>;
  evict(path: string, expected: BinarySnapshot): Promise<boolean>;
  noteLinks(path: string): Promise<readonly string[]>;
}
export interface BinaryRecord {
  pointer: string;
  at: string | null;
  materialized: boolean;
  stamp: string | null;
}
export interface BinaryUpload extends BinaryIdentity {
  operation: string;
  stamp: string;
  upload: string | null;
  cursor: number | null;
}
export interface BinaryDownload {
  pointer: string;
  at: string;
  id: string;
}
export interface BinaryState {
  version: 1;
  files: Record<string, BinaryRecord>;
  uploads: Record<string, BinaryUpload>;
  downloads: Record<string, BinaryDownload>;
}
export interface BinaryStateStore {
  load(): Promise<BinaryState | null>;
  save(state: BinaryState): Promise<void>;
}
export interface BinaryClient extends AttachmentPort {
  local: LocalVault;
  close(): void;
  flush(): Promise<void>;
}
