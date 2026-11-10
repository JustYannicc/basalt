import { DriveError } from "../shared/.generated/strata/errors.js";
import { objectId, referencedOids } from "../shared/.generated/strata/git/objects.js";
import { createSqliteRefStore, validateTransaction } from "../shared/.generated/strata/sqlite.js";
import type { TransactionStorage } from "../shared/strata/sqlite.ts";
import type {
  Bytes,
  GitObject,
  ObjectStore,
  Published,
  RefStore,
  RefTransaction,
} from "../shared/strata/types.ts";

/** What a vault needs from its Artifacts repository: Git smart HTTP plus a by-id blob read. */
export interface VaultRepository {
  refs(): Promise<Record<string, string>>;
  push(input: {
    updates: ReadonlyArray<{ ref: string; old: string | null; next: string }>;
    objects: ReadonlyArray<GitObject>;
  }): Promise<{ applied: boolean; results: Record<string, string> }>;
  fetchObjects(input: { wants: string[]; haves?: string[] }): Promise<GitObject[]>;
  /** The binding's readBlob: exact bytes or null. */
  readBlob(oid: string): Promise<Bytes | null>;
}

const main = "refs/heads/main";
const writerPrefix = "refs/heads/writers/",
  conflictPrefix = "refs/heads/conflicts/";
const conflictRef = (writer: string) => conflictPrefix + writer.slice(writerPrefix.length);
/** Durable Object SQLite refuses rows near 2 MB, so object bytes are stored in parts below it. */
const partBytes = 1024 * 1024;

/**
 * The vault's Artifacts repository is the record. This Durable Object is its only writer and keeps
 * a blobless clone: every commit and tree it has seen, objects not yet pushed, and a bounded blob
 * cache. Writer branches stay local until a land; a land is one push whose ref update names the
 * main it merged onto, so the server refuses a stale one.
 */
export function createArtifactsStores(input: {
  storage: TransactionStorage;
  repository: VaultRepository;
  blobCacheBytes?: number;
  now?: () => number;
}) {
  const { storage, repository } = input,
    { sql } = storage;
  const blobLimit = input.blobCacheBytes ?? 64 * 1024 * 1024,
    now = input.now ?? Date.now;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_git_objects (oid TEXT PRIMARY KEY, type TEXT NOT NULL, bytes INTEGER NOT NULL, kept INTEGER NOT NULL, pending INTEGER NOT NULL, used INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_git_parts (oid TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (oid, part))",
  );
  // The whole transaction travels with its push, so a crash after the push lands can finish it.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_push_intent (id INTEGER PRIMARY KEY CHECK(id = 1), ref TEXT NOT NULL, next TEXT NOT NULL, transaction_json TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_repository (id INTEGER PRIMARY KEY CHECK(id = 1), pushed_bytes INTEGER NOT NULL)",
  );
  sql.exec("INSERT OR IGNORE INTO vault_repository(id, pushed_bytes) VALUES (1, 0)");
  const local = createSqliteRefStore(storage);

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
            object.content.slice(part * partBytes, (part + 1) * partBytes).buffer,
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
        "SELECT oid, bytes FROM vault_git_objects WHERE kept = 0 AND pending = 0 ORDER BY used",
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
      if ((await objectId(object.type, object.content)) !== object.oid)
        throw new DriveError("integrity", "Artifacts returned a Git object with the wrong id");
    return objects;
  };
  const known = (oid: string) =>
    [...sql.exec("SELECT 1 FROM vault_git_objects WHERE oid = ?", oid)][0] !== undefined;
  /** Bring every commit and tree reachable from a remote head into the clone. */
  const fetchHead = async (head: string) => {
    if (known(head)) return;
    const haves = [
      ...sql.exec("SELECT oid FROM vault_git_objects WHERE type = 'commit' LIMIT 256"),
    ].map((entry) => String(entry.oid));
    save(await verified(await repository.fetchObjects({ wants: [head], haves })), false);
    evict();
  };

  const objects: ObjectStore = {
    async get(oid) {
      const stored = load(oid);
      if (stored) {
        sql.exec("UPDATE vault_git_objects SET used = ? WHERE oid = ?", now(), oid);
        return stored;
      }
      // Only a blob can be missing from a complete clone; trees and commits arrive with their head.
      const content = await repository.readBlob(oid);
      if (!content) return null;
      const [blob] = await verified([{ oid, type: "blob", content: new Uint8Array(content) }]);
      save([blob!], false);
      evict();
      return blob!;
    },
    async put(batch) {
      save(await verified(batch), true);
    },
  };

  /** Unpushed objects reachable from a head; anything already pushed is on the remote with its closure. */
  const unpushed = (head: string) => {
    const found = new Map<string, GitObject>(),
      queue = [head];
    while (queue.length) {
      const oid = queue.pop()!;
      if (found.has(oid)) continue;
      const object = load(oid, true);
      if (!object) continue;
      found.set(oid, object);
      queue.push(...referencedOids(object.type, object.content));
    }
    return [...found.values()];
  };
  const pushed = (sent: readonly GitObject[]) =>
    storage.transactionSync(() => {
      let bytes = 0;
      for (const object of sent) {
        sql.exec("UPDATE vault_git_objects SET pending = 0 WHERE oid = ?", object.oid);
        bytes += object.content.length;
      }
      sql.exec("UPDATE vault_repository SET pushed_bytes = pushed_bytes + ? WHERE id = 1", bytes);
    });
  const intent = () =>
    [...sql.exec("SELECT ref, next, transaction_json FROM vault_push_intent WHERE id = 1")][0];
  const clearIntent = () =>
    storage.transactionSync(() => sql.exec("DELETE FROM vault_push_intent WHERE id = 1"));
  /**
   * Decide an interrupted or unreadable push by what the remote now holds, never by its reply. A
   * push that landed finishes its own transaction: refs, receipt and, through the receipt, quota.
   */
  const settle = async () => {
    const open = intent();
    if (!open) return;
    const remote = await repository.refs();
    const landed = remote[String(open.ref)] === String(open.next);
    if (landed) {
      pushed(unpushed(String(open.next)));
      await local.publish(JSON.parse(String(open.transaction_json)) as RefTransaction);
    }
    clearIntent();
    return landed;
  };
  /**
   * Push one ref. Any refusal, in any wording, counts as a lost compare-and-swap: the caller merges
   * again from the remote main and keeps the work on its branch. Nothing is ever forced.
   */
  const pushRef = async (
    transaction: RefTransaction,
    ref: string,
    old: string | null,
    next: string,
  ) => {
    const sent = unpushed(next);
    storage.transactionSync(() =>
      sql.exec(
        "INSERT OR REPLACE INTO vault_push_intent(id, ref, next, transaction_json) VALUES (1, ?, ?, ?)",
        ref,
        next,
        JSON.stringify(transaction),
      ),
    );
    let accepted: boolean;
    try {
      const result = await repository.push({ updates: [{ ref, old, next }], objects: sent });
      accepted = result.applied && result.results[ref] === "ok";
    } catch {
      // A lost reply or a report we can't read: the remote ref is the only truth.
      return (await settle()) === true;
    }
    if (accepted) pushed(sent);
    else clearIntent();
    return accepted;
  };
  const setLocal = (ref: string, oid: string) =>
    storage.transactionSync(() =>
      sql.exec(
        "INSERT INTO drive_refs(name, oid) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET oid = excluded.oid",
        ref,
        oid,
      ),
    );
  /** Mirror the remote main locally after a lost race, so the next merge starts from it. */
  const adoptRemoteMain = async () => {
    const head = (await repository.refs())[main] ?? null;
    if (head) await fetchHead(head);
    if (head && head !== (await local.get(main))) setLocal(main, head);
    return head;
  };

  const refs: RefStore = {
    get: (ref) => local.get(ref),
    receipt: (operation, fingerprint) => local.receipt(operation, fingerprint),
    async publish(transaction: RefTransaction): Promise<Published> {
      validateTransaction(transaction);
      if (intent() && (await settle())) await adoptRemoteMain();
      const prior = await local.receipt(transaction.operation, transaction.fingerprint);
      if (prior) return { applied: true, receipt: prior };
      const current = Object.fromEntries(
        await Promise.all(
          transaction.changes.map(async (change) => [change.ref, await local.get(change.ref)]),
        ),
      ) as Record<string, string | null>;
      if (transaction.changes.some((change) => current[change.ref] !== change.expected))
        return { applied: false, current };
      const lost = async () => ({
        applied: false as const,
        current: { ...current, [main]: await adoptRemoteMain() },
      });
      // Record the transaction locally, then retire its push intent. A settle after a lost reply
      // may already have recorded it.
      const finish = async (): Promise<Published> => {
        const prior = await local.receipt(transaction.operation, transaction.fingerprint);
        const result = prior
          ? { applied: true as const, receipt: prior }
          : await local.publish(transaction);
        clearIntent();
        return result;
      };
      const moved = transaction.changes.find(
        (change) => change.ref === main && change.expected !== change.next,
      );
      if (moved) {
        if (!(await pushRef(transaction, main, moved.expected, moved.next))) return lost();
        return finish();
      }
      if (transaction.receipt.state === "conflict") {
        // Kept conflicts are part of the record, so other devices and agents can review them. A
        // refused push re-enters the land's bounded retry like a lost race on main.
        const ref = conflictRef(transaction.receipt.ref),
          remote = (await repository.refs())[ref] ?? null;
        if (
          remote !== transaction.receipt.oid &&
          !(await pushRef(transaction, ref, remote, transaction.receipt.oid))
        )
          return lost();
      }
      return finish();
    },
  };

  return {
    objects,
    refs,
    /**
     * Settle an interrupted push, mirror the remote main and restore kept conflict branches as
     * writer branches. Call once when the object wakes. Reports whether main arrived from the
     * repository into empty storage, so the caller can rebuild what it derives from main.
     */
    async recover() {
      await settle();
      const remote = await repository.refs();
      const empty = (await local.get(main)) === null;
      if (remote[main] && remote[main] !== (await local.get(main))) await adoptRemoteMain();
      for (const [ref, head] of Object.entries(remote)) {
        if (!ref.startsWith(conflictPrefix)) continue;
        const writer = writerPrefix + ref.slice(conflictPrefix.length);
        if ((await local.get(writer)) !== null) continue;
        await fetchHead(head);
        setLocal(writer, head);
      }
      return { adopted: empty && remote[main] !== undefined };
    },
    status: () => {
      const state = [...sql.exec("SELECT pushed_bytes FROM vault_repository WHERE id = 1")][0];
      return { pushedBytes: Number(state?.pushed_bytes ?? 0) };
    },
  };
}
