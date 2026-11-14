import assert from "node:assert/strict";
import { test } from "node:test";
import { readCommittedPoolChanges } from "./change-http.ts";
import { signEnvelope } from "./token.ts";

test("pool revision reads require the signed, bounded host assertion before touching sources", async () => {
  const signingKey = "27".repeat(32);
  const now = 1_000_000;
  const read: string[] = [];
  const current = async (pool: string) => {
    read.push(pool);
    return { revisions: [{ topic: "pool-readings", resource: pool, revision: "3" }] };
  };
  const request = async (claims: Record<string, unknown>, secret = signingKey) =>
    new Request("https://pool.example.test/pool/v1/changeRevisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: await signEnvelope(secret, "sbs1", claims) }),
    });
  const input = { signingKey, now: () => now, current };
  const claims = { action: "changeRevisions", pool: "app_fixture", expiresAt: now + 30_000 };
  for (const rejected of [
    { ...claims, action: "poolOverview" },
    { ...claims, expiresAt: now },
    { ...claims, expiresAt: now + 30_001 },
    { ...claims, pool: "" },
  ])
    assert.equal((await readCommittedPoolChanges(await request(rejected), input)).status, 401);
  assert.equal(
    (await readCommittedPoolChanges(await request(claims, "28".repeat(32)), input)).status,
    401,
  );
  assert.deepEqual(read, []);
  const result = await readCommittedPoolChanges(await request(claims), input);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), {
    revisions: [{ topic: "pool-readings", resource: "app_fixture", revision: "3" }],
  });
  assert.deepEqual(read, ["app_fixture"]);
});
