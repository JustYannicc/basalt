import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CodeHandover,
  codeHandoverDrainMs,
  codeHandoverHeader,
  decodeControllerCode,
  HandoverCount,
  handingOver,
  handoverRefusal,
} from "./code-handover.ts";
import {
  controllerReplayDelayMs,
  controllerReplayWindowMs,
  fetchController,
  type ControllerHop,
} from "./controller-reset.ts";

const own = { candidate: "a".repeat(40), workerInput: "1".repeat(64) };
const next = { candidate: "b".repeat(40), workerInput: "2".repeat(64) };
const recordKey = "pool-code-handover-v1";

function harness(
  context: TestContext,
  options: {
    record?: unknown;
    inFlight?: (elapsed: number) => number;
    busy?: (elapsed: number) => boolean;
    code?: typeof own;
    putFails?: boolean;
    abortThrows?: boolean;
  } = {},
) {
  const info = context.mock.method(console, "info", () => {});
  const errors = context.mock.method(console, "error", () => {});
  const start = 1_000_000;
  let now = start;
  const stored = new Map<string, unknown>();
  if (options.record) stored.set(recordKey, options.record);
  let reads = 0;
  const deferred: Promise<unknown>[] = [];
  const aborted: string[] = [];
  const handover = new CodeHandover({
    own: options.code ?? own,
    storage: {
      get: async (key) => {
        reads++;
        return stored.get(key);
      },
      put: async (key, value) => {
        if (options.putFails) throw new Error("storage overloaded");
        stored.set(key, value);
      },
    },
    inFlight: () => (options.inFlight ?? (() => 0))(now - start),
    ...(options.busy ? { busy: () => options.busy!(now - start) } : {}),
    abort: (reason) => {
      aborted.push(reason);
      if (options.abortThrows) throw new Error("abort threw");
    },
    defer: (work) => deferred.push(work),
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  return {
    handover,
    aborted,
    stored,
    reads: () => reads,
    settle: () => Promise.all(deferred),
    advance: (milliseconds: number) => (now += milliseconds),
    lines: () =>
      info.mock.calls
        .filter((call) => call.arguments[0] === "POOL_CODE_HANDOVER")
        .map((call) => call.arguments[1] as Record<string, unknown>),
    errors: () => errors.mock.calls.map((call) => call.arguments[0]),
  };
}

test("an adoption read naming this object's own code changes nothing", async (context) => {
  const h = harness(context, { inFlight: () => 3 });
  h.handover.offer(own);
  await h.settle();
  assert.equal(h.handover.draining, false);
  assert.deepEqual(h.aborted, []);
  assert.equal(h.stored.has(recordKey), false);
  assert.deepEqual(h.lines(), []);
});

test("a different code starts one drain, and the reads every 5 s during it start no second", async (context) => {
  const h = harness(context, { inFlight: (elapsed) => (elapsed < 12_000 ? 1 : 0) });
  h.handover.offer(next);
  h.handover.offer(next);
  await h.settle();
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  assert.equal(h.lines().length, 1);
});

test("the drain ends as soon as nothing is in flight: it records the handover and resets the object", async (context) => {
  const h = harness(context, { inFlight: (elapsed) => (elapsed < 3_000 ? 2 : 0) });
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  assert.deepEqual(h.lines(), [
    {
      outcome: "handing_over",
      reason: "drained",
      inFlightAtStart: 2,
      remaining: 0,
      busy: false,
      startedAt: 1_000_000,
      waitedMs: 3_000,
      from: own,
      to: next,
    },
  ]);
  assert.deepEqual(h.stored.get(recordKey), { from: own, to: next, at: 1_000_000 });
});

test("with nothing in flight the handover is immediate", async (context) => {
  const h = harness(context);
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  assert.equal(h.lines()[0]!.waitedMs, 0);
});

test("a stream still in flight at the bound is cut: the object resets at the bound", async (context) => {
  const h = harness(context, { inFlight: () => 1 });
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  const [line] = h.lines();
  assert.equal(line!.reason, "bound");
  assert.equal(line!.remaining, 1);
  assert.equal(line!.waitedMs, codeHandoverDrainMs);
  assert.ok(codeHandoverDrainMs < 300_000, "inside the platform's own reset");
});

test("new model calls are refused while it drains, and the refusal ends by itself if no reset comes", async (context) => {
  const h = harness(context, { inFlight: (elapsed) => (elapsed < 2_000 ? 1 : 0) });
  h.handover.offer(next);
  await h.settle();
  // The test's reset changes nothing, as a reset that never comes would.
  assert.equal(h.handover.draining, true);
  const refusal = handoverRefusal(
    new Request("https://pool.example/v1/messages", { method: "POST" }),
  );
  assert.equal(refusal.status, 503);
  assert.equal(refusal.headers.get("Retry-After"), "1");
  assert.equal(refusal.headers.get(codeHandoverHeader), "draining");
  assert.equal(handingOver(refusal), true);
  // Counted from the reset call, not from the drain's start: a missing reset costs 5 s of refusals.
  h.advance(4_999);
  assert.equal(h.handover.draining, true);
  h.advance(1);
  assert.equal(h.handover.draining, false);
});

test("a new instance still on the old code finds the recent record and does not drain again", async (context) => {
  const h = harness(context, {
    inFlight: () => 1,
    record: { from: own, to: next, at: 1_000_000 - 60_000 },
  });
  h.handover.offer(next);
  await h.settle();
  assert.equal(h.handover.draining, false);
  assert.deepEqual(h.aborted, []);
  assert.deepEqual(h.lines(), [{ outcome: "waiting_for_platform", from: own, to: next }]);
  // The adoption reads every 5 s until the platform resets it read and log nothing more.
  for (let read = 0; read < 3; read++) h.handover.offer(next);
  await h.settle();
  assert.equal(h.reads(), 1);
  assert.equal(h.lines().length, 1);
});

test("a handover record past its expiry no longer counts", async (context) => {
  const h = harness(context, { record: { from: own, to: next, at: 1_000_000 - 16 * 60_000 } });
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
});

test("after the reset the new code's object admits at once, with no person involved", async (context) => {
  const h = harness(context, {
    code: next,
    inFlight: () => 1,
    record: { from: own, to: next, at: 1_000_000 - 1_000 },
  });
  h.handover.offer(next);
  await h.settle();
  assert.equal(h.handover.draining, false);
  assert.deepEqual(h.aborted, []);
});

test("an alarm pass, Home pass or handoff still running holds the reset until it ends", async (context) => {
  const h = harness(context, { busy: (elapsed) => elapsed < 3_000 });
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  const [line] = h.lines();
  assert.equal(line!.reason, "drained");
  assert.equal(line!.busy, false);
  assert.equal(line!.waitedMs, 3_000);
});

test("work still running at the bound is cut like a stream, and the line says so", async (context) => {
  const h = harness(context, { busy: () => true });
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  const [line] = h.lines();
  assert.equal(line!.reason, "bound");
  assert.equal(line!.busy, true);
  assert.equal(line!.remaining, 0);
});

test("a record that cannot be written does not stop the handover", async (context) => {
  const h = harness(context, { putFails: true });
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  assert.equal(h.lines()[0]!.outcome, "handing_over");
  assert.deepEqual(h.errors(), ["POOL_CODE_HANDOVER_RECORD_PENDING"]);
});

test("a reset call that throws leaves only the short refusal window", async (context) => {
  const h = harness(context, { abortThrows: true });
  h.handover.offer(next);
  await h.settle();
  assert.deepEqual(h.aborted, ["code handover"]);
  assert.equal(h.handover.draining, true);
  h.advance(5_000);
  assert.equal(h.handover.draining, false);
});

test("a count that fails mid-drain clears the drain instead of refusing until it expires", async (context) => {
  const h = harness(context, {
    inFlight: (elapsed) => {
      if (elapsed >= 1_000) throw new Error("count unavailable");
      return 1;
    },
  });
  h.handover.offer(next);
  await assert.rejects(h.settle(), /count unavailable/);
  assert.equal(h.handover.draining, false);
  assert.deepEqual(h.aborted, []);
});

/** A body the test ends, errors or leaves open. */
function heldBody() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      control = controller;
    },
  });
  return { body, control };
}
const modelRequest = (headers: Record<string, string> = {}) =>
  new Request("https://pool.example/v1/responses", { method: "POST", headers });

test("a finite model call is counted from admission until its body is fully read", async () => {
  const count = new HandoverCount();
  const held = heldBody();
  let resolve!: (response: Response) => void;
  const answered = count.track(modelRequest(), () => new Promise((done) => (resolve = done)));
  assert.equal(count.active, 1, "counted before the call is answered");
  resolve(new Response(held.body));
  const reader = (await answered).body!.getReader();
  held.control.enqueue(new TextEncoder().encode("tick"));
  assert.equal((await reader.read()).done, false);
  assert.equal(count.active, 1, "an open stream keeps the call counted");
  held.control.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(count.active, 0);
});

test("a cancelled, failed or refused call is no longer counted", async () => {
  const count = new HandoverCount();
  const cancelled = heldBody();
  const first = await count.track(modelRequest(), async () => new Response(cancelled.body));
  await first.body!.cancel("client left");
  assert.equal(count.active, 0);

  const failing = heldBody();
  const second = await count.track(modelRequest(), async () => new Response(failing.body));
  failing.control.error(new Error("upstream reset"));
  await assert.rejects(second.body!.getReader().read(), /upstream reset/);
  assert.equal(count.active, 0);

  await assert.rejects(
    count.track(modelRequest(), async () => {
      throw new Error("refused");
    }),
    /refused/,
  );
  assert.throws(() =>
    count.track(modelRequest(), () => {
      throw new Error("thrown at once");
    }),
  );
  await count.track(modelRequest(), async () => new Response(null, { status: 204 }));
  assert.equal(count.active, 0);
});

test("a caller that leaves without reading its answer is no longer counted", async () => {
  const count = new HandoverCount();
  const caller = new AbortController();
  const held = heldBody();
  await count.track(
    new Request("https://pool.example/v1/responses", { method: "POST", signal: caller.signal }),
    async () => new Response(held.body),
  );
  assert.equal(count.active, 1);
  caller.abort();
  assert.equal(count.active, 0);
});

test("a model socket is not counted, so an open socket never holds a drain", async () => {
  const count = new HandoverCount();
  let started = false;
  await count.track(
    new Request("https://pool.example/v1/responses", { headers: { Upgrade: "websocket" } }),
    async () => {
      started = true;
      assert.equal(count.active, 0);
      return new Response(null, { status: 200 });
    },
  );
  assert.equal(started, true);
  assert.equal(count.active, 0);
});

test("only a controller code is read from the adoption call", () => {
  assert.deepEqual(decodeControllerCode(next), next);
  assert.equal(decodeControllerCode(undefined), undefined);
  assert.equal(decodeControllerCode({ candidate: "b".repeat(40) }), undefined);
  assert.equal(decodeControllerCode("handover"), undefined);
});

/** A controller that refuses while it hands over until `endsAt`, then answers as the new instance. */
function handingOverHop(context: TestContext, endsAt: number, afterAbort?: () => never) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  const start = 2_000_000;
  let now = start;
  const sends: { at: number; body: string }[] = [];
  let thrown = false;
  const hop: ControllerHop = {
    controller: () => ({
      fetch: async (request) => {
        const at = now - start;
        sends.push({ at, body: await request.text() });
        if (at < endsAt) return handoverRefusal(request);
        if (afterAbort && !thrown) {
          thrown = true;
          afterAbort();
        }
        return Response.json({ id: "message" });
      },
    }),
    env: { SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456" },
    defer: () => {},
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
  return { hop, sends, advance: (milliseconds: number) => (now += milliseconds) };
}

const body = JSON.stringify({
  model: "claude-opus-5-5",
  messages: [{ role: "user", content: "hi" }],
});
const call = () =>
  new Request("https://pool.example/v1/messages", {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body,
  });

test("a model call that arrives 19 s before the drain ends succeeds and its caller sees nothing", async (context) => {
  const h = handingOverHop(context, 19_000);
  const response = await fetchController(call(), h.hop);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "message" });
  assert.equal(h.sends.length, 20, "the first send, then one each second");
  assert.deepEqual(new Set(h.sends.map((send) => send.body)), new Set([body]));
  assert.equal(h.sends.at(-1)!.at, 19_000);
});

test("a call that waits past 20 s gets the retryable 503, and its retry succeeds", async (context) => {
  const h = handingOverHop(context, 25_000);
  const first = await fetchController(call(), h.hop);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get("Retry-After"), "1");
  assert.ok(h.sends.at(-1)!.at <= controllerReplayWindowMs, "never sent past the replay window");
  // The client follows Retry-After.
  h.advance(6_000);
  const retried = await fetchController(call(), h.hop);
  assert.equal(retried.status, 200);
});

test("a re-send that meets the old instance resetting is followed by the next one", async (context) => {
  const h = handingOverHop(context, 3_000, () => {
    throw Object.assign(
      new Error(
        "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
      ),
      { retryable: true },
    );
  });
  const response = await fetchController(call(), h.hop);
  assert.equal(response.status, 200);
  assert.equal(h.sends.at(-1)!.at, 3_000 + controllerReplayDelayMs);
});

test("a re-send that fails for another reason returns the retryable refusal the caller holds", async (context) => {
  const h = handingOverHop(context, 3_000, () => {
    throw new Error("Durable Object is overloaded");
  });
  const response = await fetchController(call(), h.hop);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(handingOver(response), true);
});

test("a call that is not replayable gets the handover's retryable 503 at once", async (context) => {
  const h = handingOverHop(context, 60_000);
  const response = await fetchController(
    new Request("https://pool.example/v1/videos", { method: "POST", body: "{}" }),
    h.hop,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(h.sends.length, 1);
});
