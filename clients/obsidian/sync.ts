import {
  blobId,
  maximumFileBytes,
  safePath,
  type LocalVault,
  type RemoteVault,
  type StateStore,
  type SyncState,
  type Pending,
  type Receipt,
  type Edit,
  type SyncStatus,
} from "./types.ts";
import { pull } from "./pull.ts";
import { dictionary } from "./dictionary.ts";
import { initialImport } from "./initial-import.ts";

export async function createSync(input: {
  local: LocalVault;
  remote: RemoteVault;
  store: StateStore;
  id: () => string;
  signal?: AbortSignal;
}) {
  const { local, remote, store, id } = input;
  const state: SyncState = (await store.load()) ?? {
    version: 1,
    importId: id(),
    head: null,
    files: dictionary(),
    pending: null,
    conflicts: [],
    unsupported: [],
  };
  if (state.version !== 1) throw new Error("This sync state needs a newer plugin");
  // Structured-clone storage restores normal prototypes; vault paths are arbitrary dictionary keys.
  state.files = dictionary(Object.entries(state.files));
  if (state.pending) {
    state.pending.sent = dictionary(Object.entries(state.pending.sent));
    if (state.pending.before)
      state.pending.before = dictionary(Object.entries(state.pending.before));
  }
  // Source stamps are trusted only within this session, never across an offline restart.
  const localHashes = new Map<string, { stamp: string; hash: string }>();
  let running: Promise<void> | null = null,
    error: string | null = null,
    queued = 0;
  const save = () => store.save(structuredClone(state));
  const importing = initialImport({
    state,
    local,
    remote,
    save,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const status = (): SyncStatus => ({
    ...(importing.progress() ? { initial: importing.progress()! } : {}),
    state: running
      ? "syncing"
      : error
        ? "offline"
        : state.conflicts.length
          ? "conflict"
          : state.unsupported.length
            ? "attention"
            : "idle",
    queued: state.pending?.request.edits.length ?? queued,
    conflicts: state.conflicts.length,
    unsupported: [...state.unsupported],
    error,
    head: state.head,
    importId: state.importId,
  });
  const finish = async (pending: Pending, receipt: Receipt) => {
    importing.acknowledge(pending.request.edits.map((edit) => edit.path));
    if (receipt.state === "conflict") {
      state.conflicts = state.conflicts.filter((conflict) => conflict.ref !== receipt.ref);
      state.conflicts.push(receipt);
    } else {
      for (const edit of pending.request.edits) {
        const sent = pending.sent[edit.path] ?? null;
        if (pending.kind === "resolve" && pending.before)
          await local.replace(edit.path, pending.before[edit.path] ?? null, edit.content, {
            at: receipt.oid,
          });
        const cloud = await remote.read({ path: edit.path, at: receipt.oid, maxBytes: 4 });
        await local.accept?.(edit.path, receipt.oid, cloud?.blob ?? null);
        state.files[edit.path] = {
          at:
            cloud?.blob === sent || (!cloud && sent === null) ? receipt.oid : pending.request.base,
          local: sent,
          cloud: cloud?.blob ?? null,
        };
      }
      if (pending.kind === "resolve")
        state.conflicts = state.conflicts.filter(
          (conflict) => conflict.ref !== pending.resolution?.ref,
        );
      state.head = receipt.oid;
    }
    state.pending = null;
    queued = 0;
    await save();
  };
  const deliver = async () => {
    input.signal?.throwIfAborted();
    const pending = state.pending;
    if (!pending) return;
    if (pending.attempts > 0) {
      const receipt = await remote.receipt(pending.request.operation);
      if (receipt?.state === "landed" || receipt?.state === "conflict") {
        input.signal?.throwIfAborted();
        await finish(pending, receipt);
        return;
      }
    }
    pending.attempts++;
    await save();
    const receipt =
      pending.kind === "resolve" && pending.resolution
        ? await remote.resolve({
            ...pending.resolution,
            operation: pending.request.operation,
            edits: pending.request.edits,
          })
        : await remote.apply(pending.request);
    input.signal?.throwIfAborted();
    await finish(pending, receipt);
  };
  const submit = async (base: string, edits: readonly Edit[]) => {
    const sent = dictionary<string | null>();
    for (const edit of edits)
      sent[edit.path] = edit.content === null ? null : await blobId(edit.content);
    state.pending = {
      kind: "apply",
      request: { base, operation: `sync-${id()}`, edits },
      sent,
      attempts: 0,
    };
    await save();
    await deliver();
  };
  const perform = async () => {
    error = null;
    await importing.prepare();
    await deliver();
    if (!state.head || !state.importBase) {
      const page = await remote.list({ limit: 1 });
      state.head ??= page.at;
      state.importBase = page.importBase ?? null;
      await save();
    }
    state.unsupported = [];
    await pull({ state, local, remote, save, ...(input.signal ? { signal: input.signal } : {}) });
    const listed = await local.files(),
      paths = new Set(listed.map((file) => file.path));
    for (const path of localHashes.keys()) if (!paths.has(path)) localHashes.delete(path);
    const blocked = new Set(
      state.conflicts.flatMap((conflict) => conflict.conflicts.map((file) => file.path)),
    );
    let batch: Edit[] = [],
      bytes = 0,
      base = state.head;
    const flush = async () => {
      if (batch.length) {
        const submitted = batch;
        batch = [];
        bytes = 0;
        await submit(base, submitted);
      }
    };
    for (const file of listed) {
      input.signal?.throwIfAborted();
      if (
        !safePath(file.path) ||
        (!local.binary && (!file.path.endsWith(".md") || file.bytes > maximumFileBytes))
      ) {
        state.unsupported.push(file.path);
        continue;
      }
      if (blocked.has(file.path)) continue;
      if (importing.active() && !importing.pending(file.path) && state.files[file.path]) continue;
      await importing.track(file);
      const cached = localHashes.get(file.path);
      if (
        !importing.pending(file.path) &&
        file.stamp !== undefined &&
        cached?.stamp === file.stamp &&
        state.files[file.path]?.local === cached.hash
      )
        continue;
      const content = await local.read(file.path);
      if (content === null) continue;
      const actualBytes = new TextEncoder().encode(content).length;
      if (actualBytes > maximumFileBytes) {
        state.unsupported.push(file.path);
        continue;
      }
      const hash = await blobId(content),
        prior = state.files[file.path];
      if (file.stamp !== undefined) localHashes.set(file.path, { stamp: file.stamp, hash });
      if (prior?.local === hash && !importing.pending(file.path)) continue;
      if (!prior && !state.importBase)
        throw new Error("Update the cloud Obsidian app before importing new files");
      let at = prior?.at ?? state.importBase!;
      if (
        batch.length &&
        (at !== base || batch.length >= 100 || bytes + actualBytes > 2 * 1024 * 1024)
      ) {
        await flush();
        at = prior?.at ?? state.importBase!;
      }
      base = at;
      batch.push({ path: file.path, content });
      bytes += actualBytes;
      queued++;
    }
    await flush();
    for (const [path, prior] of Object.entries(state.files)) {
      if (importing.active()) continue;
      if (paths.has(path) || blocked.has(path) || prior.local === null) continue;
      await submit(prior.at, [{ path, content: null }]);
    }
    if (state.head !== state.pulledHead)
      await pull({ state, local, remote, save, ...(input.signal ? { signal: input.signal } : {}) });
    await save();
    if (await importing.finish(paths)) await perform();
  };
  const run = () => {
    if (running) return running;
    running = perform()
      .catch((failure: unknown) => {
        error = failure instanceof Error ? failure.message : "Sync failed";
        throw failure;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const resolve = async (ref: string, edits: readonly Edit[]) => {
    if (running) throw new Error("Wait for the current sync to finish");
    const conflict = state.conflicts.find((value) => value.ref === ref);
    if (!conflict) throw new Error("Conflict no longer exists");
    const main = (await remote.list({ limit: 1 })).at;
    const sent = dictionary<string | null>();
    for (const edit of edits)
      sent[edit.path] = edit.content === null ? null : await blobId(edit.content);
    const before = dictionary<string | null>();
    for (const edit of edits) before[edit.path] = await local.read(edit.path);
    state.pending = {
      before,
      kind: "resolve",
      resolution: { ref, expected: conflict.oid, main },
      request: { base: main, operation: `resolve-${id()}`, edits },
      sent,
      attempts: 0,
    };
    await save();
    await run();
  };
  await save();
  return { run, resolve, status, conflicts: () => structuredClone(state.conflicts) };
}
