import assert from "node:assert/strict";
import { test } from "node:test";
import { unservingDecision } from "./runtime-slots/unserving-clock.ts";
import { forcedRestartsPerHour, unservingBoundMs } from "./runtime-slots/forced-restart-timing.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { retainRuntimeFailure, runtimeFailureHeaders } from "./runtime-route-diagnostic.ts";
import { poolGuard } from "./guard-failure.ts";
import { poolFailureDiagnostic } from "./json.ts";

test("the clock stops a refusing runtime only after its bound, within its hourly limit", () => {
  const since = 1_000_000;
  const state = { since, restarts: [] };
  assert.equal(unservingDecision({ restarts: [] }, since), "wait", "nothing refused yet");
  assert.equal(unservingDecision(state, since + 30_000), "wait", "a 30 s blip is never stopped");
  assert.equal(unservingDecision(state, since + unservingBoundMs - 1), "wait");
  assert.equal(unservingDecision(state, since + unservingBoundMs), "stop");
  const now = since + unservingBoundMs;
  const restarts = Array.from({ length: forcedRestartsPerHour }, (_, index) => now - index * 1_000);
  assert.equal(unservingDecision({ since, restarts }, now), "restart_limit");
  assert.equal(
    unservingDecision({ since, restarts }, now + 3_600_000),
    "stop",
    "restarts older than an hour no longer count",
  );
  assert.equal(
    unservingDecision({ ...state, needsPerson: { at: now, reason: "stop_failed" } }, now),
    "needs_person",
  );
});

test("an install guard failure keeps the selected runtime's closed refusal code", async () => {
  const refusal = new SlotRefused("identity");
  const remote = retainRuntimeFailure(
    new Response(null, {
      status: 409,
      headers: runtimeFailureHeaders(refusal, "endpoint_identity"),
    }),
    new SlotRefused("uncertain"),
  );
  await assert.rejects(poolGuard("native_policy_install", () => Promise.reject(remote)));
  assert.deepEqual(poolFailureDiagnostic(remote), {
    guard: "native_policy_install",
    failure: "runtime_refused",
    runtime: "runtime_endpoint_identity_slot_identity",
  });
});
