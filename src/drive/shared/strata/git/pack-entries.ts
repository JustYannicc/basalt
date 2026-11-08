import type { Bytes, ObjectType } from "./objects.js";
import { hex } from "./objects.js";

const kinds: Readonly<Record<number, ObjectType | "ofs_delta" | "ref_delta">> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  6: "ofs_delta",
  7: "ref_delta",
};
export class PackError extends Error {}

export interface EntryHeader {
  kind: ObjectType | "ofs_delta" | "ref_delta";
  size: number;
  headerLength: number;
  baseDistance?: number;
  baseOid?: string;
}

export function readEntryHeader(bytes: Bytes, at = 0): EntryHeader {
  if (!Number.isSafeInteger(at) || at < 0 || at >= bytes.length)
    throw new PackError("Pack entry header is out of range.");
  let pos = at;
  const next = () => {
    if (pos >= bytes.length) throw new PackError("Truncated pack entry header.");
    return bytes[pos++]!;
  };
  let byte = next();
  const kind = kinds[(byte >> 4) & 7];
  if (!kind) throw new PackError("Unknown pack object type.");
  let size = byte & 15,
    shift = 4;
  while (byte & 0x80) {
    if (shift > 49) throw new PackError("Pack entry size is not a safe integer.");
    byte = next();
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (!Number.isSafeInteger(size)) throw new PackError("Pack entry size is not a safe integer.");
  if (kind === "ofs_delta") {
    byte = next();
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      byte = next();
      distance = (distance + 1) * 128 + (byte & 0x7f);
      if (!Number.isSafeInteger(distance))
        throw new PackError("Delta base offset is not a safe integer.");
    }
    if (distance < 1) throw new PackError("Delta base offset must point backward.");
    return { kind, size, headerLength: pos - at, baseDistance: distance };
  }
  if (kind === "ref_delta") {
    if (pos + 20 > bytes.length) throw new PackError("Truncated delta base object id.");
    return { kind, size, headerLength: pos - at + 20, baseOid: hex(bytes.subarray(pos, pos + 20)) };
  }
  return { kind, size, headerLength: pos - at };
}

export function applyDelta(base: Bytes, delta: Bytes, maxBytes = 64 * 1024 * 1024): Bytes {
  let at = 0;
  const next = () => {
    if (at >= delta.length) throw new PackError("Truncated delta.");
    return delta[at++]!;
  };
  const varint = () => {
    let value = 0,
      shift = 0,
      byte;
    do {
      if (shift > 49) throw new PackError("Delta size is not a safe integer.");
      byte = next();
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    if (!Number.isSafeInteger(value)) throw new PackError("Delta size is not a safe integer.");
    return value;
  };
  if (varint() !== base.length) throw new PackError("Delta base size mismatch.");
  const size = varint();
  if (size > maxBytes) throw new PackError("Delta result exceeds its byte limit.");
  const out = new Uint8Array(size);
  let written = 0;
  while (at < delta.length) {
    const op = next();
    if (op & 0x80) {
      let offset = 0,
        length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += next() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) length += next() * 2 ** (8 * i);
      if (!length) length = 0x10000;
      if (offset + length > base.length || written + length > out.length)
        throw new PackError("Delta copies out of range.");
      out.set(base.subarray(offset, offset + length), written);
      written += length;
    } else if (op) {
      if (written + op > out.length || at + op > delta.length)
        throw new PackError("Delta inserts out of range.");
      out.set(delta.subarray(at, at + op), written);
      written += op;
      at += op;
    } else throw new PackError("Reserved delta opcode.");
  }
  if (written !== out.length) throw new PackError("Delta result size mismatch.");
  return out;
}
