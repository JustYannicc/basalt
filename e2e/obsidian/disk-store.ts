import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bucket, TransactionStorage } from "../../src/drive/shared/index.ts";

export function diskStorage(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
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
    transactionSync(body) {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { storage, close: () => db.close() };
}

/** A disk-backed synthetic R2 port keeps the volume proof out of JavaScript heap. */
export async function diskBucket(directory: string, maximumBytes: number) {
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "keys.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS objects(key TEXT PRIMARY KEY, file TEXT NOT NULL, bytes INTEGER NOT NULL)",
  );
  let writes = 0,
    reads = 0,
    lists = 0;
  const bytes = () =>
    Number(db.prepare("SELECT COALESCE(SUM(bytes),0) bytes FROM objects").get()?.bytes ?? 0);
  const bucket: Bucket = {
    async put(key, value) {
      const content = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const previous = Number(
        db.prepare("SELECT bytes FROM objects WHERE key=?").get(key)?.bytes ?? 0,
      );
      if (bytes() - previous + content.length > maximumBytes)
        throw new Error("Synthetic R2 exceeds its disk envelope");
      const file = createHash("sha256").update(key).digest("hex"),
        target = join(directory, file);
      await writeFile(target + ".pending", content);
      await rename(target + ".pending", target);
      db.prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET file=excluded.file,bytes=excluded.bytes",
      ).run(key, file, content.length);
      writes++;
    },
    async get(key, options) {
      reads++;
      const row = db.prepare("SELECT file FROM objects WHERE key=?").get(key);
      if (!row || typeof row.file !== "string") return null;
      const path = join(directory, row.file),
        size = (await stat(path)).size;
      const load = async () => {
        if (!options?.range) return new Uint8Array(await readFile(path));
        const { offset, length } = options.range,
          result = new Uint8Array(Math.min(length, Math.max(0, size - offset)));
        const file = await open(path, "r");
        try {
          let consumed = 0;
          while (consumed < result.length) {
            const { bytesRead } = await file.read(
              result,
              consumed,
              result.length - consumed,
              offset + consumed,
            );
            if (!bytesRead) throw new Error("Synthetic R2 range was truncated");
            consumed += bytesRead;
          }
          return result;
        } finally {
          await file.close();
        }
      };
      return {
        size,
        body: new ReadableStream(
          {
            async pull(controller) {
              try {
                controller.enqueue(await load());
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            },
          },
          { highWaterMark: 0 },
        ),
        async arrayBuffer() {
          return (await load()).buffer;
        },
      };
    },
    async list(options) {
      lists++;
      const rows = db
        .prepare("SELECT key FROM objects WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(
          options.prefix.length,
          options.prefix,
          options.cursor ?? options.startAfter ?? "",
          options.limit + 1,
        );
      const objects = rows.slice(0, options.limit).map((row) => {
        if (typeof row.key !== "string") throw new Error("Invalid fixture key");
        return { key: row.key };
      });
      const truncated = rows.length > options.limit;
      return { objects, truncated, ...(truncated ? { cursor: objects.at(-1)!.key } : {}) };
    },
  };
  return {
    bucket,
    stats: () => ({
      bytes: bytes(),
      objects: Number(db.prepare("SELECT count(*) count FROM objects").get()?.count ?? 0),
      writes,
      reads,
      lists,
    }),
    close: () => db.close(),
  };
}
