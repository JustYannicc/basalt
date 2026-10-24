import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, UsageWindow } from "../../apps/pool/contract.ts";
import { LimitHistory } from "./limit-history.ts";
import { ChunkStorage, type UsageStorage } from "./usage-storage.ts";

class Memory implements UsageStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024);
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) { this.values.delete(key); }
}
const start = Date.parse("2026-10-01T00:00:00Z");
const step = 5 * 60_000;
function window(remainingRatio: number | null, windowSeconds = 604800): UsageWindow {
  return { id: String(windowSeconds), label: "synthetic", remainingRatio, windowSeconds, resetAt: null };
}
function account(id: string, remainingRatio = 0.8, state: Account["state"] = "active", provider = "provider-a"): Account {
  return { id, provider, state, label: "synthetic", plan: null, message: null, windows: [window(remainingRatio)], observedAt: null };
}
async function day(history: LimitHistory, accounts: Account[], first = start) {
  for (let i = 0; i < 289; i++) await history.sample("pool-a", accounts, new Date(first + i * step));
  return (await history.advice("pool-a", new Date(first + 288 * step)))[0]!;
}

test("advice stays unknown until 24 hours of actual readings", async () => {
  let now = new Date(start);
  const history = new LimitHistory(new Memory(), () => now);
  assert.deepEqual(await history.advice("pool-a"), []);
  await history.sample("pool-a", [account("a")]);
  assert.equal((await history.advice("pool-a"))[0]!.advice, "unknown");
  now = new Date(start + 24 * 3_600_000);
  await history.sample("pool-a", [account("a")]);
  const result = (await history.advice("pool-a"))[0]!;
  assert.equal(result.advice, "unknown");
  assert.equal(result.hoursRead, 1 / 12);
});

test("all exhausted together advises adding; limit episodes count transitions", async () => {
  const storage = new Memory(), history = new LimitHistory(storage);
  const active = [account("a"), account("b")];
  for (let i = 0; i < 289; i++) {
    const accounts = i === 10 || i === 11 || i === 20 ? [account("a", 0.01), account("b", 0, "unavailable")] : active;
    await history.sample("pool-a", accounts, new Date(start + i * step));
  }
  const result = (await new LimitHistory(storage).advice("pool-a", new Date(start + 288 * step)))[0]!;
  assert.equal(result.advice, "add");
  assert.equal(result.accounts, 2);
  assert.equal(result.limitHits, 4);
  assert.equal(result.exhausted, 3 / 289);
  assert.equal(result.hoursRead, 24);
});

test("remove requires spare capacity in every applicable window sample", async () => {
  const remove = await day(new LimitHistory(new Memory()), [account("a", 0.8), account("b", 0.8)]);
  assert.equal(remove.advice, "remove");
  const accounts = [account("a", 0.5), account("b", 0.5)];
  assert.equal((await day(new LimitHistory(new Memory()), accounts)).advice, "remove");
  const history = new LimitHistory(new Memory());
  for (let i = 0; i < 289; i++) await history.sample("pool-a", [account("a", i === 20 ? 0.2 : 0.9), account("b", 0.6)], new Date(start + i * step));
  assert.equal((await history.advice("pool-a", new Date(start + 288 * step)))[0]!.advice, "enough");
  const shortFull = { ...account("a", 0.1), windows: [window(1, 18000), window(0.1)] };
  assert.equal((await day(new LimitHistory(new Memory()), [shortFull, account("b", 0.6)])).advice, "enough");
});

test("one limit hit without pool exhaustion means enough", async () => {
  const history = new LimitHistory(new Memory());
  for (let i = 0; i < 289; i++) await history.sample("pool-a", [account("a", i === 10 ? 0 : 0.9), account("b", 0.9)], new Date(start + i * step));
  const result = (await history.advice("pool-a", new Date(start + 288 * step)))[0]!;
  assert.equal(result.advice, "enough");
  assert.equal(result.exhausted, 0);
  assert.equal(result.limitHits, 1);
});

test("missing quotas, disabled accounts and single accounts never justify removal", async () => {
  const missing = { ...account("a"), windows: [] };
  for (const accounts of [[missing, account("b")], [account("a", 0.9, "disabled"), account("b")], [account("a")]]) {
    assert.equal((await day(new LimitHistory(new Memory()), accounts)).advice, "enough");
  }
});

test("providers and pools stay separate, repeated five-minute readings do not inflate evidence", async () => {
  const storage = new Memory(), history = new LimitHistory(storage);
  const accounts = [account("raw-account-a", 0, "unavailable"), account("raw-account-b", 0.8, "active", "provider-b")];
  await Promise.all([history.sample("pool-a", accounts, new Date(start)), history.sample("pool-a", accounts, new Date(start + 1000))]);
  await history.sample("pool-b", [account("c")], new Date(start));
  const result = await history.advice("pool-a", new Date(start + 1000));
  assert.equal(result.length, 2); assert.equal(result[0]!.limitHits, 1);
  assert.equal(result[0]!.hoursRead, 0);
  assert.equal((await history.advice("pool-b", new Date(start)))[0]!.accounts, 1);
  assert.equal(JSON.stringify([...storage.values]).includes("raw-account"), false);
});

test("samples older than seven days and their limit hits are pruned", async () => {
  const storage = new Memory(), history = new LimitHistory(storage);
  await history.sample("pool-a", [account("a", 0)], new Date(start));
  const weekLater = start + 7 * 24 * 3_600_000 + step;
  const result = await day(history, [account("a", 0.8), account("b", 0.8)], weekLater);
  assert.equal(result.advice, "remove"); assert.equal(result.limitHits, 0);
  const stored = await new ChunkStorage(storage).get<{ providers: Record<string, { hours: [number, ...unknown[]][] }> }>("limit-v1:pool-a");
  assert.ok(Object.values(stored!.providers).every((provider) => provider.hours.every((hour) => hour[0] + 3600000 > weekLater)));
});

test("an ongoing limit episode still blocks removal after its first hit ages out", async () => {
  const history = new LimitHistory(new Memory());
  const limited = { ...account("a", 0.9), windows: [window(0, 18000), window(0.9)] };
  const accounts = [limited, account("b", 0.9), account("c", 0.9)];
  await history.sample("pool-a", accounts, new Date(start));
  const result = await day(history, accounts, start + 8 * 24 * 3_600_000);
  assert.equal(result.limitHits, 0); assert.equal(result.advice, "enough");
});

test("chunked values round-trip above 128 KiB and clean up shortened values", async () => {
  const storage = new Memory(), chunks = new ChunkStorage(storage);
  const value = { text: "\u0000🙂".repeat(50_000) };
  await chunks.put("large", value);
  assert.deepEqual(await chunks.get("large"), value);
  await chunks.put("large", { small: true });
  assert.equal(storage.values.size, 1);
  await chunks.delete("large");
  assert.equal(storage.values.size, 0);
});

class AtomicMemory extends Memory {
  ops: { kind: string; keys: string[] }[] = [];
  failAt = Infinity;
  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    const keys = typeof key === "string" ? [key] : key;
    assert.ok(keys.length <= 128); this.ops.push({ kind: "get", keys });
    if (typeof key === "string") return super.get<T>(key);
    return new Map(keys.filter((key) => this.values.has(key)).map((key) => [key, structuredClone(this.values.get(key)) as T]));
  }
  async put(key: string, value: unknown): Promise<void>;
  async put(entries: Record<string, unknown>): Promise<void>;
  async put(key: string | Record<string, unknown>, value?: unknown) {
    const entries = typeof key === "string" ? { [key]: value } : key, keys = Object.keys(entries);
    assert.ok(keys.length <= 128); this.ops.push({ kind: "put", keys });
    if (--this.failAt === 0) throw new Error("synthetic transaction failure");
    for (const [key, value] of Object.entries(entries)) await super.put(key, value);
  }
  async delete(key: string | string[]) {
    const keys = typeof key === "string" ? [key] : key;
    assert.ok(keys.length <= 128); this.ops.push({ kind: "delete", keys });
    for (const key of keys) await super.delete(key);
  }
  async transaction<T>(work: (tx: UsageStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values);
    try { return await work(this); } catch (error) { this.values = before; throw error; }
  }
}

test("native batches stay bounded and transactions roll back a failure between physical batches", async () => {
  const storage = new AtomicMemory(), chunks = new ChunkStorage(storage);
  const writes = new Map(Array.from({ length: 130 }, (_, i) => [`key-${i}`, { value: i }]));
  storage.failAt = 2;
  await assert.rejects(chunks.commit(writes, [], "pending"), /synthetic transaction/);
  assert.equal(storage.values.size, 0);
  storage.failAt = Infinity;
  await chunks.commit(writes, [], "pending");
  assert.equal(storage.values.size, 130);
  assert.equal((await chunks.getMany<{ value: number }>([...writes.keys()])).size, 130);
  await chunks.commit(new Map(), [...writes.keys()], "pending");
  assert.equal(storage.values.size, 0);
});

test("unchanged provider timestamps and empty histories write nothing", async () => {
  const storage = new AtomicMemory(), history = new LimitHistory(storage);
  await history.sample("pool-a", [], new Date(start));
  assert.ok(storage.ops.every((op) => op.kind === "get"));
  await history.sample("pool-a", [account("a"), account("b", 0.8, "active", "provider-b")], new Date(start));
  storage.ops = [];
  await history.sample("pool-a", [account("a", 0)], new Date(start + 1000));
  await history.sample("pool-a", [], new Date(start - step));
  assert.ok(storage.ops.every((op) => op.kind === "get"));
  const result = await history.advice("pool-a", new Date(start));
  assert.equal(result[0]!.limitHits, 0); assert.equal(result[1]!.accounts, 1);
  assert.ok(storage.ops.every((op) => op.kind === "get"));
});

test("hour masks preserve legacy advice at exact week edges, gaps and account changes", async () => {
  const storage = new AtomicMemory(), chunks = new ChunkStorage(storage), history = new LimitHistory(storage);
  const samples = Array.from({ length: 2200 }, (_, i) => ({ at: start + i * step, accounts: i % 19 === 0 ? 0 : i % 3 + 1,
    limited: i % 23 === 0 ? i % 3 + 1 : 0, hits: i % 23 === 0 ? 1 : 0, spare: i % 17 !== 0 })).filter((_, i) => i % 13 !== 0);
  const providers = Object.fromEntries(["provider-a", "provider-b"].map((provider) => [JSON.stringify(provider), { samples, lastAt: samples.at(-1)!.at, previous: {} }]));
  await chunks.put("limit-v1:pool-a", { providers });
  const expected = (now: number) => {
    const selected = samples.filter((sample) => sample.at >= now - 7 * 24 * 3600000 && sample.at <= now);
    const limitHits = selected.reduce((sum, sample) => sum + sample.hits, 0);
    const exhausted = selected.filter((sample) => sample.accounts > 0 && sample.limited === sample.accounts).length / selected.length;
    const hoursRead = Math.min(168, (selected.length - 1) / 12);
    const advice = hoursRead < 24 ? "unknown" : exhausted > 0 ? "add" : limitHits === 0 && selected.every((sample) => sample.limited === 0 && sample.spare) ? "remove" : "enough";
    return ["provider-a", "provider-b"].map((provider) => ({ provider, advice, accounts: selected.at(-1)!.accounts, limitHits, exhausted, hoursRead }));
  };
  const last = samples.at(-1)!.at;
  for (const at of [start + step, start + 24 * 3600000, last - step, last, last + 1, last + 7 * 24 * 3600000]) assert.deepEqual(await history.advice("pool-a", new Date(at)), expected(at));
  await history.sample("pool-a", [], new Date(last + step));
  samples.splice(0, samples.findIndex((sample) => sample.at >= last + step - 7 * 24 * 3600000));
  samples.push({ at: last + step, accounts: 0, limited: 0, hits: 0, spare: false });
  for (const at of [last - step, last, last + step]) assert.deepEqual(await history.advice("pool-a", new Date(at)), expected(at));
  const saved = await chunks.get<{ providers: Record<string, { hours: unknown[]; samples?: unknown }> }>("limit-v1:pool-a");
  assert.ok(Object.values(saved!.providers).every((provider) => provider.hours.length <= 169 && !provider.samples));
  assert.ok(JSON.stringify(saved).length < JSON.stringify({ providers }).length / 3);
});

test("legacy chunk metadata remains readable and converts without losing the value", async () => {
  const storage = new AtomicMemory(), chunks = new ChunkStorage(storage);
  storage.values.set("legacy", { count: 2, generation: 1 });
  storage.values.set("legacy:1:0", '{"legacy":'); storage.values.set("legacy:1:1", 'true}');
  assert.deepEqual(await chunks.get("legacy"), { legacy: true });
  await chunks.commit(new Map([["legacy", { small: true }]]), [], "pending");
  assert.equal(storage.values.size, 1); assert.deepEqual(await chunks.get("legacy"), { small: true });
});


test("refresh-failure unavailability never counts as quota exhaustion or spare capacity", async () => {
  for (const ratio of [0.8, null]) {
    const accounts = [account("a", 0.8, "unavailable"), { ...account("b", 0.8, "unavailable"), windows: [window(ratio)] }];
    const result = await day(new LimitHistory(new Memory()), accounts);
    assert.equal(result.advice, "enough"); assert.equal(result.limitHits, 0); assert.equal(result.exhausted, 0);
  }
});

test("weekly headroom cannot justify removal with a tight or unknown five-hour window", async () => {
  for (const ratio of [0.2, null]) {
    const accounts = ["a", "b"].map((id) => ({ ...account(id, 0.9), windows: [window(ratio, 18000), window(0.9)] }));
    assert.equal((await day(new LimitHistory(new Memory()), accounts)).advice, "enough");
  }
});
