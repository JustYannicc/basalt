import { incrementalSha256 } from "../../src/drive/shared/bytes.ts";
import { downloadFiles } from "./download-files.ts";
import { resourceRange } from "./resource-range.ts";
import { safePath } from "./types.ts";
import { recoveryFolder } from "./local-vault.ts";
import { object, text, number } from "./http.ts";
import type { BinaryIo, BinarySnapshot } from "./binary-types.ts";
import type { DataFiles, VaultFiles, DesktopReader } from "./binary-file-types.ts";
export function createBinaryIo<F extends { path: string }>(input: {
  adapter: DataFiles;
  vault: VaultFiles<F>;
  local: {
    revision(path: string): number;
    ensureFolder(path: string): Promise<void>;
    preserve(path: string, target?: string): Promise<boolean>;
  };
  privateRoot: string;
  transferRoot: string;
  ownership: {
    get(): readonly string[];
    add(path: string): Promise<void>;
    remove(path: string): Promise<void>;
  };
  id: () => string;
  links?: (path: string) => Promise<readonly string[]>;
  desktop?: DesktopReader;
  signal?: AbortSignal;
}): BinaryIo & { pendingSnapshot(path: string, id: string): Promise<BinarySnapshot | null> } {
  const { adapter, vault, local, ownership } = input,
    parts = downloadFiles(adapter, input.privateRoot);
  const check = () => input.signal?.throwIfAborted();
  const snapshot = async (path: string) => {
    if (input.desktop) return input.desktop.snapshot(path);
    const stat = await adapter.stat(path);
    return stat?.type === "file"
      ? { bytes: stat.size, stamp: `${stat.mtime}:${stat.size}:${local.revision(path)}` }
      : null;
  };
  const matches = (a: BinarySnapshot | null, b: BinarySnapshot | null) =>
    a === null ? b === null : b !== null && a.stamp === b.stamp && a.bytes === b.bytes;
  const read = async (path: string, expected: BinarySnapshot, offset: number, length: number) => {
    check();
    if (!matches(await snapshot(path), expected))
      throw new Error("Local attachment changed during its read");
    let bytes: Uint8Array<ArrayBuffer>;
    if (input.desktop) bytes = await input.desktop.read(path, expected, offset, length);
    else if (expected.bytes <= 8 * 1048576)
      bytes = new Uint8Array(await adapter.readBinary(path)).slice(offset, offset + length);
    else bytes = await resourceRange(adapter, path, offset, length, expected.bytes);
    if (bytes.length !== length || !matches(await snapshot(path), expected))
      throw new Error("Local attachment changed or its range was truncated");
    return bytes;
  };
  const journal = async (id: string) => {
    const raw: unknown = await parts.journal(id);
    if (raw === null) return null;
    const value = object(raw),
      expected = value.expected === null ? null : object(value.expected);
    return {
      path: text(value, "path"),
      recovery: value.recovery === null ? null : text(value, "recovery"),
      expected: expected
        ? { stamp: text(expected, "stamp"), bytes: number(expected, "bytes") }
        : null,
    };
  };
  const ownedRecovery = async (path: string, id: string) => {
    const prior = await journal(id);
    if (
      !prior ||
      prior.path !== path ||
      !prior.expected ||
      !prior.recovery ||
      (await adapter.exists(path))
    )
      return null;
    const recovered = await adapter.stat(prior.recovery);
    return recovered?.type === "file" && recovered.size === prior.expected.bytes
      ? prior.expected
      : null;
  };
  const transfer = async (id: string) => {
    parts.path(id);
    const path = `${input.transferRoot}/${id}.bin`;
    await ownership.add(path);
    await local.ensureFolder(input.transferRoot);
    const previous = vault.getFileByPath(path);
    if (previous) await vault.delete(previous);
    else if (await adapter.exists(path))
      throw new Error("Wait for Obsidian to index its pending download");
    return vault.createBinary(path, new ArrayBuffer(0));
  };
  return {
    snapshot,
    read,
    beginDownload: parts.begin,
    readDownload: parts.read,
    appendDownload: parts.append,
    async removeDownload(id) {
      await parts.remove(id);
      const path = `${input.transferRoot}/${id}.bin`;
      if (ownership.get().includes(path)) {
        const file = vault.getFileByPath(path);
        if (file) await vault.delete(file);
        await ownership.remove(path);
      }
    },
    pendingSnapshot: ownedRecovery,
    async publishDownload(value) {
      check();
      value.signal?.throwIfAborted();
      if (!safePath(value.path)) throw new Error("Unsafe attachment destination");
      const total = await parts.begin(value.id),
        assembled = await transfer(value.id);
      for (let offset = 0; offset < total; offset += 1048576) {
        check();
        value.signal?.throwIfAborted();
        await vault.appendBinary(
          assembled,
          (await parts.read(value.id, offset, Math.min(1048576, total - offset))).buffer,
        );
      }
      let actual = await snapshot(value.path),
        prior = await journal(value.id);
      if (prior && prior.path !== value.path)
        throw new Error("A saved publication names another file");
      const resumed = actual === null ? await ownedRecovery(value.path, value.id) : null;
      if (!resumed && !matches(actual, value.expected)) return false;
      if (actual) {
        let target = prior?.recovery ?? `${recoveryFolder}/${value.id}/${value.path}`;
        if (await adapter.exists(target))
          target = `${recoveryFolder}/${value.id}-${input.id()}/${value.path}`;
        await parts.writeJournal(value.id, {
          path: value.path,
          expected: actual,
          recovery: target,
        });
        if (!(await local.preserve(value.path, target))) return false;
        actual = await snapshot(value.path);
        if (actual) return false;
      } else if (!prior) {
        await parts.writeJournal(value.id, { path: value.path, expected: null, recovery: null });
      }
      check();
      value.signal?.throwIfAborted();
      if (await adapter.exists(value.path)) return false;
      await local.ensureFolder(value.path.split("/").slice(0, -1).join("/"));
      try {
        await vault.rename(assembled, value.path);
      } catch (failure) {
        if (await adapter.exists(value.path))
          throw new Error("The destination appeared during publication; its bytes were kept", {
            cause: failure,
          });
        throw failure;
      }
      await ownership.remove(`${input.transferRoot}/${value.id}.bin`);
      await parts.remove(value.id);
      return true;
    },
    async preserve(path, expected) {
      check();
      if (!matches(await snapshot(path), expected)) return false;
      return local.preserve(path);
    },
    async evict(path, expected) {
      check();
      if (!safePath(path) || !matches(await snapshot(path), expected)) return false;
      if (!expected.oid) throw new Error("A retained hash is required before removing local bytes");
      const id = `evict-${input.id()}`,
        target = `${input.transferRoot}/${id}.bin`;
      await ownership.add(target);
      await local.ensureFolder(input.transferRoot);
      const file = vault.getFileByPath(path);
      if (!file) return false;
      await vault.rename(file, target);
      try {
        const moved = await snapshot(target);
        if (!moved) throw new Error("The removed copy could not be verified");
        const hash = incrementalSha256();
        for (let offset = 0; offset < moved.bytes; offset += 1048576) {
          check();
          hash.update(await read(target, moved, offset, Math.min(1048576, moved.bytes - offset)));
        }
        if (hash.digest() !== expected.oid)
          throw new Error("The local file changed before removal");
        const retained = vault.getFileByPath(target);
        if (retained) await vault.delete(retained);
        await ownership.remove(target);
        return true;
      } catch (failure) {
        const retained = vault.getFileByPath(target);
        if (retained) await local.preserve(target);
        await ownership.remove(target);
        throw new Error(
          "The downloaded copy could not be safely removed. Its bytes are kept in Signalbox recovered.",
          { cause: failure },
        );
      }
    },
    noteLinks: input.links ?? (async () => []),
  };
}
