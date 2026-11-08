import {
  decodeAttachmentPointer,
  DriveError,
  type ObjectStore,
  type TransactionStorage,
} from "./shared/index.ts";

/** Totals are derived from immutable Git objects and can be rebuilt after cache loss. */
export function treeUsage(
  storage: TransactionStorage,
  objects: ObjectStore,
  attachments?: { head(input: { oid: string }): Promise<{ oid: string; bytes: number } | null> },
) {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_tree_usage_v2(oid TEXT PRIMARY KEY, bytes INTEGER NOT NULL, files INTEGER NOT NULL)",
  );
  const remember = (oid: string, bytes: number, files: number) =>
    sql.exec("INSERT OR IGNORE INTO vault_tree_usage_v2 VALUES(?,?,?)", oid, bytes, files);
  const blobBytes = async (content: Uint8Array) => {
    const pointer = decodeAttachmentPointer(content);
    if (!pointer) return content.length;
    const accepted = await attachments?.head({ oid: pointer.oid });
    if (!accepted || accepted.bytes !== pointer.bytes)
      throw new DriveError(
        "integrity",
        "Attachment pointer references missing or mismatched canonical bytes",
      );
    return pointer.bytes;
  };
  const measured: ObjectStore = {
    get: (oid) => objects.get(oid),
    async put(batch) {
      const sizes = new Map<string, number>();
      for (const object of batch)
        if (object.type === "blob") sizes.set(object.oid, await blobBytes(object.content));
      await objects.put(batch);
      for (const object of batch)
        if (object.type === "blob") remember(object.oid, sizes.get(object.oid)!, 1);
    },
  };
  const at = async (oid: string): Promise<{ bytes: number; files: number }> => {
    const row = [...sql.exec("SELECT bytes,files FROM vault_tree_usage_v2 WHERE oid=?", oid)][0];
    if (row && typeof row.bytes === "number" && typeof row.files === "number")
      return { bytes: row.bytes, files: row.files };
    const object = await objects.get(oid);
    if (!object)
      throw new DriveError("integrity", "Usage references a missing canonical Git object");
    let bytes = 0,
      files = 0;
    if (object.type === "blob") {
      bytes = await blobBytes(object.content);
      files = 1;
    } else if (object.type === "commit") {
      const tree = /^tree ([a-f0-9]{40})\n/.exec(new TextDecoder().decode(object.content))?.[1];
      if (!tree) throw new DriveError("integrity", "Canonical commit has no valid tree");
      ({ bytes, files } = await at(tree));
    } else if (object.type === "tree") {
      let offset = 0;
      while (offset < object.content.length) {
        const end = object.content.indexOf(0, offset);
        if (end < offset || end + 21 > object.content.length)
          throw new DriveError("integrity", "Canonical tree entry is truncated");
        const child = [...object.content.subarray(end + 1, end + 21)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const value = await at(child);
        bytes += value.bytes;
        files += value.files;
        offset = end + 21;
      }
    } else throw new DriveError("integrity", "A vault tree cannot contain a tag object");
    remember(oid, bytes, files);
    return { bytes, files };
  };
  return {
    objects: measured,
    at,
    clear: () => {
      sql.exec("DELETE FROM vault_tree_usage_v2");
    },
  };
}
