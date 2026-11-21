import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CodeHandover,
  codeHandoverDrainMs,
  codeHandoverHeader,
  decodeControllerCode,
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
  options: { record?: unknown; inFlight?: (elapsed: number) => number; code?: typeof own } = {},
) {
  const info = context.mock.method(console, "info", () => {});
  const start = 1_000_000;
  let now = start;
  const stored = new Map<string, unknown>();
  if (options.record) stored.set(recordKey, options.record);
  const deferred: Promise<unknown>[] = [];
  const aborted: string[] = [];
  const handover = new CodeHandover({
    own: options.code ?? own,
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => {
        stored.set(key, value);
      },
    },
    inFlight: () => (options.inFlight ?? (() => 0))(now - start),
    abort: (reason) => {
      aborted.push(reason);
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
    settle: () => Promise.all(deferred),
    advance: (milliseconds: number) => (now += milliseconds),
    lines: () =>
      info.mock.calls
        .filter((call) => call.arguments[0] === "POOL_CODE_HANDOVER")
        .map((call) => call.arguments[1] as Record<string, unknown>),
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
      waitedMs: 3_000,
    },
  ]);
  assert.deepEqual(h.stored.get(recordKey), { from: own, to: next, at: 1_003_000 });
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
  h.advance(codeHandoverDrainMs + 5_000);
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
  assert.deepEqual(h.lines(), [{ outcome: "waiting_for_platform" }]);
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
