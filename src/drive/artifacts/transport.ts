import { concatBytes, objectId } from "../shared/.generated/strata/git/objects.js";
import { writePack } from "../shared/.generated/strata/git/write.js";
import type { Bytes, GitObject } from "../shared/strata/types.ts";
import {
  AtomicUnsupported,
  AuthFailed,
  NotFound,
  ProtocolError,
  Unavailable,
  advertisement,
  checkSize,
  commands,
  decoder,
  flush,
  oid,
  packet,
  packets,
  pushCapabilities,
  readPack,
  readPacket,
  unband,
  validateUpdate,
  type RefUpdate,
  type RemoteOptions,
} from "./wire.ts";

export {
  AtomicUnsupported,
  AuthFailed,
  NotFound,
  ProtocolError,
  PushTooLarge,
  Unavailable,
  type RefUpdate,
  type RemoteOptions,
} from "./wire.ts";

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
