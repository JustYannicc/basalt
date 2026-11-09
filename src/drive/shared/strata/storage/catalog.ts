import * as Schema from "effect/Schema";
import { DriveError, oid } from "../errors.js";
import type { SqlStorage } from "../sqlite.js";

const packedObject = Schema.Struct({
  oid: Schema.String,
  type: Schema.Literals(["blob", "tree", "commit", "tag"]),
  offset: Schema.Number,
  length: Schema.Number,
  size: Schema.Number,
});
const manifest = Schema.Struct({
  name: Schema.String,
  bytes: Schema.Number,
  objects: Schema.Array(packedObject),
});
export type PackManifest = typeof manifest.Type;
export type ObjectLocation = PackManifest["objects"][number] & { pack: string };

export function decodeManifest(value: unknown): PackManifest {
  const record = Schema.decodeUnknownSync(manifest)(value);
  oid(record.name);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 32 || record.objects.length > 100_000)
    throw new DriveError("integrity", "Invalid Git pack manifest");
  for (const object of record.objects) {
    oid(object.oid);
    if (
      ![object.offset, object.length, object.size].every(Number.isSafeInteger) ||
      object.offset < 12 ||
      object.length < 1 ||
      object.size < 0 ||
      object.offset + object.length > record.bytes - 20
    )
      throw new DriveError("integrity", "Git object range is outside its pack");
  }
  return record;
}

export function createCatalog(sql: SqlStorage) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS drive_objects (oid TEXT PRIMARY KEY, pack TEXT NOT NULL, type TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, size INTEGER NOT NULL)",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS drive_object_offsets ON drive_objects(pack, offset)");
  sql.exec("CREATE TABLE IF NOT EXISTS drive_packs (name TEXT PRIMARY KEY)");
  const decode = (row: Record<string, unknown> | undefined): ObjectLocation | null => {
    if (!row) return null;
    const object = Schema.decodeUnknownSync(packedObject)(row);
    if (typeof row.pack !== "string")
      throw new DriveError("integrity", "Missing Git pack location");
    return { ...object, pack: oid(row.pack) };
  };
  return {
    get: (id: string) =>
      decode([...sql.exec("SELECT * FROM drive_objects WHERE oid = ?", oid(id))][0]),
    at: (pack: string, offset: number) =>
      decode(
        [
          ...sql.exec(
            "SELECT * FROM drive_objects WHERE pack = ? AND offset = ?",
            oid(pack),
            offset,
          ),
        ][0],
      ),
    hasPack: (name: string) =>
      [...sql.exec("SELECT name FROM drive_packs WHERE name = ?", oid(name))].length > 0,
    register(record: PackManifest) {
      for (const object of record.objects)
        sql.exec(
          "INSERT OR IGNORE INTO drive_objects(oid, pack, type, offset, length, size) VALUES (?, ?, ?, ?, ?, ?)",
          object.oid,
          record.name,
          object.type,
          object.offset,
          object.length,
          object.size,
        );
      sql.exec("INSERT OR IGNORE INTO drive_packs(name) VALUES (?)", record.name);
    },
  };
}
