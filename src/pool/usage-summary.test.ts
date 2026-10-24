import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName, digest } from "./backend-users.ts";
import { poolGroupPrefix } from "./control.ts";
import { recordTokens, UsageLedger } from "./usage-summary.ts";
import { ChunkStorage, type UsageStorage } from "./usage-storage.ts";
import type { Json } from "./json.ts";

class Memory implements UsageStorage {
  values = new Map<string, unknown>();
  ops: { kind: string; keys: string[] }[] = [];
  readBytes = 0; writeBytes = 0;
  bytes(value: unknown) { return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)); }
  fail?: (key: string) => boolean;
  async get<T>(key: string): Promise<T | undefined> { this.ops.push({ kind: "get", keys: [key] }); return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) {
    this.ops.push({ kind: "put", keys: [key] });
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024);
    if (this.fail?.(key)) throw new Error("synthetic storage failure");
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) { this.ops.push({ kind: "delete", keys: [key] }); this.values.delete(key); }
}

// Home v1.1.6 internal/cluster/management/usage_observability.go:1589-1664.
async function record(id: string, at: string, person = "member-a", pool = "pool-a", amount: number | null = 0.25): Promise<Json> {
  return {
    id, timestamp: at, provider: "provider-a", model: "model-a",
    tokens: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cached_tokens: 30, cache_read_tokens: 30, cache_creation_tokens: 10, total_tokens: 120 },
    token_breakdown: { schema_version: 2, quality: "complete", total_tokens: 120,
      input: { total_tokens: 100, uncached_tokens: 60, cache_read_tokens: 30, cache_write_tokens: 10 },
      output: { total_tokens: 20, non_reasoning_tokens: 15, reasoning_tokens: 5 }, unclassified_tokens: 0 },
    client: { api_key_id: 1, api_key_label: "synthetic", api_key_masked: "masked", user_id: 1, username: await backendUserName(person, pool), client_ip: null },
    credential: { credential_type: "oauth", credential_id: `credential-${pool}`, auth_index: "synthetic", provider: "provider-a", label: "synthetic", source: "synthetic", status: "active", api_key_preview: null },
    billing: { charge_id: null, amount, currency: "credits", billing_basis: "billing_charge", matched_price_rule: null, balance_before: null, balance_after: null },
  };
}
class Home {
  records: Json[] = [];
  calls: URLSearchParams[] = [];
  canonical = true;
  async allMembership() {
    return { groups: ["pool-a", "pool-b"].map((pool, i) => ({ id: i + 1, channel_name: `${poolGroupPrefix}${pool}` })),
      members: ["pool-a", "pool-b"].map((pool, i) => ({ id: i + 1, channel_group_id: i + 1, auth_id: `credential-${pool}` })) };
  }
  async data(path: string): Promise<Json> {
    if (path === "/capabilities") return { capabilities: { usage_token_breakdown_v2: this.canonical } };
    const url = new URL(path, "https://synthetic.invalid");
    const query = url.searchParams;
    assert.deepEqual([url.pathname, query.get("sort"), query.get("limit")], ["/usage/records", "timestamp_asc", "200"]);
    this.calls.push(query);
    const from = Date.parse(query.get("from")!), to = Date.parse(query.get("to")!);
    const found = this.records.filter((row) => Date.parse(String(row.timestamp)) >= from && Date.parse(String(row.timestamp)) < to)
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)));
    const offset = Number(query.get("offset"));
    return { items: found.slice(offset, offset + 200), total: found.length, limit: 200, offset, sort: "timestamp_asc", sortable_fields: ["timestamp"] };
  }
}
const now = new Date("2026-10-24T12:00:00Z");
const options = (caller = "owner", days = 30) => ({ owner: "owner", caller, members: ["owner", "member-a", "member-b"], days, now, cap: () => null });

test("each tier resumes its own durable cursor and fresh completion alone advances readAt", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = await Promise.all(Array.from({ length: 1001 }, (_, i) => record(`old-${i}`, "2026-10-24T11:00:00Z")));
  assert.deepEqual(await ledger.sync(now), { complete: false, pages: 5 });
  assert.equal(await ledger.readAt(), now.toISOString());
  const saved = await new ChunkStorage(storage).get<{ late: { offset: number }; scan: { offset: number } }>("usage-v1:cursor");
  assert.equal(saved!.late.offset, 400); assert.equal(saved!.scan.offset, 400);
  home.records.push(await record("new", "2026-10-24T12:01:00Z"), await record("inserted-before-offset", "2026-10-24T10:00:00Z"));
  const restored = new UsageLedger(storage, home); await restored.sync(new Date("2026-10-24T12:05:00Z"));
  assert.equal(await restored.readAt(), "2026-10-24T12:05:00.000Z");
  assert.equal(home.calls[5]!.get("from"), "2026-10-24T11:59:00.000Z");
  assert.equal(home.calls[6]!.get("offset"), "400"); assert.equal(home.calls[8]!.get("offset"), "400");
  for (let i = 2; i <= 6; i++) await restored.sync(new Date(now.getTime() + i * 300000));
  assert.equal((await restored.summary("pool-a", options())).total.requests, 1003);
});

test("UTC buckets, retention, null pricing and separate pools", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = [await record("expired", "2026-09-23T12:00:00Z"), await record("retained", "2026-09-24T00:00:00Z"),
    await record("before", "2026-10-23T23:59:59.999Z"), await record("after", "2026-10-24T00:00:00Z", "member-a", "pool-a", null),
    await record("other-pool", "2026-10-24T00:00:00Z", "member-a", "pool-b", 7)];
  await ledger.sync(new Date("2026-10-23T23:59:59.999Z")); await ledger.sync(now);
  const result = await ledger.summary("pool-a", options()); assert.deepEqual(result.days.map((day) => [day.day, day.requests]), [["2026-10-23", 1], ["2026-10-24", 1]]);
  assert.equal(result.total.cost, 0.25); assert.equal(result.total.unpriced, 1); assert.equal((await ledger.summary("pool-b", options())).total.cost, 7);
  const chunks = new ChunkStorage(storage); assert.equal(await chunks.get("usage-v1:pool:pool-a:2026-09-23"), undefined); assert.ok(await chunks.get("usage-v1:pool:pool-a:2026-09-24"));
  assert.equal((await ledger.summary("pool-a", options("owner", 1))).total.requests, 1);
  for (let i = 0; i < 31; i++) await new UsageLedger(storage, home).sync(now);
  assert.ok(![...storage.values.keys()].some((key) => key.startsWith("usage-v1:seen:2026-09-23")));
});

test("receipt shards and buckets persist only hashed request and person identities", async () => {
  const storage = new Memory(), home = new Home();
  home.records = [await record("raw-request-id", "2026-10-24T01:00:00Z", "raw-person")];
  await new UsageLedger(storage, home).sync(now);
  const saved = JSON.stringify([...storage.values]);
  for (const raw of ["raw-request-id", "raw-person", "api_key_masked"]) assert.equal(saved.includes(raw), false);
  assert.ok(saved.includes(await digest("raw-person"))); assert.ok(saved.includes(await digest("raw-request-id")));
});

test("canonical tokens and fallback don't stack cached or reasoning tokens", async () => {
  const row = await record("tokens", "2026-10-24T01:00:00Z"); assert.deepEqual(recordTokens(row, true), { input: 60, cacheRead: 30, cacheWrite: 10, output: 20, total: 120 });
  row.tokens = { input_tokens: 90, output_tokens: 10, reasoning_tokens: 9, cached_tokens: 20, cache_creation_tokens: 5, total_tokens: 100 };
  assert.deepEqual(recordTokens(row, false), { input: 65, cacheRead: 20, cacheWrite: 5, output: 10, total: 100 });
  (row.token_breakdown as Json).quality = "inconsistent"; assert.equal(recordTokens(row, true).total, 100); (row.tokens as Json).cache_read_tokens = 0; assert.equal(recordTokens(row, false).cacheRead, 0);
  const home = new Home(), ledger = new UsageLedger(new Memory(), home); home.canonical = false; home.records = [row]; await ledger.sync(now);
  assert.equal((await ledger.summary("pool-a", options())).total.tokens.input, 85);
});

test("a partial storage commit replays before another sync", async () => {
  const storage = new Memory(), home = new Home(); home.records = [await record("one", "2026-10-24T11:59:00Z")];
  let failed = false;
  storage.fail = (key) => !failed && key === "usage-v1:cursor" && (failed = true);
  await assert.rejects(new UsageLedger(storage, home).sync(now), /synthetic storage/);
  storage.fail = undefined;
  const ledger = new UsageLedger(storage, home); await ledger.sync(now); assert.equal((await ledger.summary("pool-a", options())).total.requests, 1);
});

test("simultaneous syncs share a queue and summary rejects invalid ranges", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home); home.records = [await record("one", "2026-10-24T11:59:00Z")]; await Promise.all([ledger.sync(now), ledger.sync(now)]);
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 1);
  for (const days of [0, 31, 1.5]) await assert.rejects(ledger.summary("pool-a", options("owner", days)), /Invalid usage days/);
});

test("a failed fresh page keeps readAt and resumes already saved work", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home); assert.equal((await ledger.summary("pool-a", options())).readAt, null);
  home.records = await Promise.all(Array.from({ length: 201 }, (_, i) => record(String(i), "2026-10-24T11:59:30Z")));
  const data = home.data.bind(home); let fail = true;
  home.data = async (path) => { if (fail && path.includes("offset=200")) throw new Error("synthetic Home failure"); return data(path); };
  await assert.rejects(ledger.sync(now), /synthetic Home failure/);
  const partial = await ledger.summary("pool-a", options()); assert.equal(partial.total.requests, 200); assert.equal(partial.readAt, null);
  fail = false;
  const recovered = new UsageLedger(storage, home); assert.deepEqual(await recovered.sync(now), { complete: true, pages: 4 });
  assert.equal(await recovered.readAt(), now.toISOString());
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 201);
});

class BatchedMemory extends Memory {
  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    assert.ok(keys.length <= 128); this.ops.push({ kind: "getMany", keys });
    this.readBytes += keys.reduce((n, key) => n + this.bytes(this.values.get(key)), 0);
    return new Map(keys.filter((key) => this.values.has(key)).map((key) => [key, structuredClone(this.values.get(key)) as T]));
  }
  async putMany(entries: Record<string, unknown>) {
    const keys = Object.keys(entries); assert.ok(keys.length <= 128);
    this.writeBytes += this.bytes(entries);
    this.ops.push({ kind: "putMany", keys });
    if (keys.some((key) => this.fail?.(key))) throw new Error("synthetic storage failure");
    for (const [key, value] of Object.entries(entries)) {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024); this.values.set(key, structuredClone(value));
    }
  }
  async deleteMany(keys: string[]) { assert.ok(keys.length <= 128); this.ops.push({ kind: "deleteMany", keys }); for (const key of keys) this.values.delete(key); }
}

test("quiet reconciliation batches receipts, never reads old buckets and skips unchanged writes", async () => {
  const storage = new BatchedMemory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = await Promise.all(Array.from({ length: 31 }, (_, i) => record(`day-${i}`, new Date(now.getTime() - i * 86400000 - 60000).toISOString()))); await ledger.sync(now);
  storage.ops = []; await ledger.sync(now);
  assert.equal(storage.ops.filter((op) => op.kind.startsWith("put") || op.kind.startsWith("delete")).length, 0);
  assert.ok(storage.ops.every((op) => op.keys.every((key) => !key.startsWith("usage-v1:pool:"))));
  assert.ok(storage.ops.some((op) => op.kind === "getMany" && op.keys.length === 31));
  storage.ops = []; await ledger.sync(new Date(now.getTime() + 300000));
  const writes = storage.ops.filter((op) => op.kind.startsWith("put")).flatMap((op) => op.keys);
  assert.deepEqual(writes, ["usage-v1:cursor"]);
  assert.ok(!storage.values.has("usage-v1:pending"));
  storage.ops = []; assert.equal(await ledger.readAt(), "2026-10-24T12:05:00.000Z");
  assert.deepEqual(storage.ops.map((op) => op.kind), ["getMany"]);
  storage.ops = []; const summary = await ledger.summary("pool-a", options("member-a"));
  assert.equal(summary.total.requests, 30);
  assert.ok(storage.ops.every((op) => op.kind === "getMany")); assert.equal(storage.ops.length, 2);
  assert.ok(storage.ops.some((op) => op.keys.length === 31));
});

class TransactionMemory extends BatchedMemory {
  async transaction<T>(work: (tx: UsageStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values);
    try { return await work(this); } catch (error) { this.values = before; throw error; }
  }
}
for (const Store of [BatchedMemory, TransactionMemory]) test(`${Store.name}: page failure never loses or double counts buckets`, async () => {
  const storage = new Store(), home = new Home(); let pages = 0;
  home.records = await Promise.all(Array.from({ length: 401 }, (_, i) => record(`row-${i}`, "2026-10-24T11:59:30Z")));
  storage.fail = (key) => key === "usage-v1:cursor" && ++pages === 2;
  await assert.rejects(new UsageLedger(storage, home).sync(now), /synthetic storage/);
  storage.fail = undefined;
  assert.equal((await new UsageLedger(storage, home).summary("pool-a", options())).total.requests, 200);
  for (let i = 0; i < 3; i++) await new UsageLedger(storage, home).sync(now);
  assert.equal((await new UsageLedger(storage, home).summary("pool-a", options())).total.requests, 401);
});

test("every output cost is rounded once to six decimals; members include their own models and days", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = await Promise.all([0.1, 0.2, 0.1200001].map((cost, i) => record(`cost-${i}`, "2026-10-24T11:59:00Z", "member-a", "pool-a", cost))); await ledger.sync(now);
  const cap = { weekly: 7, used: 1, remaining: 6, resetAt: "2026-10-26T00:00:00Z" };
  const result = await ledger.summary("pool-a", { ...options(), cap: () => cap });
  assert.equal(result.cap, cap); assert.equal(result.members![0]!.cap, cap);
  for (const value of [result.total, ...result.models, ...result.days, ...result.days.flatMap((day) => day.models), result.members![1]!]) assert.equal(value.cost, 0.42);
  assert.deepEqual(Object.keys(result.members![1]!).sort(), ["member", "requests", "tokens", "cost", "unpriced", "cap", "models", "days"].sort());
  const member = await ledger.summary("pool-a", { ...options("member-a"), cap: () => cap });
  assert.equal(member.total.cost, 0.42); assert.equal(member.cap, cap);
  assert.deepEqual(result.members![1]!.models, member.models); assert.deepEqual(result.members![1]!.days, member.days);
});

test("removed credentials use pool tags, including pools only known from stored buckets", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = [await record("before", "2026-10-24T10:00:00Z")]; await ledger.sync(now);
  home.allMembership = async () => ({ groups: [], members: [] });
  home.records.push(await record("pending", "2026-10-24T10:01:00Z"));
  await new UsageLedger(storage, home).sync(now);
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 2);
});

test("credential membership beats a switched key's current username for records without charges", async () => {
  const home = new Home(), ledger = new UsageLedger(new Memory(), home);
  const row = await record("switched", "2026-10-24T10:00:00Z", "member-a", "pool-b", null);
  (row.credential as Json).credential_id = "credential-pool-a";
  home.records = [row]; await ledger.sync(now);
  assert.equal((await ledger.summary("pool-a", options())).total.unpriced, 1);
  assert.equal((await ledger.summary("pool-b", options())).total.requests, 0);
});

test("default:zero is unpriced while a matched zero-price rule is priced", async () => {
  const home = new Home(), ledger = new UsageLedger(new Memory(), home);
  home.records = [await record("missing", "2026-10-24T10:00:00Z", "member-a", "pool-a", 0),
    await record("free", "2026-10-24T10:01:00Z", "member-a", "pool-a", 0)];
  (home.records[0]!.billing as Json).matched_price_rule = "default:zero";
  (home.records[1]!.billing as Json).matched_price_rule = "provider-a:model-a:auto:0";
  await ledger.sync(now);
  assert.equal((await ledger.summary("pool-a", options())).total.unpriced, 1);
});

for (const version of [undefined, 2, 3]) test(`legacy v${version} buckets and receipts rebuild together without double counting`, async () => {
  const storage = new BatchedMemory(), home = new Home(), chunks = new ChunkStorage(storage);
  home.records = [await record("legacy", "2026-10-24T11:00:00Z")];
  await chunks.put("usage-v1:days", ["2026-10-24"]);
  await chunks.put("usage-v1:seen:2026-10-24", { ids: { [await digest("legacy")]: now.getTime() }, pools: ["pool-a"] });
  await chunks.put("usage-v1:pool:pool-a:2026-10-24", [{ person: await digest("member-a"), provider: "provider-a", model: "model-a", requests: 99 }]);
  await chunks.put("usage-v1:cursor", { version, pools: version ? ["pool-a"] : undefined, readAt: now.toISOString() });
  home.allMembership = async () => ({ groups: [], members: [] }); const ledger = new UsageLedger(storage, home);
  if (version === 3) {
    storage.fail = (key) => key === "usage-v1:cursor";
    await assert.rejects(ledger.sync(now), /synthetic storage/); storage.fail = undefined;
  }
  await ledger.sync(now); await ledger.sync(now);
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 1);
  assert.equal((await chunks.get<{ version: number }>("usage-v1:cursor"))!.version, 4);
});

test("sustained eight requests per minute cannot starve fresh, late or retained reads", async () => {
  const storage = new BatchedMemory(), home = new Home(), template = await record("template", now.toISOString());
  const make = (id: string, at: number): Json => ({ ...template, id, timestamp: new Date(at).toISOString() });
  const start = now.getTime();
  home.records = Array.from({ length: 960 }, (_, i) => make(`initial-${i}`, start - 7200000 + i * 7500));
  let sixHoursCounted = false, sweepPages = 0, readBytes = 0, writeBytes = 0;
  for (let tick = 0; tick <= 48; tick++) {
    const at = start + tick * 300000;
    if (tick) home.records.push(...Array.from({ length: 40 }, (_, i) => ({ ...make(`live-${tick}-${i}`, at - 300000 + i * 7500), model: `live-${tick}` })));
    if (tick === 1) home.records.push(make("six-hours-late", at - 21600000));
    const before = home.calls.length; storage.readBytes = storage.writeBytes = 0;
    const ledger = new UsageLedger(storage, home); await ledger.sync(new Date(at)); // Resume durable progress after every alarm.
    readBytes += storage.readBytes; writeBytes += storage.writeBytes;
    assert.ok(home.calls.length - before <= 5);
    sweepPages += home.calls.slice(before).filter((call) => Date.parse(call.get("from")!) < start - 10800000).length;
    const result = await ledger.summary("pool-a", { ...options(), now: new Date(at) });
    assert.equal(result.readAt, new Date(at).toISOString());
    if (tick) assert.equal(result.models.find((model) => model.model === `live-${tick}`)!.requests, 40);
    sixHoursCounted ||= JSON.stringify([...storage.values]).includes(await digest("six-hours-late"));
  }
  console.log(`SUSTAINED sweepPages=${sweepPages} calls=${home.calls.length} read=${readBytes} written=${writeBytes}`);
  assert.ok(sweepPages >= 49, `only ${sweepPages} sweep pages`);
  assert.ok(sixHoursCounted); assert.equal((await new UsageLedger(storage, home).summary("pool-a", { ...options(), now: new Date(start + 14400000) })).total.requests, 960 + 48 * 40 + 1);
});

test("thirty days of initial backfill finish while steady fresh traffic continues", async () => {
  const storage = new BatchedMemory(), home = new Home(), template = await record("template", now.toISOString());
  home.records = Array.from({ length: 30 * 201 }, (_, i) => ({ ...template, id: `backfill-${i}`, timestamp: new Date(now.getTime() - (0.5 + Math.floor(i / 201)) * 86400000 + i % 201).toISOString() }));
  home.records.push(...Array.from({ length: 960 }, (_, i) => ({ ...template, id: `recent-${i}`, timestamp: new Date(now.getTime() - 7200000 + i * 7500).toISOString() })));
  let complete = false;
  for (let tick = 0; tick < 40; tick++) {
    const at = now.getTime() + tick * 300000;
    if (tick) home.records.push(...Array.from({ length: 40 }, (_, i) => ({ ...template, id: `fresh-${tick}-${i}`, timestamp: new Date(at - 300000 + i * 7500).toISOString() })));
    const result = await new UsageLedger(storage, home).sync(new Date(at));
    if (result.complete) {
      complete = true; console.log(`BACKFILL completeAfter=${tick + 1} syncs`);
      assert.equal((await new UsageLedger(storage, home).summary("pool-a", options())).total.requests, 30 * 201 + 960 + tick * 40); break;
    }
  }
  assert.ok(complete, "initial sweep did not finish");
});

test("ten thousand durable receipts plus one request keep storage bytes bounded", async () => {
  const storage = new BatchedMemory(), home = new Home(), template = await record("template", "2026-10-24T00:00:00Z");
  home.records = Array.from({ length: 10000 }, (_, i) => ({ ...template, id: `large-${i}` }));
  const ledger = new UsageLedger(storage, home);
  for (let i = 0; i < 60; i++) if ((await ledger.sync(now)).complete) break;
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 10000);
  home.records.push({ ...template, id: "new-large", timestamp: "2026-10-24T12:04:00Z" });
  storage.readBytes = storage.writeBytes = 0; home.calls = [];
  await ledger.sync(new Date("2026-10-24T12:05:00Z"));
  console.log(`RECEIPT_BYTES calls=${home.calls.length} read=${storage.readBytes} written=${storage.writeBytes}`);
  assert.ok(storage.readBytes < 256000, `read ${storage.readBytes} bytes`);
  assert.ok(storage.writeBytes < 16000, `wrote ${storage.writeBytes} bytes`);
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 10001);
});

test("one- and two-hour-late arrivals are counted within thirty minutes at every late-pass phase", async () => {
  const storage = new BatchedMemory(), home = new Home(), template = await record("template", now.toISOString());
  home.records = Array.from({ length: 1200 }, (_, i) => ({ ...template, id: `seed-${i}`, timestamp: new Date(now.getTime() - 9000000 + i * 7500).toISOString() }));
  // Keep the full sweep behind ten thousand older records, so only the late tier can pass this test.
  home.records.push(...Array.from({ length: 10000 }, (_, i) => ({ ...template, id: `older-${i}`, timestamp: "2026-10-14T00:00:00Z" })));
  const arrivals = new Map<string, number>(); let worst = 0;
  for (let tick = 0; tick <= 12; tick++) {
    const at = now.getTime() + tick * 300000;
    if (tick) home.records.push(...Array.from({ length: 40 }, (_, i) => ({ ...template, id: `new-${tick}-${i}`, timestamp: new Date(at - 300000 + i * 7500).toISOString() })));
    if (tick >= 1 && tick <= 3) for (const hours of [1, 2]) {
      const id = `late-${tick}-${hours}`; arrivals.set(id, tick);
      home.records.push({ ...template, id, model: id, timestamp: new Date(at - hours * 3600000).toISOString() });
    }
    const ledger = new UsageLedger(storage, home); await ledger.sync(new Date(at));
    const result = await ledger.summary("pool-a", options());
    for (const [id, landed] of arrivals) if (result.models.some((model) => model.model === id)) {
      worst = Math.max(worst, tick - landed); assert.ok(tick - landed <= 6); arrivals.delete(id);
    }
  }
  console.log(`LATE worstMinutes=${worst * 5}`); assert.equal(arrivals.size, 0);
});
