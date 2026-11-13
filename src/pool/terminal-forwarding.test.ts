import assert from "node:assert/strict";
import { test } from "node:test";

const workerModule = "./forward.worker.ts";
const {
  forwardPoolRequest,
}: {
  forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
} = await import(workerModule);

async function forward(
  body: BodyInit | ReadableStream<Uint8Array>,
  contentType = "text/event-stream",
  options: {
    status?: number;
    length?: number;
    signal?: AbortSignal;
    failDispatch?: boolean;
    unacknowledged?: boolean;
    pathname?: string;
    start?: () => Promise<void>;
    method?: "GET" | "POST";
  } = {},
) {
  const starts: Record<string, unknown>[] = [],
    finishes: Record<string, unknown>[] = [];
  const observations: number[] = [];
  const dispatched: string[] = [],
    background: Promise<unknown>[] = [];
  const request = new Request(`https://pool.invalid${options.pathname ?? "/v1/messages"}`, {
    method: options.method ?? "POST",
    ...(options.method === "GET" ? {} : { body: "private-prompt" }),
    headers: { "X-Request-Id": "caller-spoof", "X-Basalt-Request-Id": "caller-spoof" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const response = await forwardPoolRequest(request, 8317, {
    env: { POOL_APP_SIGNING_KEY: "fixture" },
    appModel: { pool: "fixture", person: "fixture-person", keyId: 1 },
    memberships: { configured: async () => false },
    streams: {},
    protection: {},
    computers: {
      observeUsage: async (keyId: number) => {
        observations.push(keyId);
      },
    },
    lifecycle: Promise.resolve({ warm: async () => ({ boot_id: "fixture" }) }),
    terminal: {
      start: async (value: Record<string, unknown>) => {
        starts.push(value);
        await options.start?.();
      },
      finish: async (id: string, value: Record<string, unknown>) => {
        finishes.push({ requestId: id, ...value });
      },
    },
    fetch: async (outbound: Request) => {
      dispatched.push(outbound.headers.get("X-Request-Id") ?? "");
      if (options.failDispatch) throw new Error("private-upstream-error");
      return new Response(body, {
        status: options.status ?? 200,
        headers: {
          "Content-Type": contentType,
          ...(options.unacknowledged
            ? {}
            : { "X-Basalt-Request-Id": outbound.headers.get("X-Basalt-Request-Id") ?? "" }),
          ...(options.length === undefined ? {} : { "Content-Length": String(options.length) }),
        },
      });
    },
    defer: (work: Promise<unknown>) => {
      background.push(work);
    },
  });
  return {
    response,
    starts,
    finishes,
    dispatched,
    observations,
    drain: async () => {
      await Promise.all(background);
    },
  };
}

test("a truncated 200 is joined to a server-generated dispatch ID without retaining content", async () => {
  const f = await forward(
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"private-response"}}\n\n',
  );
  assert.equal(f.response.status, 200);
  await f.response.text();
  await f.drain();
  assert.equal(f.starts.length, 1);
  assert.equal(f.finishes.length, 1);
  const id = f.starts[0]!.requestId;
  assert.match(String(id), /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.dispatched, [id]);
  assert.equal(f.response.headers.get("X-Request-Id"), id);
  assert.partialDeepStrictEqual(f.finishes[0], {
    requestId: id,
    outcome: "truncated",
    status: 200,
  });
  assert.doesNotMatch(JSON.stringify([f.starts, f.finishes]), /private-|caller-spoof/);
});

for (const [name, body, type, outcome] of [
  [
    "Messages completion",
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    "text/event-stream",
    "complete",
  ],
  [
    "Responses completion with multiline data",
    'event: response.completed\ndata: {\ndata: "type":"response.completed",\ndata: "response":{"status":"completed"}}\n\n',
    "text/event-stream",
    "complete",
  ],
  [
    "provider failure in a 200 SSE",
    'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"private-provider"}}}\n\n',
    "text/event-stream",
    "provider_failed",
  ],
  [
    "provider incomplete in a 200 SSE",
    'data: {"type":"response.incomplete"}\n\n',
    "text/event-stream",
    "provider_failed",
  ],
  [
    "Chat completion",
    'data: {"choices":[]}\r\n\r\ndata: [DONE]\r\n\r\n',
    "text/event-stream",
    "complete",
  ],
  ["undispatched SSE terminator", "data: [DONE]", "text/event-stream", "truncated"],
  [
    "empty-key nested fake terminal",
    'data: {"":{"type":"response.completed"}}\n\n',
    "text/event-stream",
    "truncated",
  ],
  [
    "invalid JSON whitespace",
    'data: {"type"\u000b:"response.completed"}\n\n',
    "text/event-stream",
    "truncated",
  ],
  [
    "nested fake terminal",
    'data: {"type":"content_block_delta","delta":{"type":"response.completed","text":"private-response"}}\n\n',
    "text/event-stream",
    "truncated",
  ],
  [
    "nonstream response",
    '{"type":"message","content":[{"text":"private-response"}]}',
    "application/json",
    "complete",
  ],
  [
    "nonstream provider error",
    '{"error":{"message":"private-provider"}}',
    "application/json",
    "provider_failed",
  ],
  [
    "truncated nonstream response",
    '{"content":[{"text":"private-response',
    "application/json",
    "truncated",
  ],
] as const)
  test(`${name} preserves the response and records its actual outcome`, async () => {
    const encoded = new TextEncoder().encode(body);
    let offset = 0;
    const f = await forward(
      new ReadableStream({
        pull(controller) {
          if (offset === encoded.length) controller.close();
          else {
            controller.enqueue(encoded.slice(offset, offset + 7));
            offset = Math.min(encoded.length, offset + 7);
          }
        },
      }),
      type,
      {
        pathname:
          name.startsWith("Responses") || name.startsWith("provider ")
            ? "/v1/responses"
            : name.startsWith("Chat") || name === "undispatched SSE terminator"
              ? "/v1/chat/completions"
              : "/v1/messages",
      },
    );
    assert.equal(await f.response.text(), body);
    await f.drain();
    assert.equal(f.finishes.length, 1);
    assert.partialDeepStrictEqual(f.finishes[0], {
      outcome,
      status: 200,
      bytes: encoded.byteLength,
    });
    assert.doesNotMatch(JSON.stringify([f.starts, f.finishes]), /private-/);
  });

test("a large terminal event stays complete without buffering or logging its output", async () => {
  const body = `data: {"type":"response.completed","response":{"output":[{"text":"${"x".repeat(4 * 1024 * 1024)}"}],"status":"completed"}}\n\n`;
  const f = await forward(body, "text/event-stream", { pathname: "/v1/responses" });
  assert.equal(await f.response.text(), body);
  await f.drain();
  assert.equal(f.finishes[0]!.outcome, "complete");
  assert.ok(JSON.stringify([f.starts, f.finishes]).length < 700);
});

test("client cancellation after dispatch is retained once", async () => {
  let cancelled = 0;
  const f = await forward(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    }),
  );
  await f.response.body!.cancel();
  await f.drain();
  assert.equal(cancelled, 1);
  assert.equal(f.finishes.length, 1);
  assert.equal(f.finishes[0]!.outcome, "client_closed");
});

test("an aborted request after headers closes a pending body and records client closure", async () => {
  const abort = new AbortController();
  const f = await forward(new ReadableStream<Uint8Array>(), "text/event-stream", {
    signal: abort.signal,
  });
  const read = f.response.text();
  abort.abort();
  await assert.rejects(read, /Connection ended/);
  await f.drain();
  assert.equal(f.finishes.length, 1);
  assert.equal(f.finishes[0]!.outcome, "client_closed");
});

test("a short Content-Length response cannot be reported complete", async () => {
  const f = await forward("{}", "application/json", { length: 100 });
  await f.response.text();
  await f.drain();
  assert.equal(f.finishes[0]!.outcome, "truncated");
});

test("a dispatch failure joins the 502 response to terminal evidence without recording another refusal", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await forward("", "application/json", { failDispatch: true });
  assert.equal(f.response.status, 502);
  await f.response.text();
  await f.drain();
  assert.equal(f.finishes.length, 1);
  assert.partialDeepStrictEqual(f.finishes[0], {
    requestId: f.response.headers.get("X-Request-Id"),
    outcome: "unavailable",
    status: 502,
  });
});

test("an old producer stays explicitly unmeasured instead of creating an unjoined success", async () => {
  const f = await forward('{"type":"message"}', "application/json", { unacknowledged: true });
  assert.equal(await f.response.text(), '{"type":"message"}');
  await f.drain();
  assert.equal(f.finishes.length, 1);
  assert.equal(f.finishes[0]!.outcome, "unavailable");
});

test("a terminal from another protocol cannot complete a Messages response", async () => {
  const f = await forward('data: {"type":"response.completed"}\n\n');
  await f.response.text();
  await f.drain();
  assert.equal(f.finishes[0]!.outcome, "truncated");
});

for (const [type, outcome] of [
  ["message_stop", "complete"],
  ["error", "provider_failed"],
] as const)
  test(`a client can stop reading after the ${type} event without changing its terminal outcome`, async () => {
    const body = new TextEncoder().encode(`data: ${JSON.stringify({ type })}\n\n`);
    const f = await forward(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
        },
      }),
    );
    const reader = f.response.body!.getReader();
    assert.deepEqual((await reader.read()).value, body);
    await reader.cancel();
    await f.drain();
    assert.equal(f.finishes.length, 1);
    assert.equal(f.finishes[0]!.outcome, outcome);
  });

test("delayed persistence cannot move the request terminal into a later reliability window", async (t) => {
  const now = Date.parse("2026-11-13T16:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const saved = Promise.withResolvers<void>();
  const f = await forward('data: {"type":"message_stop"}\n\n', "text/event-stream", {
    start: () => saved.promise,
  });
  await f.response.text();
  t.mock.timers.tick(60_000);
  saved.resolve();
  await f.drain();
  assert.equal(f.finishes[0]!.at, new Date(now).toISOString());
});

for (const pathname of ["/v1/images/generations", "/v1/images/edits", "/v1/responses/compact"])
  test(`billable JSON ${pathname} has a dispatch identity and observed body terminal`, async () => {
    const f = await forward('{"data":[]}', "application/json", { pathname });
    await f.response.text();
    await f.drain();
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.dispatched, [f.starts[0]!.requestId]);
    assert.equal(f.finishes[0]!.outcome, "complete");
  });

for (const pathname of ["/v1/audio/speech", "/v1/tts"])
  test(`billable audio ${pathname} preserves binary bytes and records HTTP completion`, async () => {
    const body = new Uint8Array([0, 255, 1, 0, 128]);
    const f = await forward(body, "audio/mpeg", { pathname, length: body.length });
    assert.deepEqual(new Uint8Array(await f.response.arrayBuffer()), body);
    await f.drain();
    assert.equal(f.starts.length, 1);
    assert.equal(f.finishes[0]!.outcome, "complete");
  });
for (const pathname of [
  "/v1/videos",
  "/v1/videos/generations",
  "/v1/videos/edits",
  "/v1/videos/extensions",
  "/v1/videos/private-job",
])
  test(`billable video ${pathname} observes the HTTP request without declaring the async job finished`, async () => {
    const f = await forward('{"status":"pending"}', "application/json", {
      pathname,
      method: pathname.endsWith("private-job") ? "GET" : "POST",
    });
    await f.response.text();
    await f.drain();
    assert.equal(f.starts.length, 1);
    assert.equal(f.finishes[0]!.outcome, "complete");
    assert.doesNotMatch(JSON.stringify(f.finishes), /pending|private-job/);
  });
for (const [pathname, type] of [
  ["/v1/images/generations", "image_generation.completed"],
  ["/v1/images/edits", "image_edit.completed"],
])
  test(`image SSE ${pathname} waits for the batch EOF and rejects a partial-only EOF`, async () => {
    const f = await forward(
      `data: {"type":"${type}","b64_json":"private-image"}\n\n`,
      "text/event-stream",
      { pathname },
    );
    await f.response.text();
    await f.drain();
    assert.equal(f.finishes[0]!.outcome, "complete");
    const missing = await forward(
      'data: {"type":"image_generation.partial_image"}\n\n',
      "text/event-stream",
      { pathname },
    );
    await missing.response.text();
    await missing.drain();
    assert.equal(missing.finishes[0]!.outcome, "truncated");
  });
for (const pathname of [
  "/v1/realtime",
  "/v1/realtime/sessions",
  "/v1/live",
  "/v1/messages/count_tokens",
])
  test(`non-model control ${pathname} creates no terminal attempt`, async () => {
    const f = await forward("{}", "application/json", { pathname });
    await f.response.text();
    await f.drain();
    assert.deepEqual(f.starts, []);
    assert.deepEqual(f.finishes, []);
  });

for (const pathname of ["/v1/audio/speech", "/v1/tts"])
  test(`audio ${pathname} distinguishes JSON errors, cut bodies and client cancellation`, async () => {
    const failed = await forward('{"error":{"message":"private-error"}}', "application/json", {
      pathname,
    });
    await failed.response.text();
    await failed.drain();
    assert.equal(failed.finishes[0]!.outcome, "provider_failed");
    const cut = await forward(new Uint8Array([1, 2]), "audio/mpeg", { pathname, length: 3 });
    await cut.response.arrayBuffer();
    await cut.drain();
    assert.equal(cut.finishes[0]!.outcome, "truncated");
    const canceled = await forward(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
      }),
      "audio/mpeg",
      { pathname },
    );
    const reader = canceled.response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await canceled.drain();
    assert.equal(canceled.finishes[0]!.outcome, "client_closed");
  });

test("an image batch does not finish on its first image and preserves a later error", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      stream = c;
    },
  });
  const f = await forward(body, "text/event-stream", { pathname: "/v1/images/generations" });
  const reader = f.response.body!.getReader();
  stream.enqueue(new TextEncoder().encode('data: {"type":"image_generation.completed"}\n\n'));
  await reader.read();
  await f.drain();
  assert.equal(f.finishes.length, 0);
  stream.enqueue(
    new TextEncoder().encode('event: error\ndata: {"error":{"message":"private-error"}}\n\n'),
  );
  stream.close();
  while (!(await reader.read()).done) {}
  await f.drain();
  assert.equal(f.finishes[0]!.outcome, "provider_failed");
});

test("video polls retain terminal evidence without repeating first-use account reconciliation", async () => {
  const poll = await forward('{"status":"pending"}', "application/json", {
    pathname: "/v1/videos/private-job",
    method: "GET",
  });
  await poll.response.text();
  await poll.drain();
  assert.equal(poll.starts.length, 1);
  assert.equal(poll.finishes[0]!.outcome, "complete");
  assert.deepEqual(poll.observations, []);
  const create = await forward('{"status":"pending"}', "application/json", {
    pathname: "/v1/videos",
    method: "POST",
  });
  await create.response.text();
  await create.drain();
  assert.deepEqual(create.observations, [1]);
});

test("a delivered video status poll reports delivery separately from a failed job", async () => {
  const body =
    '{"id":"private-job","status":"failed","error":{"code":"job_failed","message":"private-error"}}';
  const poll = await forward(body, "application/json", {
    pathname: "/v1/videos/private-job",
    method: "GET",
  });
  assert.equal(await poll.response.text(), body);
  await poll.drain();
  assert.equal(poll.finishes[0]!.outcome, "complete");
  assert.doesNotMatch(JSON.stringify(poll.finishes), /private-|job_failed/);
  const failed = await forward(body, "application/json", {
    pathname: "/v1/videos/private-job",
    method: "GET",
    status: 404,
  });
  await failed.response.text();
  await failed.drain();
  assert.equal(failed.finishes[0]!.outcome, "provider_failed");
  const cut = await forward('{"status":"failed"', "application/json", {
    pathname: "/v1/videos/private-job",
    method: "GET",
  });
  await cut.response.text();
  await cut.drain();
  assert.equal(cut.finishes[0]!.outcome, "truncated");
  const create = await forward(body, "application/json", {
    pathname: "/v1/videos",
    method: "POST",
  });
  await create.response.text();
  await create.drain();
  assert.equal(create.finishes[0]!.outcome, "provider_failed");
});
