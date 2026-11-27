import assert from "node:assert/strict";
import { test } from "node:test";
import { knownRuntimeFailureCode, runtimeResponseDiagnostic } from "./runtime-route-diagnostic.ts";

/** A refusal as a controller on newer code sends it: the closed step and reason headers. */
const refusal = (runtimeReason: string) =>
  new Response(null, {
    status: 409,
    headers: {
      "X-Signalbox-Runtime-Failure-Step": "endpoint_route",
      "X-Signalbox-Runtime-Failure-Reason": runtimeReason,
    },
  });

test("a refusal of the caller's controller code decodes as its own reason before any Worker writes it", () => {
  assert.deepEqual(runtimeResponseDiagnostic(refusal("slot_controller_code")), {
    runtimeStep: "endpoint_route",
    runtimeReason: "slot_controller_code",
  });
  assert.equal(knownRuntimeFailureCode("runtime_endpoint_route_slot_controller_code"), true);
  // The older reason a controller on code from before it still sends.
  assert.deepEqual(runtimeResponseDiagnostic(refusal("slot_identity")), {
    runtimeStep: "endpoint_route",
    runtimeReason: "slot_identity",
  });
});

test("a reason outside the closed vocabulary still decodes to no diagnostic", () => {
  assert.equal(runtimeResponseDiagnostic(refusal("slot_not_a_reason")), undefined);
  assert.equal(knownRuntimeFailureCode("runtime_endpoint_route_slot_not_a_reason"), false);
});
