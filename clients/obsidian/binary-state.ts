import { decodeAttachmentPointer } from "../../src/drive/shared/bytes.ts";
import { object, text, number } from "./http.ts";
import { safePath } from "./types.ts";
import type { BinaryState, BinaryRecord, BinaryUpload, BinaryDownload } from "./binary-types.ts";
import { dictionary } from "./dictionary.ts";
export { dictionary } from "./dictionary.ts";
const path = (value: string) => {
  if (!safePath(value)) throw new Error("Invalid saved attachment path");
  return value;
};
const revision = (value: unknown) => {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value))
    throw new Error("Invalid saved attachment revision");
  return value;
};
const pointer = (value: unknown) => {
  if (typeof value !== "string" || !decodeAttachmentPointer(new TextEncoder().encode(value)))
    throw new Error("Invalid saved attachment pointer");
  return value;
};
export function decodeBinaryState(input: unknown): BinaryState {
  if (input === null || input === undefined)
    return {
      version: 1,
      files: dictionary<BinaryRecord>(),
      uploads: dictionary<BinaryUpload>(),
      downloads: dictionary<BinaryDownload>(),
    };
  const data = object(input);
  if (data.version !== 1) throw new Error("Saved attachments need another plugin version");
  const files = dictionary<BinaryRecord>(),
    uploads = dictionary<BinaryUpload>(),
    downloads = dictionary<BinaryDownload>();
  for (const [key, value] of Object.entries(object(data.files))) {
    const item = object(value);
    files[path(key)] = {
      pointer: pointer(item.pointer),
      at: item.at === null ? null : revision(item.at),
      materialized: item.materialized === true,
      stamp: item.stamp === null ? null : text(item, "stamp"),
    };
  }
  for (const [key, value] of Object.entries(object(data.uploads))) {
    const item = object(value),
      oid = text(item, "oid"),
      bytes = number(item, "bytes");
    if (
      !/^[0-9a-f]{64}$/u.test(oid) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 20 * 1024 * 1024 * 1024
    )
      throw new Error("Invalid saved attachment upload");
    uploads[path(key)] = {
      oid,
      bytes,
      operation: text(item, "operation"),
      stamp: text(item, "stamp"),
      upload: item.upload === null ? null : text(item, "upload"),
      cursor: item.cursor === null ? null : number(item, "cursor"),
    };
  }
  for (const [key, value] of Object.entries(object(data.downloads))) {
    const item = object(value);
    downloads[path(key)] = {
      pointer: pointer(item.pointer),
      at: revision(item.at),
      id: text(item, "id"),
    };
  }
  return { version: 1, files, uploads, downloads };
}
export const pointerIdentity = (value: string) =>
  decodeAttachmentPointer(new TextEncoder().encode(value));
