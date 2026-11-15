import assert from "node:assert/strict";
import { test } from "node:test";
import { startPoolFixture } from "./pool-fixture.mjs";
import { poolChangesPath } from "../../src/pool/change-http.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { poolFixtureStorage } from "./pool-fixture-storage.mjs";

const key = "27".repeat(32);
const pool = "app_change_fixture";

test("a source transaction does not discard a concurrent controller write", async () => {
  const storage = poolFixtureStorage();
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const revision = storage.transaction(async (tx) => {
    await tx.put("revision", "1");
    entered();
    await held;
  });
  await started;
  const controller = storage.put("controller", "saved");
  release();
  await Promise.all([revision, controller]);
  assert.equal(await storage.get("revision"), "1");
  assert.equal(await storage.get("controller"), "saved");
});

test("the pool fixture serves signed change reads from the production revision source", async (t) => {
  const fixture = await startPoolFixture(key);
  t.after(() => fixture.stop());
  const current = async (claims = {}, signingKey = key) => {
    const response = await fetch(fixture.origin + poolChangesPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        envelope: await signEnvelope(signingKey, "sbs1", {
          action: "changeRevisions",
          pool,
          expiresAt: Date.now() + 20_000,
          ...claims,
        }),
      }),
    });
    return { status: response.status, body: await response.text() };
  };
  const before = await current();
  assert.equal(before.status, 200, "the service assertion is not a user pool token");
  assert.deepEqual(JSON.parse(before.body), { revisions: await fixture.changes.current(pool) });
  await fixture.changes.storage.put(`usage-v2:model:${pool}:2026-11-14`, [{ requests: 1 }]);
  const after = await current();
  assert.equal(after.status, 200);
  assert.notDeepEqual(after.body, before.body, "a committed source write changes the reply");
  assert.deepEqual(JSON.parse(after.body), { revisions: await fixture.changes.current(pool) });
  assert.equal((await current({}, "28".repeat(32))).status, 401);
  assert.equal((await current({ expiresAt: Date.now() - 1 })).status, 401);
  assert.equal((await current({ action: "poolOverview" })).status, 401);
  assert.equal((await fetch(fixture.origin + poolChangesPath)).status, 405);
});
