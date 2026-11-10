import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { applyDelta, readEntryHeader } from "../shared/.generated/strata/git/pack-entries.js";
import type { Bytes, GitObject } from "../shared/strata/types.ts";
import { decoder, limits, ProtocolError, Unavailable } from "./wire.ts";
import { RetainedBytes, StreamWindow, responseBytes } from "./stream-window.ts";
import type { createFetchStaging } from "./fetch-staging.ts";

/** The caller persists objects and serves delta bases without keeping the pack in memory. */
export interface FetchSink {
  get(oid: string): Promise<GitObject | null>;
  put(object: GitObject): Promise<void>;
  staging: ReturnType<typeof createFetchStaging>;
}
export interface FetchInput {
  wants: string[];
  haves?: string[];
  sink?: FetchSink;
  onRetainedBytes?: (bytes: number) => void;
}

const id = (type: GitObject["type"], bytes: Bytes) =>
  createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

/** Removes negotiation pkt-lines and side bands without collecting the upload-pack reply. */
async function* packBytes(body: Response["body"], banded: boolean, retained: RetainedBytes) {
  const input = new StreamWindow(responseBytes(body), retained);
  let negotiating = true;
  try {
    for (;;) {
      await input.ensure(4);
      if (!input.bytes.length) return;
      await input.require(4);
      const header = decoder.decode(input.bytes.subarray(0, 4));
      if (!banded && header === "PACK") {
        yield input.bytes;
        input.consume(input.bytes.length);
        negotiating = false;
        // The remaining body is raw pack bytes, not pkt-lines.
        for (;;) {
          await input.ensure(65520);
          if (!input.bytes.length) return;
          yield input.bytes;
          input.consume(input.bytes.length);
        }
      }
      if (!/^[0-9a-f]{4}$/i.test(header)) throw new ProtocolError("Malformed Git packet header");
      const length = Number.parseInt(header, 16);
      if (!length) {
        input.consume(4);
        await input.ensure(1);
        if (input.bytes.length) throw new ProtocolError("Trailing Git response data");
        return;
      }
      if (length < 4 || length > 65520) throw new ProtocolError("Invalid Git packet size");
      await input.require(length);
      const payload = input.bytes.subarray(4, length),
        text =
          negotiating && (payload[0] === 65 || payload[0] === 78) ? decoder.decode(payload) : "";
      if (
        negotiating &&
        (text === "NAK\n" || /^ACK [0-9a-f]{40}(?: (?:common|ready|continue))?\n$/.test(text))
      ) {
        input.consume(length);
        continue;
      }
      negotiating = false;
      if (!banded) throw new ProtocolError("Missing Git pack");
      if (payload[0] === 1) yield payload.subarray(1);
      else if (payload[0] === 3) throw new ProtocolError("Git service reported a fatal error");
      else if (payload[0] !== 2) throw new ProtocolError("Invalid Git side band");
      input.consume(length);
    }
  } finally {
    await input.close();
  }
}

/** Pack payloads are bounded by one object; pack-wide bookkeeping lives in SQLite. */
export async function fetchStream(
  response: Response,
  banded: boolean,
  sink: FetchSink,
  report?: FetchInput["onRetainedBytes"],
) {
  const retained = new RetainedBytes(report),
    input = new StreamWindow(packBytes(response.body, banded, retained), retained),
    hash = createHash("sha1"),
    scratch = {},
    inflation = {},
    staging = sink.staging.begin(retained);
  let offset = 0;
  const consume = (length: number) => {
    hash.update(input.bytes.subarray(0, length));
    input.consume(length);
    offset += length;
  };
  const resolve = async (at: number, type: GitObject["type"], content: Bytes) => {
    const object = { oid: id(type, content), type, content };
    await sink.put(object);
    staging.resolved(at, object.oid);
  };
  const delta = async (at: number, oid: string | undefined, data: Bytes) => {
    if (!oid) return false;
    const base = await sink.get(oid);
    if (!base) return false;
    retained.set(scratch, base.content.buffer.byteLength);
    if (base.oid !== oid || id(base.type, base.content) !== oid)
      throw new ProtocolError("External delta base does not match its id");
    const content = applyDelta(base.content, data, limits.object);
    retained.set(scratch, base.content.buffer.byteLength + content.buffer.byteLength);
    await resolve(at, base.type, content);
    return true;
  };
  const drain = async () => {
    for (;;) {
      const entry = staging.next();
      if (!entry) return;
      if (!(await delta(entry.offset, entry.oid, entry.content)))
        throw new ProtocolError("Missing staged delta base");
      staging.release();
      retained.set(scratch, 0);
    }
  };
  try {
    await input.require(12);
    const view = new DataView(input.bytes.buffer, input.bytes.byteOffset, 12);
    if (decoder.decode(input.bytes.subarray(0, 4)) !== "PACK")
      throw new ProtocolError("Missing Git pack");
    if (![2, 3].includes(view.getUint32(4))) throw new ProtocolError("Unsupported pack version");
    const count = view.getUint32(8);
    consume(12);
    for (let index = 0; index < count; index++) {
      const at = offset;
      let header: ReturnType<typeof readEntryHeader>;
      for (let length = 1; ; length++) {
        await input.require(length);
        try {
          header = readEntryHeader(input.bytes);
          break;
        } catch (error) {
          if (!(error instanceof Error) || !/Truncated/.test(error.message) || length >= 64)
            throw error;
        }
      }
      if (header.size > limits.object)
        throw new ProtocolError("Packed object exceeds its byte limit");
      consume(header.headerLength);
      let size = Math.max(1024, input.bytes.length);
      for (;;) {
        await input.ensure(size);
        try {
          // zlib stops at this entry and reports its compressed span, even with lookahead bytes.
          retained.set(inflation, 2 * header.size + 65536);
          // Node typings omit the documented info=true result shape. Validate it at the boundary.
          const inflated: unknown = inflateSync(input.bytes, {
            info: true,
            maxOutputLength: Math.max(1, header.size),
          });
          if (
            typeof inflated !== "object" ||
            inflated === null ||
            !("buffer" in inflated) ||
            !(inflated.buffer instanceof Uint8Array) ||
            !(inflated.buffer.buffer instanceof ArrayBuffer) ||
            !("engine" in inflated) ||
            typeof inflated.engine !== "object" ||
            inflated.engine === null ||
            !("bytesWritten" in inflated.engine) ||
            typeof inflated.engine.bytesWritten !== "number"
          )
            throw new ProtocolError("Invalid inflater result");
          if (inflated.buffer.length !== header.size || !inflated.engine.bytesWritten)
            throw new ProtocolError("Packed object size mismatch");
          consume(inflated.engine.bytesWritten);
          const data = new Uint8Array(
            inflated.buffer.buffer,
            inflated.buffer.byteOffset,
            inflated.buffer.byteLength,
          );
          retained.set(inflation, data.buffer.byteLength + 65536);
          if (header.kind === "ofs_delta" || header.kind === "ref_delta") {
            const oid =
              header.kind === "ofs_delta"
                ? staging.oidAt(at - header.baseDistance!)
                : header.baseOid;
            if (!(await delta(at, oid, data))) staging.defer(at, header, data);
          } else await resolve(at, header.kind, data);
          retained.set(scratch, 0);
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "Z_BUF_ERROR")
            throw error;
          if (input.ended) throw new ProtocolError("Truncated Git pack");
          if (size >= limits.object + 1048576)
            throw new ProtocolError("Compressed object exceeds its byte limit");
          size = Math.min(size * 2, limits.object + 1048576);
        }
      }
      retained.set(inflation, 0);
      await drain();
    }
    await input.require(20);
    if (hash.digest("hex") !== Buffer.from(input.bytes.subarray(0, 20)).toString("hex"))
      throw new ProtocolError("Pack checksum mismatch");
    input.consume(20);
    await input.ensure(1);
    if (input.bytes.length) throw new ProtocolError("Trailing data in Git pack");
    if (staging.pending()) throw new ProtocolError("Missing or cyclic delta base");
  } catch (error) {
    if (error instanceof ProtocolError || error instanceof Unavailable) throw error;
    throw new ProtocolError("Invalid Git pack or delta base");
  } finally {
    try {
      await input.close();
    } finally {
      retained.set(scratch, 0);
      retained.set(inflation, 0);
      staging.close();
    }
  }
}
