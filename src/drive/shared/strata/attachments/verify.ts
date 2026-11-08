import { incrementalSha256, sha256 } from "../bytes.js";
import { DriveError } from "../errors.js";
import {
  json,
  partLength,
  parts,
  readPart,
  type AttachmentBucket,
  type Upload,
} from "./records.js";

function decode(value: unknown, upload: Upload, start: number) {
  if (
    !value ||
    typeof value !== "object" ||
    !("start" in value) ||
    value.start !== start ||
    !("next" in value) ||
    value.next !== Math.min(start + 16, parts(upload)) ||
    !("hashes" in value) ||
    !Array.isArray(value.hashes) ||
    value.hashes.length !== value.next - start ||
    !("checkpoint" in value) ||
    !("digest" in value) ||
    (value.digest !== null && typeof value.digest !== "string")
  )
    throw new DriveError("integrity", "Invalid attachment verification record");
  const hashes: string[] = [];
  for (const entry of value.hashes) {
    if (typeof entry !== "string" || !/^[0-9a-f]{64}$/.test(entry))
      throw new DriveError("integrity", "Invalid verified part hash");
    hashes.push(entry);
  }
  return { start, next: value.next, hashes, checkpoint: value.checkpoint, digest: value.digest };
}
export function verifier(
  bucket: AttachmentBucket,
  prefix: string,
  partKey: (upload: string, part: number) => string,
) {
  const key = (upload: Upload, start: number) =>
    `${prefix}uploads/${upload.upload}/verify/${String(start).padStart(5, "0")}.json`;
  const record = async (upload: Upload, start: number) => {
    const value = await json(bucket, key(upload, start), 8192);
    return value ? decode(value, upload, start) : null;
  };
  return {
    async pass(upload: Upload, cursor = 0) {
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        cursor % 16 !== 0 ||
        cursor > parts(upload)
      )
        throw new DriveError("invalid", "Invalid attachment verification cursor");
      let saved = await record(upload, cursor);
      if (!saved) {
        const previous = cursor ? await record(upload, cursor - 16) : null;
        if (cursor && (!previous || previous.next !== cursor || !previous.checkpoint))
          throw new DriveError("missing", "Previous attachment verification checkpoint is missing");
        const hash = incrementalSha256(previous?.checkpoint ?? undefined);
        if (cursor && hash.checkpoint().length !== cursor * upload.partBytes)
          throw new DriveError("integrity", "SHA-256 checkpoint byte count mismatch");
        const next = Math.min(cursor + 16, parts(upload)),
          hashes: string[] = [];
        for (let part = cursor; part < next; part++) {
          const bytes = await readPart(
            bucket,
            partKey(upload.upload, part),
            partLength(upload, part),
          );
          hash.update(bytes);
          hashes.push(sha256(bytes));
        }
        const complete = next === parts(upload);
        saved = {
          start: cursor,
          next,
          hashes,
          checkpoint: complete ? null : hash.checkpoint(),
          digest: complete ? hash.digest() : null,
        };
        if (complete && saved.digest !== upload.oid)
          throw new DriveError("integrity", "Attachment whole-file hash mismatch");
        await bucket.put(key(upload, cursor), JSON.stringify(saved));
      }
      if (saved.next === parts(upload) && saved.digest !== upload.oid)
        throw new DriveError("integrity", "Attachment whole-file hash mismatch");
      return saved.next === parts(upload) ? null : saved.next;
    },
    async partHash(upload: Upload, part: number) {
      const start = Math.floor(part / 16) * 16,
        saved = await record(upload, start);
      if (!saved) throw new DriveError("integrity", "Accepted attachment verification is missing");
      return saved.hashes[part - start];
    },
  };
}
