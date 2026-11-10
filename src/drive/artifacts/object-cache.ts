import { DriveError } from "../shared/.generated/strata/errors.js";
import { createHash } from "node:crypto";
import type { TransactionStorage } from "../shared/strata/sqlite.ts";
import type { GitObject } from "../shared/strata/types.ts";

// Durable Object SQLite rejects rows near 2 MB.
const partBytes = 1024 * 1024;

/** Object persistence, cache eviction and durable markers for interrupted pack ingestion. */
export function createObjectCache(
  storage: TransactionStorage,
  blobLimit: number,
  now: () => number,
) {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_git_objects (oid TEXT PRIMARY KEY, type TEXT NOT NULL, bytes INTEGER NOT NULL, kept INTEGER NOT NULL, pending INTEGER NOT NULL, used INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_git_parts (oid TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (oid, part))",
  );
  sql.exec("CREATE TABLE IF NOT EXISTS vault_fetch_incomplete (oid TEXT PRIMARY KEY)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_pack_bases (oid TEXT PRIMARY KEY, temporary INTEGER NOT NULL)",
  );
  // A previous wake may have stopped before releasing pins. Incomplete metadata stays excluded
  // from negotiation until a successful fetch includes it again.
  storage.transactionSync(() => {
    sql.exec(
      "DELETE FROM vault_git_parts WHERE oid IN (SELECT oid FROM vault_pack_bases WHERE temporary = 1)",
    );
    sql.exec(
      "DELETE FROM vault_git_objects WHERE oid IN (SELECT oid FROM vault_pack_bases WHERE temporary = 1)",
    );
    sql.exec("DELETE FROM vault_pack_bases");
  });
  const load = (oid: string, pendingOnly = false): GitObject | undefined => {
    const meta = [
      ...sql.exec(
        `SELECT type, bytes FROM vault_git_objects WHERE oid = ?${pendingOnly ? " AND pending = 1" : ""}`,
        oid,
      ),
    ][0];
    if (!meta) return undefined;
    const content = new Uint8Array(Number(meta.bytes));
    let at = 0;
    for (const part of sql.exec(
      "SELECT data FROM vault_git_parts WHERE oid = ? ORDER BY part",
      oid,
    )) {
      const data = new Uint8Array(part.data as ArrayBuffer);
      content.set(data, at);
      at += data.length;
    }
    if (at !== content.length)
      throw new DriveError("integrity", "A stored Git object is missing some of its bytes");
    return { oid, type: String(meta.type) as GitObject["type"], content };
  };
  const save = (objects: readonly GitObject[], pending: boolean) =>
    storage.transactionSync(() => {
      for (const object of objects) {
        const exists = [
          ...sql.exec("SELECT 1 FROM vault_git_objects WHERE oid = ?", object.oid),
        ][0];
        if (exists) {
          if (pending)
            sql.exec("UPDATE vault_pack_bases SET temporary = 0 WHERE oid = ?", object.oid);
          sql.exec(
            "UPDATE vault_git_objects SET pending = MAX(pending, ?), used = ? WHERE oid = ?",
            pending ? 1 : 0,
            now(),
            object.oid,
          );
          continue;
        }
        // Commits and trees are the clone and never leave; blobs are cache unless unpushed.
        sql.exec(
          "INSERT INTO vault_git_objects(oid, type, bytes, kept, pending, used) VALUES (?, ?, ?, ?, ?, ?)",
          object.oid,
          object.type,
          object.content.length,
          object.type === "blob" ? 0 : 1,
          pending ? 1 : 0,
          now(),
        );
        for (let part = 0; part * partBytes < Math.max(object.content.length, 1); part++)
          sql.exec(
            "INSERT INTO vault_git_parts(oid, part, data) VALUES (?, ?, ?)",
            object.oid,
            part,
            new Uint8Array(object.content.subarray(part * partBytes, (part + 1) * partBytes))
              .buffer,
          );
      }
    });
  const evict = () => {
    const cached = [
      ...sql.exec(
        "SELECT COALESCE(SUM(bytes), 0) AS total FROM vault_git_objects WHERE kept = 0 AND pending = 0",
      ),
    ][0];
    let excess = Number(cached?.total ?? 0) - blobLimit;
    if (excess <= 0) return;
    // Read the candidates fully before deleting any, so no cursor is open across the deletes.
    const victims = Array.from(
      sql.exec(
        "SELECT oid, bytes FROM vault_git_objects WHERE kept = 0 AND pending = 0 AND oid NOT IN (SELECT oid FROM vault_pack_bases) ORDER BY used",
      ),
    );
    storage.transactionSync(() => {
      for (const victim of victims) {
        if (excess <= 0) break;
        sql.exec("DELETE FROM vault_git_parts WHERE oid = ?", String(victim.oid));
        sql.exec("DELETE FROM vault_git_objects WHERE oid = ?", String(victim.oid));
        excess -= Number(victim.bytes);
      }
    });
  };
  const verified = async (objects: readonly GitObject[]) => {
    for (const object of objects)
      if (
        createHash("sha1")
          .update(`${object.type} ${object.content.length}\0`)
          .update(object.content)
          .digest("hex") !== object.oid
      )
        throw new DriveError("integrity", "Artifacts returned a Git object with the wrong id");
    return objects;
  };
  const known = (oid: string) =>
    [...sql.exec("SELECT 1 FROM vault_git_objects WHERE oid = ?", oid)][0] !== undefined;
  const endFetch = (complete: boolean) => {
    storage.transactionSync(() => {
      if (complete)
        sql.exec(
          "DELETE FROM vault_fetch_incomplete WHERE oid IN (SELECT oid FROM vault_pack_bases)",
        );
      sql.exec(
        "DELETE FROM vault_git_parts WHERE oid IN (SELECT oid FROM vault_pack_bases WHERE temporary = 1)",
      );
      sql.exec(
        "DELETE FROM vault_git_objects WHERE oid IN (SELECT oid FROM vault_pack_bases WHERE temporary = 1)",
      );
      sql.exec("DELETE FROM vault_pack_bases");
    });
    evict();
  };
  return {
    load,
    save,
    evict,
    verified,
    complete: (oid: string) =>
      known(oid) && ![...sql.exec("SELECT 1 FROM vault_fetch_incomplete WHERE oid = ?", oid)][0],
    async putFetched(object: GitObject, temporary = false) {
      await verified([object]);
      storage.transactionSync(() => {
        const exists = known(object.oid),
          pinned = [
            ...sql.exec("SELECT temporary FROM vault_pack_bases WHERE oid = ?", object.oid),
          ][0];
        if (!exists && object.type !== "blob")
          sql.exec("INSERT OR IGNORE INTO vault_fetch_incomplete(oid) VALUES (?)", object.oid);
        sql.exec(
          "INSERT INTO vault_pack_bases(oid, temporary) VALUES (?, ?) ON CONFLICT(oid) DO UPDATE SET temporary = MIN(temporary, excluded.temporary)",
          object.oid,
          temporary && (!exists || Number(pinned?.temporary) === 1) ? 1 : 0,
        );
      });
      save([object], false);
      // Incoming blobs remain pinned for later deltas. Older unpinned cache entries can go now.
      evict();
    },
    endFetch,
  };
}
