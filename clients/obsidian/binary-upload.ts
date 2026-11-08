import { incrementalSha256, encodeAttachmentPointer } from "../../src/drive/shared/bytes.ts";
import type { BinaryIo, BinaryState, BinarySnapshot, RemoteBinary } from "./binary-types.ts";
const encode = (bytes: Uint8Array) => {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
};
export function binaryUploader(input: {
  state: BinaryState;
  io: BinaryIo;
  remote: RemoteBinary;
  save: () => Promise<void>;
  id: () => string;
  check: () => void;
}) {
  const { state, io, remote, save, check } = input;
  const same = async (path: string, snapshot: BinarySnapshot) => {
    const current = await io.snapshot(path);
    if (!current || current.stamp !== snapshot.stamp || current.bytes !== snapshot.bytes)
      throw new Error("Local attachment changed during upload; its bytes are kept");
  };
  return async (path: string, snapshot: BinarySnapshot) => {
    const known = state.files[path];
    if (known?.materialized && known.stamp === snapshot.stamp) return known.pointer;
    const hash = incrementalSha256();
    for (let offset = 0; offset < snapshot.bytes; offset += 1048576) {
      check();
      const bytes = await io.read(
        path,
        snapshot,
        offset,
        Math.min(1048576, snapshot.bytes - offset),
      );
      if (bytes.length !== Math.min(1048576, snapshot.bytes - offset))
        throw new Error("Local attachment read was truncated");
      hash.update(bytes);
    }
    await same(path, snapshot);
    const oid = hash.digest();
    let pending = state.uploads[path];
    if (pending && (pending.oid !== oid || pending.bytes !== snapshot.bytes)) {
      const old = await remote.beginAttachment({
        operation: pending.operation,
        oid: pending.oid,
        bytes: pending.bytes,
      });
      if (old.state !== "present") {
        let cursor: number | null = 0;
        do {
          check();
          const page = await remote.cancelAttachment({ upload: old.upload, cursor });
          cursor = page.next;
        } while (cursor !== null);
      }
      delete state.uploads[path];
      await save();
      pending = undefined;
    }
    if (!pending) {
      pending = {
        operation: `binary-${input.id()}`,
        oid,
        bytes: snapshot.bytes,
        stamp: snapshot.stamp,
        upload: null,
        cursor: null,
      };
      state.uploads[path] = pending;
      await save();
    }
    let cursor: number | null = 0,
      present = false;
    do {
      check();
      const page = await remote.beginAttachment({
        operation: pending.operation,
        oid,
        bytes: snapshot.bytes,
        ...(cursor ? { cursor } : {}),
      });
      if (
        page.oid !== oid ||
        page.bytes !== snapshot.bytes ||
        page.partBytes < 1 ||
        page.partBytes > 1048576 ||
        page.parts !== Math.ceil(snapshot.bytes / page.partBytes)
      )
        throw new Error("Cloud upload bounds did not match this file");
      pending.upload = page.upload;
      await save();
      if (page.state === "present") {
        present = true;
        break;
      }
      for (const part of page.missing) {
        check();
        if (!Number.isSafeInteger(part) || part < 0 || part >= page.parts)
          throw new Error("Cloud requested an invalid attachment part");
        await same(path, snapshot);
        const bytes = await io.read(
          path,
          snapshot,
          part * page.partBytes,
          Math.min(page.partBytes, snapshot.bytes - part * page.partBytes),
        );
        const ack = await remote.uploadAttachmentPart({
          upload: page.upload,
          part,
          contentBase64: encode(bytes),
        });
        if (ack.part !== part || ack.bytes !== bytes.length)
          throw new Error("Cloud attachment acknowledgement was invalid");
      }
      if (page.next !== null && (page.next <= Number(cursor) || page.next > page.parts))
        throw new Error("Cloud upload cursor did not advance");
      cursor = page.next;
    } while (cursor !== null);
    if (!present) {
      if (!pending.upload) throw new Error("Cloud omitted its upload identity");
      let next: number | null = pending.cursor ?? 0;
      do {
        check();
        const verified = await remote.completeAttachment({
          upload: pending.upload,
          ...(next ? { cursor: next } : {}),
        });
        if (verified.oid !== oid || verified.bytes !== snapshot.bytes)
          throw new Error("Cloud verified a different attachment");
        if (verified.state === "present") {
          present = true;
          next = null;
        } else {
          if (verified.next === null || verified.next <= Number(next))
            throw new Error("Cloud verification did not advance");
          next = verified.next;
          pending.cursor = next;
          await save();
        }
      } while (next !== null);
    }
    check();
    await same(path, snapshot);
    const pointer = new TextDecoder().decode(
      encodeAttachmentPointer({ oid, bytes: snapshot.bytes }),
    );
    state.files[path] = {
      pointer,
      at: known?.pointer === pointer ? known.at : null,
      materialized: true,
      stamp: snapshot.stamp,
    };
    delete state.uploads[path];
    await save();
    return pointer;
  };
}
