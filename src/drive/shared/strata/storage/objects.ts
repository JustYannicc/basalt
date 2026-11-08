import { DriveError, oid } from "../errors.js";
import { inflate, objectId, referencedOids } from "../git/objects.js";
import { applyDelta, readEntryHeader, verifyPack } from "../git/pack.js";
import { writePack } from "../git/write.js";
import type { TransactionStorage } from "../sqlite.js";
import type { GitObject, ObjectStore } from "../types.js";
import { type Bucket, readRecord, records, storagePrefix } from "./bucket.js";
import { createCatalog, decodeManifest, type ObjectLocation } from "./catalog.js";
import { createPackStore } from "./packs.js";

export function createR2ObjectStore(
  bucket: Bucket,
  storage: TransactionStorage,
  input: { prefix: string; maxObjectBytes?: number; maxBatchBytes?: number },
) {
  const prefix = storagePrefix(input.prefix),
    catalog = createCatalog(storage.sql),
    packs = createPackStore(bucket, prefix);
  const objectLimit = input.maxObjectBytes ?? 8 * 1024 * 1024;
  const batchLimit = input.maxBatchBytes ?? 16 * 1024 * 1024;
  const recover = async () => {
    for await (const key of records(bucket, `${prefix}packs-record/`)) {
      const name = key.slice(`${prefix}packs-record/`.length).replace(/\.json$/, "");
      if (catalog.hasPack(name)) continue;
      const record = decodeManifest(await readRecord(bucket, key));
      if (record.name !== name) throw new DriveError("integrity", "Git pack record name mismatch");
      storage.transactionSync(() => catalog.register(record));
    }
  };
  const read = async (location: ObjectLocation, seen: Set<string>): Promise<GitObject> => {
    if (
      location.size > objectLimit ||
      location.length > batchLimit ||
      seen.has(location.oid) ||
      seen.size > 100
    )
      throw new DriveError("integrity", "Git object exceeds a read bound or has a delta cycle");
    seen.add(location.oid);
    const bytes = await packs.range(location.pack, location.offset, location.length);
    const header = readEntryHeader(bytes);
    if (header.size > objectLimit)
      throw new DriveError("capacity", "Packed object exceeds the configured byte limit");
    const data = await inflate(bytes.slice(header.headerLength), objectLimit);
    if (data.length !== header.size)
      throw new DriveError("integrity", "Packed object length mismatch");
    let content = data;
    if (header.kind === "ofs_delta" || header.kind === "ref_delta") {
      const base =
        header.kind === "ofs_delta"
          ? catalog.at(location.pack, location.offset - (header.baseDistance ?? 0))
          : catalog.get(header.baseOid ?? "");
      if (!base || base.pack !== location.pack)
        throw new DriveError("integrity", "Delta base is outside the Git pack");
      const source = await read(base, seen);
      content = applyDelta(source.content, data, objectLimit);
      if (content.length > objectLimit || source.type !== location.type)
        throw new DriveError("integrity", "Delta result violates its object bounds");
    } else if (header.kind !== location.type)
      throw new DriveError("integrity", "Packed object type mismatch");
    if (
      content.length !== location.size ||
      (await objectId(location.type, content)) !== location.oid
    )
      throw new DriveError("integrity", "Stored Git object hash mismatch");
    return { oid: location.oid, type: location.type, content };
  };
  const store: ObjectStore = {
    async get(id) {
      const location = catalog.get(oid(id));
      return location ? read(location, new Set()) : null;
    },
    async put(inputObjects) {
      const objects = [...new Map(inputObjects.map((object) => [object.oid, object])).values()];
      let total = 0;
      for (const object of objects) {
        total += object.content.length;
        if (object.content.length > objectLimit || total > batchLimit)
          throw new DriveError("capacity", "Git pack exceeds the configured byte limit");
        if ((await objectId(object.type, object.content)) !== object.oid)
          throw new DriveError("integrity", "New Git object hash mismatch");
      }
      const pending = objects.filter((object) => !catalog.get(object.oid));
      if (!pending.length) return;
      const available = new Set(objects.map((object) => object.oid));
      for (const object of objects)
        for (const target of referencedOids(object.type, object.content))
          if (!available.has(target) && !catalog.get(target))
            throw new DriveError(
              "integrity",
              "Git object references missing history or tree content",
            );
      const written = await writePack(pending);
      const checked = await verifyPack(written.pack, written.idx, objectLimit);
      await packs.put(written);
      const manifest = { name: written.name, bytes: written.pack.length, objects: checked.objects };
      await bucket.put(`${prefix}packs-record/${written.name}.json`, JSON.stringify(manifest));
      storage.transactionSync(() => catalog.register(manifest));
    },
  };
  return { ...store, recover };
}
