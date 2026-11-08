import { encodeAttachmentPointer } from "../../src/drive/shared/bytes.ts";
import { createTransport, RemoteToolError } from "./remote-connection.ts";
import { createBinaryRemote, readChanges } from "./binary-remote.ts";
import { initialTransport } from "./import-remote.ts";
import type { RemoteBinary } from "./binary-types.ts";
import type { Session } from "./auth.ts";
import { number, object, text, type Http } from "./http.ts";
import type { Entry, Page, Receipt, RemoteVault } from "./types.ts";
const oid = (data: Record<string, unknown>, key: string) => {
  const value = text(data, key);
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("Invalid cloud revision");
  return value;
};
const nullableOid = (data: Record<string, unknown>, key: string) =>
  data[key] === null ? null : oid(data, key);
export function decodeReceipt(value: unknown): Receipt {
  const data = object(value),
    common = { operation: text(data, "operation"), ref: text(data, "ref"), oid: oid(data, "oid") };
  if (data.state === "landed")
    return { ...common, state: "landed", previous: oid(data, "previous") };
  if (data.state !== "conflict" || !Array.isArray(data.conflicts))
    throw new Error("Cloud write did not return a final receipt");
  return {
    ...common,
    state: "conflict",
    main: oid(data, "main"),
    conflicts: data.conflicts.map((value) => {
      const item = object(value);
      if (item.reason !== "content" && item.reason !== "unsupported")
        throw new Error("Unknown conflict kind");
      return {
        path: text(item, "path"),
        reason: item.reason,
        base: nullableOid(item, "base"),
        ours: oid(item, "ours"),
        theirs: oid(item, "theirs"),
        baseBlob: nullableOid(item, "baseBlob"),
        oursBlob: nullableOid(item, "oursBlob"),
        theirsBlob: nullableOid(item, "theirsBlob"),
      };
    }),
  };
}
export function createRemote(input: {
  http: Http;
  session: Session;
  appSlug: string;
  appId?: string;
  saveSession: (session: Session) => Promise<void>;
  allowLoopback?: boolean;
}): RemoteVault & RemoteBinary & { close: () => Promise<void> } {
  if (!/^[A-Za-z0-9_-]+$/u.test(input.appSlug)) throw new Error("Invalid cloud app identity");
  const transport = createTransport(input),
    imported = initialTransport(transport.call),
    call = imported.call,
    binary = createBinaryRemote(call);
  return {
    initial: imported.initial,
    ...binary,
    changes: (args) => readChanges(call, args),
    async list(args = {}) {
      const data = object(
        await call("listNotes", { ...args, limit: Math.min(args.limit ?? 50, 50) }),
      );
      if (!Array.isArray(data.entries)) throw new Error("Cloud listing omitted its entries");
      const at = oid(data, "at"),
        entries = data.entries.map((value): Entry => {
          const item = object(value);
          if (item.kind !== "file" && item.kind !== "directory")
            throw new Error("Invalid cloud entry");
          return { path: text(item, "path"), kind: item.kind, oid: oid(item, "oid") };
        });
      let next: Page["next"] = null;
      if (data.next !== null) {
        const cursor = object(data.next);
        next = {
          at: oid(cursor, "at"),
          path: typeof cursor.path === "string" ? cursor.path : "",
          after: text(cursor, "after"),
        };
      }
      return {
        at,
        entries,
        next,
        ...(data.importBase === undefined ? {} : { importBase: oid(data, "importBase") }),
      };
    },
    async read(args) {
      {
        const info = await binary.info({ path: args.path, at: args.at });
        if (!info) return null;
        if (info.attachment) {
          const content = new TextDecoder().decode(encodeAttachmentPointer(info.attachment)),
            offset = args.offset ?? 0,
            end = Math.min(content.length, offset + (args.maxBytes ?? 65536));
          if (offset < 0 || offset > content.length)
            throw new Error("Invalid virtual attachment offset");
          return {
            blob: info.blob,
            bytes: content.length,
            content: content.slice(offset, end),
            next: end === content.length ? null : end,
          };
        }
      }
      let value: unknown;
      try {
        value = await call("readNote", {
          ...args,
          maxBytes: Math.min(args.maxBytes ?? 65536, 65536),
        });
      } catch (failure) {
        if (!(failure instanceof RemoteToolError) || failure.kind !== "Truncated") throw failure;
        value = await call("readNote", { ...args, maxBytes: 8192 });
      }
      if (value === null) return null;
      const data = object(value),
        next = data.next === null ? null : number(data, "next");
      return {
        content:
          typeof data.content === "string"
            ? data.content
            : (() => {
                throw new Error("Cloud note has no content");
              })(),
        blob: oid(data, "blob"),
        bytes: number(data, "bytes"),
        next,
      };
    },
    async apply(args) {
      return decodeReceipt(await call("applyNotes", args));
    },
    async resolve(args) {
      return decodeReceipt(await call("resolveConflict", args));
    },
    async receipt(operation) {
      const value = await call("operationStatus", { operation });
      if (value === null) return null;
      const data = object(value);
      if (data.state === "opened" || data.state === "saved")
        return {
          state: data.state,
          operation: text(data, "operation"),
          ref: text(data, "ref"),
          oid: oid(data, "oid"),
        };
      return decodeReceipt(data);
    },
    close: transport.close,
  };
}
