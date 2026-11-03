import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { hasUsageLimits, QuotaCollection, quotaCollectInterval } from "./quota-collection.ts";
import type { Json } from "./json.ts";

class Storage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, value); }
}
function fixture() {
  let now = Date.parse("2030-01-01T00:00:00Z"), posts = 0;
  let value: Json = { credential: { credential_id: "a" }, collection: { status: "idle", freshness: "never" } };
  let onCollect = () => {};
  const client = new HomeClient(async (path, init) => {
    if (path.endsWith("/quota/collect")) {
      posts++;
      assert.deepEqual(JSON.parse(String(init?.body)), { credential_ids: ["a"] });
      onCollect();
      return Response.json({ accepted: 1, running: true }, { status: 202 });
    }
    if (path.endsWith("/quota/credentials/b")) return Response.json({
      credential: { credential_id: "b" }, collection: { status: "success", freshness: "fresh", observed_at: new Date(now).toISOString() },
    });
    assert.ok(path.endsWith("/quota/credentials/a"));
    return Response.json(value);
  });
  const storage = new Storage();
  const options = { now: () => now };
  const fresh = () => { value = { ...value, collection: { status: "success", freshness: "fresh", observed_at: new Date(now).toISOString(), last_attempt_at: new Date(now).toISOString() } }; };
  return { client, storage, options, fresh, set: (reading: Json) => { value = reading; },
    onCollect: (work: () => void) => { onCollect = work; }, posts: () => posts, advance: (ms: number) => { now += ms; } };
}

test("fresh observations need no collect, while stale checks share a persisted thirty-minute cap", async () => {
  const f = fixture();
  f.fresh();
  const collector = new QuotaCollection(f.storage, f.client, f.options);
  await collector.read("a"); assert.equal(f.posts(), 0);
  f.advance(quotaCollectInterval);
  await Promise.all([collector.read("a", undefined, false), collector.read("a", undefined, false)]);
  assert.equal(f.posts(), 1);
  const restarted = new QuotaCollection(f.storage, f.client, f.options);
  await restarted.read("a", undefined, false); assert.equal(f.posts(), 1);
  f.advance(quotaCollectInterval); await restarted.read("a", undefined, false); assert.equal(f.posts(), 2);
});

test("a queued job cannot substitute its old successful observation for a completed check", async () => {
  const f = fixture();
  f.fresh(); f.advance(quotaCollectInterval);
  let waits = 0;
  const stop = new Error("test boundary: collection has not completed");
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async () => { waits++; throw stop; } });
  await assert.rejects(collector.read("a"), (error) => error === stop);
  assert.equal(waits, 1); assert.equal(f.posts(), 1);
});

test("completion is awaited after Home first marks the job collecting", async () => {
  const f = fixture();
  f.onCollect(() => f.set({ credential: { credential_id: "a" }, collection: { status: "collecting", freshness: "never" } }));
  let waits = 0;
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async () => { waits++; f.fresh(); } });
  const value = await collector.read("a");
  assert.equal((value!.collection as Json).status, "success");
  assert.equal(waits, 1); assert.equal(f.posts(), 1);
});

test("Home's recent failed attempt also rate-caps forced collects", async () => {
  const f = fixture();
  f.set({ credential: { credential_id: "a" }, collection: { status: "failed", freshness: "never",
    last_attempt_at: new Date(f.options.now()).toISOString(), error: { code: "UPSTREAM_AUTH_REJECTED" } } });
  const result = await new QuotaCollection(f.storage, f.client, f.options).read("a");
  assert.equal(f.posts(), 0); assert.equal(((result!.collection as Json).error as Json).code, "UPSTREAM_AUTH_REJECTED");
});

test("a health check joining the alarm's queued collection waits for completion", async () => {
  const f = fixture();
  let waits = 0;
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async () => { waits++; f.fresh(); } });
  const background = collector.read("a", undefined, false);
  const check = collector.read("a");
  await background;
  const result = await check;
  assert.equal((result!.collection as Json).status, "success");
  assert.equal(f.posts(), 1); assert.equal(waits, 1);
});


test("automatic collection honors Home retryAt even beyond the thirty-minute cap", async () => {
  const f = fixture();
  const retryAt = f.options.now() + 2 * quotaCollectInterval;
  f.set({ credential: { credential_id: "a" }, collection: { status: "failed", freshness: "stale",
    last_attempt_at: new Date(f.options.now() - quotaCollectInterval).toISOString(),
    next_probe_at: new Date(retryAt).toISOString(), error: { code: "UPSTREAM_RATE_LIMITED" } } });
  const collector = new QuotaCollection(f.storage, f.client, f.options);
  await collector.read("a", undefined, false);
  f.advance(quotaCollectInterval);
  await collector.read("a", undefined, false);
  assert.equal(f.posts(), 0);
  f.advance(quotaCollectInterval);
  await collector.read("a", undefined, false);
  assert.equal(f.posts(), 1);
});

test("connectors and explicitly unlimited accounts have no automatic usage reporter", () => {
  assert.equal(hasUsageLimits({ provider: "google" }), false);
  assert.equal(hasUsageLimits({ provider: "slack" }), false);
  assert.equal(hasUsageLimits({ provider: "codex" }), true);
  assert.equal(hasUsageLimits({ type: "typesafe" }), true);
  assert.equal(hasUsageLimits({ provider: "codex" }, { primary_windows: [{ is_unlimited: true }] }), false);
  assert.equal(hasUsageLimits({ provider: "codex" }, { primary_windows: [{ is_unlimited: true }, { limit: 100 }] }), true);
});


test("a bounded wait leaves Home's collection queued and reads its completion on the next pass", async (t) => {
  const f = fixture(), budget = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 9_000); return budget.signal; });
  f.onCollect(() => f.set({ credential: { credential_id: "a" }, collection: { status: "collecting", freshness: "never" } }));
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async (_ms, signal) => {
    budget.abort(new DOMException("Collection wait ended", "TimeoutError"));
    signal.throwIfAborted();
  } });
  const pending = await collector.read("a");
  assert.equal((pending!.collection as Json).status, "collecting");
  assert.equal(f.posts(), 1);
  t.mock.restoreAll();
  f.advance(5 * 60_000);
  f.fresh();
  const completed = await collector.read("a");
  assert.equal((completed!.collection as Json).status, "success");
  assert.equal(f.posts(), 1, "waiting never cancels or queues a second Home collection");
});

test("the caller's own request deadline keeps the retained reading instead of failing", async () => {
  const f = fixture(), caller = new AbortController();
  f.onCollect(() => f.set({ credential: { credential_id: "a" }, collection: { status: "collecting", freshness: "never" } }));
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async (_ms, signal) => {
    caller.abort(new DOMException("Request deadline", "TimeoutError"));
    signal.throwIfAborted();
  } });
  const pending = await collector.read("a", caller.signal);
  assert.equal((pending!.collection as Json).status, "collecting");
  assert.equal(f.posts(), 1, "the queued Home collection is kept for the next pass");
});

test("a caller that disconnects still fails its read", async () => {
  const f = fixture(), caller = new AbortController();
  f.onCollect(() => f.set({ credential: { credential_id: "a" }, collection: { status: "collecting", freshness: "never" } }));
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async (_ms, signal) => {
    caller.abort(new DOMException("Client went away", "AbortError"));
    signal.throwIfAborted();
  } });
  await assert.rejects(collector.read("a", caller.signal));
});

test("an awaited collection yields to another account read", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async () => {
    entered.resolve();
    await release.promise;
    f.fresh();
  } });
  const first = collector.read("a");
  await entered.promise;
  // A separate fresh account read must finish before the first collection is released.
  try {
    const second = await collector.read("b");
    assert.equal((second!.credential as Json).credential_id, "b");
  } finally { release.resolve(); }
  assert.equal(((await first)!.collection as Json).status, "success");
  assert.equal(f.posts(), 1);
});


test("joining a queued collection keeps the original nine-second wait budget", async (t) => {
  const f = fixture();
  f.fresh(); f.advance(quotaCollectInterval);
  const budgets: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 9_000);
    const budget = new AbortController(); budgets.push(budget); return budget.signal;
  });
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async (_ms, signal) => {
    assert.equal(budgets.length, 2, "joining must not allocate another wait budget");
    budgets[1]!.abort(new DOMException("Collection wait ended", "TimeoutError"));
    signal.throwIfAborted();
  } });
  const queued = collector.read("a", undefined, false);
  const observed = collector.read("a", undefined, true);
  await queued;
  const retained = await observed;
  assert.equal((retained!.collection as Json).status, "collecting");
  assert.equal((retained!.collection as Json).observed_at, new Date(f.options.now() - quotaCollectInterval).toISOString());
  assert.equal(f.posts(), 1);
});
