import { maximumFileBytes, type LocalFile, type LocalVault } from "./types.ts";

/** Kept visible on purpose, and never synced: notes removed elsewhere land here instead of being deleted. */
export const recoveryFolder = "Signalbox recovered";

interface FileLike {
  path: string;
  stat: { size: number; mtime?: number };
}

/** The slice of Obsidian's public `Vault` this bridge uses. `app.vault` satisfies it structurally. */
export interface VaultPort<F extends FileLike> {
  getFiles(): F[];
  getFileByPath(path: string): F | null;
  getAbstractFileByPath(path: string): unknown;
  read(file: F): Promise<string>;
  process(file: F, fn: (data: string) => string): Promise<string>;
  create(path: string, data: string): Promise<unknown>;
  createFolder(path: string): Promise<unknown>;
  rename(file: F, newPath: string): Promise<void>;
}

// Colons are not valid in iOS/Windows file names.
const stamp = (now: Date) => now.toISOString().slice(0, 19).replace(/:/gu, "-");

export function createLocalVault<F extends FileLike>(
  vault: VaultPort<F>,
  options: {
    /** Called right before the bridge writes `path`, so vault events from our own writes can be ignored. */
    writing?: (path: string) => void;
    now?: () => Date;
    recoveries?: { get(): readonly string[]; add(path: string): Promise<void> };
    transfers?: () => readonly string[];
  } = {},
): LocalVault & {
  recovered(): string[];
  ensureFolder(path: string): Promise<void>;
  revision(path: string): number;
  changed(path: string): void;
  ignored(path: string): boolean;
  preserve(path: string, target?: string): Promise<boolean>;
} {
  const writing = options.writing ?? (() => {});
  const recovered = new Set(options.recoveries?.get() ?? []),
    changes = new Map<string, number>();
  const ignored = (path: string) =>
    recovered.has(path) || (options.transfers?.().includes(path) ?? false);
  const now = options.now ?? (() => new Date());

  const ensureFolder = async (folder: string) => {
    let prefix = "";
    for (const part of folder.split("/").filter(Boolean)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (vault.getAbstractFileByPath(prefix)) continue;
      try {
        await vault.createFolder(prefix);
      } catch (failure) {
        // Another writer created it between the check and the call.
        if (!vault.getAbstractFileByPath(prefix)) throw failure;
      }
    }
  };

  const freePath = (path: string) => {
    const dot = path.lastIndexOf("."),
      slash = path.lastIndexOf("/");
    const stem = dot > slash ? path.slice(0, dot) : path,
      extension = dot > slash ? path.slice(dot) : "";
    let candidate = path;
    for (let n = 2; vault.getAbstractFileByPath(candidate); n++)
      candidate = `${stem} (${n})${extension}`;
    return candidate;
  };

  /**
   * Obsidian's public API has no conditional delete, so a file the cloud removed is moved,
   * never deleted. If someone edited it after our check, the edit moves with it.
   */
  const preserve = async (file: F, selected?: string) => {
    const target = selected ?? freePath(`${recoveryFolder}/${stamp(now())}/${file.path}`);
    recovered.add(target);
    await options.recoveries?.add(target);
    await ensureFolder(target.slice(0, target.lastIndexOf("/")));
    writing(file.path);
    await vault.rename(file, target);
  };

  return {
    ensureFolder,
    revision: (path: string) => changes.get(path) ?? 0,
    changed: (path: string) => {
      changes.set(path, (changes.get(path) ?? 0) + 1);
    },
    ignored,
    async preserve(path: string, target?: string) {
      const file = vault.getFileByPath(path);
      if (!file) return false;
      await preserve(file, target);
      return true;
    },
    async files(): Promise<LocalFile[]> {
      // Every file, attachments included. The sync layer decides what it can carry and
      // reports the rest; nothing is dropped silently here.
      return vault
        .getFiles()
        .filter((file) => !ignored(file.path))
        .map((file) => ({
          path: file.path,
          bytes: file.stat.size,
          ...(file.stat.mtime === undefined
            ? {}
            : { stamp: `${file.stat.mtime}:${file.stat.size}:${changes.get(file.path) ?? 0}` }),
        }));
    },

    async read(path) {
      if (ignored(path)) return null;
      const file = vault.getFileByPath(path);
      // Oversized files read as absent. Every caller then leaves them alone: a later
      // replace with `expected: null` refuses because the file exists.
      if (!file || file.stat.size > maximumFileBytes) return null;
      return vault.read(file);
    },

    async replace(path, expected, content) {
      if (ignored(path)) return false;
      const file = vault.getFileByPath(path);

      if (content === null) {
        if (!file) return expected === null;
        if (expected === null || file.stat.size > maximumFileBytes) return false;
        if ((await vault.read(file)) !== expected) return false;
        await preserve(file);
        return true;
      }

      if (expected === null) {
        if (vault.getAbstractFileByPath(path)) return false;
        const slash = path.lastIndexOf("/");
        if (slash > 0) await ensureFolder(path.slice(0, slash));
        writing(path);
        try {
          await vault.create(path, content);
          return true;
        } catch (failure) {
          // Created concurrently: keep theirs, report the miss.
          if (vault.getAbstractFileByPath(path)) return false;
          throw failure;
        }
      }

      if (!file || file.stat.size > maximumFileBytes) return false;
      let matched = false;
      writing(path);
      // Vault.process reads, transforms and saves atomically; a differing body is written back unchanged.
      await vault.process(file, (data) => {
        if (data !== expected) return data;
        matched = true;
        return content;
      });
      return matched;
    },

    recovered() {
      return vault
        .getFiles()
        .filter((file) => recovered.has(file.path))
        .map((file) => file.path)
        .sort();
    },
  };
}
