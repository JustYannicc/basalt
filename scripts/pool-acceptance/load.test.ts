import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeModelHeader } from "../../src/pool/native-contract.ts";
import { nativeRuntimeUnavailable } from "../../src/pool/runtime-unavailable.ts";
import { acceptanceCredential } from "../release/acceptance-device.ts";
import { PoolAcceptanceClient } from "./client.ts";
import type { Clock } from "./load-call.ts";
import { runLoadFromEnvironment } from "./load-entry.ts";
import { callBody, judgesUnstreamed } from "./load-verdict.mjs";
import { defaultMix, kindRotation, parseLoadShape, workerStartMs } from "./load-shape.ts";
import { runLoad, summaryLines } from "./load.ts";

const device = {
  computer: "computer-load-7c21",
  grant: "native:grant-load-3e90",
  user: "person-load-51ad",
  pool: "acceptance-load-proof",
};
const deviceEnv = {
  POOL_ACCEPTANCE_DEVICE: JSON.stringify(device),
  POOL_APP_SIGNING_KEY: "cd".repeat(32),
};
const boot = "boot-load-9f13";
const go = "coordinator-2026-11-26-load-proof";

/** Real time that a stand-in can move on, and waits that pass at once by moving it. */
function testClock() {
  let skew = 0;
  const clock: Clock & { advance(ms: number): void } = {
    now: () => performance.now() + skew,
    wall: () => Date.now() + skew,
    sleep: async (ms) => {
      skew += Math.max(0, ms);
    },
    advance: (ms) => {
      skew += ms;
    },
  };
  return clock;
}

// aimock 1.48.1's short streams, framed as scripts/emulated-upstream/emulated-upstream.test.mjs
// captured them.
const sse = (frames: readonly unknown[]) =>
  frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`);
const streams: Record<string, (content: string) => string[]> = {
  "/v1/chat/completions": (content) =>
    sse([
      { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ delta: { content }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } },
      "[DONE]",
    ]),
  "/v1/messages": (content) =>
    sse([
      { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 2 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: content } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]),
  "/v1/responses": (content) =>
    sse([
      { type: "response.output_text.delta", delta: content },
      { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 2 } } },
    ]),
};

type Answer = (response: ServerResponse, path: string) => void | Promise<void>;
const streamHeaders = (withBoot = true) => ({
  "content-type": "text/event-stream",
  "X-Request-Id": randomUUID(),
  ...(withBoot ? { "X-Signalbox-Pool-Boot": boot } : {}),
});
const streamed =
  ({ content = "OK", withBoot = true, beforeFirstByte = () => {} } = {}): Answer =>
  (response, path) => {
    response.writeHead(200, streamHeaders(withBoot));
    beforeFirstByte();
    response.end(streams[path]!(content).join(""));
  };
/** The pool's own retryable refusal (src/pool/runtime-unavailable.ts), as the entry relays it. */
const unavailable: Answer = async (response, path) => {
  const refusal = nativeRuntimeUnavailable(
    new Request(`https://pool.invalid${path}`, { method: "POST" }),
  );
  response.writeHead(refusal.status, {
    ...Object.fromEntries(refusal.headers),
    "X-Request-Id": randomUUID(),
    "X-Signalbox-Pool-Boot": boot,
  });
  response.end(await refusal.text());
};
/** Headers and the first frame, then the connection closes mid-stream. */
const cutAfterFirstFrame =
  (killed: () => void): Answer =>
  (response, path) => {
    response.writeHead(200, streamHeaders());
    response.write(streams[path]!("OK")[0], () => {
      killed();
      response.socket?.end();
    });
  };

async function stage(answers: readonly Answer[]) {
  const seen: { path?: string; traceparent?: string; assertion?: string }[] = [];
  const server = createServer((request, response) => {
    const call = {
      path: request.url,
      traceparent: request.headers.traceparent as string | undefined,
      assertion: request.headers[nativeModelHeader] as string | undefined,
    };
    seen.push(call);
    request.resume();
    answers[Math.min(seen.length, answers.length) - 1]!(response, request.url ?? "");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { seen, client: new PoolAcceptanceClient({ origin }), close };
}

const chatOnly = (calls: number) =>
  parseLoadShape(
    JSON.stringify({
      concurrency: 1,
      durationMinutes: 1,
      calls,
      mix: [{ shape: "chat", weight: 1 }],
    }),
  );

async function load(
  answers: readonly Answer[],
  calls: number,
  clock = testClock(),
  kill?: () => number | undefined,
) {
  const pool = await stage(answers);
  try {
    const shape = chatOnly(calls);
    const run = await runLoad({
      client: pool.client,
      credential: acceptanceCredential(deviceEnv),
      shape,
      clock,
      kill,
    });
    return { run, seen: pool.seen, lines: summaryLines(run, shape) };
  } finally {
    pool.close();
  }
}

test("a call that passed only on its second send is retried, not a pass, and both sends are kept", async () => {
  const { run, seen } = await load([unavailable, streamed()], 1);
  const [call] = run.calls;
  assert.deepEqual(call!.classes, ["retried"]);
  assert.equal(call!.pass, false);
  assert.equal(run.verdict.passed, false);
  assert.equal(run.verdict.counts.retried, 1);
  const [first, second] = call!.attempts;
  assert.equal(first!.status, 503);
  assert.equal(first!.retryAfterMs, 1_000);
  assert.equal(first!.retryable, true);
  assert.equal(first!.boot, boot);
  assert.match(first!.requestId ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(second!.status, 200);
  assert.equal(second!.verdict?.pass, true);
  // Both sends name one trace for the log join; each carries its own fresh device assertion.
  const traces = seen.map((request) => request.traceparent?.split("-")[1]);
  assert.deepEqual(traces, [call!.traceId, call!.traceId]);
  assert.ok(seen.every((request) => request.assertion));
  assert.notEqual(seen[0]!.assertion, seen[1]!.assertion);
});

test("a clean answer whose first byte came more than 30 s past its profile is delayed, not a pass", async () => {
  const clock = testClock();
  const { run } = await load(
    [streamed({ beforeFirstByte: () => clock.advance(31_000) })],
    1,
    clock,
  );
  assert.deepEqual(run.calls[0]!.classes, ["delayed"]);
  assert.equal(run.calls[0]!.attempts[0]!.verdict?.pass, true);
  assert.ok(run.calls[0]!.attempts[0]!.firstByteMs! > 30_200);
  assert.equal(run.verdict.passed, false);
});

test("a clean answer without the pool's boot is missing its boot, not a pass", async () => {
  const { run } = await load([streamed({ withBoot: false })], 1);
  assert.deepEqual(run.calls[0]!.classes, ["missing_boot"]);
  assert.equal(run.calls[0]!.attempts[0]!.verdict?.pass, true);
  assert.equal(run.verdict.passed, false);
});

test("a call cut at the kill counts as an in-flight cut even when its resend succeeds", async () => {
  const clock = testClock();
  let killAt: number | undefined;
  const killed = () => {
    killAt = clock.wall();
    clock.advance(5);
  };
  const { run, seen, lines } = await load(
    [cutAfterFirstFrame(killed), streamed()],
    1,
    clock,
    () => killAt,
  );
  const [call] = run.calls;
  assert.deepEqual(call!.classes, ["in_flight_cut"]);
  assert.equal(call!.pass, false);
  assert.equal(call!.attempts.length, 1, "a cut stream is not sent again by the run");
  assert.equal(call!.inFlight?.ending, "cut");
  assert.equal(call!.inFlight?.retryable, false);
  assert.ok(call!.inFlight!.bar.includes("failed"));
  assert.equal(call!.inFlight?.resend?.passed, true);
  assert.equal(seen.length, 2, "the cut send and its one resend");
  assert.equal(run.verdict.counts.in_flight_cut, 1);
  assert.equal(run.verdict.counts.failed, 0);
  assert.deepEqual(run.verdict.restart, {
    kill: "seen",
    inFlight: 1,
    resendPassed: 1,
    passed: false,
  });
  assert.equal(run.verdict.passed, false);
  assert.ok(
    lines.some((line) => line.includes("in_flight_cut=1") && line.endsWith("verdict=not_passed")),
  );
});

test("the first call that is not a pass stops the run", async () => {
  const { run, seen, lines } = await load(
    [streamed(), streamed({ content: "NO" }), streamed()],
    10,
  );
  assert.equal(seen.length, 2, "no call starts after the failure");
  assert.deepEqual(
    run.calls.map((call) => call.classes),
    [[], ["failed"]],
  );
  assert.equal(run.verdict.firstFailure, 2);
  assert.ok(
    lines.some(
      (line) =>
        line.startsWith("load stopped_by call=2") && line.endsWith("reason=content_not_exact"),
    ),
  );
});

test("an armed kill that never came leaves the restart phase not passed", async () => {
  const { run } = await load([streamed()], 2, testClock(), () => undefined);
  assert.equal(run.verdict.passes, 2);
  assert.deepEqual(run.verdict.restart, {
    kill: "unseen",
    inFlight: 0,
    resendPassed: 0,
    passed: false,
  });
  assert.equal(run.verdict.passed, false);
});

test("the load mode refuses before any credential or call without a GO or outside an acceptance pool", async () => {
  const pool = await stage([streamed()]);
  try {
    for (const [env, refusal] of [
      [{ ...deviceEnv }, /go input matching/u],
      [{ ...deviceEnv, POOL_LOAD_GO: "go" }, /go input matching/u],
      [
        {
          POOL_ACCEPTANCE_DEVICE: JSON.stringify({ ...device, pool: "app_people" }),
          POOL_APP_SIGNING_KEY: deviceEnv.POOL_APP_SIGNING_KEY,
          POOL_LOAD_GO: go,
        },
        /dedicated acceptance-<run> pool/u,
      ],
      [{ ...deviceEnv, POOL_LOAD_GO: go, POOL_LOAD_SHAPE: '{"calls":0}' }, /calls/u],
    ] as const)
      await assert.rejects(
        runLoadFromEnvironment(env, pool.client, () => {}),
        refusal,
      );
    assert.equal(pool.seen.length, 0);
  } finally {
    pool.close();
  }
});

test("a clean run across the three protocols passes and keeps ids out of its public lines", async () => {
  const pool = await stage([streamed()]);
  const directory = await mkdtemp(join(tmpdir(), "pool-load-"));
  const logged: string[] = [];
  try {
    const passed = await runLoadFromEnvironment(
      {
        ...deviceEnv,
        POOL_LOAD_GO: go,
        POOL_LOAD_OUTPUT_DIRECTORY: directory,
        POOL_LOAD_SHAPE: JSON.stringify({
          concurrency: 2,
          calls: 6,
          mix: ["chat", "responses", "messages"].map((shape) => ({ shape, weight: 1 })),
        }),
      },
      pool.client,
      (line) => logged.push(line),
    );
    assert.equal(passed, true);
    assert.deepEqual(pool.seen.map((request) => request.path).sort(), [
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/messages",
      "/v1/responses",
      "/v1/responses",
    ]);
    const calls = (await readFile(join(directory, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 6);
    assert.ok(
      calls.every(
        (call) =>
          call.pass && call.attempts[0].boot === boot && call.attempts[0].firstContentMs >= 0,
      ),
    );
    const summary = await readFile(join(directory, "summary.txt"), "utf8");
    assert.deepEqual(summary.trim().split("\n"), logged);
    assert.match(summary, /^load status=passed calls=6 passes=6 attempts=6$/mu);
    assert.match(summary, /^load boots distinct=1 answers=6$/mu);
    for (const id of [
      boot,
      ...calls.flatMap((call) => [call.traceId, call.attempts[0].requestId]),
      ...Object.values(device),
    ])
      assert.ok(!summary.includes(id), "an id in the public summary");
  } finally {
    pool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shape ramps in steps, rotates its mix by weight and carries each kind's model", () => {
  const shape = parseLoadShape(
    JSON.stringify({ concurrency: 110, ramp: { from: 5, step: 10, intervalSeconds: 120 } }),
  );
  assert.deepEqual(
    [0, 4, 5, 14, 15, 109].map((index) => workerStartMs(shape, index) / 60_000),
    [0, 0, 2, 2, 4, 22],
  );
  const next = kindRotation(defaultMix);
  const counts = new Map<string, number>();
  for (let index = 0; index < 75; index++) {
    const kind = next();
    counts.set(kind.name, (counts.get(kind.name) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(counts), {
    "chat-short": 20,
    "responses-short": 20,
    "messages-short": 20,
    "chat-long": 5,
    "responses-long": 5,
    "messages-long": 5,
  });
  const [kind] = parseLoadShape(
    '{"mix":[{"shape":"messages","model":"emulated-slow","weight":1,"ttfbProfileMs":15000}]}',
  ).mix;
  assert.equal(callBody(kind!).model, "emulated-slow");
  assert.equal(kind!.ttfbProfileMs, 15_000);
  assert.throws(() => parseLoadShape('{"durationMinutes":121}'), /durationMinutes/u);
  // An unstreamed kind turns on with data alone, as soon as the emulated shapes judge one.
  const unstreamed = '{"mix":[{"shape":"chat","weight":1,"stream":false}]}';
  if (judgesUnstreamed) assert.equal(callBody(parseLoadShape(unstreamed).mix[0]!).stream, false);
  else assert.throws(() => parseLoadShape(unstreamed), /non-streamed/u);
});
