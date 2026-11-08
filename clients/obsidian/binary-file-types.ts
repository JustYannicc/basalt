import type { BinarySnapshot } from "./binary-types.ts";
export interface FileStat {
  type: "file" | "folder";
  size: number;
  mtime: number;
}
export interface DataFiles {
  stat(path: string): Promise<FileStat | null>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  appendBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  getResourcePath(path: string): string;
}
export interface VaultFiles<F> {
  getFileByPath(path: string): F | null;
  createBinary(path: string, data: ArrayBuffer): Promise<F>;
  appendBinary(file: F, data: ArrayBuffer): Promise<void>;
  rename(file: F, path: string): Promise<void>;
  delete(file: F): Promise<void>;
}
export interface DesktopReader {
  snapshot(path: string): Promise<BinarySnapshot | null>;
  read(
    path: string,
    expected: BinarySnapshot,
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer>>;
}
