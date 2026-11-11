import { incrementalSha256 } from "../../src/drive/shared/bytes.ts";
import { blobId } from "./types.ts";
import { pointerIdentity } from "./binary-state.ts";
import type {
  BinaryIo,
  BinaryState,
  BinarySnapshot,
  BinaryRecord,
  RemoteBinary,
} from "./binary-types.ts";
export function binaryDownloader(input: {
  state: BinaryState;
  io: BinaryIo;
  remote: RemoteBinary;
  save: () => Promise<void>;
  id: () => string;
  check: () => void;
}) {
  const { state, io, remote, save } = input;
  return async (
    path: string,
    wanted: BinaryRecord,
    expected: BinarySnapshot | null,
    signal?: AbortSignal,
  ) => {
    const check = () => {
      input.check();
      signal?.throwIfAborted();
    };
    check();
    const identity = pointerIdentity(wanted.pointer);
    if (!identity || !wanted.at) throw new Error("This attachment has not landed in Signalbox yet");
    const version = state.files[path],
      info = await remote.info({ path, at: wanted.at });
    if (
      !info ||
      info.attachment?.oid !== identity.oid ||
      info.bytes !== identity.bytes ||
      info.attachment.bytes !== identity.bytes ||
      info.blob !== (await blobId(wanted.pointer))
    )
      throw new Error("Cloud attachment did not match its retained version");
    let pending = state.downloads[path];
    if (pending && pending.pointer !== wanted.pointer) {
      await io.removeDownload(pending.id);
      delete state.downloads[path];
      pending = undefined;
    }
    if (!pending) {
      pending = { pointer: wanted.pointer, at: wanted.at, id: `download-${input.id()}` };
      state.downloads[path] = pending;
      await save();
    }
    if (pending.at !== wanted.at) {
      pending.at = wanted.at;
      await save();
    }
    let offset = await io.beginDownload(pending.id);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid saved download offset");
    if (offset > identity.bytes) {
      await io.removeDownload(pending.id);
      offset = await io.beginDownload(pending.id);
      if (offset !== 0) throw new Error("Could not reset the invalid download");
    }
    const hash = incrementalSha256();
    for (let at = 0; at < offset; at += 1048576) {
      check();
      const length = Math.min(1048576, offset - at),
        bytes = await io.readDownload(pending.id, at, length);
      if (bytes.length !== length) throw new Error("Saved download was truncated");
      hash.update(bytes);
    }
    while (offset < identity.bytes) {
      check();
      const page = await remote.download({ path, at: wanted.at, offset, maxBytes: 65536 });
      check();
      if (
        !page ||
        page.blob !== info.blob ||
        page.bytes !== identity.bytes ||
        page.offset !== offset
      )
        throw new Error("Cloud attachment range changed its pinned identity");
      const raw = atob(page.contentBase64);
      if (
        btoa(raw) !== page.contentBase64 ||
        raw.length < 1 ||
        raw.length > 65536 ||
        offset + raw.length > identity.bytes
      )
        throw new Error("Invalid attachment download encoding or length");
      const next = offset + raw.length;
      if (page.next !== (next === identity.bytes ? null : next))
        throw new Error("Cloud attachment range did not advance exactly");
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      await io.appendDownload(pending.id, offset, bytes);
      hash.update(bytes);
      offset = next;
    }
    check();
    if (hash.digest() !== identity.oid) {
      await io.removeDownload(pending.id);
      delete state.downloads[path];
      await save();
      throw new Error("Downloaded attachment failed SHA-256 verification");
    }
    if (state.files[path] !== version || state.downloads[path] !== pending) return false;
    if (
      !(await io.publishDownload({ id: pending.id, path, expected, ...(signal ? { signal } : {}) }))
    )
      return false;
    const snapshot = await io.snapshot(path);
    if (!snapshot || snapshot.bytes !== identity.bytes)
      throw new Error("Published attachment has the wrong byte count");
    state.files[path] = { ...wanted, materialized: true, stamp: snapshot.stamp };
    delete state.downloads[path];
    await save();
    return true;
  };
}
