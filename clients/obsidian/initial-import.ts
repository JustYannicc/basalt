import { dictionary } from "./dictionary.ts";
import {
  blobId,
  maximumFileBytes,
  safePath,
  type LocalFile,
  type LocalVault,
  type RemoteVault,
  type SyncState,
} from "./types.ts";
import type { ImportEntry, ImportPlan } from "./import-types.ts";

export function initialImport(input: {
  state: SyncState;
  local: LocalVault;
  remote: RemoteVault;
  save: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const { state, local, save } = input,
    remote = input.remote.initial;
  const positions = new Map(state.initial?.entries.map((entry, index) => [entry.path, index]));
  let confirmed = Object.keys(state.initial?.done ?? {}).length,
    totalBytes = state.initial?.entries.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;
  const check = () => input.signal?.throwIfAborted();
  const entry = async (file: LocalFile): Promise<ImportEntry | null> => {
    check();
    if (!safePath(file.path)) return null;
    if (local.importEntry) return local.importEntry(file);
    if (!file.path.endsWith(".md") || file.bytes > maximumFileBytes)
      throw new Error(
        `Import ${file.path} from your Mac; this device cannot read it within its file limit. Its bytes are kept.`,
      );
    const content = await local.read(file.path);
    return content === null
      ? null
      : {
          path: file.path,
          kind: "note",
          bytes: new TextEncoder().encode(content).length,
          hash: await blobId(content),
        };
  };
  const done = () => {
    state.initial = {
      phase: "complete",
      entries: [],
      done: dictionary(),
      nextPage: 0,
      pending: null,
    };
    positions.clear();
    confirmed = 0;
    totalBytes = 0;
    remote?.activate(null);
  };
  const page = async (value: ImportPlan) => {
    if (!remote || !state.initial) throw new Error("Initial import is not configured");
    const initial = state.initial;
    initial.pending = value;
    await save();
    check();
    const result = await remote.plan(value);
    if (result.id !== state.importId || result.nextPage !== value.page + 1)
      throw new Error("Cloud import manifest did not acknowledge this page");
    if (initial.phase === "ready") {
      for (const update of value.entries) {
        const index = positions.get(update.path);
        totalBytes += update.bytes - (index === undefined ? 0 : initial.entries[index]!.bytes);
        if (index === undefined) {
          positions.set(update.path, initial.entries.length);
          initial.entries.push(update);
        } else initial.entries[index] = update;
      }
    }
    for (const path of value.removed ?? [])
      if (!initial.done[path]) {
        initial.done[path] = true;
        confirmed++;
      }
    initial.nextPage = result.nextPage;
    if (result.state === "ready") initial.phase = "ready";
    initial.pending = null;
    await save();
  };
  const active = () => !!remote && state.initial?.phase === "ready";
  const pending = (path: string) => positions.has(path) && state.initial?.done[path] !== true;
  return {
    active,
    pending,
    progress: () =>
      state.initial?.phase === "planning" || state.initial?.phase === "ready"
        ? { phase: state.initial.phase, files: positions.size, bytes: totalBytes, confirmed }
        : undefined,
    async prepare() {
      if (!remote) return;
      if (state.initial?.phase === "complete") {
        remote.activate(null);
        return;
      }
      const current = await remote.current();
      if (current?.state === "complete") {
        done();
        await save();
        return;
      }
      if (current && current.id !== state.importId)
        throw new Error(
          "The initial import is still running on another device. Keep your Mac open until it finishes.",
        );
      if (!state.initial) {
        if (local.initialSource === false)
          throw new Error("Import this vault on your Mac first. Your iPhone's files are kept.");
        const entries: ImportEntry[] = [];
        for (const file of await local.files()) {
          const value = await entry(file);
          if (value) entries.push(value);
        }
        state.initial = {
          phase: "planning",
          entries,
          done: dictionary(),
          nextPage: 0,
          pending: null,
        };
        for (const [index, entry] of entries.entries()) positions.set(entry.path, index);
        totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        await save();
      }
      const initial = state.initial;
      if (initial.pending) await page(initial.pending);
      if (current?.state === "ready" && current.expiresAt <= Date.now())
        await page({ id: state.importId, page: initial.nextPage, entries: [], final: true });
      if (initial.phase === "planning") {
        let offset = initial.nextPage * 100;
        do {
          const batch = initial.entries.slice(offset, offset + 100);
          await page({
            id: state.importId,
            page: initial.nextPage,
            entries: batch,
            final: offset + batch.length >= initial.entries.length,
          });
          offset += batch.length;
        } while (initial.phase === "planning");
      }
      remote.activate(state.importId);
    },
    async track(file: LocalFile) {
      if (!active()) return;
      const initial = state.initial!;
      const value = await entry(file);
      if (!value) return;
      const index = positions.get(file.path),
        prior = index === undefined ? undefined : initial.entries[index];
      if (prior?.hash === value.hash && prior.bytes === value.bytes && prior.kind === value.kind)
        return;
      await page({ id: state.importId, page: initial.nextPage, entries: [value], final: true });
    },
    acknowledge(paths: readonly string[]) {
      if (!active()) return;
      for (const path of paths)
        if (pending(path)) {
          state.initial!.done[path] = true;
          confirmed++;
        }
    },
    async finish(paths: ReadonlySet<string>) {
      if (!remote || !active()) return false;
      const initial = state.initial!;
      const removed = initial.entries
        .filter((file) => !paths.has(file.path) && !initial.done[file.path])
        .map((file) => file.path);
      for (let offset = 0; offset < removed.length; offset += 100)
        await page({
          id: state.importId,
          page: initial.nextPage,
          entries: [],
          removed: removed.slice(offset, offset + 100),
          final: true,
        });
      if (initial.entries.some((file) => !initial.done[file.path])) return false;
      check();
      const result = await remote.finish(state.importId);
      if (result.state !== "complete")
        throw new Error("Cloud initial import still has unconfirmed files");
      done();
      await save();
      return true;
    },
  };
}
