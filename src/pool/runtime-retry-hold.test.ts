import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forwardRecoverably,
  markRootFallbackCap,
  runtimeAdmissionWaitMs,
} from "./runtime-fleet/retry.ts";
import { CodeHandover, HandoverCount, codeHandoverDrainMs } from "./code-handover.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { rememberRuntimeFailure, retainRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { runtimeErrorResponse } from "./runtime-slots/request-error.ts";
import { restartStartBoundMs } from "./runtime-slots/forced-restart-timing.ts";
import { rootFallbackPerSecond } from "./runtime-fleet/root-fallback.ts";

// What a call's health read sees through the endpoint, as runtime-retry.test.ts builds it.
function endpointRefused(cause: Error, step: "endpoint_identity" | "endpoint_health") {
  rememberRuntimeFailure(step, cause);
  const error = retainRuntimeFailure(
    runtimeErrorResponse(cause, "endpoint"),
    new SlotRefused("uncertain"),
  );
  rememberRuntimeFailure("slot_health", error);
  return error;
}
/** The restart: the selected boot's record is gone while the new boot starts. */
const recordReplaced = () => endpointRefused(new SlotRefused("identity"), "endpoint_identity");
/** A readiness lapse, a soft refusal the 30 s admission wait covers. */
const readinessUnhealthy = () => endpointRefused(new PoolRuntimeUnhealthy(), "endpoint_health");
const modelRequest = (signal?: AbortSignal) =>
  new Request("http://pool/v1/responses", {
    method: "POST",
    body: "payload",
    ...(signal ? { signal } : {}),
  });

/** One fake clock for every waiter: a sleeper wakes only once the clock reaches it. */
function scheduler() {
  let now = 0;
  const sleepers = new Set<{ at: number; wake(): void }>();
  const sleep = (milliseconds: number, signal?: AbortSignal) =>
    new Promise<void>((wake, reject) => {
      const sleeper = { at: now + milliseconds, wake };
      sleepers.add(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          sleepers.delete(sleeper);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  return {
    now: () => now,
    sleep,
    timing: { now: () => now, pause: sleep },
    /** Wakes sleepers in order until `done`; a clock that would pass `limit` fails the test. */
    async run(done: () => boolean, limit: number) {
      while (!done()) {
        for (let turn = 0; turn < 50; turn++) await new Promise(setImmediate);
        if (done()) return;
        const next = Math.min(...[...sleepers].map((sleeper) => sleeper.at));
        assert.ok(next <= limit, `nothing left to wake by ${limit} ms (at ${now} ms)`);
        now = next;
        for (const sleeper of sleepers)
          if (sleeper.at <= now) {
            sleepers.delete(sleeper);
            sleeper.wake();
          }
      }
    },
  };
}

test("a hold that ends before its bound leaves the call today's 30 s and its recovery from then on", async () => {
  // Held 60 s for the restart; the root then serves, and its new boot's readiness lapses.
  for (const servesAt of [75_000, undefined]) {
    let now = 0;
    const timing = {
      now: () => now,
      pause: async (milliseconds: number) => {
        now += milliseconds;
      },
    };
    const passes: number[] = [];
    const response = await forwardRecoverably(
      modelRequest(),
      async (request, dispatch) => {
        if (now < 60_000) throw recordReplaced();
        if (servesAt === undefined || now < servesAt) throw readinessUnhealthy();
        dispatch();
        return new Response(await request.text());
      },
      () => {},
      async () => {
        passes.push(now);
      },
      { timing, rootHoldMs: async () => (now < 60_000 ? restartStartBoundMs - now : 0) },
    );
    if (servesAt !== undefined) {
      assert.equal(response.status, 200, "a lapse after the hold waits as today");
      assert.equal(await response.text(), "payload");
      assert.ok(now >= servesAt && now < servesAt + 1_000, `served at ${now}`);
    } else {
      assert.equal(response.status, 503);
      const after = 60_000 + runtimeAdmissionWaitMs;
      assert.ok(now >= after && now <= after + 1_000, `answered at ${now}, not at once`);
      assert.equal(
        passes.filter((at) => at >= 60_000).length,
        1,
        "the call joins one recovery pass after its hold, as a fresh call does",
      );
    }
  }
});

for (const refusal of [recordReplaced, readinessUnhealthy])
  test(`a code handover that begins during a hold drains within today's bound: ${refusal.name}`, async (context) => {
    const logs = context.mock.method(console, "info", () => {});
    context.mock.method(console, "warn", () => {});
    const clock = scheduler();
    const count = new HandoverCount();
    const store = new Map<string, unknown>();
    const resets: number[] = [];
    const begun: Promise<unknown>[] = [];
    const handover = new CodeHandover({
      own: { candidate: "a".repeat(40), workerInput: "b".repeat(64) },
      storage: {
        get: async (key) => store.get(key),
        put: async (key, value) => {
          store.set(key, value);
        },
      },
      inFlight: () => count.active,
      abort: () => {
        resets.push(clock.now());
      },
      defer: (work) => {
        begun.push(work);
      },
      now: clock.now,
      wait: (milliseconds) => clock.sleep(milliseconds),
    });
    const client = new AbortController();
    context.after(() => client.abort());
    const request = modelRequest(client.signal);
    let answered: { at: number; response: Response } | undefined;
    void count
      .track(request, () =>
        forwardRecoverably(
          request,
          async () => {
            throw refusal();
          },
          () => assert.fail("a refused call is never sent"),
          async () => {},
          {
            timing: clock.timing,
            rootHoldMs: async () => Math.max(0, restartStartBoundMs - clock.now()),
            handover: () => handover.draining,
          },
        ),
      )
      .then(async (response) => {
        answered = { at: clock.now(), response: response.clone() };
        // The client reads its answer, which is what ends the call's count.
        await response.text();
      })
      .catch(() => {});
    await clock.run(() => clock.now() >= 10_000, 11_000);
    assert.equal(count.active, 1, "held, and counted, before the handover");
    handover.offer({ candidate: "c".repeat(40), workerInput: "d".repeat(64) });
    const offeredAt = clock.now();
    await clock.run(() => resets.length > 0, offeredAt + codeHandoverDrainMs + 1_000);
    await Promise.all(begun);
    assert.equal(answered?.response.status, 503, "today's answer, not a cut");
    assert.equal(answered.response.headers.get("Retry-After"), "1");
    assert.ok(answered.at <= resets[0]!, "answered before the reset");
    // On its own history: today's 30 s counted from its first refusal, not from the handover.
    assert.ok(answered.at <= runtimeAdmissionWaitMs + 1_000, `answered at ${answered.at} ms`);
    const line = logs.mock.calls
      .map((call) => call.arguments[1] as { outcome?: string; reason?: string; waitedMs?: number })
      .find((value) => value?.outcome === "handing_over");
    assert.equal(line?.reason, "drained");
    // Today's longest: a call that arrives as the handover begins, its 30 s, one pause and one poll.
    assert.ok(
      line.waitedMs! <= runtimeAdmissionWaitMs + 1_000 + 250,
      `the drain waited ${line.waitedMs} ms`,
    );
  });

test("a held call waits out the root fallback cap at the cap's rate inside the hold's bound, and only there", async () => {
  const paceMs = 1_000 / rootFallbackPerSecond;
  const capped = () => markRootFallbackCap(new Response(null, { status: 503 }), paceMs);
  const timing = (clock: { now: number; pauses: number[] }) => ({
    now: () => clock.now,
    pause: async (milliseconds: number) => {
      clock.pauses.push(milliseconds);
      clock.now += milliseconds;
    },
  });
  const inside = { now: 0, pauses: [] as number[] };
  let attempts = 0;
  const served = await forwardRecoverably(
    modelRequest(),
    async (request, dispatch) => {
      if (++attempts < 6) return capped();
      dispatch();
      return new Response(await request.text());
    },
    () => {},
    async () => {},
    { timing: timing(inside), rootHoldMs: async () => restartStartBoundMs - inside.now },
  );
  assert.equal(await served.text(), "payload");
  assert.deepEqual(inside.pauses, Array(5).fill(paceMs));
  // Held 2 s, then the bound passes: the cap's refusal goes back, as today.
  const past = { now: 0, pauses: [] as number[] };
  const refused = await forwardRecoverably(
    modelRequest(),
    async () => {
      if (past.now < 2_000) throw recordReplaced();
      return capped();
    },
    () => {},
    async () => {},
    { timing: timing(past), rootHoldMs: async () => Math.max(0, 2_000 - past.now) },
  );
  assert.equal(refused.status, 503);
  assert.ok(past.now >= 2_000 && past.now <= 3_000, `returned at ${past.now}`);
  // With no recovery in progress, at once.
  const none = { now: 0, pauses: [] as number[] };
  assert.equal(
    (
      await forwardRecoverably(
        modelRequest(),
        async () => capped(),
        () => {},
        undefined,
        {
          timing: timing(none),
          rootHoldMs: async () => 0,
        },
      )
    ).status,
    503,
  );
  assert.deepEqual(none.pauses, []);
});

// With enable_request_signal a caller who leaves aborts the request's signal; #1861 listed "a
// client's abort may not reach the hold" as a limit while the flag was off.
for (const hold of ["rootHoldMs", "coldHoldMs"] as const)
  test(`a caller who leaves during the ${hold === "rootHoldMs" ? "root-recovery" : "cold-start"} hold ends it and lets go of its body`, async () => {
    const caller = new AbortController();
    let bodyCancelled = false;
    const request = new Request("http://pool/v1/responses", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        // Still uploading, as a long request is while it waits.
        start(controller) {
          controller.enqueue(new TextEncoder().encode("payload"));
        },
        cancel() {
          bodyCancelled = true;
        },
      }),
      duplex: "half",
      signal: caller.signal,
    } as RequestInit);
    let attempts = 0;
    let paused!: () => void;
    const pausing = new Promise<void>((resolve) => (paused = resolve));
    const timing = {
      now: () => 0,
      pause: (_milliseconds: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          paused();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const answer = forwardRecoverably(
      request,
      async () => {
        attempts++;
        throw recordReplaced();
      },
      () => {},
      async () => {},
      { timing, [hold]: async () => restartStartBoundMs },
    );
    await pausing;
    assert.equal(attempts, 1);
    caller.abort(new DOMException("The caller left", "AbortError"));
    await assert.rejects(answer, { name: "AbortError" });
    assert.equal(attempts, 1, "no attempt after the caller left");
    await new Promise(setImmediate);
    assert.equal(bodyCancelled, true, "the held copy of the body is let go");
  });
