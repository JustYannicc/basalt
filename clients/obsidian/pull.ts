import {
  blobId,
  maximumFileBytes,
  safePath,
  type LocalVault,
  type RemoteVault,
  type SyncState,
} from "./types.ts";
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
  if (state.pulledHead === head) return;
  const blocked = new Set(
      state.conflicts.flatMap((conflict) => conflict.conflicts.map((file) => file.path)),
    ),
    observed = new Set<string>();
  let complete = true;
  const apply = async (path: string, blob: string | null) => {
    signal?.throwIfAborted();
    if (!safePath(path)) throw new Error("Cloud returned an unsafe vault path");
    observed.add(path);
    if (!path.endsWith(".md") && !local.binary) {
      if (!state.unsupported.includes(path)) state.unsupported.push(path);
      return;
    }
    if (blocked.has(path)) return;
    const baseline = state.files[path],
      current = await local.read(path),
      currentBlob = current === null ? null : await blobId(current);
    if (blob !== null && blob === currentBlob) {
      state.files[path] = { at: head, local: currentBlob, cloud: blob };
      return;
    }
    if (baseline ? currentBlob !== baseline.local : current !== null) return;
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
    const from = state.pulledHead ?? null;
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
  state.head = head;
  if (complete) state.pulledHead = head;
  await save();
}
