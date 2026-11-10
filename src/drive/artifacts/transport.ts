import { inflateSync } from "node:zlib";
import { concatBytes, hex, objectId, sha1 } from "../shared/.generated/strata/git/objects.js";
import { applyDelta, readEntryHeader } from "../shared/.generated/strata/git/pack-entries.js";
import { writePack } from "../shared/.generated/strata/git/write.js";
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
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const zero = "0".repeat(40),
  flush = encoder.encode("0000");
const pushCapabilities = ["report-status", "atomic", "side-band-64k"];
const limits = { request: 67_108_864, commands: 1_048_576, objects: 50_000, object: 33_554_432 };
const oid = (value: string) => /^[0-9a-f]{40}$/.test(value);
const packet = (text: string) => {
  const bytes = encoder.encode(text),
    length = bytes.length + 4;
  if (length > 65520) throw new ProtocolError("Git packet exceeds its byte limit");
  return concatBytes([encoder.encode(length.toString(16).padStart(4, "0")), bytes]);
};
function readPacket(bytes: Bytes, at: number) {
  const header = decoder.decode(bytes.subarray(at, at + 4));
  if (header.length !== 4 || !/^[0-9a-f]{4}$/i.test(header))
    throw new ProtocolError("Malformed Git packet header");
  const length = Number.parseInt(header, 16);
  if (length === 0) return { data: null, next: at + 4 };
  if (length < 4 || length > 65520 || at + length > bytes.length)
    throw new ProtocolError("Truncated or invalid Git packet");
  return { data: bytes.subarray(at + 4, at + length), next: at + length };
}
function packets(bytes: Bytes) {
  const result: Bytes[] = [];
  for (let at = 0; at < bytes.length;) {
    const item = readPacket(bytes, at);
    if (item.data !== null) result.push(item.data);
    at = item.next;
  }
  return result;
}
function advertisement(bytes: Bytes, service: string) {
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
function validateUpdate(update: RefUpdate) {
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
const commands = (updates: readonly RefUpdate[], capabilities: readonly string[]) =>
  concatBytes([
    ...updates.map((update, index) =>
      packet(
        `${update.old ?? zero} ${update.next} ${update.ref}${index === 0 ? `\0${capabilities.join(" ")}` : ""}\n`,
      ),
    ),
    flush,
  ]);
function checkSize(commandBytes: number, packBytes: number, objects: readonly GitObject[]) {
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
function unband(bytes: Bytes) {
  const data: Bytes[] = [];
  for (const part of packets(bytes)) {
    if (part[0] === 1) data.push(part.subarray(1));
    else if (part[0] === 3) throw new ProtocolError("Git service reported a fatal error");
    else if (part[0] !== 2) throw new ProtocolError("Invalid Git side band");
  }
  return concatBytes(data);
}

async function readPack(pack: Bytes, base?: RemoteOptions["base"]): Promise<GitObject[]> {
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
export function createGitRemote(options: RemoteOptions) {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new ProtocolError("Invalid Git remote URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash)
    throw new ProtocolError("Invalid Git remote URL");
  url.username = "";
  url.password = "";
  const root = url.href.replace(/\/$/, ""),
    fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let capabilities: readonly string[] = [];
  async function request(service: string, body?: Bytes) {
    let response: Response;
    try {
      const token = (await options.auth()).split("?expires=")[0]!;
      const headers: Record<string, string> = {
        Authorization: `Basic ${btoa(`x:${token}`)}`,
        Accept: `application/x-${service}-${body ? "result" : "advertisement"}`,
      };
      if (options.userAgent) headers["User-Agent"] = options.userAgent;
      if (body) headers["Content-Type"] = `application/x-${service}-request`;
      response = await fetcher(`${root}/${body ? service : `info/refs?service=${service}`}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body } : {}),
        redirect: "manual",
      });
    } catch {
      throw new Unavailable("Git remote request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403)
        throw new AuthFailed("Git authentication failed");
      if (response.status === 404) throw new NotFound("Git repository not found");
      if (response.status >= 500) throw new Unavailable("Git remote unavailable");
      throw new ProtocolError(`Unexpected Git HTTP status ${response.status}`);
    }
    if (
      response.headers.get("Content-Type")?.split(";")[0] !==
      `application/x-${service}-${body ? "result" : "advertisement"}`
    ) {
      await response.body?.cancel().catch(() => {});
      throw new ProtocolError("Unexpected Git response content type");
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new Unavailable("Git remote response interrupted");
    }
  }
  async function receiveAdvertisement() {
    const advertised = advertisement(await request("git-receive-pack"), "git-receive-pack");
    capabilities = Object.freeze(advertised.capabilities);
    return advertised;
  }
  return {
    get capabilities() {
      return capabilities;
    },
    async refs(): Promise<Record<string, string>> {
      return { ...(await receiveAdvertisement()).refs };
    },
    async push(input: { updates: readonly RefUpdate[]; objects: readonly GitObject[] }): Promise<{
      applied: boolean;
      results: Record<string, "ok" | string>;
    }> {
      const updates = input.updates.map((update) => ({ ...update })),
        objects = input.objects.slice();
      if (!updates.length) throw new ProtocolError("Push requires a ref update");
      updates.forEach(validateUpdate);
      if (new Set(updates.map((update) => update.ref)).size !== updates.length)
        throw new ProtocolError("Push repeats a ref update");
      const preflight = commands(updates, pushCapabilities);
      checkSize(preflight.length, 0, objects);
      for (const object of objects) {
        if (!oid(object.oid) || (await objectId(object.type, object.content)) !== object.oid)
          throw new ProtocolError("Push object does not match its id");
      }
      const { pack } = await writePack(objects);
      // Reserve all possible capability bytes before discovery, including command framing.
      checkSize(preflight.length, pack.length, objects);
      const advertised = await receiveAdvertisement();
      const selected = pushCapabilities.filter((cap) => advertised.capabilities.includes(cap));
      if (!selected.includes("report-status"))
        throw new ProtocolError("Remote lacks report-status");
      if (updates.length > 1 && !selected.includes("atomic"))
        throw new AtomicUnsupported("Remote cannot apply multiple ref updates atomically");
      const command = commands(updates, selected);
      checkSize(command.length, pack.length, objects);
      const reply = await request("git-receive-pack", concatBytes([command, pack]));
      const lines = packets(selected.includes("side-band-64k") ? unband(reply) : reply).map(
        (line) => decoder.decode(line).replace(/\n$/, ""),
      );
      if (lines.shift() !== "unpack ok")
        throw new ProtocolError("Git remote could not unpack push");
      const results: Record<string, string> = Object.create(null);
      for (const line of lines) {
        const match = /^(ok|ng) ([^ ]+)(?: (.+))?$/.exec(line);
        if (
          !match ||
          !updates.some((update) => update.ref === match[2]) ||
          results[match[2]!] !== undefined ||
          (match[1] === "ng" && !match[3])
        )
          throw new ProtocolError("Malformed push status");
        results[match[2]!] = match[1] === "ok" ? "ok" : match[3]!;
      }
      if (Object.keys(results).length !== updates.length)
        throw new ProtocolError("Missing push status");
      return {
        applied: Object.values(results).every((result) => result === "ok"),
        results: { ...results },
      };
    },
    async fetchObjects(input: {
      wants: string[];
      haves?: string[];
      depth?: never;
      base?: RemoteOptions["base"];
    }): Promise<GitObject[]> {
      if (input.depth !== undefined) throw new ProtocolError("Shallow fetch is not supported");
      const wants = [...new Set(input.wants)],
        haves = [...new Set(input.haves ?? [])];
      if (![...wants, ...haves].every(oid)) throw new ProtocolError("Invalid fetch object id");
      if (!wants.length) return [];
      // v1 shares push framing and avoids v2's separate ls-refs and section state machine.
      const advertised = advertisement(await request("git-upload-pack"), "git-upload-pack");
      const selected = [
        "side-band-64k",
        "ofs-delta",
        ...((input.base ?? options.base) ? ["thin-pack"] : []),
      ].filter((cap) => advertised.capabilities.includes(cap));
      const body = concatBytes([
        ...wants.map((want, index) =>
          packet(`want ${want}${index === 0 && selected.length ? ` ${selected.join(" ")}` : ""}\n`),
        ),
        flush,
        ...haves.map((have) => packet(`have ${have}\n`)),
        packet("done\n"),
      ]);
      const reply = await request("git-upload-pack", body);
      let at = 0;
      while (at < reply.length) {
        if (decoder.decode(reply.subarray(at, at + 4)) === "PACK") break;
        const item = readPacket(reply, at),
          text = decoder.decode(item.data ?? new Uint8Array());
        if (text === "NAK\n" || /^ACK [0-9a-f]{40}(?: (?:common|ready|continue))?\n$/.test(text))
          at = item.next;
        else break;
      }
      try {
        const pack = selected.includes("side-band-64k")
          ? unband(reply.subarray(at))
          : reply.subarray(at);
        return await readPack(pack, input.base ?? options.base);
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError("Invalid Git pack or delta base");
      }
    },
  };
}
