import assert from "node:assert/strict";
import { test } from "node:test";
import { stoppedFixture } from "../../scripts/pool-tests/stopped-fixture.ts";
import { decodeStoppedApproval } from "./stopped-approval.ts";
import { handleStoppedRecovery } from "./stopped-handler.ts";
import { decodeRecoveryApproval, runtimeRecoveryPrefix } from "./recovery-approval.ts";
import { signEnvelope } from "./token.ts";

test("the new action is signed, target-bound, and refused by the old recovery decoder", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  const key = "a".repeat(64);
  const envelope = await signEnvelope(key, runtimeRecoveryPrefix, approval);
  assert.deepEqual(await decodeStoppedApproval(key, envelope, approval.at), approval);
  await assert.rejects(decodeStoppedApproval("b".repeat(64), envelope, approval.at));
  await assert.rejects(decodeRecoveryApproval(key, envelope, approval.at));
});

test("stopped evidence rejects stale samples, gaps, different targets and every other failure class", async () => {
  const f = await stoppedFixture();
  const valid = await f.approval();
  for (const approval of [
    {
      ...valid,
      samples: valid.samples.map((s, i) => ({ ...s, at: s.at - (i === 2 ? 31_000 : 0) })),
    },
    { ...valid, samples: valid.samples.map((s, i) => ({ ...s, at: s.at - (i === 1 ? 1 : 0) })) },
    {
      ...valid,
      samples: valid.samples.map((s, i) => ({
        ...s,
        selection: i === 0 ? "f".repeat(64) : s.selection,
      })),
    },
    ...(["policy-invalid", "unready", "unknown"] as const).map((condition) => ({
      ...valid,
      samples: valid.samples.map((s, i) => (i === 0 ? { ...s, condition } : s)),
    })),
    { ...valid, expiresAt: valid.at + 60_001 },
    { ...valid, generation: valid.generation + 1 },
  ]) {
    await assert.rejects(f.construct().run(approval));
    assert.equal(f.state().starts, 1);
  }
});

test("stopped observations must be fresh, exact and unambiguous at the controller", async () => {
  for (const change of [
    { state: "unknown" },
    { state: "running" },
    { observedAt: 0 },
    { generation: 99 },
  ]) {
    const f = await stoppedFixture();
    const observe = f.deps.observeStopped;
    f.deps.observeStopped = async () => ({ ...(await observe()), ...change });
    await assert.rejects(f.construct().run(await f.approval()), /observation-mismatch/);
    assert.equal(f.state().starts, 1);
  }
});

test("private handler refuses tampering without logging tokens or entering the lifecycle", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  // Its synthetic clock deliberately differs from the handler's real clock; use a fresh signed timestamp.
  const value = { ...approval, at: Date.now(), expiresAt: Date.now() + 60_000 };
  const envelope = await signEnvelope("a".repeat(64), runtimeRecoveryPrefix, value);
  const response = await handleStoppedRecovery(
    new Request("https://private.invalid/recovery", {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    f.construct(),
    "b".repeat(64),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "stopped_recovery_refused",
    reason: "unavailable",
  });
  assert.equal(f.state().starts, 1);
});
