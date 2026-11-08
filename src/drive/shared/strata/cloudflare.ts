import type { TransactionStorage } from "./sqlite.js";
import { type Bucket, storagePrefix } from "./storage/bucket.js";
import { createJournal } from "./storage/journal.js";
import { createR2ObjectStore } from "./storage/objects.js";
import { DriveError } from "./errors.js";

export type { Bucket, BucketObject } from "./storage/bucket.js";
export type { TransactionStorage, SqlStorage, SqlValue } from "./sqlite.js";

export async function openCloudflareStorage(input: {
  bucket: Bucket;
  storage: TransactionStorage;
  prefix: string;
  maxObjectBytes?: number;
  maxBatchBytes?: number;
}) {
  const prefix = storagePrefix(input.prefix);
  input.storage.transactionSync(() => {
    input.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS drive_identity (id INTEGER PRIMARY KEY CHECK(id = 1), prefix TEXT NOT NULL)",
    );
    const existing = [
      ...input.storage.sql.exec("SELECT prefix FROM drive_identity WHERE id = 1"),
    ][0];
    if (existing && existing.prefix !== prefix)
      throw new DriveError("invalid", "SQLite storage is already bound to another drive prefix");
    input.storage.sql.exec(
      "INSERT OR IGNORE INTO drive_identity(id, prefix) VALUES (1, ?)",
      prefix,
    );
  });
  const objects = createR2ObjectStore(input.bucket, input.storage, { ...input, prefix });
  const journal = createJournal(input.bucket, input.storage, prefix);
  await objects.recover();
  await journal.recover();
  return { objects, refs: journal.refs };
}
