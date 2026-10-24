import assert from "node:assert/strict";
import test from "node:test";
import { PoolAcceptanceClient } from "./client.ts";
import { HttpStatusFailure } from "./types.ts";

const poolAccess = { token: "pool-token-fixture", owner: "acceptance" };

function usageRecord(id: string, account: string) {
  return { id, account, status: "success", at: "2026-10-23T12:00:00Z" };
}

test("usage polling sends the wire session to the signed pool route and waits for missing records", async () => {
  let now = 0;
  let reads = 0;
  const delays: number[] = [];
  const client = new PoolAcceptanceClient({
    origin: "https://fixture.invalid",
    now: () => now,
    delay: async (ms) => {
      delays.push(ms);
      now += ms;
    },
    usagePollWindowMs: 5_000,
    usagePollIntervalMs: 500,
    fetch: async (input, init) => {
      reads += 1;
      const url = new URL(input.toString());
      assert.equal(url.pathname, "/pool/v1/usage");
      assert.equal(url.searchParams.get("session"), "conversation-v4");
      assert.equal(url.searchParams.get("status"), "success");
      assert.equal(url.searchParams.get("limit"), "20");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer pool-token-fixture");
      assert.equal(new Headers(init?.headers).get("x-signalbox-caller"), "acceptance");
      assert.equal(url.searchParams.has("session_id"), false);
      const records = reads === 1
        ? []
        : reads === 2
          ? [usageRecord("one", "subscription-a")]
          : [
              usageRecord("one", "subscription-a"),
              usageRecord("two", "subscription-a"),
            ];
      return Response.json({ records });
    },
  });

  const records = await client.waitForUsageRecords(poolAccess, {
    id: "conversation-v4",
    expectedRecords: 2,
  });
  assert.equal(reads, 3);
  assert.deepEqual(delays, [500, 500]);
  assert.deepEqual(records.map((record) => record.account), ["subscription-a", "subscription-a"]);
});

test("usage rejects invalid scoped evidence without retrying", async (t) => {
  for (const [label, payload, failure] of [
    ["raw Home schema", { items: [usageRecord("one", "subscription-a")] }, /records\[\]/],
    ["missing account", { records: [{ id: "one", status: "success", at: "2026-10-23T12:00:00Z" }] }, /id or account/],
    ["failed request", { records: [{ ...usageRecord("one", "subscription-a"), status: "failed" }] }, /successful/],
    ["invalid time", { records: [{ ...usageRecord("one", "subscription-a"), at: "invalid" }] }, /timestamp/],
    ["duplicate rows", { records: [usageRecord("one", "subscription-a"), usageRecord("one", "subscription-a")] }, /duplicate/],
    ["extra rows", { records: [usageRecord("one", "subscription-a"), usageRecord("two", "subscription-a")] }, /expected 1/],
  ] as const) {
    await t.test(label, async () => {
      let reads = 0;
      const client = new PoolAcceptanceClient({
        fetch: async () => { reads += 1; return Response.json(payload); },
        delay: async () => { throw new Error("Invalid evidence must not be retried"); },
      });
      await assert.rejects(client.waitForUsageRecords(poolAccess, { id: "conversation-v4", expectedRecords: 1 }), failure);
      assert.equal(reads, 1);
    });
  }
  for (const status of [401, 403]) {
    await t.test(`authorization HTTP ${status}`, async () => {
      let reads = 0;
      const client = new PoolAcceptanceClient({
        fetch: async () => { reads += 1; return new Response(null, { status }); },
        delay: async () => { throw new Error("Authorization failures must not be retried"); },
      });
      await assert.rejects(client.waitForUsageRecords(poolAccess, { id: "conversation-v4", expectedRecords: 1 }), new RegExp(`usage returned HTTP ${status}`));
      assert.equal(reads, 1);
    });
  }
});

test("missing scoped records fail at the polling deadline", async () => {
  let now = 0;
  let reads = 0;
  const client = new PoolAcceptanceClient({
    now: () => now,
    delay: async (ms) => { now += ms; },
    usagePollWindowMs: 1_000,
    usagePollIntervalMs: 500,
    fetch: async () => { reads += 1; return Response.json({ records: [] }); },
  });
  await assert.rejects(client.waitForUsageRecords(poolAccess, { id: "conversation-v4", expectedRecords: 1 }), /incomplete after 1000 ms/);
  assert.equal(reads, 2);
});

test("model catalog exposes HTTP status for bounded restart handling", async () => {
  const client = new PoolAcceptanceClient({
    origin: "https://fixture.invalid",
    fetch: async () => new Response("warming", { status: 503 }),
  });
  await assert.rejects(client.modelCatalog("test-key"), (error: unknown) => {
    assert.ok(error instanceof HttpStatusFailure);
    assert.equal(error.status, 503);
    return true;
  });
});
