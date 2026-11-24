import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardRecoverably, runtimeAdmissionWaitMs } from "./runtime-fleet/retry.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { FleetRefused } from "./runtime-fleet/state.ts";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { ProtectionRefusal } from "./runtime-protection.ts";
import { rememberRuntimeFailure, retainRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { remoteRuntimeDefect, runtimeErrorResponse } from "./runtime-slots/request-error.ts";
import { restartStartBoundMs } from "./runtime-slots/forced-restart-timing.ts";
import { runtimeRecoveryBudgetMs } from "./runtime-slots/recovery.ts";

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
// 22:02Z, 22:05Z: readiness answered healthy, but the lease it granted ran out before the router
// admitted the request (RuntimeProtection.admit refuses a lease with under 250 ms left).
const leaseRanOut = (reason: "lease_expired" | "lease_too_short") => () => {
  const refusal = new ProtectionRefusal(reason);
  rememberRuntimeFailure("slot_protection", refusal);
  return refusal;
};
// 20:47Z: the container's readiness answers after the endpoint's deadline.
const readinessTimedOut = () =>
  endpointRefused(new DOMException("Runtime health deadline exceeded", "TimeoutError"));
// The root's restart, as a call's health read sees it through the endpoint: the selected boot's
// record is gone while the new boot starts, or the restart's start found no container to give it.
function restartRefused(cause: Error, step: "endpoint_identity" | "endpoint_route") {
  if (step === "endpoint_identity") rememberRuntimeFailure(step, cause);
  const refused = runtimeErrorResponse(cause, "endpoint");
  const error = retainRuntimeFailure(
    refused,
    remoteRuntimeDefect(refused) ?? new SlotRefused("uncertain"),
  );
  rememberRuntimeFailure("slot_health", error);
  return error;
}
const recordReplaced = () => restartRefused(new SlotRefused("identity"), "endpoint_identity");
const noContainer = () =>
  restartRefused(new Error("synthetic: no container instance"), "endpoint_route");
// channel.health refuses a stopped container before reading readiness.
const containerStopped = () => {
  const stopped = new SlotRefused("unhealthy");
  rememberRuntimeFailure("endpoint_identity", stopped);
  return stopped;
};
/** A root recovery detected `detectedAt` into the clock, as the controller reports what is left of it. */
const recovering =
  (clock: { now: number }, detectedAt = 0) =>
  async () =>
    Math.max(0, detectedAt + restartStartBoundMs - clock.now);
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
  ["22:02Z a healthy read granted a lease too short to admit", 600, leaseRanOut("lease_too_short")],
  ["22:05Z a healthy read's lease expired before admission", 600, leaseRanOut("lease_expired")],
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
      { timing },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "payload");
    assert.equal(dispatched, 1);
    // Recovery joins after the fifth failure; a sub-second lapse is served before it is needed.
    const expected = attempts > 5 ? 1 : 0;
    assert.equal(recoveries, expected, "one shared recovery attempt, never the request's refusal");
    assert.equal(declined.mock.callCount(), expected);
    for (const call of declined.mock.calls) {
      assert.equal(call.arguments[0], "POOL_RUNTIME_RECOVERY_DECLINED");
      assert.equal(call.arguments[1].runtimeReason, "slot_uncertain");
    }
    assert.ok(clock.now >= lapseMs && clock.now < runtimeAdmissionWaitMs);
    assert.ok(clock.pauses.every((pause) => pause > 0 && pause <= 1_000));
    assert.ok(attempts > (lapseMs > 5_000 ? 6 : 2), "a lapse does not spend the fixed budget");
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
    { timing },
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
    { timing },
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
    { timing },
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
      { timing },
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
    { timing },
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
      { timing },
    ),
  );
  assert.equal(client.signal.aborted, true);
  assert.equal(attempts, 3);
  assert.equal(clock.pauses.length, 3);
});

test("a call held for the root's restart waits through everything the restart refuses, paced, and is served", async (context) => {
  context.mock.method(console, "error", () => {});
  const { clock, timing } = fakeTiming();
  const refusals = [containerStopped, recordReplaced, noContainer];
  let attempts = 0,
    dispatched = 0,
    recoveries = 0;
  const response = await forwardRecoverably(
    modelRequest(),
    async (request, dispatch) => {
      if (clock.now < 50_000) throw refusals[attempts++ % refusals.length]!();
      dispatch();
      return new Response(await request.text());
    },
    () => dispatched++,
    // A pass that never returns: a held call that awaited one would never be served.
    () => {
      recoveries++;
      return new Promise<void>(() => {});
    },
    { timing, rootHoldMs: recovering(clock) },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "payload");
  assert.equal(dispatched, 1);
  assert.equal(recoveries, 1, "a hold kicks the recovery once and never waits on it");
  assert.ok(clock.now >= 50_000 && clock.now < 51_000, `served at ${clock.now}`);
  assert.ok(
    clock.pauses.every((pause) => pause > 0 && pause <= 1_000),
    "paced like admission",
  );
  assert.ok(attempts <= 55, `${attempts} attempts in 50 s: about one a second`);
});

for (const [refusal, detectedAt] of [
  [recordReplaced, 0],
  [containerStopped, 0],
  [recordReplaced, -100_000],
] as const)
  test(
    `a recovery that never completes ends a call held ${-detectedAt / 1_000} s into it with the retryable 503 at its bound: ${refusal.name}`,
    { timeout: 10_000 },
    async () => {
      const { clock, timing } = fakeTiming();
      const response = await forwardRecoverably(
        modelRequest(),
        async () => {
          throw refusal();
        },
        () => assert.fail("a held call is never sent"),
        // A recovery pass that never returns never stretches the hold.
        () => new Promise<void>(() => {}),
        { timing, rootHoldMs: recovering(clock, detectedAt) },
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("Retry-After"), "1");
      const bound = detectedAt + restartStartBoundMs;
      assert.ok(clock.now >= bound && clock.now <= bound + 1_000, `ended at ${clock.now}`);
    },
  );

test("a start that found no container is waited on only while the root's recovery holds", async (context) => {
  context.mock.method(console, "error", () => {});
  const { clock, timing } = fakeTiming();
  let attempts = 0;
  const response = await forwardRecoverably(
    modelRequest(),
    async (request, dispatch) => {
      if (++attempts < 4) throw noContainer();
      dispatch();
      return new Response(await request.text());
    },
    () => {},
    async () => {},
    { timing, rootHoldMs: recovering(clock) },
  );
  assert.equal(await response.text(), "payload");
  assert.equal(attempts, 4);
  attempts = 0;
  await assert.rejects(
    forwardRecoverably(
      modelRequest(),
      async () => {
        attempts++;
        throw noContainer();
      },
      () => {},
      async () => {},
      { timing, rootHoldMs: async () => 0 },
    ),
  );
  assert.equal(attempts, 1, "a defect with no recovery in progress still ends the call at once");
});

test("with no recovery in progress, a restart-shaped refusal keeps today's six and a stopped container today's 30 s", async () => {
  for (const rootHoldMs of [undefined, async () => 0]) {
    const replaced = fakeTiming();
    let attempts = 0,
      recoveries = 0;
    const refused = await forwardRecoverably(
      modelRequest(),
      async () => {
        attempts++;
        throw recordReplaced();
      },
      () => assert.fail("a refused call is never sent"),
      async () => {
        recoveries++;
      },
      { timing: replaced.timing, ...(rootHoldMs ? { rootHoldMs } : {}) },
    );
    assert.equal(refused.status, 503);
    assert.equal(attempts, 6);
    assert.equal(recoveries, 1);
    assert.deepEqual(replaced.clock.pauses, []);
    const stopped = fakeTiming();
    const waited = await forwardRecoverably(
      modelRequest(),
      async () => {
        throw containerStopped();
      },
      () => assert.fail("a refused call is never sent"),
      async () => {},
      { timing: stopped.timing, ...(rootHoldMs ? { rootHoldMs } : {}) },
    );
    assert.equal(waited.status, 503);
    assert.ok(
      stopped.clock.now >= runtimeAdmissionWaitMs &&
        stopped.clock.now <= runtimeAdmissionWaitMs + 1_000,
    );
  }
});

test("a caller that leaves during a hold ends it at once", async () => {
  const client = new AbortController();
  const { clock, timing } = fakeTiming((count) => {
    if (count === 40) client.abort(new DOMException("client left", "AbortError"));
  });
  let attempts = 0;
  await assert.rejects(
    forwardRecoverably(
      modelRequest(client.signal),
      async () => {
        attempts++;
        throw recordReplaced();
      },
      () => assert.fail("an abandoned request must not be sent"),
      async () => {},
      { timing, rootHoldMs: recovering(clock) },
    ),
  );
  assert.equal(attempts, 40);
  assert.ok(clock.now < restartStartBoundMs);
});

test("the request's own deadline never ends a call held inside the recovery's bound", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const timing = {
    now: () => Date.now(),
    pause: (milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  // Past the request's 200 s recovery deadline, still inside the restart's 240 s start bound.
  const servedAt = runtimeRecoveryBudgetMs + 20_000;
  assert.ok(servedAt < restartStartBoundMs);
  let settled = false;
  const pending = forwardRecoverably(
    modelRequest(),
    async (request, dispatch) => {
      if (Date.now() < servedAt) throw recordReplaced();
      dispatch();
      return new Response(await request.text());
    },
    () => {},
    async () => {},
    { timing, rootHoldMs: async () => Math.max(0, restartStartBoundMs - Date.now()) },
  ).finally(() => {
    settled = true;
  });
  for (let step = 0; !settled && step < 4_000; step++) {
    context.mock.timers.tick(100);
    await new Promise(setImmediate);
  }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "payload");
  assert.ok(Date.now() >= servedAt);
});

for (const [method, path, status, retry, upgrade] of [
  ["POST", "/v1/messages", 503, true, false],
  ["POST", "/v1/responses", 503, true, false],
  ["POST", "/v1/responses", 503, true, true],
  ["GET", "/v1/videos/video_1", 503, true, false],
  ["POST", "/v1/images/generations", 502, false, false],
  ["POST", "/v1/images/generations", 502, false, true],
  ["POST", "/v1/videos", 502, false, false],
] as const)
  test(`a runtime crash after ${method} ${path}${upgrade ? " with an upgrade header" : ""} was accepted ${retry ? "asks for a retry" : "keeps the cautious answer"}`, async () => {
    let sends = 0;
    const response = await forwardRecoverably(
      new Request(`http://pool${path}`, {
        method,
        ...(method === "POST" ? { body: "{}" } : {}),
        ...(upgrade ? { headers: { Upgrade: "websocket" } } : {}),
      }),
      async (_request, dispatch) => {
        sends++;
        dispatch();
        throw new Error("synthetic accepted runtime crash");
      },
      () => {},
    );
    assert.equal(sends, 1);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-should-retry"), retry ? null : "false");
    assert.equal(response.headers.get("retry-after"), retry ? "1" : null);
    // The step and reason join the client's request id to the endpoint trace either way.
    assert.equal(response.headers.get("X-Signalbox-Runtime-Failure-Step"), "fleet_forward");
    assert.ok(response.headers.get("X-Signalbox-Runtime-Failure-Reason"));
    const body = await response.json();
    if (!retry) {
      assert.equal(body.error.retryable, false);
      assert.match(body.error.message, /outcome is unknown/);
    }
  });
