import { verifier } from "./attachments/verify.js";
import { attachment, sha256, type Attachment } from "./bytes.js";
import { DriveError, operation } from "./errors.js";
import { serialized } from "./serial.js";
import { storagePrefix } from "./storage/bucket.js";
import {
  decodeManifest,
  decodeUpload,
  json,
  maxBytes,
  partBytes,
  partLength,
  parts,
  readPart,
  uploadId,
  type AttachmentBucket,
  type Upload,
} from "./attachments/records.js";
export { encodeAttachmentPointer, decodeAttachmentPointer } from "./bytes.js";
export type { AttachmentBucket } from "./attachments/records.js";

export function openAttachmentStore(input: {
  bucket: AttachmentBucket;
  prefix: string;
  now: () => number;
  uploadTtlMs?: number;
}) {
  const prefix = `${storagePrefix(input.prefix)}attachments/`,
    bucket = input.bucket,
    serial = serialized();
  const startKey = (upload: string) => `${prefix}uploads/${uploadId(upload)}/start.json`;
  const partKey = (upload: string, part: number) =>
    `${prefix}uploads/${uploadId(upload)}/parts/${String(part).padStart(5, "0")}`;
  const manifestKey = (oid: string) => {
    attachment({ oid, bytes: 0 });
    return `${prefix}objects/${oid}.json`;
  };
  const load = async (id: string) => {
    const value = await json(bucket, startKey(id), 2048);
    if (!value) throw new DriveError("missing", "Attachment upload is missing");
    const upload = decodeUpload(value);
    if (upload.upload !== id)
      throw new DriveError("integrity", "Attachment upload identity mismatch");
    return upload;
  };
  const manifest = async (oid: string) => {
    const value = await json(bucket, manifestKey(oid));
    if (!value) return null;
    const ready = decodeManifest(value);
    if (ready.oid !== oid)
      throw new DriveError("integrity", "Attachment manifest hash identity mismatch");
    return ready;
  };
  const verify = verifier(bucket, prefix, partKey);
  const active = async (upload: Upload) => {
    if (await json(bucket, `${prefix}uploads/${upload.upload}/cancel.json`, 1024))
      throw new DriveError("stale", "Attachment upload was cancelled");
    if (input.now() >= upload.expiresAt) throw new DriveError("stale", "Attachment upload expired");
  };
  const status = async (upload: Upload, cursor = 0) => {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > parts(upload))
      throw new DriveError("invalid", "Invalid attachment part cursor");
    const ready = await manifest(upload.oid);
    if (ready && ready.bytes !== upload.bytes)
      throw new DriveError("integrity", "Attachment hash has a different byte count");
    const missing: number[] = [],
      stop = Math.min(parts(upload), cursor + 100);
    if (!ready) {
      await active(upload);
      for (let part = cursor; part < stop; part++) {
        const stored = await bucket.get(partKey(upload.upload, part));
        if (!stored) missing.push(part);
        else if (stored.size !== partLength(upload, part))
          throw new DriveError("integrity", "Attachment part byte count mismatch");
        else await stored.body.cancel();
      }
    }
    return {
      ...upload,
      state: ready ? ("present" as const) : ("uploading" as const),
      parts: parts(upload),
      missing,
      next: stop < parts(upload) ? stop : null,
    };
  };
  return {
    begin(value: Attachment & { operation: string; cursor?: number }) {
      return serial(async () => {
        attachment(value);
        operation(value.operation);
        if (value.bytes > maxBytes)
          throw new DriveError("capacity", "Attachment exceeds the byte limit");
        const id = sha256(new TextEncoder().encode(value.operation));
        const old = await json(bucket, startKey(id), 2048);
        const upload: Upload = old
          ? decodeUpload(old)
          : {
              version: 1,
              upload: id,
              operation: value.operation,
              oid: value.oid,
              bytes: value.bytes,
              partBytes,
              expiresAt: input.now() + (input.uploadTtlMs ?? 24 * 60 * 60 * 1000),
            };
        if (
          upload.operation !== value.operation ||
          upload.oid !== value.oid ||
          upload.bytes !== value.bytes
        )
          throw new DriveError("invalid", "Attachment operation was used for different content");
        if (!old) await bucket.put(startKey(id), JSON.stringify(upload));
        return status(upload, value.cursor);
      });
    },
    status(value: { upload: string; cursor?: number }) {
      return serial(async () => status(await load(value.upload), value.cursor));
    },
    put(value: { upload: string; part: number; content: Uint8Array }) {
      return serial(async () => {
        const upload = await load(value.upload);
        await active(upload);
        const length = partLength(upload, value.part);
        if (value.content.length !== length)
          throw new DriveError("invalid", "Attachment part has a different byte count");
        const key = partKey(upload.upload, value.part),
          previous = await bucket.get(key);
        if (previous) {
          const bytes = await readPart(bucket, key, length);
          await previous.body.cancel();
          if (sha256(bytes) !== sha256(value.content))
            throw new DriveError("invalid", "Attachment part already has different bytes");
          return { part: value.part, bytes: length };
        }
        if (await manifest(upload.oid))
          throw new DriveError("stale", "Attachment was already accepted");
        await bucket.put(key, value.content.slice());
        return { part: value.part, bytes: length };
      });
    },
    complete(value: { upload: string; cursor?: number }) {
      return serial(async () => {
        const upload = await load(value.upload),
          accepted = await manifest(upload.oid);
        if (accepted) {
          if (accepted.bytes !== upload.bytes)
            throw new DriveError("integrity", "Attachment byte count mismatch");
          return {
            state: "present" as const,
            oid: accepted.oid,
            bytes: accepted.bytes,
            next: null,
          };
        }
        await active(upload);
        const next = await verify.pass(upload, value.cursor);
        if (next !== null)
          return { state: "verifying" as const, oid: upload.oid, bytes: upload.bytes, next };
        await bucket.put(
          manifestKey(upload.oid),
          JSON.stringify({ ...upload, verificationParts: 16 }),
        );
        return { state: "present" as const, oid: upload.oid, bytes: upload.bytes, next: null };
      });
    },
    head(value: { oid: string }) {
      return serial(async () => {
        const ready = await manifest(value.oid);
        return ready ? { oid: ready.oid, bytes: ready.bytes } : null;
      });
    },
    read(value: { oid: string; offset?: number; length?: number }) {
      return serial(async () => {
        const ready = await manifest(value.oid);
        if (!ready) throw new DriveError("missing", "Attachment is missing");
        const offset = value.offset ?? 0,
          length = value.length ?? partBytes;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > ready.bytes ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > partBytes
        )
          throw new DriveError("invalid", "Invalid attachment byte range");
        const end = Math.min(ready.bytes, offset + length),
          content = new Uint8Array(end - offset);
        for (let part = Math.floor(offset / partBytes); part < Math.ceil(end / partBytes); part++) {
          const bytes = await readPart(
            bucket,
            partKey(ready.upload, part),
            partLength(ready, part),
          );
          if (sha256(bytes) !== (await verify.partHash(ready, part)))
            throw new DriveError("integrity", "Attachment part hash mismatch");
          const from = Math.max(offset, part * partBytes),
            to = Math.min(end, (part + 1) * partBytes);
          content.set(
            bytes.subarray(from - part * partBytes, to - part * partBytes),
            from - offset,
          );
        }
        return {
          oid: ready.oid,
          bytes: ready.bytes,
          content,
          next: end < ready.bytes ? end : null,
        };
      });
    },
    cancel(value: { upload: string; cursor?: number }) {
      return serial(async () => {
        const upload = await load(value.upload),
          accepted = await manifest(upload.oid);
        if (accepted?.upload === upload.upload)
          throw new DriveError("stale", "Attachment upload was accepted and cannot be deleted");
        const cancelKey = `${prefix}uploads/${upload.upload}/cancel.json`;
        if (!(await json(bucket, cancelKey, 1024)))
          await bucket.put(cancelKey, JSON.stringify({ cancelled: true }));
        const cursor = value.cursor ?? 0;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > parts(upload))
          throw new DriveError("invalid", "Invalid attachment cleanup cursor");
        const stop = Math.min(parts(upload), cursor + 100);
        for (let part = cursor; part < stop; part++) {
          const key = partKey(upload.upload, part);
          await bucket.delete(key);
          const retained = await bucket.get(key);
          if (retained) {
            await retained.body.cancel();
            throw new DriveError("integrity", "Attachment part deletion was not confirmed");
          }
        }
        // Keep the operation binding so an old request can never become a different upload.
        return { next: stop < parts(upload) ? stop : null };
      });
    },
  };
}
