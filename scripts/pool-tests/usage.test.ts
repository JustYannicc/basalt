import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callerHeader, type Cap, type UsageSlice, type UsageSummary } from "../../apps/pool/contract.ts";
import { backendUserName } from "../../src/pool/backend-users.ts";
import { capMessage, rewriteCapResponse } from "../../src/pool/cap-message.ts";
import { readCap } from "../../src/pool/caps.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { PoolUsage, summaryPath } from "../../src/pool/pool-usage.ts";
import { UsageLedger } from "../../src/pool/usage-summary.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { MemoryStorage, SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

interface Record {
  id: string; timestamp: string; provider: string; model: string;
  client: { api_key_id: number; user_id: number; username: string };
  tokens: { input_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; output_tokens: number; total_tokens: number };
  token_breakdown?: { quality: string; total_tokens: number; input: { uncached_tokens: number; cache_read_tokens: number; cache_write_tokens: number }; output: { total_tokens: number } };
  billing: { amount: number | null; matched_price_rule: string | null };
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for synthetic Home records or cap totals");
}
function total(records: Record[]): UsageSlice {
  const result = { requests: records.length, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }, cost: 0, unpriced: 0 };
  for (const row of records) {
    const t = row.tokens, canonical = row.token_breakdown;
    const values = canonical?.quality === "complete"
      ? [canonical.input.uncached_tokens, canonical.input.cache_read_tokens, canonical.input.cache_write_tokens, canonical.output.total_tokens, canonical.total_tokens]
      : [t.input_tokens - (t.cache_read_tokens ?? 0) - (t.cache_creation_tokens ?? 0), t.cache_read_tokens ?? 0, t.cache_creation_tokens ?? 0, t.output_tokens, t.total_tokens];
    for (const [index, key] of ["input", "cacheRead", "cacheWrite", "output", "total"].entries()) result.tokens[key as keyof UsageSlice["tokens"]] += values[index]!;
    // Home's billing record is the oracle, including its zero or null for the discovery requests.
    result.cost += row.billing.amount ?? 0;
    if (row.billing.amount === null || row.billing.matched_price_rule === "default:zero") result.unpriced++;
  }
  // The summary rounds cost to millionths of a dollar.
  return { ...result, cost: Math.round(result.cost * 1e6) / 1e6 };
}
function models(result: Pick<UsageSummary, "total" | "models">, records: Record[]) {
  const { requests, tokens, cost, unpriced } = result.total;
  assert.deepEqual({ requests, tokens, cost, unpriced }, total(records));
  const modelIds = [...new Set(records.map((row) => JSON.stringify([row.provider, row.model])))].sort();
  assert.deepEqual(result.models, modelIds.map((id) => {
    const [provider, model] = JSON.parse(id) as string[];
    return { provider, model, ...total(records.filter((row) => row.provider === provider && row.model === model)) };
  }));
}
function slices(result: Pick<UsageSummary, "total" | "models" | "days">, records: Record[]) {
  models(result, records);
  const days = [...new Set(records.map((row) => row.timestamp.slice(0, 10)))].sort();
  assert.equal(result.days.length, days.length);
  for (const [index, day] of days.entries()) {
    const own = records.filter((row) => row.timestamp.startsWith(day));
    assert.equal(result.days[index]!.day, day);
    models({ total: { requests: result.days[index]!.requests, tokens: result.days[index]!.tokens, cost: result.days[index]!.cost, unpriced: result.days[index]!.unpriced }, models: result.days[index]!.models }, own);
    assert.deepEqual(total(own), { requests: result.days[index]!.requests, tokens: result.days[index]!.tokens,
      cost: result.days[index]!.cost, unpriced: result.days[index]!.unpriced });
  }
}

const signingKey = "ab".repeat(32), owner = "fixture-owner", a = "fixture-member-a", b = "fixture-member-b";
test("real pinned Home/node: owner/member usage isolation, prices, second pool and cap enforcement", { timeout: 420_000 }, async () => {
  const fixture = new SharingFixture();
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init)), home = new ComputerHome(client);
    const providers = await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility");
    for (const [pool, provider] of [["pool-a", "fixture-p1"], ["pool-b", "fixture-p2"]]) {
      await new PoolHome(client, pool!).add([providers.find((row) => row.name === provider)!.keys[0]!.id]);
    }
    const keys = [await home.mint(owner, "pool-a", "owner-computer", owner), await home.mint(a, "pool-a", "member-a-computer", owner),
      await home.mint(b, "pool-a", "member-b-computer", owner), await home.mint(a, "pool-b", "own-computer", a)];
    assert.equal(new Set(keys.map((key) => key.userId)).size, 4);
    async function turn(index: number, session: string, model = "fixture-model") {
      const response = await fixture.model(keys[index]!.key, session, false, model), body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, new RegExp(`"content":"${index === 3 ? "P2" : "P1"}"`));
    }
    const records = () => fixture.data<{ items: Record[] }>("/usage/records?limit=200&sort=timestamp_asc").then((page) => page.items);
    await turn(0, "discover-a"); await turn(3, "discover-b");
    const discovery = await until(records, (rows) => rows.length === 2);
    const prices = [0.02, 0.03];
    for (const provider of new Set(discovery.map((row) => row.provider))) {
      for (const [index, model] of ["fixture-model", "fixture-alt"].entries()) {
        await fixture.data("/billing/model-prices", "POST", { provider, model, request_price: prices[index], source: "manual" });
      }
    }
    for (const index of [0, 1, 2, 3]) {
      await turn(index, `priced-${index}-model`);
      await turn(index, `priced-${index}-alt`, "fixture-alt");
    }
    const rows = await until(records, (rows) => rows.length === 10 && rows.filter((row) => (row.billing.amount ?? 0) > 0).length >= 8);
    for (const [index, person] of [owner, a, b, a].entries()) {
      const own = rows.filter((row) => row.client.api_key_id === keys[index]!.keyId);
      assert.equal(own.length, index === 0 || index === 3 ? 3 : 2);
      const name = await backendUserName(person, index === 3 ? "pool-b" : "pool-a");
      assert.ok(own.every((row) => row.client.username === name));
      for (const [model, price] of [["fixture-model", 0.02], ["fixture-alt", 0.03]] as const) {
        assert.ok(own.some((row) => row.model === model && row.billing.amount === price));
      }
      assert.ok(total(own).tokens.total > 0);
    }
    console.log("PASS 1: four person/pool users, ten Home records, two manually priced synthetic models");
    const usage = new PoolUsage({ storage: new MemoryStorage(), client, signingKey,
      audience: async (pool) => pool === "pool-a" ? [owner, a, b] : [a] });
    async function summary(caller: string, pool = "pool-a") {
      const token = await signPoolToken(signingKey, { pool, owner: pool === "pool-a" ? owner : a, organization: `org-${pool}` });
      const response = await usage.handle(new Request(`https://pool.example.test${summaryPath}`, {
        headers: { authorization: `Bearer ${token}`, [callerHeader]: caller },
      }));
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<UsageSummary>;
    }
    const shared = rows.filter((row) => row.client.api_key_id !== keys[3]!.keyId);
    const poolSummary = await summary(owner);
    assert.equal(poolSummary.scope, "pool"); assert.equal(poolSummary.cap, null);
    slices(poolSummary, shared);
    assert.deepEqual(poolSummary.members!.map((row) => row.member), [owner, a, b]);
    assert.ok(Object.hasOwn(poolSummary, "accountsNeeded"));
    for (const [index, person] of [owner, a, b].entries()) {
      const own = rows.filter((row) => row.client.api_key_id === keys[index]!.keyId);
      const member = poolSummary.members!.find((row) => row.member === person)!;
      const { member: _member, cap: _cap, models: _models, days: _days, ...amount } = member;
      slices({ total: amount, models: member.models, days: member.days }, own);
      assert.deepEqual(amount, total(own));
      assert.equal(member.cap, null);
      if (person === owner) continue;
      const result = await summary(person);
      assert.equal(result.scope, "you"); assert.equal(result.cap, null);
      assert.equal(Object.hasOwn(result, "members"), false); assert.equal(Object.hasOwn(result, "accountsNeeded"), false);
      slices(result, own);
    }
    const ownPool = await summary(a, "pool-b");
    assert.equal(ownPool.scope, "pool"); slices(ownPool, rows.filter((row) => row.client.api_key_id === keys[3]!.keyId));
    console.log("PASS 2: totals, tokens, cost, models and days match Home by key; members and second pool stay isolated");
    await usage.setCap("pool-a", owner, a, 0.01);
    const cap = await until(() => readCap(client, a, "pool-a"), (cap) => cap !== null && cap.used >= 0.05) as Cap;
    assert.equal(cap.remaining, 0);
    const before = fixture.calls.length;
    const blocked = await rewriteCapResponse(await fixture.model(keys[1]!.key, "capped"), "/v1/chat/completions");
    assert.equal(blocked.status, 429, await blocked.clone().text());
    const body = await blocked.json();
    assert.equal(body.error.message, capMessage); assert.equal(body.error.code, "user_period_limit_exceeded");
    assert.equal(fixture.calls.length, before);
    const memberCap = await summary(a), ownerCap = await summary(owner);
    assert.deepEqual(memberCap.cap, cap);
    assert.deepEqual(ownerCap.members!.find((row) => row.member === a)!.cap, cap);
    assert.equal(ownerCap.members!.find((row) => row.member === owner)!.cap, null);
    await turn(2, "other-member-still-works"); await turn(3, "own-pool-still-works");
    assert.equal(await readCap(client, b, "pool-a"), null); assert.equal(await readCap(client, a, "pool-b"), null);
    console.log("PASS 3: capped member gets rewritten 429 without upstream call; other member and own pool still succeed");
  } finally { await fixture.close(); }
});


test("real Home: late landing, removed credentials, switched key attribution and default:zero", { timeout: 420_000 }, async () => {
  const fixture = new SharingFixture();
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init)), home = new ComputerHome(client);
    const provider = (await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility")).find((row) => row.name === "fixture-p1")!;
    const credential = provider.keys[0]!.id;
    await new PoolHome(client, "pool-a").add([credential]);
    const key = await home.mint(a, "pool-a", "regression-computer", owner);
    const storage = new MemoryStorage(), ledger = new UsageLedger(storage, client, { maxPages: 1 });
    const start = Date.now(), firstSync = new Date(start + 60 * 60000), landedSync = new Date(start + 65 * 60000);
    const options = { owner, caller: owner, members: [a], days: 30, now: landedSync, cap: () => null };
    const records = () => fixture.data<{ items: Record[] }>("/usage/records?limit=200&sort=timestamp_asc").then((page) => page.items);
    const slow = await fixture.model(key.key, "late-landing", true);
    const body = slow.text();
    await until(async () => fixture.slowStarted, Boolean);
    // Advance only the ledger clock. Home/node perform a real held streaming request.
    await ledger.sync(firstSync);
    assert.equal((await ledger.summary("pool-a", options)).total.requests, 0);
    await delay(1200); const releasedAt = Date.now();
    fixture.finishStream(); assert.equal(slow.status, 200); await body;
    const missing = await until(records, (rows) => rows.length === 1);
    assert.ok(Date.parse(missing[0]!.timestamp) <= firstSync.getTime() - 59 * 60000);
    assert.ok(Date.parse(missing[0]!.timestamp) < releasedAt - 1000, "node stamps request start, before release");
    assert.equal(missing[0]!.billing.amount, 0);
    assert.equal(missing[0]!.billing.matched_price_rule, "default:zero");
    assert.deepEqual(await ledger.sync(landedSync), { complete: false, pages: 1 });
    assert.equal(await ledger.readAt(), landedSync.toISOString());
    assert.equal((await ledger.summary("pool-a", options)).total.requests, 1);
    assert.equal((await ledger.summary("pool-a", options)).total.unpriced, 1);
    console.log("PASS 4: real held request lands an hour late; one recent page counts it as unpriced without sweeping");
    await fixture.data("/billing/model-prices", "POST", { provider: missing[0]!.provider, model: "fixture-alt", request_price: 0, source: "manual" });
    const free = await fixture.model(key.key, "real-zero-price", false, "fixture-alt");
    assert.equal(free.status, 200, await free.text());
    const withFree = await until(records, (rows) => rows.length === 2);
    const zero = withFree.find((row) => row.model === "fixture-alt")!;
    assert.equal(zero.billing.amount, 0); assert.notEqual(zero.billing.matched_price_rule, "default:zero");
    assert.ok(zero.billing.matched_price_rule);
    // Both charged records, including default:zero, keep their ingestion-time user after rebind.
    const switched = await home.rebind(key.keyId, "pool-b", a, a);
    const afterSwitch = await records();
    assert.ok(afterSwitch.every((row) => row.client.user_id === key.userId && row.client.user_id !== switched));
    assert.ok(afterSwitch.every((row) => row.client.username === missing[0]!.client.username));
    // The free record is still pending in the ledger when the serving credential is deleted.
    await new PoolHome(client, "pool-a").remove(credential, async () => {});
    const removed = await records(); assert.equal(removed.length, 2);
    await new UsageLedger(storage, client).sync(landedSync);
    const result = await ledger.summary("pool-a", options);
    assert.equal(result.total.requests, 2); assert.equal(result.total.unpriced, 1); assert.equal(result.total.cost, 0);
    assert.equal((await ledger.summary("pool-b", options)).total.requests, 0);
    const cold = new UsageLedger(new MemoryStorage(), client); await cold.sync(landedSync);
    assert.equal((await cold.summary("pool-a", options)).total.requests, 2);
    console.log("PASS 5: removed credential's pending records survive; rebound key keeps charge user; real zero rule stays priced");
  } finally { await fixture.close(); }
});


test("real Home: records without billing charges follow the current key user after a pool switch", { timeout: 420_000 }, async () => {
  const fixture = new SharingFixture();
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init)), home = new ComputerHome(client);
    const provider = (await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility")).find((row) => row.name === "fixture-p1")!;
    await new PoolHome(client, "pool-a").add([provider.keys[0]!.id]);
    const key = await home.mint(a, "pool-a", "no-charge-computer", owner);
    const response = await fixture.model(key.key, "failed-request", "fail");
    assert.equal(response.status, 400, await response.text());
    const records = () => fixture.data<{ items: Record[] }>("/usage/records?limit=200").then((page) => page.items);
    const before = await until(records, (rows) => rows.length > 0);
    assert.ok(before.every((row) => row.billing.amount === null && row.client.user_id === key.userId));
    const user = await home.rebind(key.keyId, "pool-b", a, a);
    const after = await records();
    const name = await backendUserName(a, "pool-b");
    assert.ok(after.every((row) => row.client.user_id === user && row.client.username === name));
    const ledger = new UsageLedger(new MemoryStorage(), client), now = new Date(Date.now() + 60000);
    await ledger.sync(now);
    const options = { owner, caller: owner, members: [a], days: 30, now, cap: () => null };
    const result = await ledger.summary("pool-a", options);
    assert.equal(result.total.requests, after.length); assert.equal(result.total.unpriced, after.length);
    assert.equal((await ledger.summary("pool-b", options)).total.requests, 0);
    console.log("PASS 6: no-charge record username follows reassigned key; serving credential keeps its usage in original pool");
  } finally { await fixture.close(); }
});
