import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundSlotDriver } from "./runtime-slots/transport.ts";
import { slotIdentity } from "../../scripts/pool-tests/runtime-slots-fixture.ts";
import { runtimeFailureDiagnostic } from "./runtime-route-diagnostic.ts";

test("a private endpoint transport refusal throws with its closed cause while provider HTTP conflicts pass through", async () => {
  const identity = slotIdentity("candidate");
  let privateFailure = true,
    calls = 0;
  const driver = new BoundSlotDriver(() => ({
    fetch: async () => {
      calls++;
      return new Response("conflict", {
        status: 409,
        headers: privateFailure
          ? {
              "X-Signalbox-Runtime-Failure-Step": "port_dispatch",
              "X-Signalbox-Runtime-Failure-Reason": "transport",
            }
          : {},
      });
    },
  }));
  await assert.rejects(
    driver.fetch(identity, new Request("http://pool/v1/responses"), 8317),
    (error) => {
      assert.deepEqual(runtimeFailureDiagnostic(error, "fleet_forward"), {
        runtimeStep: "port_dispatch",
        runtimeReason: "transport",
      });
      return true;
    },
  );
  assert.equal(calls, 1);
  privateFailure = false;
  const response = await driver.fetch(identity, new Request("http://pool/v1/responses"), 8317);
  assert.equal(response.status, 409);
  assert.equal(await response.text(), "conflict");
  assert.equal(calls, 2);
});

for (const healthDelay of [10, 1_600])
  test(`cold startup gets a separate health lease while health transport still consumes it: ${healthDelay}ms`, async (context) => {
    let now = 0;
    context.mock.method(performance, "now", () => now);
    const identity = slotIdentity("candidate");
    const calls: string[] = [];
    const driver = new BoundSlotDriver(() => ({
      fetch: async (request) => {
        const action = new URL(request.url).pathname;
        calls.push(action);
        now += action === "/start" ? 10_000 : healthDelay;
        return Response.json({ identity, leaseMs: 1_500 });
      },
    }));
    const pending = driver.start(identity, new AbortController().signal);
    if (healthDelay >= 1_500) {
      await assert.rejects(pending, /unhealthy/);
    } else {
      const health = await pending;
      assert.deepEqual(health.identity, identity);
      assert.equal(health.policyLeaseUntil, 11_500);
      assert.ok(health.policyLeaseUntil > now);
    }
    assert.deepEqual(calls, ["/start", "/health"]);
  });

test("a lost start ACK never sends a health read or another start", async () => {
  const calls: string[] = [];
  const driver = new BoundSlotDriver(() => ({
    fetch: async (request) => {
      calls.push(new URL(request.url).pathname);
      throw new Error("Synthetic lost start ACK");
    },
  }));
  await assert.rejects(
    driver.start(slotIdentity("candidate"), new AbortController().signal),
    /lost start ACK/,
  );
  assert.deepEqual(calls, ["/start"]);
});

test("cancellation after the start ACK cannot dispatch the fresh health read", async (context) => {
  const cancelled = new AbortController();
  const calls: string[] = [];
  context.mock.method(performance, "now", () => 0);
  const identity = slotIdentity("candidate");
  const driver = new BoundSlotDriver(() => ({
    fetch: async (request) => {
      calls.push(new URL(request.url).pathname);
      cancelled.abort(new Error("Synthetic caller cancellation"));
      return Response.json({ identity, leaseMs: 1_500 });
    },
  }));
  await assert.rejects(driver.start(identity, cancelled.signal), /caller cancellation/);
  assert.deepEqual(calls, ["/start"]);
});

for (const mismatch of ["start-target", "health-boot"])
  test(`a cold start cannot replace the acknowledged runtime identity: ${mismatch}`, async (context) => {
    context.mock.method(performance, "now", () => 0);
    const identity = slotIdentity("candidate");
    const calls: string[] = [];
    const driver = new BoundSlotDriver(() => ({
      fetch: async (request) => {
        const action = new URL(request.url).pathname;
        calls.push(action);
        return Response.json({
          identity:
            mismatch === "start-target"
              ? slotIdentity("foreign")
              : action === "/health"
                ? { ...identity, bootId: "changed-boot" }
                : identity,
          leaseMs: 1_500,
        });
      },
    }));
    await assert.rejects(driver.start(identity, new AbortController().signal), /identity/);
    assert.deepEqual(calls, mismatch === "start-target" ? ["/start"] : ["/start", "/health"]);
  });

test("cancellation after fresh health completes cannot return a usable lease", async (context) => {
  context.mock.method(performance, "now", () => 0);
  const cancelled = new AbortController();
  const identity = slotIdentity("candidate");
  const calls: string[] = [];
  const driver = new BoundSlotDriver(() => ({
    fetch: async (request) => {
      const action = new URL(request.url).pathname;
      calls.push(action);
      const response = Response.json({ identity, leaseMs: 1_500 });
      if (action === "/health") {
        const read = response.json.bind(response);
        context.mock.method(response, "json", async () => {
          const body: unknown = await read();
          cancelled.abort(new Error("Synthetic cancellation after health completion"));
          return body;
        });
      }
      return response;
    },
  }));
  await assert.rejects(driver.start(identity, cancelled.signal), /after health completion/);
  assert.deepEqual(calls, ["/start", "/health"]);
});
