import assert from "node:assert/strict";
import { test } from "node:test";
import { slotFixture } from "../../scripts/pool-tests/runtime-slots-fixture.ts";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { membershipTtlMs } from "./membership-contract.ts";
import type { MembershipState } from "./membership-state.ts";
import { nativeMembershipKey } from "./runtime-slots/storage.ts";

// A pool without native registration or Home references stays dirty with no accounts.
const unready = (expiresAt = Date.now() + membershipTtlMs): Record<string, MembershipState> => ({
  "unready-pool": {
    pool: "unready-pool",
    organization: "other-organization",
    revision: 5,
    accounts: [],
    dirty: true,
    expiresAt,
    native: false,
    checkedAt: Date.now(),
    installedRevision: 5,
    installedUntil: expiresAt,
  },
});

test("a pool that is not ready does not block adopting the running runtime", async (context) => {
  const f = await slotFixture({ memberships: unready() });
  context.after(f.cleanup);
  assert.ok((await f.storage.inspect()).selection, "adoption commits a selection");
  assert.equal(f.policies.get(f.old.instanceId)?.get("unready-pool")?.dirty, true);
  const reader = (await f.forward()).body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value).trim(), f.old.bootId);
  await reader.cancel();
});

test("the not-ready pool's own traffic stays refused after adoption", async (context) => {
  const f = await slotFixture({ memberships: unready() });
  context.after(f.cleanup);
  await assert.rejects(
    f.forward(
      async (signal) => new Request("http://private/v1/responses", { signal }),
      "unready-pool",
    ),
    /refused: policy/,
  );
});

test("an expired dirty veto is installed with a fresh lease and does not block adoption", async (context) => {
  const f = await slotFixture({ memberships: unready(Date.now() - 2 * membershipTtlMs) });
  context.after(f.cleanup);
  assert.ok((await f.storage.inspect()).selection);
  const installed = f.policies.get(f.old.instanceId)?.get("unready-pool");
  assert.equal(installed?.dirty, true);
  assert.ok(installed!.expiresAt > Date.now());
});

test("an expired clean policy still refuses the runtime proof", async () => {
  const expired = Date.now() - 2 * membershipTtlMs;
  const row = unready(expired)["unready-pool"]!;
  await assert.rejects(
    slotFixture({
      memberships: {
        "expired-pool": {
          ...row,
          pool: "expired-pool",
          accounts: ["account"],
          dirty: false,
          native: true,
        },
      },
    }).then((f) => f.cleanup()),
    /refused: policy/,
  );
});

test("a pool that is not ready does not block staging and promoting a candidate", async (context) => {
  const f = await slotFixture({ memberships: unready() });
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  assert.equal((await f.slots.promote(await f.intent())).status, "promoted");
  assert.equal(f.policies.get(f.candidate.instanceId)?.get("unready-pool")?.dirty, true);
});

test(
  "a pool that is not ready does not block recovering the selected runtime",
  { timeout: 10_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    const rows = (await f.old.storage.get<Record<string, MembershipState>>(nativeMembershipKey))!;
    await f.old.storage.put(nativeMembershipKey, { ...rows, ...unready() });
    f.old.crash();
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.calls.start, 1);
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.ok(f.old.calls.install.some((policy) => policy.pool === "unready-pool" && policy.dirty));
  },
);
