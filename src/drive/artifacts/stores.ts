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
  fetch(input: { wants: string[]; haves?: string[] }): Promise<GitObject[]>;
  /** The binding's readBlob: exact bytes or null. */
  readBlob(oid: string): Promise<Bytes | null>;
}

const main = "refs/heads/main";
const conflictRef = (writer: string) =>
  `refs/heads/conflicts/${writer.slice("refs/heads/writers/".length)}`;

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
    "CREATE TABLE IF NOT EXISTS vault_objects (oid TEXT PRIMARY KEY, type TEXT NOT NULL, content BLOB NOT NULL, bytes INTEGER NOT NULL, kept INTEGER NOT NULL, pending INTEGER NOT NULL, used INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_push_intent (id INTEGER PRIMARY KEY CHECK(id = 1), ref TEXT NOT NULL, old TEXT, next TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_repository (id INTEGER PRIMARY KEY CHECK(id = 1), pushed_bytes INTEGER NOT NULL)",
  );
  sql.exec("INSERT OR IGNORE INTO vault_repository(id, pushed_bytes) VALUES (1, 0)");
  const local = createSqliteRefStore(storage);

  const row = (oid: string) =>
    [...sql.exec("SELECT type, content FROM vault_objects WHERE oid = ?", oid)][0];
  const save = (objects: readonly GitObject[], pending: boolean) =>
    storage.transactionSync(() => {
      for (const object of objects)
        sql.exec(
          // Commits and trees are the clone and never leave; blobs are cache unless unpushed.
          "INSERT INTO vault_objects(oid, type, content, bytes, kept, pending, used) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(oid) DO UPDATE SET pending = MAX(pending, excluded.pending), used = excluded.used",
          object.oid,
          object.type,
          object.content.slice().buffer,
          object.content.length,
          object.type === "blob" ? 0 : 1,
          pending ? 1 : 0,
          now(),
        );
    });
  const evict = () => {
    const cached = [
      ...sql.exec(
        "SELECT COALESCE(SUM(bytes), 0) AS total FROM vault_objects WHERE kept = 0 AND pending = 0",
      ),
    ][0];
    let excess = Number(cached?.total ?? 0) - blobLimit;
    if (excess <= 0) return;
    for (const victim of [
      ...sql.exec(
        "SELECT oid, bytes FROM vault_objects WHERE kept = 0 AND pending = 0 ORDER BY used",
      ),
    ]) {
      if (excess <= 0) break;
      sql.exec("DELETE FROM vault_objects WHERE oid = ?", String(victim.oid));
      excess -= Number(victim.bytes);
    }
  };
  const verified = async (objects: readonly GitObject[]) => {
    for (const object of objects)
      if ((await objectId(object.type, object.content)) !== object.oid)
        throw new DriveError("integrity", "Artifacts returned a Git object with the wrong id");
    return objects;
  };
  const known = (oid: string) => row(oid) !== undefined;
  /** Bring every commit and tree reachable from a remote head into the clone. */
  const fetchHead = async (head: string) => {
    if (known(head)) return;
    const haves = [...sql.exec("SELECT oid FROM vault_objects WHERE type = 'commit'")]
      .map((entry) => String(entry.oid))
      .slice(0, 256);
    save(await verified(await repository.fetch({ wants: [head], haves })), false);
    evict();
  };

  const objects: ObjectStore = {
    async get(oid) {
      const stored = row(oid);
      if (stored) {
        sql.exec("UPDATE vault_objects SET used = ? WHERE oid = ?", now(), oid);
        return {
          oid,
          type: String(stored.type) as GitObject["type"],
          content: new Uint8Array(stored.content as ArrayBuffer),
        };
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
      const stored = [
        ...sql.exec("SELECT type, content FROM vault_objects WHERE oid = ? AND pending = 1", oid),
      ][0];
      if (!stored) continue;
      const object: GitObject = {
        oid,
        type: String(stored.type) as GitObject["type"],
        content: new Uint8Array(stored.content as ArrayBuffer),
      };
      found.set(oid, object);
      queue.push(...referencedOids(object.type, object.content));
    }
    return [...found.values()];
  };
  const pushed = (sent: readonly GitObject[]) =>
    storage.transactionSync(() => {
      let bytes = 0;
      for (const object of sent) {
        sql.exec("UPDATE vault_objects SET pending = 0 WHERE oid = ?", object.oid);
        bytes += object.content.length;
      }
      sql.exec("UPDATE vault_repository SET pushed_bytes = pushed_bytes + ? WHERE id = 1", bytes);
    });
  const intent = () => [...sql.exec("SELECT ref, next FROM vault_push_intent WHERE id = 1")][0];
  /** Decide an interrupted or unreadable push by what the remote now holds; never by its reply. */
  const settle = async () => {
    const open = intent();
    if (!open) return;
    const remote = await repository.refs();
    const landed = remote[String(open.ref)] === String(open.next);
    if (landed) pushed(unpushed(String(open.next)));
    storage.transactionSync(() => sql.exec("DELETE FROM vault_push_intent WHERE id = 1"));
    return landed;
  };
  /**
   * Push one ref. Any refusal, in any wording, counts as a lost compare-and-swap: the caller merges
   * again from the remote main and keeps the work on its branch. Nothing is ever forced.
   */
  const pushRef = async (ref: string, old: string | null, next: string) => {
    const sent = unpushed(next);
    storage.transactionSync(() =>
      sql.exec(
        "INSERT OR REPLACE INTO vault_push_intent(id, ref, old, next) VALUES (1, ?, ?, ?)",
        ref,
        old,
        next,
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
    storage.transactionSync(() => sql.exec("DELETE FROM vault_push_intent WHERE id = 1"));
    return accepted;
  };
  /** Mirror the remote main locally after a lost race, so the next merge starts from it. */
  const adoptRemoteMain = async () => {
    const head = (await repository.refs())[main] ?? null;
    if (head) await fetchHead(head);
    const mirrored = await local.get(main);
    if (head && head !== mirrored)
      storage.transactionSync(() =>
        sql.exec(
          "INSERT INTO drive_refs(name, oid) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET oid = excluded.oid",
          main,
          head,
        ),
      );
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
      const moved = transaction.changes.find(
        (change) => change.ref === main && change.expected !== change.next,
      );
      if (moved && !(await pushRef(main, moved.expected, moved.next))) {
        const head = await adoptRemoteMain();
        return { applied: false, current: { ...current, [main]: head } };
      }
      if (transaction.receipt.state === "conflict") {
        // Kept conflicts are part of the record, so other devices and agents can review them.
        const ref = conflictRef(transaction.receipt.ref),
          remote = (await repository.refs())[ref] ?? null;
        if (
          remote !== transaction.receipt.oid &&
          !(await pushRef(ref, remote, transaction.receipt.oid))
        )
          throw new DriveError("stale", "The conflict branch changed remotely; save it again");
      }
      return local.publish(transaction);
    },
  };

  return {
    objects,
    refs,
    /** Settle an interrupted push, then mirror the remote main. Call once when the object wakes. */
    async recover() {
      await settle();
      const head = (await repository.refs())[main];
      if (head && head !== (await local.get(main))) await adoptRemoteMain();
    },
    status: () => {
      const state = [...sql.exec("SELECT pushed_bytes FROM vault_repository WHERE id = 1")][0];
      return { pushedBytes: Number(state?.pushed_bytes ?? 0) };
    },
  };
}
