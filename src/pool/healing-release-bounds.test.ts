import assert from "node:assert/strict";
import { test } from "node:test";
import * as timing from "./runtime-slots/forced-restart-timing.ts";
import { readinessCommandSeconds, readinessWaitMs } from "./readiness-budget.ts";

test("a healing release's two bounds follow every part they are made of", () => {
  // Recomputed from the parts, so a part that grows while a bound stays put fails here.
  const heldStreamsHeal =
    timing.recoveryPassMs +
    Math.max(timing.unservingBoundMs, timing.leakedStreamsMs) +
    timing.recoveryWarmMs +
    2 * timing.readinessReadMs +
    timing.forcedStopGraceMs +
    2 * timing.exitConfirmationMs +
    timing.providerReadAllowanceMs +
    timing.runtimeStartupMs +
    timing.restartTailAllowanceMs +
    timing.recoveryPassMs;
  const acceptance = heldStreamsHeal + timing.destroyAndMembershipMs;
  const readiness = timing.controllerAdoptionMs + acceptance;
  assert.equal(timing.healingAcceptanceWithinMs, acceptance);
  assert.equal(timing.healingReadinessWithinMs, readiness);
  assert.equal(readinessWaitMs, readiness);
  assert.equal(readinessCommandSeconds * 1_000, readiness + 5_000);
  // The numbers the release notes state.
  assert.deepEqual([acceptance, readiness, readinessCommandSeconds], [658_000, 988_000, 993]);
});
