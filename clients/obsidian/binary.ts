import { binaryConflictTools } from "./binary-conflicts.ts";
import { binaryDownloader } from "./binary-download.ts";
import { linkedAttachments } from "./binary-links.ts";
import { blobId, safePath, type LocalVault, type RemoteVault } from "./types.ts";
import type { AttachmentPort, DeviceMode } from "./attachments.ts";
import type { BinaryIo, BinarySnapshot, BinaryStateStore, RemoteBinary } from "./binary-types.ts";
import { decodeBinaryState, pointerIdentity } from "./binary-state.ts";
import { binaryUploader } from "./binary-upload.ts";
import { incrementalSha256 } from "../../src/drive/shared/bytes.ts";
import { isTextContent, isTextPath, maximumTextBytes } from "../../src/drive/text-files.ts";
export async function createBinaryClient(input: {
  text: LocalVault;
  io: BinaryIo;
  remote: RemoteVault & RemoteBinary;
  store: BinaryStateStore;
  pins: { get(): readonly string[]; set(value: readonly string[]): Promise<void> };
  mode: DeviceMode;
  id: () => string;
  changed: () => void;
  signal?: AbortSignal;
  resolve?: (ref: string, edits: readonly import("./types.ts").Edit[]) => Promise<void>;
}) {
  const state = decodeBinaryState(await input.store.load()),
    stop = new AbortController(),
    listeners = new Set<() => void>();
  const check = () => {
    stop.signal.throwIfAborted();
    input.signal?.throwIfAborted();
  };
  const save = async () => {
    await input.store.save(structuredClone(state));
    input.changed();
    for (const listener of listeners) listener();
  };
  const uploading = new Map<string, Promise<string>>(),
    downloading = new Map<string, Promise<boolean>>(),
    failures = new Map<string, string>();
  const inFolder = (path: string, folder: string) =>
    path === folder || path.startsWith(folder + "/");
  let required = new Set<string>();
  const pinned = (path: string) =>
    input.pins.get().some((folder) => inFolder(path, folder)) || required.has(path);
  const fetchBytes = binaryDownloader({ ...input, state, save, check });
  const ensure = async (path: string, signal?: AbortSignal) => {
    check();
    const record = state.files[path];
    if (!record) throw new Error("This attachment is not in Signalbox's file list yet");
    if (record.materialized && (await input.io.snapshot(path))) return true;
    let work = downloading.get(path);
    if (!work) {
      work = fetchBytes(path, record, null, signal)
        .catch((failure: unknown) => {
          if (!signal?.aborted && !stop.signal.aborted && !input.signal?.aborted)
            failures.set(
              path,
              failure instanceof Error ? failure.message : "Attachment download failed",
            );
          throw failure;
        })
        .finally(() => {
          downloading.delete(path);
          input.changed();
          for (const listener of listeners) listener();
        });
      downloading.set(path, work);
      input.changed();
    }
    return work;
  };
  const refreshPins = async () => {
    const available = new Set(Object.keys(state.files)),
      needed = new Set<string>();
    for (const file of await input.text.files())
      if (
        file.path.endsWith(".md") &&
        input.pins.get().some((folder) => inFolder(file.path, folder))
      )
        for (const path of linkedAttachments(
          file.path,
          await input.io.noteLinks(file.path),
          available,
        ))
          needed.add(path);
    required = needed;
  };

  const uploadFile = binaryUploader({ ...input, state, save, check });
  // A path already kept as an attachment stays one. Text must also decode losslessly, or its
  // exact bytes go up as an attachment instead of being mangled by a text round trip.
  const textual = async (path: string, snapshot: BinarySnapshot) =>
    isTextPath(path) &&
    !state.files[path] &&
    snapshot.bytes <= maximumTextBytes &&
    // The desktop reader refuses zero-length reads, and an empty file is valid text anyway.
    (snapshot.bytes === 0 || isTextContent(await input.io.read(path, snapshot, 0, snapshot.bytes)));
  // A pull compares this against blobs; no pointer or note can contain a NUL byte.
  const changed = "\u0000changed attachment";
  const look = async (path: string, upload: boolean): Promise<string | null> => {
    const file = await input.io.snapshot(path);
    if (!file) {
      const known = state.files[path],
        pending = state.downloads[path];
      if (known?.materialized && pending && input.io.pendingSnapshot) {
        const recovered = await input.io.pendingSnapshot(path, pending.id);
        if (recovered?.stamp === known.stamp) return known.pointer;
      }
      return known?.materialized ? null : (known?.pointer ?? null);
    }
    if (file.bytes === 0 || (await textual(path, file))) return input.text.read(path);
    if (!safePath(path)) throw new Error("Unsafe local attachment path");
    if (!upload) {
      const known = state.files[path];
      if (!known?.materialized) return changed;
      if (known.stamp === file.stamp) return known.pointer;
      // A rewrite with the same bytes is no edit; hash it, without uploading, to tell.
      const identity = pointerIdentity(known.pointer);
      if (identity?.bytes !== file.bytes) return changed;
      const hash = incrementalSha256();
      for (let offset = 0; offset < file.bytes; offset += 1048576)
        hash.update(
          await input.io.read(path, file, offset, Math.min(1048576, file.bytes - offset)),
        );
      return hash.digest() === identity.oid ? known.pointer : changed;
    }
    let work = uploading.get(path);
    if (!work) {
      work = uploadFile(path, file).finally(() => uploading.delete(path));
      uploading.set(path, work);
    }
    return work;
  };
  const local: LocalVault = {
    binary: true,
    initialSource: input.mode === "full",
    async importEntry(file) {
      const snapshot = await input.io.snapshot(file.path);
      if (!snapshot) return null;
      if (await textual(file.path, snapshot)) {
        const content = await input.text.read(file.path);
        return content === null
          ? null
          : {
              path: file.path,
              kind: "note",
              bytes: new TextEncoder().encode(content).length,
              hash: await blobId(content),
            };
      }
      const hash = incrementalSha256();
      for (let offset = 0; offset < snapshot.bytes; offset += 1048576) {
        check();
        hash.update(
          await input.io.read(
            file.path,
            snapshot,
            offset,
            Math.min(1048576, snapshot.bytes - offset),
          ),
        );
      }
      const current = await input.io.snapshot(file.path);
      if (current?.stamp !== snapshot.stamp || current.bytes !== snapshot.bytes)
        throw new Error(
          `Local file changed while preparing its import: ${file.path}. Its bytes are kept.`,
        );
      return { path: file.path, kind: "attachment", bytes: snapshot.bytes, hash: hash.digest() };
    },
    async files() {
      const actual = await input.text.files(),
        seen = new Set(actual.map((file) => file.path));
      return [
        ...actual,
        ...Object.entries(state.files)
          .filter(([path, value]) => !seen.has(path) && !value.materialized)
          .map(([path, value]) => ({ path, bytes: pointerIdentity(value.pointer)!.bytes })),
      ];
    },
    read: (path) => look(path, true),
    inspect: (path) => look(path, false),
    async replace(path, expected, content, context) {
      const identity = pointerIdentity(content ?? ""),
        known = state.files[path];
      if (!identity && !known) return input.text.replace(path, expected, content, context);
      if ((await look(path, false)) !== expected) return false;
      const snapshot = await input.io.snapshot(path);
      if (content === null) {
        if (snapshot && !(await input.io.preserve(path, snapshot))) return false;
        delete state.files[path];
        const pending = state.downloads[path];
        if (pending) {
          await input.io.removeDownload(pending.id);
          delete state.downloads[path];
        }
        await save();
        return true;
      }
      if (!identity) {
        const id = `inline-${input.id()}`;
        await input.io.beginDownload(id);
        const bytes = new TextEncoder().encode(content);
        for (let offset = 0; offset < bytes.length; offset += 65536)
          await input.io.appendDownload(id, offset, bytes.slice(offset, offset + 65536));
        if (!(await input.io.publishDownload({ id, path, expected: snapshot }))) return false;
        delete state.files[path];
        await save();
        return true;
      }
      if (!context?.at) throw new Error("An attachment download needs its pinned cloud revision");
      if (known?.pointer === content && snapshot && known.materialized) {
        state.files[path] = { ...known, at: context.at };
        await save();
        return true;
      }
      const wanted = { pointer: content, at: context.at, materialized: false, stamp: null };
      if (input.mode === "on-demand" && !path.toLowerCase().endsWith(".md") && !pinned(path)) {
        // Preserve an old downloaded version before replacing its virtual cloud entry.
        if (snapshot && !(await input.io.preserve(path, snapshot))) return false;
        state.files[path] = wanted;
        await save();
        return true;
      }
      return fetchBytes(path, wanted, snapshot);
    },
    async accept(path, at, blob) {
      const known = state.files[path];
      if (!known) return;
      if (blob === null) delete state.files[path];
      else if ((await blobId(known.pointer)) === blob) state.files[path] = { ...known, at };
      await save();
    },
  };
  const flush = async () => {
    check();
    await refreshPins();
    for (const [path, record] of Object.entries(state.files))
      if (
        (input.mode === "full" || path.toLowerCase().endsWith(".md") || pinned(path)) &&
        !record.materialized
      )
        await ensure(path);
  };
  const entries = () =>
    Object.entries(state.files).map(([path, value]) => ({
      path,
      bytes: pointerIdentity(value.pointer)!.bytes,
      local: value.materialized,
      pinned: input.mode === "full" || path.toLowerCase().endsWith(".md") || pinned(path),
    }));
  const port = {
    ...binaryConflictTools(input.remote, input.resolve),
    mode: () => input.mode,
    entries,
    summary: () => ({
      unsynced: Object.keys(state.uploads),
      cloudOnly: Object.values(state.files).filter((value) => !value.materialized).length,
      downloading: downloading.size,
      failed: [...failures].map(([path, reason]) => ({ path, reason })),
    }),
    pins: () => (input.mode === "full" ? [] : input.pins.get()),
    async setPinned(folder, value) {
      if (!safePath(folder)) throw new Error("Invalid offline folder");
      const pins = new Set(input.pins.get());
      if (value) pins.add(folder);
      else pins.delete(folder);
      await input.pins.set([...pins]);
      await flush();
      await save();
    },
    async noteOpened(path, signal) {
      check();
      signal.throwIfAborted();
      const available = new Set(Object.keys(state.files));
      if (available.has(path)) await ensure(path, signal);
      for (const target of linkedAttachments(path, await input.io.noteLinks(path), available)) {
        signal.throwIfAborted();
        await ensure(target, signal);
      }
    },
    async download(path, signal) {
      if (!(await ensure(path, signal)))
        throw new Error("Local attachment changed during download. Its bytes were kept.");
      failures.delete(path);
      await save();
    },
    async evict(path) {
      check();
      await refreshPins();
      if (input.mode === "full" || path.toLowerCase().endsWith(".md") || pinned(path))
        throw new Error(
          "This attachment is kept offline. Unpin its folder before removing the downloaded copy.",
        );
      const record = state.files[path],
        snapshot = await input.io.snapshot(path);
      if (
        !record?.at ||
        state.uploads[path] ||
        !snapshot ||
        !record.materialized ||
        snapshot.stamp !== record.stamp
      )
        throw new Error(
          "This device has bytes Signalbox may not hold yet. Sync before removing this copy.",
        );
      const info = await input.remote.info({ path, at: record.at });
      if (info?.attachment?.oid !== pointerIdentity(record.pointer)?.oid)
        throw new Error("The retained cloud copy could not be verified");
      state.files[path] = { ...record, materialized: false, stamp: null };
      await save();
      if (
        !(await input.io.evict(path, { ...snapshot, oid: pointerIdentity(record.pointer)!.oid }))
      ) {
        state.files[path] = record;
        await save();
        throw new Error("Local attachment changed and was kept");
      }
      failures.delete(path);
      await save();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies AttachmentPort;
  return {
    ...port,
    local,
    flush,
    close() {
      stop.abort();
    },
  };
}
