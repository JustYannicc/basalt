import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedState } from "./stage-fault.ts";

const identity = { slotId: "legacy", instanceId: "a".repeat(64), bootId: "boot-old" };
const stuck = {
  inspect: {
    selection: { epoch: 3, active: { fenced: false, identity } },
    policies: [{ pool: "pool-a", dirty: false, expiresAt: 1_000 }],
  },
  witness: { kind: "witness", witness: { operationId: "restart-abc" } },
  activeHealth: { status: 409, reason: "runtime_endpoint_identity_slot_identity" },
  running: true,
  at: 61_000,
};

test("production's stuck state reads as stuck, with no raw id in the report", () => {
  const state = confirmedState(stuck);
  assert.equal(state.stuck, true);
  assert.equal(state.policyCleanAndExpired, true);
  assert.equal(state.policies.longestExpiredMs, 60_000);
  const report = JSON.stringify(state);
  for (const raw of [identity.instanceId, identity.bootId, "restart-abc", "pool-a"])
    assert.ok(!report.includes(raw), `${raw} leaked`);
});

test("each missing condition clears the stuck verdict", () => {
  const variants = [
    { ...stuck, running: false },
    { ...stuck, witness: { witness: { operationId: "restart-abc", bootId: "boot-new" } } },
    { ...stuck, witness: { witness: { operationId: "stage-abc" } } },
    { ...stuck, activeHealth: { status: 200 } },
    {
      ...stuck,
      inspect: { ...stuck.inspect, selection: { epoch: 3, active: { fenced: true, identity } } },
    },
  ];
  for (const variant of variants) assert.equal(confirmedState(variant).stuck, false);
});
