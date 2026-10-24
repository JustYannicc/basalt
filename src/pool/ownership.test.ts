import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolDirectory } from "./directory.ts";
import { fixture, member, owner, pool } from "./test/computers.ts";

const personal = { pool: "personal-pool", owner: member, organization: "personal-organization" };

test("forged own cannot take over an existing pool, switch onto it or delete it", async () => {
  const f = fixture();
  await f.access({ action: "audience", pools: [{ ...pool, users: [owner] }] });
  const victim = await f.create(owner);
  const attacker = await f.create(member, personal);
  const directory = await PoolDirectory.load(f.storage, f.now());
  const before = structuredClone(directory.entry(pool.pool));
  for (const organization of [pool.organization, "forged-organization"]) {
    const own = { pool: pool.pool, organization };
    const response = await f.action("computers", member, attacker.intent, { own });
    assert.equal(response.status, 200);
    const listing = await response.json() as { pools: { id: string }[] };
    assert.ok(!listing.pools.some((choice) => choice.id === pool.pool));
    assert.equal((await f.action("switch", member, attacker.intent, {
      id: attacker.computer.id, pool: pool.pool, own,
    })).status, 403);
    assert.deepEqual((await PoolDirectory.load(f.storage, f.now())).entry(pool.pool), before);
  }
  assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
  const after = (await PoolDirectory.load(f.storage, f.now())).entry(pool.pool)!;
  assert.equal(after.owner, owner);
  assert.equal(after.organization, pool.organization);
  assert.equal(after.refuseBefore, undefined);
  assert.equal((await f.registry())[victim.computer.id]!.state, "active");
  assert.equal(f.server.keys.length, 1);
});

test("own cannot change an existing owner's organization", async () => {
  const f = fixture();
  await f.intent(owner);
  const directory = await PoolDirectory.load(f.storage, f.now());
  const before = structuredClone(directory.entry(pool.pool));
  await directory.learnOwn({ pool: pool.pool, organization: "forged" }, owner, f.now());
  assert.deepEqual(directory.entry(pool.pool), before);
});

test("trusted audiences and pool claims replace an own-only owner and its membership", async () => {
  for (const source of ["audience", "context", "intent"]) {
    const f = fixture();
    const setup = await f.intent();
    const own = { pool: personal.pool, organization: "forged-organization" };
    assert.equal((await f.action("computers", member, setup, { own })).status, 200);
    f.restart();
    const real = { ...personal, owner, organization: "real-organization" };
    if (source === "audience") {
      assert.equal((await f.access({ action: "audience", pools: [{ ...real, name: "Real", users: [owner] }] })).status, 200);
    } else if (source === "context") {
      assert.equal((await f.context(owner, real)).status, 200);
    } else {
      const intent = await f.intent("real-member", real);
      assert.equal((await f.action("computers", "real-member", intent)).status, 200);
    }
    const directory = await PoolDirectory.load(f.storage, f.now());
    const entry = directory.entry(real.pool)!;
    assert.equal(entry.owner, owner, source);
    assert.equal(entry.organization, real.organization, source);
    assert.ok(!entry.users.includes(member), source);
    assert.ok(!directory.choices(member, f.now(), pool).some((choice) => choice.id === real.pool), source);
    // Deleting the forger must not delete the trusted owner's pool.
    assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
    assert.equal((await PoolDirectory.load(f.storage, f.now())).entry(real.pool)!.refuseBefore, undefined);
    assert.equal((await f.access({ action: "person-deleted", user: owner })).status, 200);
    assert.ok((await PoolDirectory.load(f.storage, f.now())).entry(real.pool)!.refuseBefore);
  }
});

test("own-only and legacy ownership never authorize pool deletion", async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    const intent = await f.intent();
    await f.action("computers", member, intent, { own: personal });
    if (legacy) {
      const state = await f.storage.get<{ pools: Record<string, { ownerSource?: string }> }>("pool-directory-v1");
      delete state!.pools[JSON.stringify(personal.pool)]!.ownerSource;
      await f.storage.put("pool-directory-v1", state);
    }
    f.restart();
    assert.equal((await f.access({ action: "person-deleted", user: member })).status, 200);
    const entry = (await PoolDirectory.load(f.storage, f.now())).entry(personal.pool)!;
    assert.equal(entry.refuseBefore, undefined);
    assert.equal(entry.at, -1);
    assert.deepEqual(entry.users, []);
  }
});
