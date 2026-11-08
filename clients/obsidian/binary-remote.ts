import { object, text, number } from "./http.ts";
import type { RemoteBinary, BinaryIdentity } from "./binary-types.ts";
import type { ChangeCursor, RemoteVault } from "./types.ts";
type Call = (tool: string, args: unknown) => Promise<unknown>;
const hash = (data: Record<string, unknown>, key: string, length: number) => {
  const value = text(data, key);
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value))
    throw new Error("Invalid cloud file identity");
  return value;
};
const count = (data: Record<string, unknown>, key: string) => {
  const value = number(data, key);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid cloud byte or part count");
  return value;
};
const identity = (value: unknown): BinaryIdentity => {
  const data = object(value);
  return { oid: hash(data, "oid", 64), bytes: count(data, "bytes") };
};
export function createBinaryRemote(call: Call): RemoteBinary {
  return {
    async info(input) {
      const value = await call("fileInfo", input);
      if (value === null) return null;
      const data = object(value);
      return {
        at: hash(data, "at", 40),
        path: text(data, "path"),
        blob: hash(data, "blob", 40),
        bytes: count(data, "bytes"),
        attachment: data.attachment === null ? null : identity(data.attachment),
      };
    },
    async beginAttachment(input) {
      const data = object(await call("beginAttachment", input));
      if (data.state !== "present" && data.state !== "uploading")
        throw new Error("Invalid cloud upload state");
      if (
        !Array.isArray(data.missing) ||
        data.missing.some((value) => !Number.isSafeInteger(value) || Number(value) < 0)
      )
        throw new Error("Invalid missing upload parts");
      const missing = data.missing.map((value) => Number(value));
      return {
        ...identity(data),
        state: data.state,
        upload: hash(data, "upload", 64),
        partBytes: count(data, "partBytes"),
        parts: count(data, "parts"),
        expiresAt: count(data, "expiresAt"),
        missing,
        next: data.next === null ? null : count(data, "next"),
      };
    },
    async uploadAttachmentPart(input) {
      const data = object(await call("uploadAttachmentPart", input));
      return { part: count(data, "part"), bytes: count(data, "bytes") };
    },
    async completeAttachment(input) {
      const data = object(await call("completeAttachment", input));
      if (data.state !== "present" && data.state !== "verifying")
        throw new Error("Invalid verification state");
      return {
        ...identity(data),
        state: data.state,
        next: data.next === null ? null : count(data, "next"),
      };
    },
    async cancelAttachment(input) {
      const data = object(await call("cancelAttachment", input));
      return { next: data.next === null ? null : count(data, "next") };
    },
    async download(input) {
      const value = await call("readAttachment", input);
      if (value === null) return null;
      const data = object(value);
      return {
        blob: hash(data, "blob", 40),
        bytes: count(data, "bytes"),
        offset: count(data, "offset"),
        next: data.next === null ? null : count(data, "next"),
        contentBase64:
          typeof data.contentBase64 === "string"
            ? data.contentBase64
            : (() => {
                throw new Error("Attachment reply omitted bytes");
              })(),
      };
    },
  };
}
export async function readChanges(
  call: Call,
  input: Parameters<NonNullable<RemoteVault["changes"]>>[0],
) {
  const data = object(await call("changes", input));
  const revision = (value: unknown) => (value === null ? null : hash({ value }, "value", 40));
  const cursor = (value: unknown): ChangeCursor => {
    const item = object(value);
    if (!Array.isArray(item.frames) || item.frames.length > 33)
      throw new Error("Invalid cloud change cursor");
    return {
      from: revision(item.from),
      to: hash(item, "to", 40),
      frames: item.frames.map((value) => {
        const frame = object(value);
        return {
          name: typeof frame.name === "string" ? frame.name : "",
          after: typeof frame.after === "string" ? frame.after : "",
        };
      }),
    };
  };
  if (!Array.isArray(data.entries)) throw new Error("Cloud changes omitted entries");
  return {
    from: revision(data.from),
    to: hash(data, "to", 40),
    entries: data.entries.map((value) => {
      const item = object(value);
      return {
        path: text(item, "path"),
        before: revision(item.before),
        after: revision(item.after),
      };
    }),
    next: data.next === null ? null : cursor(data.next),
  };
}
