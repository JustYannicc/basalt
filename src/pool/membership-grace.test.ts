import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import { modelMembership } from "./model-membership.ts";
import { membershipTtlMs, policyHeader, policyUsePrefix } from "./membership-contract.ts";
import { openEnvelope } from "./token.ts";
import {
  membershipGraceFixture as fixture,
  membershipSigningKey as key,
} from "../../scripts/pool-tests/membership-grace-fixture.ts";

const graceMs = 24 * 60 * 60_000;

for (const fault of ["install400", "read", "reconcile"] as const)
  test(`${fault} keeps the last acknowledged model policy through a two-hour outage, never beyond 24-hour grace`, async () => {
    const f = fixture();
    const memberships = new NativeMemberships(f.dependencies);
    await memberships.ensure("pool", "organization");
    const accepted = await memberships.authority("pool");
    assert.ok(accepted);
    f.fault(fault);
    f.advance(membershipTtlMs + 2 * 60 * 60_000);
    await memberships.ensure("pool", "organization");
    assert.deepEqual(await memberships.authority("pool"), accepted);
    const gate = await modelMembership(
      new Request("https://pool.invalid/v1/models"),
      memberships,
      key,
      undefined,
      f.streams,
      { pool: "pool", person: "person" },
    );
    const assertion = await openEnvelope(
      key,
      policyUsePrefix,
      gate.request.headers.get(policyHeader)!,
    );
    assert.equal((assertion as { revision: number }).revision, accepted.revision);
    assert.deepEqual(f.installed()?.accounts, ["saved-account"]);
    f.advance(graceMs - 2 * 60 * 60_000 - 1);
    await memberships.tick();
    assert.deepEqual(await memberships.authority("pool"), accepted);
    f.advance(1);
    await assert.rejects(memberships.ensure("pool", "organization"));
    await assert.rejects(memberships.authority("pool"), /refreshing/);
    await assert.rejects(
      modelMembership(
        new Request("https://pool.invalid/v1/models"),
        memberships,
        key,
        undefined,
        f.streams,
        {
          pool: "pool",
          person: "person",
        },
      ),
      /unavailable/,
    );
    f.fault("none");
    await memberships.ensure("pool", "organization");
    assert.deepEqual((await memberships.authority("pool"))?.accounts, ["saved-account"]);
  });

test("a reservation durably revokes grace even if its dirty policy install returns 400", async () => {
  const f = fixture();
  let memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  f.fault("install400");
  f.advance(membershipTtlMs + 1);
  await memberships.ensure("pool", "organization");
  await assert.rejects(f.reserve(memberships));
  assert.equal(f.aborted.at(-1), "pool");
  await assert.rejects(memberships.authority("pool"), /refreshing/);
  memberships = new NativeMemberships(f.dependencies);
  await assert.rejects(memberships.authority("pool"), /refreshing/);
  await assert.rejects(memberships.ensure("pool", "organization"));
  f.select([]);
  f.fault("none");
  await memberships.ensure("pool", "organization");
  assert.deepEqual((await memberships.authority("pool"))?.accounts, []);
});

for (const change of ["removed", "replaced", "not-native"] as const)
  test(`observed ${change} membership cannot reuse grace when reconciliation or installation fails`, async () => {
    const f = fixture();
    const memberships = new NativeMemberships(f.dependencies);
    await memberships.ensure("pool", "organization");
    if (change === "not-native") f.native(false);
    else f.select(change === "removed" ? [] : ["replacement"]);
    f.fault(change === "not-native" ? "install400" : "reconcile");
    f.advance(membershipTtlMs + 1);
    await assert.rejects(memberships.ensure("pool", "organization"));
    assert.equal(f.aborted.at(-1), "pool");
    await assert.rejects(memberships.authority("pool"), /refreshing/);
  });

test("a failed first clean installation never creates last-known-good authority", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.dependencies);
  f.fault("install400");
  await assert.rejects(memberships.ensure("pool", "organization"));
  await assert.rejects(memberships.authority("pool"), /refreshing/);
});

test("actual Home membership drift aborts active use before a dirty installation fails with 400", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  const active = f.streams.acquire("computer", "pool", new AbortController().signal);
  const other = f.streams.acquire("other-computer", "other-pool", new AbortController().signal);
  let closed = 0;
  active.onClose(() => {
    closed++;
  });
  f.actual(["saved-account", "unexpected-account"]);
  f.fault("install400");
  f.advance(membershipTtlMs + 1);
  await assert.rejects(memberships.ensure("pool", "organization"));
  assert.equal(active.signal.aborted, true);
  assert.equal(closed, 1);
  assert.equal(other.signal.aborted, false);
  await assert.rejects(memberships.authority("pool"), /refreshing/);
  f.actual(undefined);
  f.fault("none");
  await memberships.ensure("pool", "organization");
  assert.deepEqual((await memberships.authority("pool"))?.accounts, ["saved-account"]);
  assert.equal(active.signal.aborted, true);
  other.release();
});

test("last acknowledged grace survives controller reactivation without extending its deadline", async () => {
  const f = fixture();
  let memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  const accepted = await memberships.authority("pool");
  f.fault("install400");
  f.advance(membershipTtlMs + graceMs - 1);
  memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  assert.deepEqual(await memberships.authority("pool"), accepted);
  f.advance(1);
  await assert.rejects(memberships.authority("pool"), /refreshing/);
});

test("retained records without a grace acknowledgement cannot gain grace during an outage", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  const name = "native-pool-memberships-v1";
  const retained =
    await f.dependencies.storage.get<Record<string, { installedGraceUntil?: number }>>(name);
  assert.ok(retained?.pool);
  delete retained.pool.installedGraceUntil;
  await f.dependencies.storage.put(name, retained);
  assert.ok(await memberships.authority("pool"));
  f.fault("install400");
  f.advance(membershipTtlMs);
  await assert.rejects(memberships.ensure("pool", "organization"));
  await assert.rejects(memberships.authority("pool"), /refreshing/);
});
