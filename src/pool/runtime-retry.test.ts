import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardRecoverably, runtimeAdmissionWaitMs } from "./runtime-fleet/retry.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { FleetRefused } from "./runtime-fleet/state.ts";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { rememberRuntimeFailure, retainRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { runtimeErrorResponse } from "./runtime-slots/request-error.ts";

// The endpoint refuses the controller's /health with 409 runtime-refused and the slot driver
// retains that refusal, as router.ts does through BoundSlotDriver.health.
function endpointRefused(cause: Error) {
  rememberRuntimeFailure("endpoint_health", cause);
  const refused = runtimeErrorResponse(cause, "endpoint");
  assert.equal(refused.status, 409);
  const error = retainRuntimeFailure(refused, new SlotRefused("uncertain"));
  rememberRuntimeFailure("slot_health", error);
  return error;
}
// 21:23Z, 21:38Z, 21:42Z: the container's readiness answers fast and says unhealthy (503).
const readinessUnhealthy = () => endpointRefused(new PoolRuntimeUnhealthy());
// 20:47Z: the container's readiness answers after the endpoint's deadline.
const readinessTimedOut = () =>
  endpointRefused(new DOMException("Runtime health deadline exceeded", "TimeoutError"));
// What selected recovery throws when its witness says the container is still running.
const stillRunning = async () => {
  throw new SlotRefused("uncertain");
};
function fakeTiming(onPause: (count: number) => void = () => {}) {
  const clock = { now: 0, pauses: [] as number[] };
  return {
    clock,
    timing: {
      now: () => clock.now,
      pause: async (milliseconds: number) => {
        clock.pauses.push(milliseconds);
        onPause(clock.pauses.length);
        clock.now += milliseconds;
      },
    },
  };
}
const modelRequest = (signal?: AbortSignal) =>
  new Request("http://pool/v1/responses", {
    method: "POST",
    body: "payload",
    ...(signal ? { signal } : {}),
  });

test("a healthy accepted model request retains its caller deadline while waiting for headers", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(),
    headers = deferred();
  let finished = false;
  const response = forwardRecoverably(
    new Request("http://pool/v1/responses", { method: "POST", body: "payload" }),
    async (_request, dispatch) => {
      dispatch();
      entered.resolve();
      await headers.promise;
      return new Response("healthy");
    },
    () => {},
  ).then((value) => {
    finished = true;
    return value;
  });
  await entered.promise;
  context.mock.timers.tick(201_000);
  await Promise.resolve();
  assert.equal(finished, false);
  headers.resolve();
  assert.equal(await (await response).text(), "healthy");
});

test("a successful dispatched upload keeps transport ownership after headers", async () => {
  let accepted!: Request;
  const response = await forwardRecoverably(
    new Request("http://pool/v1/responses", { method: "POST", body: "upload" }),
    async (request, dispatch) => {
      accepted = request;
      dispatch();
      return new Response("headers");
    },
    () => {},
  );
  assert.equal(response.status, 200);
  assert.equal(await accepted.text(), "upload");
});

test("an undispatched retry closes its failed upload branch and preserves the next upload", async () => {
  let calls = 0,
    first!: Request;
  const response = await forwardRecoverably(
    new Request("http://pool/v1/responses", { method: "POST", body: "upload" }),
    async (request, dispatch) => {
      if (++calls === 1) {
        first = request;
        throw new SlotRefused("unhealthy");
      }
      dispatch();
      return new Response(await request.text());
    },
    () => {},
  );
  assert.equal(await response.text(), "upload");
  assert.equal((await first.body!.getReader().read()).done, true);
});

test("capacity refusal closes both retained upload branches", async () => {
  const cancelled = deferred();
  const body = new ReadableStream({
    cancel() {
      cancelled.resolve();
    },
  });
  const init = { method: "POST", body, duplex: "half" };
  const response = await forwardRecoverably(
    new Request("http://pool/v1/responses", init),
    async () => {
      throw new FleetRefused("capacity");
    },
    () => {},
  );
  assert.equal(response.status, 503);
  await cancelled.promise;
});

for (const [episode, lapseMs, refusal] of [
  ["21:23Z readiness says unhealthy for 3.5 s", 3_500, readinessUnhealthy],
  ["20:47Z readiness answers late for 17 s", 17_000, readinessTimedOut],
] as const)
  test(`a serving runtime keeps the request until it admits again: ${episode}`, async (context) => {
    const declined = context.mock.method(console, "warn", () => {});
    const { clock, timing } = fakeTiming();
    let attempts = 0,
      dispatched = 0,
      recoveries = 0;
    const response = await forwardRecoverably(
      modelRequest(),
      async (request, dispatch) => {
        attempts++;
        if (clock.now < lapseMs) throw refusal();
        dispatch();
        return new Response(await request.text());
      },
      () => dispatched++,
      () => {
        recoveries++;
        return stillRunning();
      },
      timing,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "payload");
    assert.equal(dispatched, 1);
    assert.equal(
      recoveries,
      1,
      "one shared recovery attempt, and its refusal is not the request's",
    );
    assert.equal(declined.mock.callCount(), 1);
    assert.equal(declined.mock.calls[0]!.arguments[0], "POOL_RUNTIME_RECOVERY_DECLINED");
    assert.equal(declined.mock.calls[0]!.arguments[1].runtimeReason, "slot_uncertain");
    assert.ok(clock.now >= lapseMs && clock.now < runtimeAdmissionWaitMs);
    assert.ok(clock.pauses.every((pause) => pause > 0 && pause <= 1_000));
    assert.ok(attempts > (lapseMs > 5_000 ? 6 : 3), "a lapse does not spend the fixed budget");
  });

test("a stopped container waits for the recovery that restarts it", async () => {
  const { clock, timing } = fakeTiming();
  let restarted = false,
    recoveries = 0;
  const response = await forwardRecoverably(
    modelRequest(),
    async (request, dispatch) => {
      if (!restarted) {
        // channel.health refuses a stopped container before reading readiness.
        const stopped = new SlotRefused("unhealthy");
        rememberRuntimeFailure("endpoint_identity", stopped);
        throw stopped;
      }
      dispatch();
      return new Response(await request.text());
    },
    () => {},
    async () => {
      recoveries++;
      restarted = true;
    },
    timing,
  );
  assert.equal(await response.text(), "payload");
  assert.equal(recoveries, 1);
  assert.ok(clock.now < 2_000, "recovery starts after the fifth failure, within two seconds");
});

test("an endpoint that does not answer keeps the unpaced six-attempt budget", async () => {
  const { clock, timing } = fakeTiming();
  let attempts = 0;
  const response = await forwardRecoverably(
    modelRequest(),
    async () => {
      attempts++;
      const silent = new DOMException("The operation timed out", "TimeoutError");
      rememberRuntimeFailure("slot_health", silent);
      throw silent;
    },
    () => assert.fail("an unanswered request must not be sent"),
    async () => {},
    timing,
  );
  assert.equal(response.status, 503);
  assert.equal(attempts, 6);
  assert.deepEqual(clock.pauses, []);
});

test("a runtime that never admits again is refused with a retryable 503 once the wait is spent", async () => {
  const { clock, timing } = fakeTiming();
  let dispatched = 0;
  const response = await forwardRecoverably(
    modelRequest(),
    async () => {
      throw readinessUnhealthy();
    },
    () => dispatched++,
    async () => {},
    timing,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(dispatched, 0);
  assert.ok(clock.now >= runtimeAdmissionWaitMs && clock.now <= runtimeAdmissionWaitMs + 1_000);
});

test("a fenced or deselected runtime is refused at once without waiting", async () => {
  const { clock, timing } = fakeTiming();
  const fenced = new SlotRefused("selection");
  rememberRuntimeFailure("slot_selection", fenced);
  let attempts = 0;
  await assert.rejects(
    forwardRecoverably(
      modelRequest(),
      async () => {
        attempts++;
        throw fenced;
      },
      () => assert.fail("a fenced runtime must not receive the request"),
      stillRunning,
      timing,
    ),
    (error) => error === fenced,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(clock.pauses, []);
});

test("a replaced boot keeps its bounded retries and never waits on the old one", async () => {
  const { clock, timing } = fakeTiming();
  let attempts = 0,
    recoveries = 0;
  const response = await forwardRecoverably(
    modelRequest(),
    async () => {
      attempts++;
      const replaced = new SlotRefused("identity");
      rememberRuntimeFailure("endpoint_identity", replaced);
      throw replaced;
    },
    () => assert.fail("a replaced runtime must not receive the request"),
    async () => {
      recoveries++;
    },
    timing,
  );
  assert.equal(response.status, 503);
  assert.equal(attempts, 6);
  assert.equal(recoveries, 1);
  assert.deepEqual(clock.pauses, []);
});

test("a caller that leaves during the wait ends it", async () => {
  const client = new AbortController();
  const { clock, timing } = fakeTiming((count) => {
    if (count === 3) client.abort(new DOMException("client left", "AbortError"));
  });
  let attempts = 0;
  await assert.rejects(
    forwardRecoverably(
      modelRequest(client.signal),
      async () => {
        attempts++;
        throw readinessUnhealthy();
      },
      () => assert.fail("an abandoned request must not be sent"),
      stillRunning,
      timing,
    ),
  );
  assert.equal(client.signal.aborted, true);
  assert.equal(attempts, 3);
  assert.equal(clock.pauses.length, 3);
});
