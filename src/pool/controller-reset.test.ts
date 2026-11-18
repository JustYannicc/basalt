import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  controllerInstanceEnded,
  controllerReplayDelayMs,
  fetchController,
  type ControllerHop,
} from "./controller-reset.ts";

// Verbatim from production Workers Observability, 2026-11-18T20:01:07.410Z.
const resetMessage =
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";
const reset = () => Object.assign(new Error(resetMessage), { retryable: true });
const env = { SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456" };

function observe(context: TestContext) {
  const log = context.mock.method(console, "error", () => {});
  const sentry: { code: unknown; requestId: unknown }[] = [];
  const deferred: Promise<unknown>[] = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const lines = (await new Response(init?.body).text()).split("\n");
    const event = JSON.parse(lines[2]!);
    sentry.push({ code: event.tags.error_code, requestId: event.tags.request_id });
    return new Response(null, { status: 200 });
  };
  context.after(() => {
    globalThis.fetch = fetch;
  });
  return {
    deferred,
    async events() {
      await Promise.all(deferred);
      const lines = log.mock.calls
        .filter((call) => call.arguments[0] === "POOL_CONTROLLER_INTERRUPTED")
        .map((call) => JSON.parse(String(call.arguments[1])));
      return { lines, sentry };
    },
  };
}

function harness(context: TestContext, attempts: (() => Promise<Response>)[]) {
  const observed = observe(context);
  return Object.assign(controllerHop(attempts, observed.deferred), { events: observed.events });
}

function controllerHop(attempts: (() => Promise<Response>)[], deferred: Promise<unknown>[]) {
  const waits: number[] = [];
  let resolved = 0;
  const hop: ControllerHop = {
    controller: () => {
      const attempt = attempts[resolved++];
      assert.ok(attempt, "no further controller attempt was expected");
      return { fetch: attempt };
    },
    env,
    defer: (work) => deferred.push(work),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  };
  return {
    hop,
    waits,
    get resolved() {
      return resolved;
    },
  };
}

test("the platform's reset error is the replayable class; an overloaded or unrelated error is not", () => {
  assert.equal(controllerInstanceEnded(reset()), true);
  assert.equal(controllerInstanceEnded(new Error(resetMessage)), true);
  assert.equal(controllerInstanceEnded(Object.assign(reset(), { overloaded: true })), false);
  assert.equal(controllerInstanceEnded(new Error("Network connection lost.")), false);
  assert.equal(controllerInstanceEnded(resetMessage), false);
});

test("a safe read cut before its response is replayed once on a re-resolved controller", async (context) => {
  const h = harness(context, [
    async () => {
      throw reset();
    },
    async () => Response.json({ data: [] }),
  ]);
  const response = await fetchController(new Request("https://pool.example/v1/models"), h.hop);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [] });
  assert.equal(h.resolved, 2);
  assert.deepEqual(h.waits, [controllerReplayDelayMs]);
  const { lines, sentry } = await h.events();
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { ...lines[0], requestId: undefined },
    {
      count: 1,
      requestId: undefined,
      outcome: "replayed",
      cause: "instance_ended",
      method: "GET",
      endpoint: "/v1/:operation",
      signalAborted: false,
    },
  );
  assert.deepEqual(sentry, [
    { code: "pool_controller_interrupted", requestId: lines[0].requestId },
  ]);
});

test("a second reset surfaces as retry advice instead of a third attempt", async (context) => {
  const h = harness(context, [
    async () => {
      throw reset();
    },
    async () => {
      throw reset();
    },
  ]);
  const response = await fetchController(
    new Request("https://pool.example/pool/v1/computers"),
    h.hop,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(h.resolved, 2);
  const { lines } = await h.events();
  assert.deepEqual(
    lines.map((line) => line.outcome),
    ["replay_failed"],
  );
  assert.equal(response.headers.get("X-Request-Id"), lines[0].requestId);
});

for (const [path, status, type] of [
  ["/v1/messages", 529, "overloaded_error"],
  ["/v1/responses", 503, "server_error"],
] as const)
  test(`a ${path} call cut before its response is never replayed and gets native retry advice`, async (context) => {
    const h = harness(context, [
      async () => {
        throw reset();
      },
    ]);
    const response = await fetchController(
      new Request(`https://pool.example${path}`, { method: "POST", body: "{}" }),
      h.hop,
    );
    assert.equal(h.resolved, 1);
    assert.deepEqual(h.waits, []);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Retry-After"), "1");
    assert.equal(response.headers.has("x-should-retry"), false);
    assert.equal((await response.json()).error.type, type);
    const { lines, sentry } = await h.events();
    assert.deepEqual(
      lines.map((line) => [line.outcome, line.method, line.endpoint]),
      [["retry_advised", "POST", path]],
    );
    assert.equal(response.headers.get("X-Request-Id"), lines[0].requestId);
    assert.equal(sentry.length, 1);
  });

test("requests the controller records, assigns an account to or meters are never sent twice", async (context) => {
  const recorded = [
    new Request("https://pool.example/v1/messages", { method: "POST", body: "{}" }),
    new Request("https://pool.example/v1/chat/completions", { method: "POST", body: "{}" }),
    new Request("https://pool.example/v1/videos", { method: "POST", body: "{}" }),
    new Request("https://pool.example/v1/videos/video_1"),
    new Request("https://pool.example/v1/responses", { headers: { Upgrade: "websocket" } }),
  ];
  const observed = observe(context);
  for (const request of recorded) {
    const h = controllerHop(
      [
        async () => {
          throw reset();
        },
      ],
      observed.deferred,
    );
    const response = await fetchController(request, h.hop);
    assert.equal(h.resolved, 1, `${request.method} ${request.url}`);
    assert.equal(response.headers.get("Retry-After"), "1");
  }
  const { lines } = await observed.events();
  assert.deepEqual(new Set(lines.map((line) => line.outcome)), new Set(["retry_advised"]));
});

test("a started stream is not replayed and ends with the native retry terminal", async (context) => {
  const encoder = new TextEncoder();
  const started = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  const controllerRequestId = crypto.randomUUID();
  let pulls = 0;
  const h = harness(context, [
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(encoder.encode(started));
            else controller.error(reset());
          },
        }),
        { headers: { "content-type": "text/event-stream", "X-Request-Id": controllerRequestId } },
      ),
  ]);
  const response = await fetchController(
    new Request("https://pool.example/v1/messages", { method: "POST", body: "{}" }),
    h.hop,
  );
  const body = await response.text();
  assert.equal(h.resolved, 1);
  assert.ok(body.startsWith(started));
  assert.match(body.slice(started.length), /^event: error\ndata: .*"overloaded_error"/);
  assert.doesNotMatch(body, /Durable Object/);
  const { lines, sentry } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.cause, line.requestId]),
    [["stream_ended", "instance_ended", controllerRequestId]],
  );
  assert.deepEqual(sentry, [
    { code: "pool_controller_interrupted", requestId: controllerRequestId },
  ]);
});

test("unrelated failures and closed clients keep today's behaviour", async (context) => {
  const observed = observe(context);
  const unrelated = controllerHop(
    [
      async () => {
        throw new Error("private failure");
      },
    ],
    observed.deferred,
  );
  await assert.rejects(
    fetchController(new Request("https://pool.example/v1/models"), unrelated.hop),
    /private failure/,
  );
  assert.equal(unrelated.resolved, 1);
  const closed = new AbortController();
  closed.abort();
  const client = controllerHop(
    [
      async () => {
        throw reset();
      },
    ],
    observed.deferred,
  );
  await assert.rejects(
    fetchController(
      new Request("https://pool.example/v1/models", { signal: closed.signal }),
      client.hop,
    ),
    /no longer active/,
  );
  assert.equal(client.resolved, 1);
  assert.deepEqual((await observed.events()).lines, []);
});

test("a control write cut before its response keeps today's failure and is never sent twice", async (context) => {
  const h = harness(context, [
    async () => {
      throw reset();
    },
  ]);
  await assert.rejects(
    fetchController(
      new Request("https://pool.example/pool/v1/sign-ins", { method: "POST", body: "{}" }),
      h.hop,
    ),
    /no longer active/,
  );
  assert.equal(h.resolved, 1);
  const { lines, sentry } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.method]),
    [["surfaced", "POST"]],
  );
  assert.equal(sentry.length, 1);
});
