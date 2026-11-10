import assert from "node:assert/strict";
import { test } from "node:test";
import { stoppedFixture } from "../../scripts/pool-tests/stopped-fixture.ts";
import type { MembershipState } from "./membership-state.ts";
import { slotFixture } from "../../scripts/pool-tests/runtime-slots-fixture.ts";

test("a stopped boot acknowledges an expired retired denial without blocking its live pool", async () => {
  const f = await stoppedFixture();
  await f.memberships.retire("one", f.deps.now());
  const retained = await f.storage.get<Record<string, MembershipState>>(
    "native-pool-memberships-v1",
  );
  assert.ok(retained?.one?.retired);
  const revision = retained.one.revision;
  f.advance(20_000);
  const checked: string[] = [];
  const check = f.deps.checkPolicy;
  f.deps.checkPolicy = async (policy, signal) => {
    checked.push(policy.pool);
    await check(policy, signal);
  };

  const receipt = await f.construct().run(await f.approval());
  assert.equal(receipt.status, "ready");
  assert.deepEqual(checked, ["two"]);
  const denial = f.installed.get("one");
  assert.ok(denial);
  assert.equal(denial.revision, revision);
  assert.equal(denial.dirty, true);
  assert.deepEqual(denial.accounts, []);
  assert.ok(denial.expiresAt > f.deps.now());
  await assert.rejects(f.memberships.authority("one"), /refreshing/);
  assert.equal(
    (await f.storage.get<Record<string, MembershipState>>("native-pool-memberships-v1"))?.one
      ?.installedRevision,
    0,
  );
});

test("slot promotion replaces stale deleted-pool authority with its retired denial", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.memberships.ensure("retired", "organization");
  const before = await f.slots.inspect();
  const oldPolicy = before.policies.find((policy) => policy.pool === "retired");
  assert.ok(oldPolicy);
  await f.driver.install(f.candidate, oldPolicy, new AbortController().signal);
  await f.memberships.retire("retired", Date.now());
  assert.notEqual((await f.slots.inspect()).digest, before.digest);

  await f.slots.stage(f.candidate);
  const receipt = await f.slots.promote(await f.intent());
  assert.equal(receipt.status, "promoted");
  assert.ok(
    receipt.policies.some(
      ({ pool, revision }) => pool === "retired" && revision === oldPolicy.revision + 1,
    ),
  );
  const denial = f.policies.get(f.candidate.instanceId)?.get("retired");
  assert.ok(denial);
  assert.equal(denial.revision, oldPolicy.revision + 1);
  assert.equal(denial.dirty, true);
  assert.deepEqual(denial.accounts, []);
  assert.ok(denial.expiresAt > Date.now());
  await assert.rejects(
    f.driver.install(f.candidate, oldPolicy, new AbortController().signal),
    /policy/,
  );
  await assert.rejects(f.memberships.authority("retired"), /refreshing/);
});

test("a retired denial must acknowledge on the new stopped boot before completion", async () => {
  let refuse = false;
  const f = await stoppedFixture({
    install: async (policy) => {
      if (refuse && policy.dirty) throw new Error("retired denial unacknowledged");
    },
  });
  await f.memberships.retire("one", f.deps.now());
  refuse = true;
  const approval = await f.approval();
  await assert.rejects(f.construct().run(approval), /retired denial unacknowledged/);
  assert.equal((await f.construct().run(approval)).status, "started");
  assert.equal(f.installed.has("one"), false);
  await assert.rejects(f.memberships.authority("one"), /refreshing/);
});

test("a boot with only retired pools proves their denials without reactivating them", async () => {
  const f = await stoppedFixture();
  await f.memberships.retire("one", f.deps.now());
  await f.memberships.retire("two", f.deps.now());
  f.advance(20_000);
  f.deps.checkPolicy = async () => assert.fail("a retired denial is not live authority");
  assert.equal((await f.construct().run(await f.approval())).status, "ready");
  for (const pool of ["one", "two"]) {
    assert.equal(f.installed.get(pool)?.dirty, true);
    await assert.rejects(f.memberships.authority(pool), /refreshing/);
  }
});

test("a candidate that refuses a retired denial cannot promote over the serving runtime", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.memberships.ensure("retired", "organization");
  await f.memberships.retire("retired", Date.now());
  f.hooks.install = async (identity, policy) => {
    if (identity.instanceId === f.candidate.instanceId && policy.dirty)
      throw new Error("retired denial unacknowledged");
  };
  await assert.rejects(f.slots.stage(f.candidate), /retired denial unacknowledged/);
  await assert.rejects(f.slots.promote(await f.intent()), /retired denial unacknowledged/);
  assert.equal((await f.slots.inspect()).selection?.active.identity?.bootId, f.old.bootId);
  assert.equal((await f.slots.inspect()).selection?.epoch, 1);
  assert.equal(f.calls.retire.length, 0);
});

test("a newer retirement revision fences a candidate proof that already read its tombstone", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.memberships.ensure("retired", "organization");
  const at = Date.now();
  await f.memberships.retire("retired", at);
  let superseded = false;
  f.hooks.install = async (identity, policy) => {
    if (identity.instanceId !== f.candidate.instanceId || !policy.dirty || superseded) return;
    superseded = true;
    await f.memberships.retire("retired", at + 1);
  };
  await assert.rejects(f.slots.stage(f.candidate), /policy|selection/);
  assert.equal(superseded, true);
  assert.equal((await f.slots.inspect()).selection?.active.identity?.bootId, f.old.bootId);
  assert.equal((await f.slots.inspect()).selection?.epoch, 1);
});

test("slot reconstruction with only retired pools preserves denial through promotion", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.memberships.retire("pool", Date.now());
  const slots = f.reconstruct();
  await slots.stage(f.candidate);
  const receipt = await slots.promote(await f.intent());
  assert.equal(receipt.status, "promoted");
  assert.deepEqual(receipt.policies, [{ pool: "pool", organization: "organization", revision: 2 }]);
  assert.equal(f.policies.get(f.candidate.instanceId)?.get("pool")?.dirty, true);
  await assert.rejects(f.memberships.authority("pool"), /refreshing/);
});
