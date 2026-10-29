import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { QuotaCollection, quotaCollectInterval } from "./quota-collection.ts";
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
  assert.equal((value?.collection as Json).status, "success");
  assert.equal(waits, 1); assert.equal(f.posts(), 1);
});

test("Home's recent failed attempt also rate-caps forced collects", async () => {
  const f = fixture();
  f.set({ credential: { credential_id: "a" }, collection: { status: "failed", freshness: "never",
    last_attempt_at: new Date(f.options.now()).toISOString(), error: { code: "UPSTREAM_AUTH_REJECTED" } } });
  const result = await new QuotaCollection(f.storage, f.client, f.options).read("a");
  assert.equal(f.posts(), 0); assert.equal(((result?.collection as Json).error as Json).code, "UPSTREAM_AUTH_REJECTED");
});

test("a health check joining the alarm's queued collection waits for completion", async () => {
  const f = fixture();
  let waits = 0;
  const collector = new QuotaCollection(f.storage, f.client, { ...f.options, wait: async () => { waits++; f.fresh(); } });
  const background = collector.read("a", undefined, false);
  const check = collector.read("a");
  await background;
  const result = await check;
  assert.equal((result?.collection as Json).status, "success");
  assert.equal(f.posts(), 1); assert.equal(waits, 1);
});
