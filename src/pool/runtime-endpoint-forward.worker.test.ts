import assert from "node:assert/strict";
import { test } from "node:test";

for (const failure of ["throw", "refusal"] as const)
  test(`production forwarding joins the endpoint failure ID: ${failure}`, async (context) => {
    const log = context.mock.method(console, "error", () => {});
    const workerModule = "./forward.worker.ts";
    const {
      forwardPoolRequest,
    }: {
      forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
    } = await import(workerModule);
    const { BoundSlotDriver } = await import("./runtime-slots/transport.ts");
    const { slotIdentity } = await import("../../scripts/pool-tests/runtime-slots-fixture.ts");
    const { refuseRuntime } = await import("./runtime-route-diagnostic.ts");
    const driver = new BoundSlotDriver(() => ({
      fetch: async () => {
        if (failure === "throw") throw new Error("private-endpoint-error");
        return new Response("private-refusal-body", {
          status: 409,
          headers: {
            "X-Signalbox-Runtime-Failure-Step": "endpoint_health",
            "X-Signalbox-Runtime-Failure-Reason": "transport",
          },
        });
      },
    }));
    const background: Promise<unknown>[] = [];
    const response = await forwardPoolRequest(new Request("http://pool/v1/models"), 8317, {
      env: { POOL_APP_SIGNING_KEY: "synthetic" },
      memberships: { configured: async () => false },
      route: async () => {
        try {
          await driver.health(slotIdentity("primary"), AbortSignal.timeout(2000));
        } catch (error) {
          refuseRuntime("slot_health", error);
        }
        throw new Error("expected health refusal");
      },
      defer: (work: Promise<unknown>) => background.push(work),
    });
    assert.equal(response.status, 503);
    const endpoint = JSON.parse(
      log.mock.calls.find((call) => call.arguments[0] === "POOL_RUNTIME_ENDPOINT_FAILURE")!
        .arguments[1],
    );
    const gateway = log.mock.calls.find((call) => call.arguments[0] === "POOL_GATEWAY_FAILURE")!
      .arguments[1];
    assert.equal(response.headers.get("X-Request-Id"), endpoint.requestId);
    assert.equal(gateway.requestId, endpoint.requestId);
    assert.doesNotMatch(JSON.stringify(log.mock.calls.map((call) => call.arguments)), /private-/);
    await response.body?.cancel();
    await Promise.all(background);
  });
