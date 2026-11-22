import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";

test(
  "a native retry reply joins the actual sibling endpoint failure and public route log",
  { timeout: 15_000 },
  async (context) => {
    const errors = context.mock.method(console, "error", () => {});
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "native-trace",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    const initial = await f.model();
    await initial.body?.cancel();
    await f.settle();
    const [sibling] = await f.resourcesWhen((rows) => rows.some((row) => row.phase === "ready"));
    assert.ok(sibling);
    let calls = 0;
    // A ready sibling takes the call, never the root.
    f.onModel(async (instance) => {
      assert.notEqual(instance, f.old);
      calls++;
      instance.crash();
      throw new Error("private-transport-exception");
    });
    const response = await f.model(
      new Request("http://pool/v1/responses", { method: "POST", body: "private-request-body" }),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "1");
    const requestId = response.headers.get("X-Request-Id");
    assert.ok(requestId);
    const endpoints = errors.mock.calls
      .filter((call) => call.arguments[0] === "POOL_RUNTIME_ENDPOINT_FAILURE")
      .map((call) => JSON.parse(call.arguments[1]));
    assert.ok(
      endpoints.some((endpoint) => endpoint.path === "other" && endpoint.requestId === requestId),
    );
    assert.equal(
      errors.mock.calls.filter((call) => call.arguments[0] === "POOL_RUNTIME_ROUTE_FAILURE").at(-1)!
        .arguments[1].requestId,
      requestId,
    );
    assert.equal(response.headers.get("X-Signalbox-Runtime-Failure-Step"), null);
    assert.equal((await response.json()).error.type, "server_error");
    assert.equal(calls, 1);
    assert.doesNotMatch(
      JSON.stringify(errors.mock.calls.map((call) => call.arguments)),
      /private-/,
    );
  },
);
