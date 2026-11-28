// The stage Worker's key gate, its two account profiles and profile b's control, run against a
// stand-in for aimock behind the container's port.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chaosFrom,
  forward,
  gate,
  mockCalls,
  profileControlPath,
  profileRoute,
  RETRY_AFTER_SECONDS,
} from "./gateway.ts";
import { refusalPath } from "./mock-start.ts";
import { sendMarker } from "./prompts.ts";
import { durableSends, recorded, sendsPage, sendsPath } from "./sends.ts";
import { memorySendStorage } from "./test/memory-sends.ts";
import { paths, requestBody, verdict } from "./shapes.mjs";
import { chaos429Body } from "./test/aimock-shapes.mjs";
import { fakeAimock, memoryStore } from "./test/fake-aimock.mjs";

const key = "k".repeat(43);
const origin = "https://basalt-emulated-upstream-gateway.example.workers.dev";
const fields = ["drop", "malformed", "disconnect", "ratelimit", "latency"];
const chaosOf = (values) =>
  Object.fromEntries(fields.map((field) => [`x-aimock-chaos-${field}`, values[field] ?? "0"]));
const modelCall = (path, { shape = "messages", headers = {}, stream = true } = {}) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(requestBody(shape, false, { stream })),
  });

test("a profile prefix is stripped; any other path is not a profile", () => {
  assert.deepEqual(profileRoute("/a/v1/messages"), { profile: "a", pathname: "/v1/messages" });
  assert.deepEqual(profileRoute("/b/v1/chat/completions"), {
    profile: "b",
    pathname: "/v1/chat/completions",
  });
  assert.deepEqual(profileRoute("/b"), { profile: "b", pathname: "/" });
  assert.deepEqual(profileRoute("/a/"), { profile: "a", pathname: "/" });
  for (const path of [
    "/v1/messages",
    "/ab/v1/messages",
    "/A/v1/messages",
    "/c/v1",
    "/",
    "/_emulated/profiles/b",
  ])
    assert.equal(profileRoute(path), undefined, path);
});

test("each profile sets every chaos field to its own, whatever the caller sent", async () => {
  const aimock = fakeAimock({ key });
  const caller = { "x-aimock-chaos-ratelimit": "1", "x-aimock-chaos-drop": "1" };
  const profileB = { rateLimitRate: 0.25, latencyMs: 7000 };
  for (const shape of Object.keys(paths)) {
    const answer = await forward(
      aimock.port,
      modelCall(`/a${paths[shape]}?beta=true`, { shape, headers: caller }),
      profileB,
    );
    assert.equal(answer.status, 200, shape);
    assert.equal(verdict(shape, false, await answer.text()).pass, true, shape);
  }
  await (await forward(aimock.port, modelCall(`/b${paths.messages}`), profileB)).text();
  assert.deepEqual(
    aimock.calls.map((call) => [call.path, call.search]),
    [
      ["/v1/chat/completions", "?beta=true"],
      ["/v1/responses", "?beta=true"],
      ["/v1/messages", "?beta=true"],
      ["/v1/messages", ""],
    ],
  );
  for (const call of aimock.calls.slice(0, 3)) assert.deepEqual(call.chaos, chaosOf({}));
  assert.deepEqual(aimock.calls[3].chaos, chaosOf({ ratelimit: "0.25", latency: "7000" }));
});

test("an unprefixed call reaches the mock as it came, chaos headers and 429 included", async () => {
  const aimock = fakeAimock({ key });
  const answer = await forward(
    aimock.port,
    modelCall(paths.messages, { headers: { "x-aimock-chaos-ratelimit": "1" } }),
    { rateLimitRate: 0, latencyMs: 0 },
  );
  assert.equal(answer.status, 429);
  assert.equal(answer.headers.get("retry-after"), "1");
  assert.equal(answer.headers.get("x-ratelimit-reset-tokens"), "6m0s");
  assert.deepEqual(aimock.calls[0].chaos, { "x-aimock-chaos-ratelimit": "1" });
  assert.equal(aimock.calls[0].path, "/v1/messages");
});

test("profile b's 429 says Retry-After 15 and no other time; profile a stays clean beside it", async () => {
  // Home ends a 429 cooldown exactly at a provider time of 10 s or more; shorter only feeds its backoff.
  assert.ok(Number.isInteger(RETRY_AFTER_SECONDS) && RETRY_AFTER_SECONDS >= 10);
  const aimock = fakeAimock({ key });
  const limited = { rateLimitRate: 1, latencyMs: 0 };
  for (const shape of Object.keys(paths)) {
    const answer = await forward(aimock.port, modelCall(`/b${paths[shape]}`, { shape }), limited);
    assert.equal(answer.status, 429, shape);
    assert.equal(answer.headers.get("retry-after"), "15", shape);
    assert.deepEqual(
      [...answer.headers.keys()].filter((name) => name.startsWith("x-ratelimit-")),
      [],
      shape,
    );
    assert.equal(await answer.text(), chaos429Body, shape);
  }
  const beside = await forward(aimock.port, modelCall(`/a${paths.messages}`), limited);
  assert.equal(beside.status, 200);
  assert.equal(verdict("messages", false, await beside.text()).pass, true);
});

test("profile b's control reads and replaces both faults, refuses anything else, and never starts the mock", async () => {
  const aimock = fakeAimock({ key });
  const store = memoryStore();
  let starts = 0;
  const answer = mockCalls({
    store,
    key,
    start: async () => {
      starts++;
      return aimock.port;
    },
  });
  const url = `${origin}${profileControlPath}`;
  const read = async () => (await answer(new Request(url))).json();
  const put = (body) => answer(new Request(url, { method: "PUT", body }));
  assert.deepEqual(await read(), {
    profile: "b",
    rateLimitRate: 0,
    latencyMs: 0,
  });
  const set = await put(JSON.stringify({ rateLimitRate: 0.25, latencyMs: 12000 }));
  assert.equal(set.status, 200);
  assert.deepEqual(await read(), {
    profile: "b",
    rateLimitRate: 0.25,
    latencyMs: 12000,
  });
  for (const body of [
    { rateLimitRate: 1.5, latencyMs: 0 },
    { rateLimitRate: -0.1, latencyMs: 0 },
    { rateLimitRate: 1e-7, latencyMs: 0 },
    { rateLimitRate: "0.5", latencyMs: 0 },
    { rateLimitRate: 0.5, latencyMs: 30001 },
    { rateLimitRate: 0.5, latencyMs: 1.5 },
    { rateLimitRate: 0.5, latencyMs: -1 },
    { rateLimitRate: 0.5 },
    { rateLimitRate: 0.5, latencyMs: 0, dropRate: 1 },
    [0.5, 0],
    null,
  ]) {
    const refused = await put(JSON.stringify(body));
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal((await put("{not json")).status, 400);
  assert.equal((await answer(new Request(url, { method: "DELETE" }))).status, 405);
  assert.deepEqual(store.value, { rateLimitRate: 0.25, latencyMs: 12000 });
  assert.equal(starts, 0);
  // The next call through b carries what the control set; the limits are aimock's own.
  await (await answer(modelCall(`/b${paths.messages}`))).text();
  assert.equal(starts, 1);
  assert.deepEqual(aimock.calls[0].chaos, chaosOf({ ratelimit: "0.25", latency: "12000" }));
  assert.deepEqual(chaosFrom({ rateLimitRate: 1, latencyMs: 30000 }), {
    rateLimitRate: 1,
    latencyMs: 30000,
  });
});

test("the mock's own refusal still goes to the mock, behind the start", async () => {
  const aimock = fakeAimock({ key });
  const answer = mockCalls({ store: memoryStore(), key, start: async () => aimock.port });
  assert.deepEqual(await (await answer(new Request(`${origin}${refusalPath}`))).json(), {
    missing: { status: 401, aimock: true },
    wrong: { status: 401, aimock: true },
  });
});

test("the key gate refuses every route without the right key before anything answers", async () => {
  const forwarded = [];
  const next = async (request) => {
    forwarded.push(new URL(request.url).pathname);
    return new Response("{}");
  };
  const routes = [
    "/v1/models",
    `/a${paths.messages}`,
    `/b${paths.messages}`,
    `/a${paths.chat}`,
    profileControlPath,
    refusalPath,
    sendsPath,
  ];
  const wrong = [
    {},
    { authorization: "Bearer wrong-key-of-the-right-length-000000" },
    { authorization: `Bearer ${key}x` },
    { authorization: `Bearer ${key.slice(1)}` },
    { authorization: "Bearer " },
    { authorization: `bearer ${key}` },
    { authorization: key },
    { "x-api-key": "wrong" },
    { "x-api-key": "" },
  ];
  for (const path of routes)
    for (const headers of wrong)
      for (const method of ["GET", "PUT"]) {
        const answer = await gate(
          new Request(`${origin}${path}`, {
            method,
            headers,
            body: method === "PUT" ? JSON.stringify({ rateLimitRate: 1, latencyMs: 0 }) : undefined,
          }),
          key,
          next,
        );
        assert.equal(answer.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
      }
  assert.deepEqual(forwarded, []);
  for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }])
    assert.equal(
      (await gate(new Request(`${origin}${profileControlPath}`, { headers }), key, next)).status,
      200,
    );
  assert.deepEqual(forwarded, [profileControlPath, profileControlPath]);
});

const run = "0123456789abcdef";
const marker = sendMarker(run, "ab".repeat(16), 1);
const markedCall = (path, { shape = "messages", long = false } = {}) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(requestBody(shape, long, { marker })),
  });
/** The mock's Durable Object as the stage runs it, with its send record in memory. */
function recordingMock(aimock) {
  const storage = memorySendStorage();
  const answer = mockCalls({
    key,
    store: memoryStore(),
    start: async () => aimock.port,
    sends: durableSends(storage, () => aimock.clock.ms),
    now: () => aimock.clock.ms,
  });
  return { storage, answer };
}

test("a marked call is answered as before and recorded as the mock passed it on; an unmarked one is not", async () => {
  const aimock = fakeAimock({ key, clock: { ms: 1_000 }, longMs: 60_000 });
  const { storage, answer } = recordingMock(aimock);
  for (const shape of Object.keys(paths)) {
    const marked = await answer(markedCall(`/a${paths[shape]}`, { shape }));
    assert.equal(verdict(shape, false, await marked.text()).pass, true, shape);
  }
  await (await answer(modelCall(`/a${paths.chat}`, { shape: "chat" }))).text();
  const long = await answer(markedCall(`/b${paths.chat}`, { shape: "chat", long: true }));
  assert.equal(verdict("chat", true, await long.text()).pass, true);
  const rows = [...storage.rows.values()];
  assert.equal(rows.length, 4, "every marked call and no unmarked one");
  for (const row of rows) {
    assert.equal(row.marker, marker);
    assert.equal(row.status, 200);
    assert.equal(row.end, "complete");
    assert.ok(row.firstContentAt !== undefined && row.firstContentAt <= row.endedAt);
  }
  assert.deepEqual(
    rows.map((row) => row.path),
    [paths.chat, paths.responses, paths.messages, paths.chat],
  );
  // The fake's long stream moves the clock before it answers, so the record shows the wait.
  assert.equal(rows[3].firstContentAt - rows[3].receivedAt, 60_000);
  assert.ok([...storage.rows.keys()].every((name) => name.startsWith(`send:${run}:`)));
});

test("a marked answer whose reader stops is recorded as cut", async () => {
  const aimock = fakeAimock({ key });
  const { storage, answer } = recordingMock(aimock);
  const marked = await answer(markedCall(`/a${paths.messages}`));
  await marked.body.cancel();
  const [row] = storage.rows.values();
  assert.equal(row.end, "cut");
});

test("a run's records are read back in pages, and only with a run and cursor the route gave", async () => {
  const storage = memorySendStorage();
  let ms = 0;
  const sends = durableSends(storage, () => ++ms);
  const send = (index) => ({
    marker: sendMarker(run, "cd".repeat(16), (index % 900) + 1),
    path: paths.chat,
    status: 200,
    receivedAt: index,
    headersAt: index,
    firstContentAt: index,
    endedAt: index,
    end: "complete",
  });
  for (let index = 0; index < sendsPage + 1; index++) await sends.save(run, send(index));
  await sends.save("fedcba9876543210", send(0));
  const answer = mockCalls({
    key,
    store: memoryStore(),
    start: async () => assert.fail("reading the record starts no mock"),
    sends,
  });
  const read = (query, init) =>
    answer(
      new Request(`${origin}${sendsPath}${query}`, {
        headers: { authorization: `Bearer ${key}` },
        ...init,
      }),
    );
  const first = await (await read(`?run=${run}`)).json();
  assert.equal(first.sends.length, sendsPage);
  assert.equal(typeof first.next, "string");
  const second = await (await read(`?run=${run}&after=${first.next}`)).json();
  assert.deepEqual(second.sends, [send(sendsPage)]);
  assert.equal(second.next, undefined);
  for (const query of ["", "?run=XYZ", `?run=${run}&after=../x`, `?run=${run}0`])
    assert.equal((await read(query)).status, 400, query);
  assert.equal((await read(`?run=${run}`, { method: "PUT" })).status, 405);
});

/** One recorded stream read by a client that cancels once `stopAfter` has reached it. */
async function readAndStop(path, lines, stopAfter) {
  const encoder = new TextEncoder();
  let clock = 1_000;
  const answer = new Response(
    new ReadableStream({
      pull(controller) {
        const next = lines.shift();
        if (next === undefined) return controller.close();
        clock += 100;
        controller.enqueue(encoder.encode(next));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const saved = [];
  const response = recorded(answer, {
    marker: "m",
    path,
    receivedAt: 1_000,
    now: () => clock,
    save: (send) => saved.push(send),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    seen += decoder.decode(part.value, { stream: true });
    if (stopAfter && seen.includes(stopAfter)) {
      // The pool stops at the terminal event; time passes before its cancel reaches the mock.
      clock += 5_000;
      await reader.cancel();
      break;
    }
  }
  return saved[0];
}

test("a reader that stops at the stream's terminal event had the whole answer; one that stops before it did not", async () => {
  const streams = {
    "/v1/chat/completions": [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
      ": trailing\n\n",
    ],
    "/v1/responses": [
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{}}\n\n',
      ": trailing\n\n",
    ],
    "/v1/messages": [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
      ": trailing\n\n",
    ],
  };
  const terminalOf = {
    "/v1/chat/completions": "[DONE]",
    "/v1/responses": "response.completed",
    "/v1/messages": "message_stop",
  };
  for (const [path, lines] of Object.entries(streams)) {
    const atTerminal = await readAndStop(path, [...lines], terminalOf[path]);
    assert.equal(atTerminal.end, "complete", path);
    // It ended when the terminal event passed, not when the cancel arrived.
    assert.ok(atTerminal.endedAt < 2_000, `${path} ${atTerminal.endedAt}`);
    assert.ok(atTerminal.firstContentAt !== undefined, path);
    const before = await readAndStop(path, [...lines], "hi");
    assert.equal(before.end, "cut", path);
    const whole = await readAndStop(path, [...lines], undefined);
    assert.equal(whole.end, "complete", path);
  }
  // A terminal event on a last line with no line ending still counts once the body is flushed.
  const unterminated = await readAndStop(
    "/v1/chat/completions",
    ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]"],
    "[DONE]",
  );
  assert.equal(unterminated.end, "complete");
});

/**
 * One recorded stream sent as `chunks`, read by a client that cancels once it has read
 * `stopAfter` chunks; "ERROR" makes the upstream body fail at that point instead.
 */
async function readChunks(path, chunks, stopAfter) {
  const encoder = new TextEncoder();
  let clock = 1_000;
  const arrived = [];
  const answer = new Response(
    new ReadableStream(
      {
        pull(controller) {
          const next = chunks.shift();
          if (next === undefined) return controller.close();
          clock += 100;
          if (next === "ERROR") return controller.error(new Error("upstream broke off"));
          arrived.push(clock);
          controller.enqueue(encoder.encode(next));
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "text/event-stream" } },
  );
  const saved = [];
  const response = recorded(answer, {
    marker: "m",
    path,
    receivedAt: 1_000,
    now: () => clock,
    save: (send) => saved.push(send),
  });
  const reader = response.body.getReader();
  for (let read = 0; ;) {
    let part;
    try {
      part = await reader.read();
    } catch {
      break;
    }
    if (part.done) break;
    if (++read === stopAfter) {
      clock += 5_000;
      await reader.cancel();
      break;
    }
  }
  return { send: saved[0], arrived };
}

test("the terminal event is read from whole lines, however the stream is cut into chunks", async () => {
  const chat = "/v1/chat/completions";
  const content = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
  // Split inside the terminal: complete once its line is whole, at that line's time.
  const split = await readChunks(chat, [content, "data: [DO", "NE]\n\n", ": more\n\n"], 3);
  assert.equal(split.send.end, "complete");
  assert.equal(split.send.endedAt, split.arrived[2]);
  // Stopped on the terminal's first half: it never reached the reader whole.
  const half = await readChunks(chat, [content, "data: [DO", "NE]\n\n"], 2);
  assert.equal(half.send.end, "cut");
  // A chunk that looks like the terminal on its own is not one while its line goes on.
  const goesOn = await readChunks(chat, [content, "data: [DONE]", "x\n\n", ": more\n\n"], 3);
  assert.equal(goesOn.send.end, "cut");
  // A JSON frame split mid-key.
  const messages = await readChunks(
    "/v1/messages",
    [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"ty',
      'pe":"message_stop"}\n\n',
      ": more\n\n",
    ],
    3,
  );
  assert.equal(messages.send.end, "complete");
  // CRLF, cut between the CR and the LF, and read whole.
  const crlf = [content.replace(/\n/gu, "\r\n"), "data: [DONE]\r", "\n\r\n", ": more\r\n"];
  assert.equal((await readChunks(chat, [...crlf], 2)).send.end, "complete");
  assert.equal((await readChunks(chat, [...crlf], 3)).send.end, "complete");
  // The terminal's last byte alone, and an unterminated terminal line: ended when it arrived.
  const lastByte = await readChunks(chat, [content, "data: [DONE", "]", "\n\n", ": more\n\n"], 4);
  assert.equal(lastByte.send.end, "complete");
  const unterminated = await readChunks(chat, [content, "data: [DONE", "]", ": more\n\n"], 3);
  assert.equal(unterminated.send.end, "complete");
  assert.equal(unterminated.send.endedAt, unterminated.arrived[2]);
  // No space after `data:` is the same frame.
  const tight = await readChunks(
    "/v1/messages",
    [
      'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data:{"type":"message_stop"}\n\n',
      ": more\n\n",
    ],
    2,
  );
  assert.equal(tight.send.end, "complete");
  // An upstream that breaks off after the terminal had sent the whole answer.
  const broke = await readChunks(chat, [content, "data: [DONE]\n\n", "ERROR"], 0);
  assert.equal(broke.send.end, "complete");
});

test("the terminal's words inside content are content, never the end", async () => {
  const inChat = await readChunks(
    "/v1/chat/completions",
    ['data: {"choices":[{"delta":{"content":"data: [DONE]"}}]}\n\n', ": more\n\n"],
    1,
  );
  assert.equal(inChat.send.end, "cut");
  const inMessages = await readChunks(
    "/v1/messages",
    [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"type\\":\\"message_stop\\"}"}}\n\n',
      ": more\n\n",
    ],
    1,
  );
  assert.equal(inMessages.send.end, "cut");
});

test("every page of the record names its recorder", async () => {
  const store = durableSends(memorySendStorage(), () => 1);
  const answer = await (
    await import("./sends.ts")
  ).sendsControl(new Request(`https://x${sendsPath}?run=${"a".repeat(16)}`), store);
  assert.equal((await answer.json()).recorder, "terminal-v1");
});
