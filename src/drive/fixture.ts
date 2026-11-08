import { DatabaseSync } from "node:sqlite";
import { createDrive, type TransactionStorage } from "./shared/index.ts";
import { openCloudflareStorage, type Bucket, type BucketObject } from "./shared/index.ts";

export function storageFixture() {
  const db = new DatabaseSync(":memory:"),
    files = new Map<string, Uint8Array<ArrayBuffer>>();
  const storage: TransactionStorage = {
    sql: {
      exec(query, ...bindings) {
        return db
          .prepare(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          );
      },
    },
    transactionSync: (body) => {
      db.exec("BEGIN");
      try {
        const value = body();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const bucket: Bucket & { delete(key: string): Promise<void> } = {
    async delete(key) {
      files.delete(key);
    },
    async put(key, value) {
      files.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value.slice());
    },
    async get(key, options) {
      const value = files.get(key);
      if (!value) return null;
      const data = options?.range
        ? value.slice(options.range.offset, options.range.offset + options.range.length)
        : value.slice();
      return {
        size: value.length,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return data.buffer;
        },
      } satisfies BucketObject;
    },
    async list(options) {
      const keys = [...files.keys()]
        .filter(
          (key) =>
            key.startsWith(options.prefix) && key > (options.cursor ?? options.startAfter ?? ""),
        )
        .sort();
      const selected = keys.slice(0, options.limit),
        truncated = keys.length > options.limit;
      return {
        objects: selected.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: selected.at(-1)! } : {}),
      };
    },
  };
  return { storage, bucket, close: () => db.close() };
}

export async function driveFixture() {
  const fixture = storageFixture();
  const { storage, bucket } = fixture;
  const stores = await openCloudflareStorage({ bucket, storage, prefix: "fixture/" });
  const drive = createDrive({
    ...stores,
    author: {
      name: "Fixture",
      email: "writer@example.invalid",
      timestamp: 1_800_000_000,
      timezoneOffset: 0,
    },
  });
  const root = await drive.initialize("initialize");
  return { drive, root, storage, bucket, close: fixture.close };
}
