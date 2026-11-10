import {
  blobId,
  maximumFileBytes,
  safePath,
  type LocalVault,
  type RemoteVault,
  type SyncState,
} from "./types.ts";
import { isTextPath } from "../../src/drive/text-files.ts";
export async function pull(input: {
  state: SyncState;
  local: LocalVault;
  remote: RemoteVault;
  save: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const { state, local, remote, save, signal } = input;
  signal?.throwIfAborted();
  const head = (await remote.list({ limit: 1 })).at;
  const from = state.pulledHead ?? null;
  if (from === head) return;
  const blocked = new Set(
      state.conflicts.flatMap((conflict) => conflict.conflicts.map((file) => file.path)),
    ),
    observed = new Set<string>();
  let complete = true;
  const apply = async (path: string, blob: string | null) => {
    signal?.throwIfAborted();
    if (!safePath(path)) throw new Error("Cloud returned an unsafe vault path");
    observed.add(path);
    if (!isTextPath(path) && !local.binary) {
      if (!state.unsupported.includes(path)) state.unsupported.push(path);
      return;
    }
    if (blocked.has(path)) return;
    const baseline = state.files[path],
      current = await (local.inspect ?? local.read).call(local, path),
      currentBlob = current === null ? null : await blobId(current);
    if (blob !== null && blob === currentBlob) {
      state.files[path] = { at: head, local: currentBlob, cloud: blob };
      return;
    }
    if (baseline ? currentBlob !== baseline.local : current !== null) {
      // A local edit is kept. When the cloud still holds the blob its base had, head is an
      // equally good base, so the next checkpoint needn't commit it separately. `cloud` is the
      // blob at `at` only when it equals `local`; after a merge it is the merged result instead.
      if (baseline && blob === baseline.cloud && baseline.cloud === baseline.local)
        state.files[path] = { ...baseline, at: head };
      return;
    }
    if (blob === null) {
      if (baseline && (await local.replace(path, current, null, { at: head }))) {
        delete state.files[path];
      }
      return;
    }
    if (blob === currentBlob) {
      state.files[path] = { at: head, local: currentBlob, cloud: blob };
      return;
    }
    let content = "",
      offset = 0,
      next: number | null = 0;
    while (next !== null) {
      signal?.throwIfAborted();
      const page = await remote.read({ path, at: head, offset, maxBytes: 65536 });
      if (!page || page.blob !== blob || page.bytes > maximumFileBytes)
        throw new Error("Cloud note is unavailable or exceeds the device file limit");
      if (page.next !== null && page.next <= offset)
        throw new Error("Cloud download did not advance");
      content += page.content;
      next = page.next;
      if (next !== null) offset = next;
    }
    if ((await blobId(content)) !== blob)
      throw new Error("Cloud note hash did not match its manifest");
    signal?.throwIfAborted();
    if (await local.replace(path, current, content, { at: head })) {
      state.files[path] = { at: head, local: blob, cloud: blob };
    } else complete = false;
  };
  if (remote.changes) {
    let cursor: import("./types.ts").ChangeCursor | null = null;
    do {
      signal?.throwIfAborted();
      const page = await remote.changes({
        from,
        to: head,
        ...(cursor ? { cursor } : {}),
        limit: 50,
      });
      if (page.from !== from || page.to !== head)
        throw new Error("Cloud changes moved their pinned revisions");
      for (const entry of page.entries) await apply(entry.path, entry.after);
      await save();
      if (page.next && JSON.stringify(page.next) === JSON.stringify(cursor))
        throw new Error("Cloud change cursor did not advance");
      cursor = page.next;
    } while (cursor);
    if (from === null)
      for (const path of Object.keys(state.files)) if (!observed.has(path)) await apply(path, null);
  } else {
    const visit = async (path: string) => {
      let cursor: import("./types.ts").Page["next"] = null;
      do {
        signal?.throwIfAborted();
        const page = await remote.list({
          at: head,
          path,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (page.at !== head) throw new Error("Cloud listing changed its pinned revision");
        for (const entry of page.entries)
          if (entry.kind === "directory") await visit(entry.path);
          else await apply(entry.path, entry.oid);
        await save();
        cursor = page.next;
      } while (cursor);
    };
    await visit("");
    for (const path of Object.keys(state.files)) if (!observed.has(path)) await apply(path, null);
  }
  if (complete && from !== null)
    // A path the range didn't touch has the same content at head as at `from`, so a file based
    // on `from` can move to head. That lets a checkpoint commit every dirty file from one base.
    // Files left on an older base (a local edit that outlived a cloud change) keep it, so their
    // commit still merges against the cloud edit instead of overwriting it.
    for (const [path, file] of Object.entries(state.files))
      if (!observed.has(path) && file.at === from) state.files[path] = { ...file, at: head };
  state.head = head;
  if (complete) state.pulledHead = head;
  await save();
}
