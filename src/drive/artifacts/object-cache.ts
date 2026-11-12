import { DriveError } from "../shared/.generated/strata/errors.js";
import { referencedOids } from "../shared/.generated/strata/git/objects.js";
import { createHash } from "node:crypto";
import type { TransactionStorage } from "../shared/strata/sqlite.ts";
import type { GitObject } from "../shared/strata/types.ts";

// Durable Object SQLite rejects rows near 2 MB.
/** A part plus its keys stays within 1 MiB; Durable Object SQLite refuses rows near 2 MB. */
const partBytes = 1024 * 1024 - 4096;

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
  // Every oid a stored tree names. A blobless clone holds every tree it knows, so a blob the
  // repository could hold is named here; anything else is new and needs no remote read.
  sql.exec("CREATE TABLE IF NOT EXISTS vault_tree_refs (oid TEXT PRIMARY KEY)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_tree_refs_ready (id INTEGER PRIMARY KEY CHECK(id = 1))",
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
  const indexTree = (object: GitObject) => {
    if (object.type !== "tree") return;
    for (const oid of referencedOids("tree", object.content))
      sql.exec("INSERT OR IGNORE INTO vault_tree_refs(oid) VALUES (?)", oid);
  };
  const save = (objects: readonly GitObject[], pending: boolean) =>
    storage.transactionSync(() => {
      for (const object of objects) {
        indexTree(object);
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
    storage.transactionSync(() => {
      while (excess > 0) {
        const victim = [
          ...sql.exec(
            "SELECT oid, bytes FROM vault_git_objects WHERE kept = 0 AND pending = 0 ORDER BY used LIMIT 1",
          ),
        ][0];
        if (!victim) break;
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
  // Storage from before the index: name what its trees already point at, once.
  if (![...sql.exec("SELECT 1 FROM vault_tree_refs_ready WHERE id = 1")][0])
    storage.transactionSync(() => {
      // Listed first: loading each tree runs further statements.
      const trees = Array.from(sql.exec("SELECT oid FROM vault_git_objects WHERE type = 'tree'"));
      for (const row of trees) {
        const tree = load(String(row.oid));
        if (tree) indexTree(tree);
      }
      sql.exec("INSERT INTO vault_tree_refs_ready(id) VALUES (1)");
    });
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
    /** Whether a stored tree names this oid, so the repository may hold it. */
    referenced: (oid: string) =>
      [...sql.exec("SELECT 1 FROM vault_tree_refs WHERE oid = ?", oid)][0] !== undefined,
    complete: (oid: string) =>
      known(oid) && ![...sql.exec("SELECT 1 FROM vault_fetch_incomplete WHERE oid = ?", oid)][0],
    async putFetched(object: GitObject) {
      await verified([object]);
      if (object.type !== "blob")
        storage.transactionSync(() => {
          if (!known(object.oid))
            sql.exec("INSERT OR IGNORE INTO vault_fetch_incomplete(oid) VALUES (?)", object.oid);
          sql.exec(
            "INSERT OR REPLACE INTO vault_pack_bases(oid, temporary) VALUES (?, 0)",
            object.oid,
          );
        });
      save([object], false);
      // Delta bases may be evicted here; the sink can read them again from the repository.
      evict();
    },
    endFetch,
  };
}
