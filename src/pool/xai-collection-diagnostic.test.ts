import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { QuotaCollection, quotaCollectInterval } from "./quota-collection.ts";
import { collectionOf } from "./quota-collection.ts";
import type { Json } from "./json.ts";

function fixture(collection: Json, accepted: number | Error = 1) {
  let now = Date.parse("2030-01-01T01:00:00Z");
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
  };
  let posts = 0;
  const client = new HomeClient(
    async (path) => {
      if (path.endsWith("/quota/collect")) {
        posts++;
        if (accepted instanceof Error) throw accepted;
        return Response.json({ accepted });
      }
      return Response.json({
        credential: { credential_id: "xai-fixture", provider: "xai" },
        collection,
        windows: [],
      });
    },
    undefined,
    undefined,
    storage,
  );
  return {
    get now() {
      return now;
    },
    storage,
    client,
    stored: () => [...values.values()],
    posts: () => posts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("xAI read names Home backoff without inventing a fresh vendor attempt", async () => {
  const old = "2030-01-01T00:00:00Z";
  const next = "2030-01-01T02:00:00Z";
  const f = fixture({
    status: "failed",
    freshness: "never",
    last_attempt_at: old,
    next_probe_at: next,
    error: { code: "UPSTREAM_RESPONSE_INVALID", occurred_at: old },
  });
  const value = await new QuotaCollection(f.storage, f.client, { now: () => f.now }).read(
    "xai-fixture",
  );
  assert.equal(f.posts(), 0);
  assert.deepEqual(collectionOf(value!).request, {
    requested_at: new Date(f.now).toISOString(),
    disposition: "home_backoff",
    home_attempt_at: new Date(old).toISOString(),
    next_allowed_at: new Date(next).toISOString(),
  });
});

test("an uncertain xAI submission retains its decision without vendor exception text", async () => {
  const f = fixture(
    { status: "failed", freshness: "never", last_attempt_at: "2030-01-01T00:00:00Z" },
    new Error("private-secret"),
  );
  await assert.rejects(
    new QuotaCollection(f.storage, f.client, { now: () => f.now }).refresh("xai-fixture"),
  );
  const retained = await f.client.data("/quota/credentials/xai-fixture");
  assert.equal(f.posts(), 1);
  assert.equal((collectionOf(retained).request as Json).disposition, "submission_unconfirmed");
  assert.ok(!JSON.stringify(f.stored()).includes("private-secret"));
});

test("xAI request admission and deduplication are visible before Home completes", async () => {
  for (const accepted of [0, 1]) {
    const f = fixture(
      { status: "failed", freshness: "never", last_attempt_at: "2030-01-01T00:00:00Z" },
      accepted,
    );
    const value = await new QuotaCollection(f.storage, f.client, { now: () => f.now }).read(
      "xai-fixture",
      undefined,
      false,
      true,
    );
    assert.equal(f.posts(), 1);
    const request = collectionOf(value!).request as Json;
    assert.equal(request.disposition, accepted === 1 ? "submitted" : "home_already_queued");
    assert.equal(request.accepted, accepted === 1);
  }
});

test("a restarted pool exposes its persisted cap even when the Home failure is older", async () => {
  const old = "2030-01-01T00:00:00Z";
  const f = fixture({ status: "failed", freshness: "never", last_attempt_at: old });
  const requestedAt = f.now;
  await new QuotaCollection(f.storage, f.client, { now: () => f.now }).read(
    "xai-fixture",
    undefined,
    false,
  );
  f.advance(10_000);
  const value = await new QuotaCollection(f.storage, f.client, { now: () => f.now }).refresh(
    "xai-fixture",
  );
  const request = collectionOf(value!).request as Json;
  assert.equal(f.posts(), 1);
  assert.equal(request.disposition, "pool_cap");
  assert.equal(request.home_attempt_at, new Date(old).toISOString());
  assert.equal(request.requested_at, new Date(f.now).toISOString());
  assert.equal(request.next_allowed_at, new Date(requestedAt + quotaCollectInterval).toISOString());
});

test("an admitted Home job that outlives the SDK budget stays visibly pending", async () => {
  const old = "2030-01-01T00:00:00Z";
  const f = fixture({ status: "failed", freshness: "never", last_attempt_at: old });
  const caller = new AbortController();
  const collection = new QuotaCollection(f.storage, f.client, {
    now: () => f.now,
    wait: async () => {
      caller.abort(new DOMException("Synthetic caller deadline", "TimeoutError"));
      throw caller.signal.reason;
    },
  });
  const value = await collection.refresh("xai-fixture", caller.signal);
  const request = collectionOf(value!).request as Json;
  assert.equal(f.posts(), 1);
  assert.equal(request.disposition, "home_pending");
  assert.equal(request.accepted, true);
  assert.equal(request.home_attempt_at, new Date(old).toISOString());
});

test("xAI forced refresh names the persisted pool cap independently of Home failure time", async () => {
  const at = "2030-01-01T00:55:00Z";
  const f = fixture({ status: "failed", freshness: "never", last_attempt_at: at });
  const value = await new QuotaCollection(f.storage, f.client, { now: () => f.now }).refresh(
    "xai-fixture",
  );
  assert.equal(f.posts(), 0);
  const request = collectionOf(value!).request as Json;
  assert.equal(request.disposition, "pool_cap");
  assert.equal(request.home_attempt_at, new Date(at).toISOString());
  assert.equal(
    request.next_allowed_at,
    new Date(Date.parse(at) + quotaCollectInterval).toISOString(),
  );
});
