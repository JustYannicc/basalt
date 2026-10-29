import assert from "node:assert/strict";
import { test } from "node:test";
import { Computers } from "./computers.ts";
import { HomeClient } from "./control.ts";
import { PoolUsage } from "./pool-usage.ts";
import { setupTtl, signIntent } from "./setup-links.ts";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import { signEnvelope } from "./token.ts";

function usageFixture() {
  const f = fixture();
  const reads: unknown[][] = [], writes: unknown[][] = [];
  const real = new PoolUsage({ storage: { get: f.storage.get.bind(f.storage), put: f.storage.put.bind(f.storage), delete: async () => {} },
    client: new HomeClient(async () => { throw Error("Invalid cap must not reach Home"); }), signingKey, audience: async () => [] });
  const usage = {
    summary: async (...args: Parameters<PoolUsage["summary"]>) => { reads.push(args); return { scope: "pool", pool: args[0] } as never; },
    setCap: async (...args: Parameters<PoolUsage["setCap"]>) => { writes.push(args); return real.setCap(...args); },
  };
  const computers = new Computers({ storage: f.storage, home: f.home, signingKey, now: f.now, usage });
  async function send(action: string, intent: string, user = owner, extra: Record<string, unknown> = {}, secret = signingKey) {
    const envelope = await signEnvelope(secret, "sbs1", { action, intent, user, expiresAt: f.now() + 10_000, ...extra });
    return computers.handle(new Request(`https://pool.example.test/__setup/v1/${action}`, { method: "POST", body: JSON.stringify({ envelope }) }));
  }
  return { ...f, computers, reads, writes, send };
}

test("usage and cap require the signed intent's owner to equal the signed user", async () => {
  const f = usageFixture();
  const own = await f.intent(owner), shared = await f.intent(member);
  for (const action of ["usage", "cap"]) {
    const data = { member, weekly: 1, owner: member, pool: "pool-b", scope: "pool" };
    assert.equal((await f.send(action, shared, member, data)).status, 403);
    assert.equal((await f.send(action, own, member, data)).status, 401);
    assert.equal((await f.send(action, shared, owner, data)).status, 401);
  }
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});

test("usage and cap reject forged or expired host assertions and intents before reading or writing", async () => {
  const f = usageFixture(), intent = await f.intent(owner);
  for (const action of ["usage", "cap"]) {
    const data = { member, weekly: 1 };
    for (const response of [
      await f.send(action, intent, owner, data, "cd".repeat(32)),
      await f.send(action, intent, owner, { ...data, expiresAt: f.now() }),
      await f.send(action, intent, owner, { ...data, expiresAt: f.now() + 30_001 }),
      await f.send(action, `${intent}x`, owner, data),
      await f.send(action, await signIntent("cd".repeat(32), { ...pool, user: owner, expiresAt: f.now() + setupTtl }), owner, data),
      await f.send(action, await signIntent(signingKey, { ...pool, user: owner, expiresAt: f.now() }), owner, data),
      await f.send(action, intent, owner, { ...data, action: "validate" }),
    ]) assert.equal(response.status, 401, await response.clone().text());
  }
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});

test("usage always delegates the intent's pool and owner, ignoring supplied pool and scope", async () => {
  const f = usageFixture(), intent = await f.intent(owner);
  const response = await f.send("usage", intent, owner, { pool: "pool-b", owner: member, caller: member, days: 1, members: [member] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scope: "pool", pool: pool.pool });
  assert.deepEqual(f.reads, [[pool.pool, owner, owner, 30, [member], true]]);
});

test("signed cap action refuses the owner, invalid targets and invalid amounts through PoolUsage", async () => {
  const f = usageFixture(), intent = await f.intent(owner);
  assert.equal((await f.send("cap", intent, owner, { member: owner, weekly: 1 })).status, 400);
  for (const weekly of [0, -1, 100_001, 0.001, "1", {}, []]) {
    const response = await f.send("cap", intent, owner, { member, weekly });
    assert.equal(response.status, 400, await response.clone().text());
  }
  for (const target of ["", "x".repeat(513)]) assert.equal((await f.send("cap", intent, owner, { member: target, weekly: 1 })).status, 400);
  assert.equal(f.server.calls.length, 0);
});

test("audience is pool-specific and includes directory members without computers or usage", async () => {
  const f = usageFixture();
  assert.deepEqual(await f.computers.audience(pool.pool), []);
  assert.equal((await f.access({ action: "audience", pools: [pool, { ...pool, pool: "pool-b", owner: member, users: [member, "other-member"] }] })).status, 200);
  assert.deepEqual((await f.computers.audience(pool.pool)).sort(), [member, owner].sort());
  assert.deepEqual((await f.computers.audience("pool-b")).sort(), [member, "other-member"].sort());
  assert.deepEqual(await f.computers.audience("missing-pool"), []);
  assert.deepEqual(await f.registry(), {});
});
