import assert from "node:assert/strict";
import { test } from "node:test";
import { ChunkStorage } from "./usage-storage.ts";
import { PoolChanges, type PoolRevision } from "./change-revisions.ts";

class MemoryTransaction {
  readonly values: Map<string, unknown>;
  constructor(values = new Map<string, unknown>()) {
    this.values = values;
  }
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key))
      return new Map(
        key
          .filter((key) => this.values.has(key))
          .map((key) => [key, structuredClone(this.values.get(key)) as T]),
      );
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(key: string | Record<string, T>, value?: T) {
    for (const [name, saved] of typeof key === "string"
      ? ([[key, value]] as const)
      : Object.entries(key))
      this.values.set(name, structuredClone(saved));
  }
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(key: string | string[]) {
    if (typeof key === "string") return this.values.delete(key);
    return key.filter((key) => this.values.delete(key)).length;
  }
}
class MemoryStorage extends MemoryTransaction {
  async transaction<T>(work: (tx: MemoryTransaction) => Promise<T>) {
    const candidate = new MemoryTransaction(structuredClone(this.values));
    const result = await work(candidate);
    this.values.clear();
    for (const [key, value] of candidate.values) this.values.set(key, value);
    return result;
  }
}
const pool = "app_0123456789abcdef";
const dataKey = `usage-v2:model:${pool}:2026-11-13`;
const put = (changes: PoolChanges, requests: number) =>
  new ChunkStorage(changes.storage).commit(
    new Map([[dataKey, [{ requests }]]]),
    [],
    "usage-v1:pending",
  );
const samples = (changes: PoolChanges) => changes.current(pool).then((heads) => heads[0]!.revision);

test("the source commit and revision roll back together; unchanged reports do not notify", async () => {
  const storage = new MemoryStorage();
  const sent: PoolRevision[][] = [];
  const changes = new PoolChanges(storage, async (batch) => {
    sent.push([...batch]);
  });
  assert.equal(await samples(changes), "0");
  await put(changes, 1);
  assert.equal(await samples(changes), "1");
  await changes.deliver();
  await put(changes, 1);
  await changes.deliver();
  assert.equal(await samples(changes), "1");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [
    { scope: `pool:${pool}`, hint: { topic: "pool-samples", resource: pool, revision: "1" } },
  ]);
  await assert.rejects(
    changes.storage.transaction!(async (tx) => {
      await tx.put(dataKey, { value: [{ requests: 2 }] });
      throw Error("rollback");
    }),
  );
  assert.equal(await samples(changes), "1");
  assert.deepEqual(await new ChunkStorage(changes.storage).get(dataKey), [{ requests: 1 }]);
});

test("a restart after commit or a lost acknowledgment recovers durable delivery", async () => {
  const storage = new MemoryStorage();
  const lost = new PoolChanges(storage, async () => {
    throw Error("ack lost");
  });
  await put(lost, 1);
  await assert.rejects(lost.deliver());
  const sent: PoolRevision[][] = [];
  const recovered = new PoolChanges(storage, async (batch) => {
    sent.push([...batch]);
  });
  await recovered.deliver();
  await recovered.deliver();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0]!.hint.revision, "1");
});

test("acknowledging an older delivery leaves a concurrent committed revision pending", async () => {
  const storage = new MemoryStorage();
  const sent: string[] = [];
  const changes = new PoolChanges(storage, async (batch) => {
    sent.push(batch[0]!.hint.revision);
    if (sent.length === 1) await put(changes, 2);
  });
  await put(changes, 1);
  await changes.deliver();
  await changes.deliver();
  await changes.deliver();
  assert.deepEqual(sent, ["1", "2"]);
});

test("price retry bookkeeping changes no revision, while a changed price notifies active pools", async () => {
  const storage = new MemoryStorage();
  await storage.put("pool-directory-v1", { pools: { [pool]: { pool } } });
  const sent: PoolRevision[][] = [];
  const changes = new PoolChanges(storage, async (batch) => {
    sent.push([...batch]);
  });
  const key = 'pool-public-price-v1:["codex","model"]';
  await changes.storage.put(key, { nextAttemptAt: 100, prices: [{ input: 1 }] });
  await changes.deliver();
  await changes.storage.put(key, { nextAttemptAt: 200, prices: [{ input: 1 }] });
  await changes.deliver();
  assert.equal(sent.length, 1);
  await changes.storage.put(key, { nextAttemptAt: 300, prices: [{ input: 2 }] });
  await changes.deliver();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]![0]!.hint.topic, "pool-prices");
});
