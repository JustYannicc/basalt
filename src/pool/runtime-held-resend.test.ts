import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fetchController, type ControllerHop } from "./controller-reset.ts";
import { reachedNoContainer } from "./controller-unsent.ts";
import { heldBytes, holdBody } from "./held-body.ts";
import { heldCopyBudgetBytes, heldCopyBytes, heldResendMs } from "./runtime-fleet/held-resend.ts";
import { forwardRecoverably, markRootFallbackCap } from "./runtime-fleet/retry.ts";
import { rootFallbackPerSecond } from "./runtime-fleet/root-fallback.ts";
import { rememberRuntimeFailure, retainRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { restartStartBoundMs } from "./runtime-slots/forced-restart-timing.ts";
import { runtimeErrorResponse } from "./runtime-slots/request-error.ts";

const unsentMark = "X-Signalbox-Controller-Unsent";
const readyAt = 70_000;
const capPaceMs = 1_000 / rootFallbackPerSecond;

/** A runtime's endpoint refusing a sent call at `step`, as the cell's transport retains it. */
function endpointRefused(step: "endpoint_identity" | "port_dispatch") {
  const cause = new SlotRefused("unhealthy");
  rememberRuntimeFailure(step, cause);
  return retainRuntimeFailure(
    runtimeErrorResponse(cause, "endpoint"),
    new SlotRefused("uncertain"),
  );
}
/** S1's lapse at 17:01:51Z: the endpoint's own readiness read found the policy lease run out. */
const leaseLapsed = () => endpointRefused("endpoint_identity");
/** The root's fallback cap turning a call away while the fleet is cold. */
const capped = () => markRootFallbackCap(new Response(null, { status: 503 }), capPaceMs);
/** The root's restart, as a held call's health read sees it before the new boot is selected. */
function recordReplaced() {
  const cause = new SlotRefused("identity");
  rememberRuntimeFailure("endpoint_identity", cause);
  const error = retainRuntimeFailure(
    runtimeErrorResponse(cause, "endpoint"),
    new SlotRefused("uncertain"),
  );
  rememberRuntimeFailure("slot_health", error);
  return error;
}
const modelCall = (body: BodyInit = "payload", signal?: AbortSignal) =>
  new Request("http://pool/v1/messages", { method: "POST", body, ...(signal ? { signal } : {}) });
/** A cell starting while no ready cell can take the call, until `readyAt`. */
const coldUntil = (now: () => number) => async () =>
  now() < readyAt ? restartStartBoundMs - now() : 0;
const stepClock = () => {
  const clock = { now: 0 };
  return {
    clock,
    timing: {
      now: () => clock.now,
      pause: async (milliseconds: number) => {
        clock.now += milliseconds;
      },
    },
  };
};
function quiet(context: TestContext) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
}

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

test("the lapse S1 showed is a refusal before the container send", () => {
  assert.equal(reachedNoContainer(leaseLapsed()), true);
  assert.equal(reachedNoContainer(endpointRefused("port_dispatch")), false);
});

test("calls a starting cell held past the entry's window are released together and every one is served, the ones its endpoint refused unsent sent again", async (context) => {
  quiet(context);
  const clock = scheduler();
  const refusedOnce = new Set(["0", "3", "6", "9", "12", "15", "18"]);
  const endpointSends = new Map<string, number>();
  const controllerSends = new Map<string, number>();
  const count = (sends: Map<string, number>, id: string) => {
    sends.set(id, (sends.get(id) ?? 0) + 1);
    return sends.get(id)!;
  };
  const hop: ControllerHop = {
    controller: () => ({
      fetch: async (request) => {
        count(controllerSends, request.headers.get("x-call")!);
        return forwardRecoverably(
          request,
          async (current, dispatch) => {
            if (clock.now() < readyAt) return capped();
            dispatch();
            const id = current.headers.get("x-call")!;
            if (count(endpointSends, id) === 1 && refusedOnce.has(id)) throw leaseLapsed();
            return new Response(await current.text());
          },
          () => {},
          async () => {},
          { timing: { now: clock.now, pause: clock.sleep }, coldHoldMs: coldUntil(clock.now) },
        );
      },
    }),
    env: { SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456" },
    defer: () => {},
    now: clock.now,
    wait: clock.sleep,
  };
  const answers = new Map<string, { status: number; text: string; at: number }>();
  const calls = Array.from({ length: 20 }, (_, index) => {
    const id = String(index);
    const request = new Request("https://pool.example/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-call": id },
      body: `payload-${id}`,
    });
    return fetchController(request, hop).then(async (response) =>
      answers.set(id, { status: response.status, text: await response.text(), at: clock.now() }),
    );
  });
  await clock.run(() => answers.size === 20, restartStartBoundMs);
  await Promise.all(calls);
  for (const [id, answer] of answers) {
    assert.equal(answer.status, 200, `call ${id} is served`);
    assert.equal(answer.text, `payload-${id}`, `call ${id} carries its own body`);
    assert.ok(answer.at >= readyAt && answer.at <= readyAt + 2_000, `call ${id} at ${answer.at}`);
    assert.equal(endpointSends.get(id), refusedOnce.has(id) ? 2 : 1, `call ${id}'s sends`);
    // The controller sent it again, so the entry's window never mattered.
    assert.equal(controllerSends.get(id), 1, `call ${id} reached the controller once`);
  }
  assert.equal(heldBytes(), 0, "every copy is let go");
});

test("a call held through a root recovery is sent again after its endpoint refuses it unsent", async (context) => {
  quiet(context);
  const { clock, timing } = stepClock();
  const servesAt = 90_000;
  let sends = 0;
  const response = await forwardRecoverably(
    modelCall(),
    async (request, dispatch) => {
      if (clock.now < servesAt) throw recordReplaced();
      dispatch();
      if (++sends === 1) throw leaseLapsed();
      return new Response(await request.text());
    },
    () => {},
    async () => {},
    {
      timing,
      rootHoldMs: async () => (clock.now < servesAt ? restartStartBoundMs - clock.now : 0),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "payload");
  assert.equal(sends, 2);
  assert.ok(clock.now >= servesAt && clock.now <= servesAt + 2_000, `served at ${clock.now}`);
});

test("an endpoint that keeps refusing a held call unsent ends it with the retryable 503 at the hold's bound, not later", async (context) => {
  quiet(context);
  const { clock, timing } = stepClock();
  let sends = 0;
  let firstSendAt: number | undefined;
  const response = await forwardRecoverably(
    modelCall(),
    async (_request, dispatch) => {
      if (clock.now < readyAt) return capped();
      dispatch();
      sends++;
      firstSendAt ??= clock.now;
      throw leaseLapsed();
    },
    () => {},
    async () => {},
    { timing, coldHoldMs: coldUntil(() => clock.now) },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  // Past its window the entry passes it on without the mark, as any late unsent refusal.
  assert.equal(response.headers.get(unsentMark), "1");
  assert.ok(
    clock.now > restartStartBoundMs - heldResendMs && clock.now <= restartStartBoundMs,
    `answered at ${clock.now}`,
  );
  // Once a second from the first send for as long as the next send still falls inside the bound.
  assert.equal(sends, Math.floor((restartStartBoundMs - firstSendAt!) / heldResendMs) + 1);
});

test("a held call whose caller left is not sent again, and its copy is let go", async (context) => {
  quiet(context);
  const caller = new AbortController();
  let now = 0;
  let resting!: () => void;
  const rested = new Promise<void>((resolve) => (resting = resolve));
  const timing = {
    now: () => now,
    pause: (milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (now >= readyAt) resting();
        else {
          now += milliseconds;
          resolve();
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  let sends = 0;
  const answer = forwardRecoverably(
    modelCall("payload", caller.signal),
    async (_request, dispatch) => {
      if (now < readyAt) return capped();
      dispatch();
      sends++;
      throw leaseLapsed();
    },
    () => {},
    async () => {},
    { timing, coldHoldMs: coldUntil(() => now) },
  );
  const first = await Promise.race([
    rested.then(() => "waits to send again"),
    answer.then(
      () => "answered",
      () => "answered",
    ),
  ]);
  assert.equal(first, "waits to send again");
  assert.equal(sends, 1);
  caller.abort(new DOMException("The caller left", "AbortError"));
  await assert.rejects(answer, { name: "AbortError" });
  assert.equal(sends, 1, "no send after the caller left");
  assert.equal(heldBytes(), 0);
});

test("a call no hold made wait, a job and a model socket keep the unsent refusal for the entry, at once", async (context) => {
  quiet(context);
  const shapes = {
    // No hold read at all.
    unheld: { request: () => modelCall(), cold: false, waits: false },
    // A cell is starting, but the root's cap takes the call at once.
    "admitted at once": { request: () => modelCall(), cold: true, waits: false },
    // Calls the entry never sends again either, held first.
    job: {
      request: () => new Request("http://pool/v1/videos", { method: "POST", body: "payload" }),
      cold: true,
      waits: true,
    },
    socket: {
      request: () => new Request("http://pool/v1/responses", { headers: { upgrade: "websocket" } }),
      cold: true,
      waits: true,
    },
  };
  for (const [shape, { request, cold, waits }] of Object.entries(shapes)) {
    const { clock, timing } = stepClock();
    let sends = 0;
    const response = await forwardRecoverably(
      request(),
      async (_request, dispatch) => {
        if (waits && clock.now < readyAt) return capped();
        dispatch();
        sends++;
        throw leaseLapsed();
      },
      () => {},
      async () => {},
      { timing, coldHoldMs: cold ? coldUntil(() => clock.now) : async () => 0 },
    );
    assert.equal(response.status, 503, shape);
    assert.equal(response.headers.get(unsentMark), "1", shape);
    assert.equal(sends, 1, shape);
    assert.ok(clock.now < (waits ? readyAt + heldResendMs : 1), `${shape} at ${clock.now}`);
    assert.equal(heldBytes(), 0, shape);
  }
});

test("a held call whose copy finds the isolate's budget full keeps today's unsent refusal", async (context) => {
  quiet(context);
  const filler = holdBody(
    new Response(new Uint8Array(heldCopyBudgetBytes)).body,
    { maxBytes: heldCopyBudgetBytes, budgetBytes: heldCopyBudgetBytes, windowMs: 60_000 },
    () => {},
  );
  await filler.ready;
  try {
    assert.equal(heldBytes(), heldCopyBudgetBytes);
    const { clock, timing } = stepClock();
    let sends = 0;
    const response = await forwardRecoverably(
      modelCall(),
      async (_request, dispatch) => {
        if (clock.now < readyAt) return capped();
        dispatch();
        sends++;
        throw leaseLapsed();
      },
      () => {},
      async () => {},
      { timing, coldHoldMs: coldUntil(() => clock.now) },
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get(unsentMark), "1");
    assert.equal(sends, 1);
  } finally {
    filler.release();
  }
  assert.equal(heldBytes(), 0);
});

test("a held call whose caller leaves while its copy is still read lets the copy go", async (context) => {
  quiet(context);
  const caller = new AbortController();
  // Still uploading: the copy can't finish reading it.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
  });
  const request = new Request("http://pool/v1/messages", {
    method: "POST",
    body,
    duplex: "half",
    signal: caller.signal,
  } as RequestInit);
  const { clock, timing } = stepClock();
  let refused!: () => void;
  const refusal = new Promise<void>((resolve) => (refused = resolve));
  const answer = forwardRecoverably(
    request,
    async (_request, dispatch) => {
      if (clock.now < readyAt) return capped();
      dispatch();
      refused();
      throw leaseLapsed();
    },
    () => {},
    async () => {},
    { timing, coldHoldMs: coldUntil(() => clock.now) },
  );
  await refusal;
  for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate);
  assert.ok(heldBytes() > 0, "the copy holds what has arrived");
  caller.abort(new DOMException("The caller left", "AbortError"));
  await assert.rejects(answer, { name: "AbortError" });
  assert.equal(heldBytes(), 0, "the copy is let go");
});

test("a held call whose send itself failed is never sent again", async (context) => {
  quiet(context);
  const { clock, timing } = stepClock();
  let sends = 0;
  const response = await forwardRecoverably(
    modelCall(),
    async (_request, dispatch) => {
      if (clock.now < readyAt) return capped();
      dispatch();
      sends++;
      throw endpointRefused("port_dispatch");
    },
    () => {},
    async () => {},
    { timing, coldHoldMs: coldUntil(() => clock.now) },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get(unsentMark), null, "an outcome that may have run");
  assert.equal(sends, 1);
  assert.equal(heldBytes(), 0);
});

test("a held call keeps today's unsent refusal while a code handover drains, or when its body is over the copy's bound", async (context) => {
  quiet(context);
  for (const shape of ["handover", "large"] as const) {
    const { clock, timing } = stepClock();
    let sends = 0;
    const body = shape === "large" ? new Uint8Array(heldCopyBytes + 1) : "payload";
    const response = await forwardRecoverably(
      modelCall(body),
      async (_request, dispatch) => {
        if (clock.now < readyAt) return capped();
        dispatch();
        sends++;
        throw leaseLapsed();
      },
      () => {},
      async () => {},
      {
        timing,
        coldHoldMs: coldUntil(() => clock.now),
        handover: () => shape === "handover" && clock.now >= readyAt,
      },
    );
    assert.equal(response.status, 503, shape);
    assert.equal(response.headers.get(unsentMark), "1", shape);
    assert.equal(sends, 1, shape);
    assert.ok(
      clock.now >= readyAt && clock.now < readyAt + heldResendMs,
      `${shape} at ${clock.now}`,
    );
    assert.equal(heldBytes(), 0, shape);
  }
});
