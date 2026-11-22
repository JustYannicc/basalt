import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { poolArrival, stampPoolReceive } from "./pool-arrival.ts";
import { unsentRefusal } from "./controller-unsent.ts";
import { rememberRuntimeFailure } from "./runtime-route-diagnostic.ts";

const workerModule = "./forward.worker.ts";
const {
  forwardPoolRequest,
}: {
  forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
} = await import(workerModule);

const text = new TextEncoder();

/** The real forward path with a synthetic runtime; the event is read where evlog writes it. */
function harness(
  context: TestContext,
  options: { env?: object; fail?: Error; admission?: number; warm?: number | Error } = {},
) {
  const events: Record<string, unknown>[] = [];
  context.mock.method(console, "info", (value: unknown) => {
    if (value && typeof value === "object" && "outcome" in value)
      events.push({ ...(value as Record<string, unknown>) });
  });
  context.mock.method(console, "error", () => {});
  const background: Promise<unknown>[] = [];
  const dependencies = {
    env: { POOL_APP_SIGNING_KEY: "fixture", ...options.env },
    appModel: { pool: "pool-private-name", person: "person-private-name", keyId: 987654321 },
    memberships: {
      configured: async () => {
        if (options.admission) await wait(options.admission);
        return false;
      },
    },
    streams: { active: 3 },
    protection: {},
    computers: { observeUsage: async () => {} },
    lifecycle: Promise.resolve({
      warm: async () => {
        if (options.warm instanceof Error) throw options.warm;
        if (options.warm) await wait(options.warm);
        return { boot_id: "fixture" };
      },
    }),
    terminal: { start: async () => {}, finish: async () => {} },
    fetch: async (outbound: Request) => {
      if (options.fail) throw options.fail;
      await wait(30);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(text.encode('data: {"choices":[{"delta":"private-response"}]}\n\n'));
            await wait(40);
            controller.enqueue(text.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "X-Basalt-Request-Id": outbound.headers.get("X-Basalt-Request-Id") ?? "",
          },
        },
      );
    },
    defer: (work: Promise<unknown>) => {
      background.push(work);
    },
  };
  return {
    events,
    forward: (request: Request, extra: object = {}) =>
      forwardPoolRequest(request, 8317, { ...dependencies, ...extra }),
    drain: async () => {
      while (background.length) await background.shift();
    },
  };
}

const modelRequest = (headers: Record<string, string> = {}) =>
  new Request("https://pool.invalid/v1/chat/completions?key=private-key", {
    method: "POST",
    body: '{"model":"private-model","messages":[{"content":"private-prompt"}]}',
    headers,
  });

test("a streamed model response is one event whose hops add up to its total", async (context) => {
  const h = harness(context);
  const received = Date.now() - 250;
  const arrival = poolArrival(stampPoolReceive(modelRequest(), received, received + 60));
  assert.equal(arrival.request.headers.has("x-basalt-pool-receive"), false);
  const response = await h.forward(arrival.request, { arrival });
  const body = await response.text();
  await h.drain();

  assert.equal(h.events.length, 1);
  const [event] = h.events;
  assert.equal(event!.requestId, response.headers.get("X-Request-Id"));
  assert.equal(event!.path, "/v1/chat/completions");
  assert.equal(event!.outcome, "complete");
  assert.equal(event!.status, 200);
  assert.equal(event!.bytes, text.encode(body).byteLength);
  assert.equal(event!.inFlight, 3);
  assert.equal(event!.workerMs, 60);
  assert.ok(Number(event!.queueMs) >= 190, `queueMs ${event!.queueMs}`);
  assert.ok(Number(event!.firstByteMs) >= 25, `firstByteMs ${event!.firstByteMs}`);
  assert.ok(Number(event!.streamMs) >= 35, `streamMs ${event!.streamMs}`);
  assert.equal(
    ["workerMs", "queueMs", "admissionMs", "dispatchMs", "firstByteMs", "streamMs"].reduce(
      (total, hop) => total + Number(event![hop]),
      0,
    ),
    event!.totalMs,
  );
  // A burst is grouped by an opaque reference: the pool's name, its people and its keys stay out.
  assert.match(String(event!.poolRef), /^[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(event), /private-|fixture|987654321/);
});

test("a runtime that fails after dispatch is unanswered, not a first byte", async (context) => {
  const h = harness(context, { fail: new Error("private-upstream-error") });
  const response = await h.forward(modelRequest());
  await h.drain();

  assert.equal(response.status, 502);
  assert.equal(h.events.length, 1);
  const [event] = h.events;
  assert.equal(event!.outcome, "outcome_unknown");
  assert.equal(event!.status, 502);
  assert.equal(event!.guard, "upstream_dispatch");
  assert.equal(event!.cause, "Error");
  assert.equal(event!.requestId, response.headers.get("X-Request-Id"));
  assert.equal(typeof event!.unansweredMs, "number");
  assert.equal(event!.firstByteMs, undefined);
  assert.equal(event!.streamMs, undefined);
  assert.equal(event!.workerMs, undefined);
  assert.doesNotMatch(JSON.stringify(event), /private-/);
});

test("a refusal before dispatch names its guard and claims no runtime time", async (context) => {
  const h = harness(context, { warm: new Error("private-startup-error") });
  const response = await h.forward(modelRequest());
  await h.drain();

  assert.equal(response.status, 503);
  assert.equal(h.events.length, 1);
  const [event] = h.events;
  assert.equal(event!.outcome, "refused");
  assert.equal(event!.status, 503);
  assert.equal(event!.guard, "runtime_readiness");
  assert.equal(typeof event!.dispatchMs, "number");
  for (const hop of ["firstByteMs", "unansweredMs", "streamMs"])
    assert.equal(event![hop], undefined, hop);
  assert.doesNotMatch(JSON.stringify(event), /private-/);
});

for (const [slow, options, hop, other] of [
  ["membership", { admission: 80 }, "admissionMs", "dispatchMs"],
  ["readiness", { warm: 80 }, "dispatchMs", "admissionMs"],
] as const)
  test(`a slow ${slow} check is ${hop}, not ${other}`, async (context) => {
    const h = harness(context, options);
    await (await h.forward(modelRequest())).text();
    await h.drain();

    const [event] = h.events;
    assert.ok(Number(event![hop]) >= 75, `${hop} ${event![hop]}`);
    assert.ok(Number(event![hop]) >= Number(event![other]) + 50, `${other} ${event![other]}`);
  });

test("a refusal routing builds after dispatch is unanswered and names its step", async (context) => {
  const h = harness(context);
  const response = await h.forward(modelRequest(), {
    route: async (
      _request: Request,
      _port: number,
      _pool: string | undefined,
      _legacy: unknown,
      beforeDispatch: () => void,
    ) => {
      beforeDispatch();
      await wait(40);
      return new Response(null, {
        status: 503,
        headers: {
          "X-Signalbox-Runtime-Failure-Step": "fleet_forward",
          "X-Signalbox-Runtime-Failure-Reason": "transport",
        },
      });
    },
  });
  await h.drain();

  assert.equal(response.status, 503);
  const [event] = h.events;
  assert.equal(event!.outcome, "runtime_refused");
  assert.equal(event!.runtimeStep, "fleet_forward");
  assert.equal(event!.runtimeReason, "transport");
  assert.ok(Number(event!.unansweredMs) >= 35, `unansweredMs ${event!.unansweredMs}`);
  assert.equal(event!.firstByteMs, undefined);
  // The refusal answered under the pool's own request ID, so there is no second one to record.
  assert.equal(event!.requestId, response.headers.get("X-Request-Id"));
  assert.equal(event!.responseRequestId, undefined);
});

for (const how of ["thrown", "routed"] as const)
  test(`a call its runtime refused before the container send (${how}) ends unsent, under the ID its re-send keeps`, async (context) => {
    const error = new Error("private-endpoint-refusal");
    rememberRuntimeFailure("endpoint_health", error);
    const h = harness(context, how === "thrown" ? { fail: error } : {});
    const route = async (
      request: Request,
      _port: number,
      _pool: string | undefined,
      _legacy: unknown,
      beforeDispatch: () => void,
    ) => {
      beforeDispatch();
      return unsentRefusal(request, error);
    };
    const response = await h.forward(modelRequest(), how === "routed" ? { route } : {});
    await response.text();
    await h.drain();

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("X-Signalbox-Controller-Unsent"), "1");
    assert.equal(h.events.length, 1);
    const [event] = h.events;
    assert.equal(event!.outcome, "unsent");
    assert.equal(event!.runtimeStep, "endpoint_health");
    assert.equal(event!.requestId, response.headers.get("X-Request-Id"));
    assert.equal(typeof event!.unansweredMs, "number");
    assert.equal(event!.firstByteMs, undefined);
    assert.doesNotMatch(JSON.stringify(event), /private-/);
  });

test("a request that cannot be observed is still forwarded", async (context) => {
  const h = harness(context);
  const failures = context.mock.method(console, "error", () => {});
  const response = await h.forward(modelRequest(), { streams: undefined });
  assert.equal(await response.text().then((body) => body.includes("[DONE]")), true);
  await h.drain();

  assert.equal(response.status, 200);
  assert.equal(h.events.length, 0);
  assert.deepEqual(
    failures.mock.calls.map((call) => call.arguments),
    [["POOL_REQUEST_EVENT_UNAVAILABLE"]],
  );
});

test("the event continues the caller's trace and takes nothing else from its headers", async (context) => {
  const h = harness(context);
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const response = await h.forward(
    modelRequest({
      traceparent: `00-${traceId}-b7ad6b7169203331-01`,
      tracestate: "private-trace-state",
      "x-request-id": "private-caller-id",
    }),
  );
  await response.text();
  await h.drain();

  assert.equal(h.events[0]!.traceId, traceId);
  assert.doesNotMatch(JSON.stringify(h.events), /private-|b7ad6b7169203331/);
});
