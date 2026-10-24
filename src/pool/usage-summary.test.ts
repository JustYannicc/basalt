import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName } from "./backend-users.ts";
import { digest } from "./backend-users.ts";
import { poolGroupPrefix } from "./control.ts";
import { recordTokens, UsageLedger } from "./usage-summary.ts";
import { ChunkStorage, type UsageStorage } from "./usage-storage.ts";
import type { Json } from "./json.ts";

class Memory implements UsageStorage {
  values = new Map<string, unknown>();
  ops: { kind: string; keys: string[] }[] = [];
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
    id, usage_id: 1, timestamp: at, request_id: `request-${id}`, session_id: null, parent_session_id: null,
    root_session_id: null, upstream_request_id: null, event_type: null, status: "success", failed: false,
    status_code: 200, upstream_status_code: null, source: null, provider: "provider-a", model: "model-a", original_model: "model-a",
    endpoint: "/v1/responses", service_tier: null, reasoning_effort: null, executor_type: "synthetic",
    tokens: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cached_tokens: 30, cache_read_tokens: 30, cache_creation_tokens: 10, total_tokens: 120 },
    token_breakdown: { schema_version: 2, quality: "complete", total_tokens: 120,
      input: { total_tokens: 100, uncached_tokens: 60, cache_read_tokens: 30, cache_write_tokens: 10 },
      output: { total_tokens: 20, non_reasoning_tokens: 15, reasoning_tokens: 5 }, unclassified_tokens: 0 },
    performance: { latency_ms: 100, ttft_ms: null, tps: null },
    client: { api_key_id: 1, api_key_label: "synthetic", api_key_masked: "masked", user_id: 1, username: await backendUserName(person, pool), client_ip: null },
    credential: { credential_type: "oauth", credential_id: `credential-${pool}`, auth_index: "synthetic", provider: "provider-a", label: "synthetic", source: "synthetic", status: "active", api_key_preview: null },
    billing: { charge_id: null, amount, currency: "credits", billing_basis: "billing_charge", matched_price_rule: null, balance_before: null, balance_after: null },
    runtime: { home_ip: "", home_port: null, cpa_node_id: null, cpa_ip: null, cpa_port: null, cpa_label: null, request_log_available: false, log_home_ip_required: false }, error: null,
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
    assert.equal(url.pathname, "/usage/records");
    const query = url.searchParams;
    assert.equal(query.get("sort"), "timestamp_asc");
    assert.equal(query.get("limit"), "200");
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

test("overlap dedupes globally and catches a late record", async () => {
  const storage = new Memory(), home = new Home();
  const ledger = new UsageLedger(storage, home);
  home.records = [await record("one", "2026-10-24T11:59:00Z")];
  await ledger.sync(now);
  home.records.push(await record("late", "2026-10-24T11:58:00Z"));
  await ledger.sync(new Date("2026-10-24T12:05:00Z"));
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 2);
  assert.equal(home.calls[1]!.get("from"), "2026-10-24T11:50:00.000Z");
  assert.equal((await ledger.summary("pool-a", options())).readAt, "2026-10-24T12:05:00.000Z");
  await ledger.sync(new Date("2026-10-24T12:20:00Z"));
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 2);
  assert.deepEqual((await new ChunkStorage(storage).get<{ ids: object }>("usage-v1:seen:2026-10-24"))!.ids, {});
});

test("five pages are bounded, and a reconstructed ledger resumes its saved offset", async () => {
  const storage = new Memory(), home = new Home();
  home.records = await Promise.all(Array.from({ length: 1001 }, (_, i) => record(String(i).padStart(4, "0"), "2026-10-24T11:00:00Z")));
  assert.deepEqual(await new UsageLedger(storage, home).sync(now), { complete: false, pages: 5 });
  assert.equal(home.calls.length, 5);
  const ledger = new UsageLedger(storage, home);
  assert.deepEqual(await ledger.sync(now), { complete: true, pages: 1 });
  assert.equal(home.calls[5]!.get("offset"), "1000");
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 1001);
});

test("UTC buckets, retention, null pricing and separate pools", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = [await record("expired", "2026-09-23T12:00:00Z"), await record("retained", "2026-09-24T00:00:00Z"),
    await record("before", "2026-10-23T23:59:59.999Z"), await record("after", "2026-10-24T00:00:00Z", "member-a", "pool-a", null),
    await record("other-pool", "2026-10-24T00:00:00Z", "member-a", "pool-b", 7)];
  await ledger.sync(new Date("2026-10-23T23:59:59.999Z"));
  await ledger.sync(now);
  const result = await ledger.summary("pool-a", options());
  assert.deepEqual(result.days.map((day) => [day.day, day.requests]), [["2026-10-23", 1], ["2026-10-24", 1]]);
  assert.equal(result.total.cost, 0.25);
  assert.equal(result.total.unpriced, 1);
  assert.equal((await ledger.summary("pool-b", options())).total.cost, 7);
  const chunks = new ChunkStorage(storage);
  assert.equal(await chunks.get("usage-v1:pool:pool-a:2026-09-23"), undefined);
  assert.ok(await chunks.get("usage-v1:pool:pool-a:2026-09-24"));
  assert.equal((await ledger.summary("pool-a", options("owner", 1))).total.requests, 1);
});

test("member totals, models and days contain exactly their own slice", async () => {
  const storage = new Memory(), home = new Home();
  const cap = { weekly: 10, used: 1, remaining: 9, resetAt: "2026-10-26T00:00:00Z" };
  let adviceCalls = 0;
  const ledger = new UsageLedger(storage, home, { history: { advice: async () => { adviceCalls++; return []; } } });
  const own = await record("own", "2026-10-24T01:00:00Z");
  const other = await record("someone-else", "2026-10-23T01:00:00Z", "member-b", "pool-a", 99);
  other.model = "other-model"; other.provider = "other-provider";
  const unknown = await record("unknown", "2026-10-24T02:00:00Z", "not-listed");
  const foreign = await record("foreign", "2026-10-24T03:00:00Z");
  (foreign.client as Json).username = "not-our-backend-user";
  home.records = [own, other, unknown, foreign];
  await ledger.sync(now);
  const member = await ledger.summary("pool-a", { ...options("member-a"), cap: () => cap });
  assert.equal(member.scope, "you");
  assert.deepEqual(member.total, { requests: 1, tokens: { input: 60, cacheRead: 30, cacheWrite: 10, output: 20, total: 120 }, cost: 0.25, unpriced: 0 });
  assert.deepEqual(member.models, [{ provider: "provider-a", model: "model-a", ...member.total }]);
  assert.deepEqual(member.days, [{ day: "2026-10-24", ...member.total, models: member.models }]);
  assert.equal(Object.hasOwn(member, "members"), false);
  assert.equal(Object.hasOwn(member, "accountsNeeded"), false);
  assert.deepEqual(member.cap, cap);
  assert.equal(adviceCalls, 0);
  const owner = await ledger.summary("pool-a", { ...options(), cap: (member) => member === "owner" ? null : cap });
  assert.equal(owner.scope, "pool"); assert.equal(owner.total.requests, 4); assert.equal(owner.cap, null);
  assert.equal(owner.members!.length, 3);
  assert.equal(owner.members!.find((item) => item.member === "member-a")!.requests, 1);
  assert.equal(owner.members!.find((item) => item.member === "member-b")!.cost, 99);
  assert.equal(owner.members!.find((item) => item.member === "owner")!.cap, null);
  const saved = JSON.stringify([...storage.values]);
  for (const raw of ["member-a", "member-b", "not-listed", "not-our-backend-user", "api_key_masked", "request-one"]) assert.equal(saved.includes(raw), false);
  assert.ok(saved.includes(await digest("member-a")));
});

test("canonical tokens and fallback don't stack cached or reasoning tokens", async () => {
  const row = await record("tokens", "2026-10-24T01:00:00Z");
  assert.deepEqual(recordTokens(row, true), { input: 60, cacheRead: 30, cacheWrite: 10, output: 20, total: 120 });
  row.tokens = { input_tokens: 90, output_tokens: 10, reasoning_tokens: 9, cached_tokens: 20, cache_creation_tokens: 5, total_tokens: 100 };
  assert.deepEqual(recordTokens(row, false), { input: 65, cacheRead: 20, cacheWrite: 5, output: 10, total: 100 });
  (row.token_breakdown as Json).quality = "inconsistent";
  assert.equal(recordTokens(row, true).total, 100);
  (row.tokens as Json).cache_read_tokens = 0;
  assert.equal(recordTokens(row, false).cacheRead, 0);
  const home = new Home(), ledger = new UsageLedger(new Memory(), home);
  home.canonical = false; home.records = [row];
  await ledger.sync(now);
  assert.equal((await ledger.summary("pool-a", options())).total.tokens.input, 85);
});

test("a partial storage commit replays before another sync", async () => {
  const storage = new Memory(), home = new Home();
  home.records = [await record("one", "2026-10-24T11:59:00Z")];
  let failed = false;
  storage.fail = (key) => {
    if (!failed && key === "usage-v1:cursor") { failed = true; return true; }
    return false;
  };
  await assert.rejects(new UsageLedger(storage, home).sync(now), /synthetic storage/);
  storage.fail = undefined;
  const ledger = new UsageLedger(storage, home);
  await ledger.sync(now);
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 1);
});

test("simultaneous syncs share a queue and summary rejects invalid ranges", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = [await record("one", "2026-10-24T11:59:00Z")];
  await Promise.all([ledger.sync(now), ledger.sync(now)]);
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 1);
  for (const days of [0, 31, 1.5]) await assert.rejects(ledger.summary("pool-a", options("owner", days)), /Invalid usage days/);
});

test("a failed later page keeps readAt and resumes already saved work", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  assert.equal((await ledger.summary("pool-a", options())).readAt, null);
  home.records = await Promise.all(Array.from({ length: 201 }, (_, i) => record(String(i), "2026-10-24T11:00:00Z")));
  const data = home.data.bind(home);
  let fail = true;
  home.data = async (path) => {
    if (fail && path.includes("offset=200")) throw new Error("synthetic Home failure");
    return data(path);
  };
  await assert.rejects(ledger.sync(now), /synthetic Home failure/);
  const partial = await ledger.summary("pool-a", options());
  assert.equal(partial.total.requests, 200); assert.equal(partial.readAt, null);
  fail = false;
  assert.deepEqual(await ledger.sync(now), { complete: true, pages: 1 });
  assert.equal((await ledger.summary("pool-a", options())).total.requests, 201);
});

class BatchedMemory extends Memory {
  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    assert.ok(keys.length <= 128); this.ops.push({ kind: "getMany", keys });
    return new Map(keys.filter((key) => this.values.has(key)).map((key) => [key, structuredClone(this.values.get(key)) as T]));
  }
  async putMany(entries: Record<string, unknown>) {
    const keys = Object.keys(entries); assert.ok(keys.length <= 128);
    this.ops.push({ kind: "putMany", keys });
    if (keys.some((key) => this.fail?.(key))) throw new Error("synthetic storage failure");
    for (const [key, value] of Object.entries(entries)) {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024); this.values.set(key, structuredClone(value));
    }
  }
  async deleteMany(keys: string[]) { assert.ok(keys.length <= 128); this.ops.push({ kind: "deleteMany", keys }); for (const key of keys) this.values.delete(key); }
}

test("quiet sync touches only overlap receipts, skips unchanged writes and batches summary reads", async () => {
  const storage = new BatchedMemory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = await Promise.all(Array.from({ length: 31 }, (_, i) => record(`day-${i}`, new Date(now.getTime() - i * 86400000 - 60000).toISOString())));
  await ledger.sync(now);
  storage.ops = [];
  await ledger.sync(now);
  assert.equal(storage.ops.filter((op) => op.kind.startsWith("put") || op.kind.startsWith("delete")).length, 0);
  assert.ok(storage.ops.every((op) => op.keys.every((key) => !key.startsWith("usage-v1:seen:") || key.includes("2026-10-24"))));
  storage.ops = [];
  await ledger.sync(new Date(now.getTime() + 300000));
  const writes = storage.ops.filter((op) => op.kind.startsWith("put")).flatMap((op) => op.keys);
  assert.deepEqual(writes, ["usage-v1:cursor"]);
  assert.ok(!storage.values.has("usage-v1:pending"));
  storage.ops = [];
  assert.equal(await ledger.readAt(), "2026-10-24T12:05:00.000Z");
  assert.deepEqual(storage.ops.map((op) => op.kind), ["getMany"]);
  storage.ops = [];
  const summary = await ledger.summary("pool-a", options("member-a"));
  assert.equal(summary.total.requests, 30);
  assert.ok(storage.ops.every((op) => op.kind === "getMany"));
  assert.equal(storage.ops.length, 2);
  assert.ok(storage.ops.some((op) => op.keys.length === 31));
});

class TransactionMemory extends BatchedMemory {
  async transaction<T>(work: (tx: UsageStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values);
    try { return await work(this); } catch (error) { this.values = before; throw error; }
  }
}
for (const Store of [BatchedMemory, TransactionMemory]) test(`${Store.name}: page failure never loses or double counts buckets`, async () => {
  const storage = new Store(), home = new Home();
  home.records = await Promise.all(Array.from({ length: 401 }, (_, i) => record(`row-${i}`, new Date(now.getTime() - (500 - i) * 60000).toISOString())));
  let pages = 0;
  storage.fail = (key) => key === "usage-v1:cursor" && ++pages === 2;
  await assert.rejects(new UsageLedger(storage, home).sync(now), /synthetic storage/);
  storage.fail = undefined;
  const chunks = new ChunkStorage(storage);
  const receipts = await chunks.get<{ ids: Record<string, number> }>("usage-v1:seen:2026-10-24");
  assert.equal(Object.keys(receipts!.ids).length, 11);
  assert.equal((await new UsageLedger(storage, home).summary("pool-a", options())).total.requests, 200);
  await new UsageLedger(storage, home).sync(now);
  assert.equal((await new UsageLedger(storage, home).summary("pool-a", options())).total.requests, 401);
});

test("every output cost is rounded once to six decimals; members contain only a slice and cap", async () => {
  const storage = new Memory(), home = new Home(), ledger = new UsageLedger(storage, home);
  home.records = await Promise.all([0.1, 0.2, 0.1200001].map((cost, i) => record(`cost-${i}`, "2026-10-24T11:59:00Z", "member-a", "pool-a", cost)));
  await ledger.sync(now);
  const cap = { weekly: 7, used: 1, remaining: 6, resetAt: "2026-10-26T00:00:00Z" };
  const result = await ledger.summary("pool-a", { ...options(), cap: () => cap });
  assert.equal(result.cap, cap); assert.equal(result.members![0]!.cap, cap);
  for (const value of [result.total, ...result.models, ...result.days, ...result.days.flatMap((day) => day.models), result.members![1]!]) assert.equal(value.cost, 0.42);
  assert.deepEqual(Object.keys(result.members![1]!).sort(), ["member", "requests", "tokens", "cost", "unpriced", "cap"].sort());
  const member = await ledger.summary("pool-a", { ...options("member-a"), cap: () => cap });
  assert.equal(member.total.cost, 0.42); assert.equal(member.cap, cap);
});
