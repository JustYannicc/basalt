import { DriveError, oid } from "../errors.js";
import type { Bytes } from "../types.js";
import type { Bucket } from "./bucket.js";

// Extracted from Signalbox's DrivePacks. Keep the index last as the publication marker.
export function createPackStore(bucket: Bucket, prefix: string) {
  const key = (name: string, extension: "pack" | "idx") =>
    `${prefix}packs/pack-${oid(name)}.${extension}`;
  return {
    async put(input: { name: string; pack: Bytes; idx: Bytes }) {
      await bucket.put(key(input.name, "pack"), input.pack);
      await bucket.put(key(input.name, "idx"), input.idx);
    },
    get(name: string, file: "pack" | "idx") {
      return bucket.get(key(name, file));
    },
    async range(name: string, offset: number, length: number) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1
      )
        throw new DriveError("invalid", "Invalid pack byte range");
      const object = await bucket.get(key(name, "pack"), { range: { offset, length } });
      if (!object) throw new DriveError("missing", "Git pack is missing");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.length !== length)
        throw new DriveError("integrity", "Git pack byte range is truncated");
      return bytes;
    },
  };
}
