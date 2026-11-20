import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { proofRefusedByRuntime } from "./runtime-slots/controller.ts";
import { runtimeErrorResponse } from "./runtime-slots/request-error.ts";
import { BoundSlotDriver } from "./runtime-slots/transport.ts";
import { slotIdentity } from "../../scripts/pool-tests/runtime-slots-fixture.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { PoolDependencyFailure } from "./dependency-failure.ts";
import { ControlFailure } from "./json.ts";

/** What the controller holds when the endpoint answers a health read by refusing with `error`. */
async function endpointRefusal(error: unknown) {
  const identity = slotIdentity("active");
  const driver = new BoundSlotDriver(() => ({
    fetch: async () => runtimeErrorResponse(error, "endpoint"),
  }));
  return driver.health(identity, AbortSignal.timeout(1_000)).then(
    () => assert.fail("the health read was refused"),
    (refusal: unknown) => refusal,
  );
}

test("unfence hands back only on the runtime's own refusal, as the endpoint sends it", async (context) => {
  context.mock.method(console, "error", () => {});
  // Each arrives as `uncertain`; its closed reason says whose refusal it was.
  for (const [name, error] of [
    ["the container isn't running", new SlotRefused("unhealthy")],
    ["readiness answers 503", new PoolRuntimeUnhealthy()],
    ["another boot answers", new SlotRefused("identity")],
    ["the policy plugin refuses", new ControlFailure(503, "backend_unavailable", "refused")],
    ["its membership port fails", new PoolDependencyFailure("membership", new Error("reset"))],
  ] as const) {
    const refusal = await endpointRefusal(error);
    assert.ok(refusal instanceof SlotRefused && refusal.reason === "uncertain", name);
    assert.equal(proofRefusedByRuntime(refusal), true, name);
  }
  // The endpoint's own state, or a defect: the operator gets the error and the fence holds.
  for (const [name, error] of [
    ["no deployment key or container binding", new SlotRefused("selection")],
    ["a policy refusal", new SlotRefused("policy")],
    ["a draining slot", new SlotRefused("draining")],
    ["its storage fails", new PoolDependencyFailure("storage", new Error("reset"))],
    ["its signing fails", new PoolDependencyFailure("signing", new Error("reset"))],
    ["a defect", new TypeError("a defect")],
  ] as const)
    assert.equal(proofRefusedByRuntime(await endpointRefusal(error)), false, name);
});

test("a local refusal hands back only when the runtime is late or not serving", () => {
  assert.equal(proofRefusedByRuntime(new DOMException("late", "TimeoutError")), true, "no answer");
  assert.equal(proofRefusedByRuntime(new SlotRefused("unhealthy")), true, "its lease ran out");
  for (const local of [
    new SlotRefused("policy"),
    new SlotRefused("selection"),
    new DOMException("gone", "AbortError"),
    new TypeError("a defect"),
    new Error("a defect"),
    "a string",
  ])
    assert.equal(proofRefusedByRuntime(local), false, String(local));
});
