import assert from "node:assert/strict";
import { test } from "node:test";
import { callerHeader, type UsageSlice, type UsageSummary } from "../../apps/pool/contract.ts";
import { backendUserName } from "./backend-users.ts";
import { HomeClient, poolGroupPrefix } from "./control.ts";
import type { Json } from "./json.ts";
import { LimitHistory, type UsageStorage } from "./limit-history.ts";
import { PoolUsage, summaryPath } from "./pool-usage.ts";
import { signPoolToken } from "./token.ts";

const signingKey = "ab".repeat(32);
const owner = "owner-a", a = "member-a", b = "member-b", idle = "member-idle";
const claims = { pool: "pool-a", owner, organization: "org-a" };
const now = new Date("2026-10-24T12:00:00Z");
class Memory implements UsageStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { this.values.delete(key); }
}

async function fixture() {
  const storage = new Memory();
  const calls: string[] = [], audienceCalls: string[] = [];
  const specs = [
    [owner, "pool-a", 23, "model-x", 1], [a, "pool-a", 23, "model-x", 2],
    [b, "pool-a", 23, "model-x", 4], [a, "pool-a", 23, "model-y", 8],
    [b, "pool-a", 23, "model-y", 16], [a, "pool-a", 24, "model-x", 32],
    [b, "pool-a", 24, "model-x", 64], [a, "pool-b", 24, "model-x", 128],
  ] as const;
  const records: Json[] = await Promise.all(specs.map(async ([person, pool, day, model, n], index) => ({
    id: `record-${index}`, timestamp: `2026-10-${day}T01:00:00Z`, provider: "fixture", model,
    client: { username: await backendUserName(person, pool) }, credential: { credential_id: pool },
    tokens: { input_tokens: 10 * n, cache_read_tokens: 2 * n, cache_creation_tokens: n, output_tokens: 3 * n, total_tokens: 13 * n },
    billing: { amount: n / 128 },
  })));
  const users = await Promise.all([a, b, idle].map(async (person, index) => ({
    id: index + 1, username: await backendUserName(person, "pool-a"), limit_7d_credits: [5, 9, null][index],
  })));
  users.push({ id: 4, username: await backendUserName(a, "pool-b"), limit_7d_credits: null });
  const client = new HomeClient(async (path) => {
    const url = new URL(path, "https://home.example.test");
    const route = url.pathname.slice("/v8/management".length);
    calls.push(route);
    if (route === "/channel-groups") return Response.json({ channel_groups: ["pool-a", "pool-b"].map((pool, index) => ({ id: index + 1, channel_name: `${poolGroupPrefix}${pool}` })) });
    if (route === "/channel-group-details") return Response.json({ channel_group_details: ["pool-a", "pool-b"].map((pool, index) => ({ id: index + 1, channel_group_id: index + 1, auth_id: pool })) });
    if (route === "/capabilities") return Response.json({ capabilities: {} });
    if (route === "/usage/records") {
      const items = records.filter((row) => Date.parse(String(row.timestamp)) >= Date.parse(url.searchParams.get("from")!)
        && Date.parse(String(row.timestamp)) < Date.parse(url.searchParams.get("to")!));
      return Response.json({ items, total: items.length });
    }
    if (route === "/users") return Response.json({ users });
    if (/^\/users\/[12]\/period-limits$/.test(route)) {
      const first = route.includes("/1/");
      return Response.json({ timezone: "UTC", windows: [{ id: "7d", enabled: true, limit: first ? 5 : 9,
        used: first ? 1 : 2, remaining: first ? 4 : 7, mode: "calendar", week_reset_day: 1, week_reset_hour: 0,
        reset_at: "2026-10-26T00:00:00Z" }] });
    }
    throw new Error(`Unexpected Home read: ${path}`);
  });
  await new LimitHistory(storage, () => now).sample("pool-a", [{ id: "credential-a", provider: "fixture", state: "active", observedAt: now.toISOString(),
    windows: [{ id: "weekly", label: "Weekly", remainingRatio: 0.5, resetAt: null, windowSeconds: 604800 }] }]);
  const usage = new PoolUsage({ storage, client, signingKey, now: () => now,
    audience: async (pool) => { audienceCalls.push(pool); return pool === "pool-a" ? [owner, a, b, idle] : [a]; } });
  const token = await signPoolToken(signingKey, claims);
  async function request(caller: string | null = a, query = "", init: RequestInit = {}) {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (caller !== null) headers.set(callerHeader, caller);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return usage.handle(new Request(`https://pool.example.test${summaryPath}${query}`, { ...init, headers }));
  }
  async function summary(caller: string, query = ""): Promise<UsageSummary> {
    const response = await request(caller, query);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  return { usage, calls, audienceCalls, request, summary };
}

const slice = (n: number, requests: number): UsageSlice => ({ requests,
  tokens: { input: 7 * n, cacheRead: 2 * n, cacheWrite: n, output: 3 * n, total: 13 * n }, cost: Math.round(n / 128 * 1e6) / 1e6, unpriced: 0 });
function own(result: UsageSummary, x: number, y: number) {
  assert.equal(result.scope, "you");
  assert.deepEqual(result.total, slice(x + y, 3));
  const model = (name: string, n: number, requests: number) => ({ provider: "fixture", model: name, ...slice(n, requests) });
  assert.deepEqual(result.models, [model("model-x", x, 2), model("model-y", y, 1)]);
  const firstX = x / 17, lastX = x - firstX;
  assert.deepEqual(result.days, [
    { day: "2026-10-23", ...slice(firstX + y, 2), models: [model("model-x", firstX, 1), model("model-y", y, 1)] },
    { day: "2026-10-24", ...slice(lastX, 1), models: [model("model-x", lastX, 1)] },
  ]);
  assert.equal(Object.hasOwn(result, "members"), false);
  assert.equal(Object.hasOwn(result, "accountsNeeded"), false);
  assert.equal(result.from, "2026-09-25T00:00:00.000Z");
  assert.equal(result.to, "2026-10-25T00:00:00.000Z");
}

test("summary requires a valid pool token and caller, GET and 1 to 30 days", async () => {
  const f = await fixture();
  for (const authorization of ["", "Bearer invalid", `Bearer ${await signPoolToken("cd".repeat(32), claims)}`]) {
    assert.equal((await f.request(a, "", { headers: { authorization } })).status, 401);
  }
  assert.equal((await f.request(null)).status, 403);
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) assert.equal((await f.request(a, "", { method })).status, 404);
  for (const days of ["", "0", "31", "-1", "1.5", "01", "NaN", "Infinity", "1e1", " 2"]) {
    assert.equal((await f.request(a, `?days=${encodeURIComponent(days)}`)).status, 400, days);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.audienceCalls, []);
  assert.equal((await f.request(a, "?days=1")).status, 200);
  assert.equal((await f.request(a, "?days=30")).status, 200);
});

test("interleaved members on the same models and days see only their own usage and cap", async () => {
  const f = await fixture();
  const first = await f.summary(a), second = await f.summary(b);
  own(first, 34, 8); own(second, 68, 16);
  assert.deepEqual(first.cap, { weekly: 5, used: 1, remaining: 4, resetAt: "2026-10-26T00:00:00Z" });
  assert.deepEqual(second.cap, { weekly: 9, used: 2, remaining: 7, resetAt: "2026-10-26T00:00:00Z" });
  assert.deepEqual(f.audienceCalls, []);
  const empty = await f.summary(idle);
  assert.deepEqual(empty.total, slice(0, 0));
  assert.deepEqual(empty.models, []); assert.deepEqual(empty.days, []); assert.equal(empty.cap, null);
});

test("owning pool B cannot elevate membership on A or include B's records; queries cannot choose owner scope", async () => {
  const f = await fixture();
  // v1 trusts the host-supplied caller header; caller-id spoofing is outside this boundary.
  for (const query of ["", "?scope=pool", `?owner=${owner}&caller=${owner}&user=${owner}&pool=pool-b&members=${b}&accountsNeeded=true&cap=9`]) {
    own(await f.summary(a, query), 34, 8);
  }
  const token = await signPoolToken(signingKey, { pool: "pool-b", owner: a, organization: "org-b" });
  const response = await f.request(a, "", { headers: { authorization: `Bearer ${token}` } });
  const ownPool = await response.json() as UsageSummary;
  assert.equal(response.status, 200); assert.equal(ownPool.scope, "pool");
  assert.deepEqual(ownPool.total, slice(128, 1));
  assert.deepEqual(ownPool.members!.map((row) => row.member), [a]);
});

test("owner sees every audience member including zero usage, each cap and pool-only accounts-needed", async () => {
  const f = await fixture(), result = await f.summary(owner);
  assert.equal(result.scope, "pool"); assert.equal(result.cap, null);
  assert.deepEqual(result.total, slice(127, 7));
  assert.deepEqual(result.models, [
    { provider: "fixture", model: "model-x", ...slice(103, 5) },
    { provider: "fixture", model: "model-y", ...slice(24, 2) },
  ]);
  assert.deepEqual(result.days.map(({ models: _models, ...day }) => day), [
    { day: "2026-10-23", ...slice(31, 5) }, { day: "2026-10-24", ...slice(96, 2) },
  ]);
  assert.deepEqual(result.members!.map((row) => row.member), [owner, a, b, idle]);
  for (const [person, n, requests, weekly] of [[owner, 1, 1, null], [a, 42, 3, 5], [b, 84, 3, 9], [idle, 0, 0, null]] as const) {
    const row = result.members!.find((row) => row.member === person)!;
    const { member: _member, cap, models, days, ...amount } = row;
    assert.deepEqual(amount, slice(n, requests)); assert.equal(cap?.weekly ?? null, weekly);
    const own = person === owner ? null : await f.summary(person);
    assert.deepEqual(models, person === owner ? [{ provider: "fixture", model: "model-x", ...slice(1, 1) }] : own!.models);
    assert.deepEqual(days, person === owner ? [{ day: "2026-10-23", ...slice(1, 1), models }] : own!.days);
  }
  assert.deepEqual(result.accountsNeeded, [{ provider: "fixture", advice: "unknown", accounts: 1, limitHits: 0, exhausted: 0, hoursRead: 0 }]);
  assert.deepEqual(f.audienceCalls, ["pool-a"]);
});

test("alarm samples Home collection status and each primary window's observation", async () => {
  const storage = new Memory(); let clock = now;
  let reading: Json = {};
  const client = new HomeClient(async (path) => {
    const route = new URL(path, "https://home.example.test").pathname.slice("/v8/management".length);
    if (route === "/channel-groups") return Response.json({ channel_groups: [{ id: 1, channel_name: `${poolGroupPrefix}pool-a` }] });
    if (route === "/channel-group-details") return Response.json({ channel_group_details: [{ id: 1, channel_group_id: 1, auth_id: "a" }] });
    if (route === "/capabilities") return Response.json({});
    if (route === "/usage/records") return Response.json({ items: [], total: 0 });
    if (route === "/credentials") return Response.json({ files: [{ id: "a", provider: "fixture" }] });
    if (route === "/quota/credentials") return Response.json({ items: [reading] });
    throw new Error(path);
  });
  const usage = new PoolUsage({ storage, client, signingKey, audience: async () => [], now: () => clock });
  const raw = (at: Date): Json => ({ credential_id: "a", observed_at: at.toISOString(), freshness: "fresh", collection_status: "success",
    primary_windows: [{ id: "weekly", status: "healthy", remaining_ratio: 0.9, window_seconds: 604800, observed_at: at.toISOString() }] });
  const history = new LimitHistory(storage);
  for (const fault of ["failed", "stale", "old-window", "unknown-window"]) {
    reading = raw(clock);
    if (fault === "failed") reading.collection_status = "failed";
    if (fault === "stale") reading.freshness = "stale";
    const windows = reading.primary_windows as Json[];
    if (fault === "old-window") windows[0]!.observed_at = new Date(clock.getTime() - 31 * 60000).toISOString();
    if (fault === "unknown-window") windows[0]!.status = "unknown";
    await usage.observe(); assert.deepEqual(await history.advice("pool-a", clock), []);
    clock = new Date(clock.getTime() + 300000);
  }
  reading = raw(clock); await usage.observe();
  assert.equal((await history.advice("pool-a", clock))[0]!.hoursRead, 0);
  clock = new Date(clock.getTime() + 300000); await usage.observe();
  assert.equal((await history.advice("pool-a", clock))[0]!.hoursRead, 0);
  reading = raw(clock); await usage.observe();
  assert.equal((await history.advice("pool-a", clock))[0]!.hoursRead, 1 / 12);
});
