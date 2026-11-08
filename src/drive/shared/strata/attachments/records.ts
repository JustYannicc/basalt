import { attachment, type Attachment } from "../bytes.js";
import { DriveError } from "../errors.js";
import type { Bucket } from "../storage/bucket.js";

export const partBytes = 1024 * 1024;
export const maxBytes = 20 * 1024 * 1024 * 1024;
export interface AttachmentBucket extends Bucket {
  delete(key: string): Promise<unknown>;
}
export interface Upload extends Attachment {
  version: 1;
  upload: string;
  operation: string;
  partBytes: number;
  expiresAt: number;
}
export interface Manifest extends Upload {
  verificationParts: 16;
}
export function uploadId(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new DriveError("invalid", "Invalid attachment upload id");
  return value;
}
export function parts(upload: Upload) {
  return Math.ceil(upload.bytes / upload.partBytes);
}
export function partLength(upload: Upload, part: number) {
  if (!Number.isSafeInteger(part) || part < 0 || part >= parts(upload))
    throw new DriveError("invalid", "Invalid attachment part index");
  return Math.min(upload.partBytes, upload.bytes - part * upload.partBytes);
}
export async function json(bucket: Bucket, key: string, limit = 2 * 1024 * 1024) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > limit)
    throw new DriveError("integrity", "Attachment record exceeds its byte limit");
  const data = await object.arrayBuffer();
  if (data.byteLength > limit)
    throw new DriveError("integrity", "Attachment record exceeds its byte limit");
  const value: unknown = JSON.parse(new TextDecoder().decode(data));
  return value;
}
export function decodeUpload(value: unknown): Upload {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("oid" in value) ||
    typeof value.oid !== "string" ||
    !("bytes" in value) ||
    typeof value.bytes !== "number" ||
    !("upload" in value) ||
    typeof value.upload !== "string" ||
    !("operation" in value) ||
    typeof value.operation !== "string" ||
    !("partBytes" in value) ||
    value.partBytes !== partBytes ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt)
  )
    throw new DriveError("integrity", "Invalid attachment upload record");
  attachment({ oid: value.oid, bytes: value.bytes });
  uploadId(value.upload);
  if (value.bytes > maxBytes) throw new DriveError("capacity", "Attachment exceeds the byte limit");
  return {
    version: 1,
    oid: value.oid,
    bytes: value.bytes,
    upload: value.upload,
    operation: value.operation,
    partBytes: value.partBytes,
    expiresAt: value.expiresAt,
  };
}
export function decodeManifest(value: unknown): Manifest {
  const upload = decodeUpload(value);
  if (
    !value ||
    typeof value !== "object" ||
    !("verificationParts" in value) ||
    value.verificationParts !== 16
  )
    throw new DriveError("integrity", "Invalid attachment manifest");
  return { ...upload, verificationParts: 16 };
}
export async function readPart(bucket: Bucket, key: string, length: number) {
  const object = await bucket.get(key);
  if (!object) throw new DriveError("missing", "Attachment part is missing");
  if (object.size !== length)
    throw new DriveError("integrity", "Attachment part byte count mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== length)
    throw new DriveError("integrity", "Attachment part byte count mismatch");
  return bytes;
}
