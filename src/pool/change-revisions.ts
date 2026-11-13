import type { UsageStorage } from "./usage-storage.ts";
import type { DurableObjectStorage, DurableObjectTransaction } from "@cloudflare/workers-types";
import { signEnvelope } from "./token.ts";

export interface PoolRevision {
  scope: string;
  hint: { topic: string; resource: string; revision: string };
}
export const poolChangePath = "/api/internal/change-revisions";
export const poolChangePrefix = "sbcr1";
const stateKey = "pool-committed-changes-v1";
type Heads = Record<string, { revision: string; pending: boolean }>;
type Transaction = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
type NativeStorage = Pick<DurableObjectStorage, "get" | "put" | "delete"> & {
  transaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
};
const keyOf = (pool: string, topic: string) => JSON.stringify([pool, topic]);

/** A pool's derived reports and their pending hints share the native storage transaction. */
export class PoolChanges {
  readonly storage: UsageStorage;
  private sending?: Promise<void>;
  private readonly native: NativeStorage;
  private readonly publish: (changes: readonly PoolRevision[]) => Promise<void>;
  private readonly ready: () => void;
  constructor(
    native: NativeStorage,
    publish: (changes: readonly PoolRevision[]) => Promise<void>,
    ready: () => void = () => {},
  ) {
    this.native = native;
    this.publish = publish;
    this.ready = ready;
    this.storage = {
      get: <T>(key: string) => native.get<T>(key),
      getMany: <T>(keys: string[]) => native.get<T>(keys),
      put: (key, value) => this.commit((tx) => tx.put(key, value)),
      putMany: (entries) => this.commit((tx) => tx.putMany!(entries)),
      delete: (key) => this.commit((tx) => tx.delete(key)),
      deleteMany: (keys) => this.commit((tx) => tx.deleteMany!(keys)),
      transaction: (work) => this.commit(work),
    };
  }

  private commit<A>(work: (storage: UsageStorage) => Promise<A>): Promise<A> {
    let committedChange = false;
    return this.native
      .transaction(async (tx) => {
        const changed = new Set<string>();
        const put = async (entries: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(entries))
            if (this.reading(key, await tx.get(key)) !== this.reading(key, value)) changed.add(key);
          await tx.put(entries);
        };
        const remove = async (keys: string[]) => {
          for (const key of keys) if ((await tx.get(key)) !== undefined) changed.add(key);
          await tx.delete(keys);
        };
        const storage: UsageStorage = {
          get: <T>(key: string) => tx.get<T>(key),
          getMany: <T>(keys: string[]) => tx.get<T>(keys),
          put: (key, value) => put({ [key]: value }),
          putMany: put,
          delete: (key) => remove([key]),
          deleteMany: remove,
        };
        const value = await work(storage);
        const keys = await this.affected(tx, changed);
        if (keys.size) {
          const heads = (await tx.get<Heads>(stateKey)) ?? {};
          for (const key of keys)
            heads[key] = {
              revision: String(BigInt(heads[key]?.revision ?? "0") + 1n),
              pending: true,
            };
          await tx.put(stateKey, heads);
          committedChange = true;
        }
        return value;
      })
      .then((value) => {
        if (committedChange) this.ready();
        return value;
      });
  }

  private reading(key: string, value: unknown) {
    if (key.startsWith("pool-public-price-v1:") && typeof value === "object" && value !== null) {
      const { nextAttemptAt: _attempt, ...reading } = value as Record<string, unknown>;
      return JSON.stringify(reading);
    }
    return JSON.stringify(value);
  }

  private async affected(tx: Transaction, changed: ReadonlySet<string>) {
    const keys = new Set<string>();
    let prices = false;
    for (const key of changed) {
      const sampled = /^(?:capacity-v1|limit-v1):([^:]+)/u.exec(key);
      const usage = /^usage-v2:(?:model|account):([^:]+)/u.exec(key);
      const pool = sampled?.[1] ?? (usage?.[1] ? decodeURIComponent(usage[1]) : undefined);
      if (pool) keys.add(keyOf(pool, "pool-samples"));
      if (key.startsWith("pool-public-price-v1:")) prices = true;
    }
    if (prices) {
      const directory = await tx.get<{
        pools: Record<string, { pool: string; deleted?: boolean }>;
      }>("pool-directory-v1");
      for (const pool of Object.values(directory?.pools ?? {}))
        if (!pool.deleted) keys.add(keyOf(pool.pool, "pool-prices"));
    }
    return keys;
  }

  async current(pool: string) {
    const heads = (await this.native.get<Heads>(stateKey)) ?? {};
    return ["pool-samples", "pool-prices"].map((topic) => ({
      topic,
      resource: pool,
      revision: heads[keyOf(pool, topic)]?.revision ?? "0",
    }));
  }

  /** Acknowledgement compares the sent revision; a concurrent commit remains pending. */
  deliver(): Promise<void> {
    if (this.sending) return this.sending;
    const work = (async () => {
      const heads = (await this.native.get<Heads>(stateKey)) ?? {};
      const pending = Object.entries(heads)
        .filter(([, head]) => head.pending)
        .slice(0, 100);
      if (!pending.length) return;
      const changes = pending.map(([key, head]) => {
        const [pool, topic] = JSON.parse(key) as [string, string];
        return { scope: `pool:${pool}`, hint: { topic, resource: pool, revision: head.revision } };
      });
      await this.publish(changes);
      await this.native.transaction(async (tx) => {
        const current = (await tx.get<Heads>(stateKey)) ?? {};
        for (const [key, sent] of pending)
          if (current[key]?.revision === sent.revision) current[key]!.pending = false;
        await tx.put(stateKey, current);
      });
    })().finally(() => {
      if (this.sending === work) this.sending = undefined;
    });
    this.sending = work;
    return work;
  }
}

export async function publishPoolChanges(
  service: { fetch(input: string, init: RequestInit): Promise<Response> },
  signingKey: string,
  changes: readonly PoolRevision[],
  now = Date.now(),
) {
  if (!changes.length) return;
  const envelope = await signEnvelope(signingKey, poolChangePrefix, {
    action: "publish-changes",
    at: now,
    expiresAt: now + 30_000,
    changes,
  });
  const response = await service.fetch(`https://tools${poolChangePath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status !== 204) throw new Error("Committed pool changes remain pending");
}
