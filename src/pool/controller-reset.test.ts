import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  modelCallReplayable,
  upstreamOutcomeUnknown,
} from "../../clients/contracts/model-error.ts";
import {
  controllerHeldBytes,
  controllerHoldBytes,
  controllerInstanceEnded,
  controllerReplayDelayMs,
  controllerReplayWindowMs,
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
      const marked = (marker: string) =>
        log.mock.calls
          .filter((call) => call.arguments[0] === marker)
          .map((call) => JSON.parse(String(call.arguments[1])));
      return {
        lines: marked("POOL_CONTROLLER_INTERRUPTED"),
        calls: marked("POOL_CONTROLLER_CALL_FAILED"),
        logged: JSON.stringify(log.mock.calls),
        sentry,
      };
    },
  };
}

type Attempt = (request: Request) => Promise<Response>;
const fails = (error: () => unknown) => async () => {
  throw error();
};

function harness(context: TestContext, attempts: Attempt[]) {
  const observed = observe(context);
  return Object.assign(controllerHop(attempts, observed.deferred), { events: observed.events });
}

function controllerHop(attempts: Attempt[], deferred: Promise<unknown>[]) {
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

test("the platform's reset error or retryable flag is the replay class; an overloaded one is not", () => {
  assert.equal(controllerInstanceEnded(reset()), true);
  assert.equal(controllerInstanceEnded(new Error(resetMessage)), true);
  assert.equal(
    controllerInstanceEnded(
      Object.assign(new Error("Network connection lost."), { retryable: true }),
    ),
    true,
  );
  assert.equal(controllerInstanceEnded(Object.assign(reset(), { overloaded: true })), false);
  assert.equal(controllerInstanceEnded(new Error("Network connection lost.")), false);
  assert.equal(controllerInstanceEnded(resetMessage), false);
});

test("a model call cut before its response is sent once more, with its body, to a new instance", async (context) => {
  const body = JSON.stringify({
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: "hi" }],
  });
  const received: { body: string; version: string | null; same: boolean }[] = [];
  const original = new Request("https://pool.example/v1/messages", {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body,
  });
  const h = harness(context, [
    fails(reset),
    async (request) => {
      received.push({
        body: await request.text(),
        version: request.headers.get("anthropic-version"),
        same: request === original,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  ]);
  const response = await fetchController(original, h.hop);
  assert.equal(response.status, 200);
  assert.equal(h.resolved, 2);
  assert.deepEqual(h.waits, [controllerReplayDelayMs]);
  assert.deepEqual(received, [{ body, version: "2023-06-01", same: false }]);
  const { lines, calls, logged, sentry } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.saved, line.cause, line.endpoint]),
    [["replayed", true, "instance_ended", "/v1/messages"]],
  );
  assert.deepEqual(
    calls.map((call) => [call.attempt, call.messageClass, call.retryable, call.overloaded]),
    [[1, "instance_inactive", true, null]],
  );
  assert.doesNotMatch(logged, /no longer active|claude-opus|hi"/);
  assert.deepEqual(sentry, [
    { code: "pool_controller_interrupted", requestId: lines[0].requestId },
  ]);
});

test("a safe read cut before its response is sent once more to a new instance", async (context) => {
  const h = harness(context, [fails(reset), async () => Response.json({ data: [] })]);
  const response = await fetchController(new Request("https://pool.example/v1/models"), h.hop);
  assert.deepEqual(await response.json(), { data: [] });
  assert.equal(h.resolved, 2);
  const { lines } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.saved, line.method, line.endpoint]),
    [["replayed", true, "GET", "/v1/:operation"]],
  );
});

for (const [path, status, type] of [
  ["/v1/messages", 503, "api_error"],
  ["/v1/responses", 503, "server_error"],
] as const)
  test(`a ${path} call that meets a second reset gets native retry advice, not a third send`, async (context) => {
    const h = harness(context, [fails(reset), fails(reset)]);
    const response = await fetchController(
      new Request(`https://pool.example${path}`, { method: "POST", body: "{}" }),
      h.hop,
    );
    assert.equal(h.resolved, 2);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Retry-After"), "1");
    assert.equal(response.headers.has("x-should-retry"), false);
    assert.equal((await response.json()).error.type, type);
    const { lines, calls } = await h.events();
    assert.deepEqual(
      lines.map((line) => [line.outcome, line.saved]),
      [["replay_failed", false]],
    );
    assert.deepEqual(
      calls.map((call) => call.attempt),
      [1, 2],
    );
    assert.equal(response.headers.get("X-Request-Id"), lines[0].requestId);
  });

test("a model body too large to hold is sent once and gets native retry advice", async (context) => {
  const h = harness(context, [fails(reset)]);
  const response = await fetchController(
    new Request("https://pool.example/v1/messages", {
      method: "POST",
      body: new Uint8Array(controllerHoldBytes + 1),
    }),
    h.hop,
  );
  assert.equal(h.resolved, 1);
  assert.equal(response.status, 503);
  const { lines } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.saved, line.reason]),
    [["retry_advised", false, "body_too_large"]],
  );
});

test("a call cut after the device assertion's window gets retry advice instead of a stale replay", async (context) => {
  let clock = 0;
  const h = harness(context, [
    async () => {
      clock = controllerReplayWindowMs + 1;
      throw reset();
    },
  ]);
  h.hop.now = () => clock;
  const response = await fetchController(
    new Request("https://pool.example/v1/responses/compact", { method: "POST", body: "{}" }),
    h.hop,
  );
  assert.equal(h.resolved, 1);
  assert.equal(response.status, 503);
  const { lines, calls } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.saved, line.reason]),
    [["retry_advised", false, "too_late"]],
  );
  assert.equal(calls[0].requestId, lines[0].requestId);
  assert.equal(calls[0].elapsedMs, controllerReplayWindowMs + 1);
});

test("a replay the new instance refuses is not counted as saved", async (context) => {
  const h = harness(context, [fails(reset), async () => new Response(null, { status: 503 })]);
  const response = await fetchController(
    new Request("https://pool.example/v1/messages", { method: "POST", body: "{}" }),
    h.hop,
  );
  assert.equal(response.status, 503);
  const { lines } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.saved]),
    [["replayed", false]],
  );
});

test("only allow-listed model routes are replayable; a new route is not until it is added", () => {
  for (const path of [
    "/v1/messages",
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/models",
    "/v1/systemone",
    "/typesafe/v1/systemone",
    "/v1beta/models/gemini-pro:streamGenerateContent",
  ])
    assert.equal(modelCallReplayable(path), true, path);
  for (const path of [
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/videos",
    "/v1/videos/generations",
    "/v1/videos/edits",
    "/v1/audio/speech",
    "/v1/tts",
    "/v1/audio/transcriptions",
    "/v1/a-route-added-later",
  ])
    assert.equal(modelCallReplayable(path), false, path);
});

test("the unknown-outcome answer is cautious unless its route is replayable", async () => {
  for (const [pathname, retry] of [
    [undefined, false],
    ["/v1/videos", false],
    ["/v1/messages", true],
  ] as const) {
    const response = upstreamOutcomeUnknown("00000000-0000-4000-8000-000000000000", pathname);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-should-retry"), retry ? null : "false");
    assert.equal(response.headers.get("retry-after"), retry ? "1" : null);
    const body = await response.json();
    assert.equal(body.error.retryable, retry);
    assert.match(body.error.message, retry ? /Retry it/ : /Do not retry automatically/);
  }
});

test("a call that starts a paid job is never sent twice and gets the cautious answer", async (context) => {
  const observed = observe(context);
  for (const path of [
    "/v1/images/generations",
    "/v1/videos",
    "/v1/videos/generations",
    "/v1/audio/speech",
  ]) {
    const h = controllerHop([fails(reset)], observed.deferred);
    const response = await fetchController(
      new Request(`https://pool.example${path}`, { method: "POST", body: "{}" }),
      h.hop,
    );
    assert.equal(h.resolved, 1, path);
    assert.equal(response.status, 502, path);
    assert.equal(response.headers.get("x-should-retry"), "false", path);
    const body = await response.json();
    assert.equal(body.error.retryable, false, path);
    assert.match(body.error.message, /outcome is unknown/, path);
  }
  const poll = controllerHop([fails(reset)], observed.deferred);
  const status = await fetchController(
    new Request("https://pool.example/v1/videos/video_1"),
    poll.hop,
  );
  assert.equal(poll.resolved, 1);
  assert.equal(status.status, 503);
  const { lines } = await observed.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.saved, line.reason]),
    [
      ["outcome_unknown", false, "not_replayable"],
      ["outcome_unknown", false, "not_replayable"],
      ["outcome_unknown", false, "not_replayable"],
      ["outcome_unknown", false, "not_replayable"],
      ["retry_advised", false, "not_replayable"],
    ],
  );
});

test("a control write cut before its response keeps today's failure and is never sent twice", async (context) => {
  const h = harness(context, [fails(reset)]);
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
    lines.map((line) => [line.outcome, line.saved, line.reason]),
    [["surfaced", false, "not_replayable"]],
  );
  assert.equal(sentry.length, 1);
});

test("a model socket cut before its upgrade gets retry advice and is never sent twice", async (context) => {
  const h = harness(context, [fails(reset)]);
  const response = await fetchController(
    new Request("https://pool.example/v1/responses", { headers: { Upgrade: "websocket" } }),
    h.hop,
  );
  assert.equal(h.resolved, 1);
  assert.equal(response.status, 503);
  const { lines } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.reason]),
    [["retry_advised", "not_replayable"]],
  );
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
  assert.match(body.slice(started.length), /^event: error\ndata: .*"api_error"/);
  assert.doesNotMatch(body, /Durable Object/);
  const { lines, sentry } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.saved, line.cause, line.requestId]),
    [["stream_ended", false, "instance_ended", controllerRequestId]],
  );
  assert.deepEqual(sentry, [
    { code: "pool_controller_interrupted", requestId: controllerRequestId },
  ]);
});

test("unrelated failures and closed clients keep today's behaviour", async (context) => {
  const observed = observe(context);
  const unrelated = controllerHop([fails(() => new Error("private failure"))], observed.deferred);
  await assert.rejects(
    fetchController(
      new Request("https://pool.example/v1/messages", { method: "POST", body: "{}" }),
      unrelated.hop,
    ),
    /private failure/,
  );
  assert.equal(unrelated.resolved, 1);
  const closed = new AbortController();
  closed.abort();
  const client = controllerHop([fails(reset)], observed.deferred);
  await assert.rejects(
    fetchController(
      new Request("https://pool.example/v1/models", { signal: closed.signal }),
      client.hop,
    ),
    /no longer active/,
  );
  assert.equal(client.resolved, 1);
  const { lines, calls, logged } = await observed.events();
  assert.deepEqual(lines, []);
  assert.deepEqual(
    calls.map((call) => call.messageClass),
    ["other", "instance_inactive"],
  );
  assert.doesNotMatch(logged, /private failure/);
});

test("a client leaving a stream is not a controller interruption", async (context) => {
  const h = harness(context, [
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  ]);
  const response = await fetchController(
    new Request("https://pool.example/v1/messages", { method: "POST", body: "{}" }),
    h.hop,
  );
  const reader = response.body!.getReader();
  await reader.read();
  const waiting = reader.read();
  await reader.cancel("client left");
  assert.equal((await waiting).done, true);
  const { lines, sentry } = await h.events();
  assert.deepEqual(lines, []);
  assert.deepEqual(sentry, []);
});

test("a complete stream passes through unchanged and records nothing", async (context) => {
  const body =
    'event: message_start\ndata: {"type":"message_start"}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const h = harness(context, [
    async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  ]);
  const response = await fetchController(
    new Request("https://pool.example/v1/messages", { method: "POST", body: "{}" }),
    h.hop,
  );
  assert.equal(await response.text(), body);
  const { lines, calls, sentry } = await h.events();
  assert.deepEqual(lines, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(sentry, []);
});

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a held body is dropped as soon as the controller answers", async (context) => {
  const h = harness(context, [async (request) => new Response(await request.text())]);
  const response = await fetchController(
    new Request("https://pool.example/v1/messages", { method: "POST", body: "x".repeat(4096) }),
    h.hop,
  );
  assert.equal((await response.text()).length, 4096);
  assert.equal(controllerHeldBytes(), 0);
});

test("a held body is dropped when the replay window closes, and the cut gets advice", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let fail!: (error: unknown) => void;
  const h = harness(context, [
    () =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      }),
  ]);
  const pending = fetchController(
    new Request("https://pool.example/v1/messages", { method: "POST", body: "x".repeat(4096) }),
    h.hop,
  );
  while (controllerHeldBytes() === 0) await turn();
  context.mock.timers.tick(controllerReplayWindowMs);
  assert.equal(controllerHeldBytes(), 0);
  fail(reset());
  const response = await pending;
  assert.equal(h.resolved, 1);
  assert.equal(response.status, 503);
  const { lines } = await h.events();
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.reason]),
    [["retry_advised", "too_late"]],
  );
});

test("past the isolate's hold budget a call is forwarded unheld, logged and not replayed", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const budget = 1024 * 1024;
  let finish!: (response: Response) => void;
  const holding = controllerHop(
    [
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ],
    [],
  );
  holding.hop.holdBudgetBytes = budget;
  const first = fetchController(
    new Request("https://pool.example/v1/messages", {
      method: "POST",
      body: new Uint8Array(768 * 1024),
    }),
    holding.hop,
  );
  while (controllerHeldBytes() < 768 * 1024) await turn();
  const received: number[] = [];
  const unheld = controllerHop(
    [
      async (request) => (
        received.push((await request.arrayBuffer()).byteLength),
        Response.json({})
      ),
    ],
    [],
  );
  unheld.hop.holdBudgetBytes = budget;
  const served = await fetchController(
    new Request("https://pool.example/v1/messages", {
      method: "POST",
      body: new Uint8Array(512 * 1024),
    }),
    unheld.hop,
  );
  assert.equal(served.status, 200);
  assert.deepEqual(received, [512 * 1024]);
  const cut = controllerHop([fails(reset)], []);
  cut.hop.holdBudgetBytes = budget;
  const advised = await fetchController(
    new Request("https://pool.example/v1/messages", {
      method: "POST",
      body: new Uint8Array(512 * 1024),
    }),
    cut.hop,
  );
  assert.equal(cut.resolved, 1);
  assert.equal(advised.status, 503);
  finish(Response.json({}));
  await (await first).text();
  assert.equal(controllerHeldBytes(), 0);
  const marked = (marker: string) =>
    log.mock.calls
      .filter((call) => call.arguments[0] === marker)
      .map((call) => JSON.parse(String(call.arguments[1])));
  assert.equal(marked("POOL_CONTROLLER_HOLD_SKIPPED").length, 2);
  assert.deepEqual(
    marked("POOL_CONTROLLER_INTERRUPTED").map((line) => [line.outcome, line.reason]),
    [["retry_advised", "hold_budget_full"]],
  );
});
