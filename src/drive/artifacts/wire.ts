/** Git smart-HTTP wire formats: pkt-lines, ref advertisements, push commands and packs. No I/O. */
import { inflateSync } from "node:zlib";
import { concatBytes, hex, objectId, sha1 } from "../shared/.generated/strata/git/objects.js";
import { applyDelta, readEntryHeader } from "../shared/.generated/strata/git/pack-entries.js";
import type { Bytes, GitObject } from "../shared/strata/types.ts";

export class AuthFailed extends Error {
  override name = "AuthFailed";
}
export class NotFound extends Error {
  override name = "NotFound";
}
export class Unavailable extends Error {
  override name = "Unavailable";
}
export class ProtocolError extends Error {
  override name = "ProtocolError";
}
export class AtomicUnsupported extends ProtocolError {
  override name = "AtomicUnsupported";
}
export class PushTooLarge extends ProtocolError {
  override name = "PushTooLarge";
  readonly requestBytes: number;
  readonly commandBytes: number;
  readonly packBytes: number;
  readonly objectCount: number;
  readonly largestObjectBytes: number;
  constructor(measured: {
    requestBytes: number;
    commandBytes: number;
    packBytes: number;
    objectCount: number;
    largestObjectBytes: number;
  }) {
    super(
      `Push exceeds Artifacts limits: ${measured.requestBytes} request bytes, ${measured.commandBytes} command bytes, ${measured.objectCount} objects, ${measured.largestObjectBytes} largest object bytes`,
    );
    this.requestBytes = measured.requestBytes;
    this.commandBytes = measured.commandBytes;
    this.packBytes = measured.packBytes;
    this.objectCount = measured.objectCount;
    this.largestObjectBytes = measured.largestObjectBytes;
  }
}

export interface RemoteOptions {
  url: string;
  auth: () => Promise<string>;
  fetch?: typeof fetch;
  userAgent?: string;
  base?: (oid: string) => Promise<GitObject | null>;
}
export interface RefUpdate {
  ref: string;
  old: string | null;
  next: string;
}
export const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export const zero = "0".repeat(40),
  flush = encoder.encode("0000");
export const pushCapabilities = ["report-status", "atomic", "side-band-64k"];
export const limits = {
  request: 67_108_864,
  commands: 1_048_576,
  objects: 50_000,
  object: 33_554_432,
};
export const oid = (value: string) => /^[0-9a-f]{40}$/.test(value);
export const packet = (text: string) => {
  const bytes = encoder.encode(text),
    length = bytes.length + 4;
  if (length > 65520) throw new ProtocolError("Git packet exceeds its byte limit");
  return concatBytes([encoder.encode(length.toString(16).padStart(4, "0")), bytes]);
};
export function readPacket(bytes: Bytes, at: number) {
  const header = decoder.decode(bytes.subarray(at, at + 4));
  if (header.length !== 4 || !/^[0-9a-f]{4}$/i.test(header))
    throw new ProtocolError("Malformed Git packet header");
  const length = Number.parseInt(header, 16);
  if (length === 0) return { data: null, next: at + 4 };
  if (length < 4 || length > 65520 || at + length > bytes.length)
    throw new ProtocolError("Truncated or invalid Git packet");
  return { data: bytes.subarray(at + 4, at + length), next: at + length };
}
export function packets(bytes: Bytes) {
  const result: Bytes[] = [];
  for (let at = 0; at < bytes.length;) {
    const item = readPacket(bytes, at);
    if (item.data !== null) result.push(item.data);
    at = item.next;
  }
  return result;
}
export function advertisement(bytes: Bytes, service: string) {
  const lines = packets(bytes).map((line) => decoder.decode(line).replace(/\n$/, ""));
  if (lines.shift() !== `# service=${service}`)
    throw new ProtocolError("Unexpected Git service advertisement");
  const refs: Record<string, string> = Object.create(null);
  let capabilities: string[] = [];
  for (const [index, line] of lines.entries()) {
    const [refLine, caps] = line.split("\0");
    if (caps !== undefined) {
      if (index !== 0) throw new ProtocolError("Capabilities outside first advertised ref");
      capabilities = caps.split(" ").filter(Boolean);
    }
    const match = /^([0-9a-f]{40}) (.+)$/.exec(refLine!);
    if (!match) throw new ProtocolError("Malformed advertised ref");
    if (match[1] !== zero) refs[match[2]!] = match[1]!;
    else if (match[2] !== "capabilities^{}") throw new ProtocolError("Invalid zero-id ref");
  }
  if (capabilities.some((cap) => cap.startsWith("object-format=") && cap !== "object-format=sha1"))
    throw new ProtocolError("Only SHA-1 Git repositories are supported");
  return { refs, capabilities };
}
export function validateUpdate(update: RefUpdate) {
  if (!oid(update.next) || (update.old !== null && !oid(update.old)))
    throw new ProtocolError("Invalid ref update object id");
  const ref = update.ref;
  if (
    !ref.startsWith("refs/") ||
    // Git refuses control characters, space and DEL, then ~ ^ : ? * [ and backslash.
    [...ref].some((character) => character <= " " || character === "\u007f") ||
    /[~^:?*[\\]/.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.endsWith(".") ||
    ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new ProtocolError("Invalid Git ref name");
}
export const commands = (updates: readonly RefUpdate[], capabilities: readonly string[]) =>
  concatBytes([
    ...updates.map((update, index) =>
      packet(
        `${update.old ?? zero} ${update.next} ${update.ref}${index === 0 ? `\0${capabilities.join(" ")}` : ""}\n`,
      ),
    ),
    flush,
  ]);
export function checkSize(commandBytes: number, packBytes: number, objects: readonly GitObject[]) {
  const measured = {
    commandBytes,
    packBytes,
    requestBytes: commandBytes + packBytes,
    objectCount: objects.length,
    largestObjectBytes: objects.reduce((max, object) => Math.max(max, object.content.length), 0),
  };
  if (
    measured.requestBytes > limits.request ||
    commandBytes > limits.commands ||
    objects.length > limits.objects ||
    measured.largestObjectBytes > limits.object
  )
    throw new PushTooLarge(measured);
}
export function unband(bytes: Bytes) {
  const data: Bytes[] = [];
  for (const part of packets(bytes)) {
    if (part[0] === 1) data.push(part.subarray(1));
    else if (part[0] === 3) throw new ProtocolError("Git service reported a fatal error");
    else if (part[0] !== 2) throw new ProtocolError("Invalid Git side band");
  }
  return concatBytes(data);
}

export async function readPack(pack: Bytes, base?: RemoteOptions["base"]): Promise<GitObject[]> {
  if (pack.length < 32 || decoder.decode(pack.subarray(0, 4)) !== "PACK")
    throw new ProtocolError("Missing Git pack");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength),
    end = pack.length - 20;
  if (![2, 3].includes(view.getUint32(4))) throw new ProtocolError("Unsupported pack version");
  if ((await sha1(pack.subarray(0, end))) !== hex(pack.subarray(end)))
    throw new ProtocolError("Pack checksum mismatch");
  const entries: { offset: number; header: ReturnType<typeof readEntryHeader>; data: Bytes }[] = [];
  let at = 12;
  for (let index = 0; index < view.getUint32(8); index++) {
    if (at >= end) throw new ProtocolError("Truncated Git pack");
    const header = readEntryHeader(pack, at);
    if (header.size > limits.object)
      throw new ProtocolError("Packed object exceeds its byte limit");
    // A wire pack has no index. Workers' node:zlib reports the exact consumed zlib span.
    const inflated = inflateSync(pack.subarray(at + header.headerLength, end), {
      info: true,
      maxOutputLength: Math.max(1, header.size),
    }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== header.size || !inflated.engine.bytesWritten)
      throw new ProtocolError("Packed object size mismatch");
    entries.push({ offset: at, header, data: new Uint8Array(inflated.buffer) });
    at += header.headerLength + inflated.engine.bytesWritten;
  }
  if (at !== end) throw new ProtocolError("Trailing data in Git pack");
  const byOffset = new Map<number, GitObject>(),
    byOid = new Map<string, GitObject>();
  const external = new Map<string, GitObject | null>();
  let pending = entries;
  let externalAllowed = false;
  while (pending.length) {
    const remaining: typeof entries = [];
    for (const entry of pending) {
      const { header, data, offset } = entry;
      let type: GitObject["type"], content: Bytes;
      if (header.kind === "ofs_delta" || header.kind === "ref_delta") {
        let parent =
          header.kind === "ofs_delta"
            ? byOffset.get(offset - header.baseDistance!)
            : byOid.get(header.baseOid!);
        if (!parent && header.kind === "ref_delta" && base && externalAllowed) {
          if (!external.has(header.baseOid!)) {
            const candidate = await base(header.baseOid!);
            if (
              candidate &&
              (candidate.oid !== header.baseOid ||
                (await objectId(candidate.type, candidate.content)) !== header.baseOid)
            )
              throw new ProtocolError("External delta base does not match its id");
            external.set(header.baseOid!, candidate);
          }
          parent = external.get(header.baseOid!) ?? undefined;
        }
        if (!parent) {
          remaining.push(entry);
          continue;
        }
        type = parent.type;
        content = applyDelta(parent.content, data, limits.object);
      } else {
        type = header.kind;
        content = data;
      }
      const object = { oid: await objectId(type, content), type, content };
      byOffset.set(offset, object);
      byOid.set(object.oid, object);
    }
    if (remaining.length === pending.length) {
      // REF_DELTA may point forward; exhaust in-pack bases before consulting storage.
      if (base && !externalAllowed) {
        externalAllowed = true;
        continue;
      }
      throw new ProtocolError("Missing or cyclic delta base");
    }
    externalAllowed = false;
    pending = remaining;
  }
  return entries.map((entry) => byOffset.get(entry.offset)!);
}

/** Smart HTTP needs no local checkout; node:zlib requires Workers Node compatibility. */
