import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceCredential } from "../release/acceptance-device.ts";
import type { Attempt } from "./load-call.ts";
import { contentWaitMs, delayed, loopLagLimitMs } from "./load-classes.ts";
import { parseLoadShape } from "./load-shape.ts";
import { frameTimer } from "./load-stream.ts";
import type { Shape } from "./load-verdict.mjs";
import { runLoad, summaryLines } from "./load.ts";
import {
  dataLine,
  deviceEnv,
  frame,
  pacedPool,
  testClock,
  type Step,
} from "./test/load-fixtures.ts";

// The frames each protocol's stream is built from, as aimock 1.48.1 sends them.
const chat = {
  role: { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
  content: (content: unknown) => ({ choices: [{ delta: { content }, finish_reason: null }] }),
  stop: { choices: [{ delta: {}, finish_reason: "stop" }] },
  usage: { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } },
};
const chatTail = [chat.stop, chat.usage, "[DONE]"].map(frame).join("");
const messages = {
  start: { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 2 } } },
  text: (text: unknown) => ({ type: "content_block_delta", delta: { type: "text_delta", text } }),
  ping: { type: "ping" },
  tail: [
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]
    .map(frame)
    .join(""),
};
const responses = {
  created: { type: "response.created", response: {} },
  text: (delta: unknown) => ({ type: "response.output_text.delta", delta }),
  done: { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 2 } } },
};

/** One call of `shape` whose answer arrives in `steps`, judged against the 200 ms profile. */
async function paced(shape: Shape, steps: readonly Step[]) {
  const clock = testClock();
  const pool = pacedPool(clock, steps);
  const loadShape = parseLoadShape(
    JSON.stringify({ concurrency: 1, durationMinutes: 1, calls: 1, mix: [{ shape, weight: 1 }] }),
  );
  const run = await runLoad({
    client: pool.client,
    credential: acceptanceCredential(deviceEnv),
    shape: loadShape,
    clock,
  });
  assert.equal(pool.seen.length, 1);
  const [call] = run.calls;
  return { call: call!, attempt: call!.attempts[0]!, run, lines: summaryLines(run, loadShape) };
}

/** The call's answer is exact, and it still fails the bar as delayed. */
async function lateButExact(shape: Shape, steps: readonly Step[]) {
  const { call, attempt, run } = await paced(shape, steps);
  assert.equal(attempt.verdict?.pass, true, `${shape}: the pass rule reads the answer`);
  assert.deepEqual(call.classes, ["delayed"], shape);
  assert.equal(run.verdict.passed, false);
  return attempt;
}

test("content in a last line without a line ending is timed when it arrives", async () => {
  for (const [shape, steps] of [
    [
      "chat",
      [
        [0, frame(chat.role) + chatTail],
        [60_000, dataLine(chat.content("OK"))],
      ],
    ],
    [
      "messages",
      [
        [0, frame(messages.start) + messages.tail],
        [60_000, dataLine(messages.text("OK"))],
      ],
    ],
    [
      "responses",
      [
        [0, frame(responses.done)],
        [60_000, dataLine(responses.text("OK"))],
      ],
    ],
  ] as const) {
    const attempt = await lateButExact(shape, steps);
    assert.ok(attempt.firstContentMs! >= 60_000, shape);
  }
});

test("text the pass rule reads that is not a string is timed as content", async () => {
  for (const [shape, steps] of [
    [
      "chat",
      [
        [0, frame(chat.role)],
        [60_000, frame(chat.content(["OK"])) + chatTail],
      ],
    ],
    [
      "chat",
      [
        [0, frame(chat.role)],
        [60_000, frame({ choices: { 0: { delta: { content: "OK" } } } }) + chatTail],
      ],
    ],
    [
      "messages",
      [
        [0, frame(messages.start)],
        [60_000, frame(messages.text(["OK"])) + messages.tail],
      ],
    ],
    [
      "responses",
      [
        [0, frame(responses.created)],
        [60_000, frame(responses.text(["OK"])) + frame(responses.done)],
      ],
    ],
  ] as const)
    await lateButExact(shape, steps);
});

test("a whole answer 60 s behind its headers is delayed, however its content is written", async () => {
  for (const body of [
    frame(chat.role) + chatTail + dataLine(chat.content("OK")),
    frame(chat.role) + frame({ choices: [{ delta: { content: ["OK"] } }] }) + chatTail,
  ])
    await lateButExact("chat", [[60_000, body]]);
});

test("a 200 whose content was never timed waited for all of it, never only for its headers", () => {
  const [kind] = parseLoadShape('{"mix":[{"shape":"chat","weight":1}]}').mix;
  const untimed: Attempt = {
    attempt: 1,
    startedAt: 0,
    endedAt: 60_000,
    end: "complete",
    status: 200,
    headersMs: 1,
    firstByteMs: 2,
    totalMs: 60_000,
    verdict: { pass: true, reason: undefined },
    retryable: false,
  };
  assert.equal(contentWaitMs(untimed), 60_000);
  assert.equal(delayed(untimed, kind!), true);
});

test("the wait from the last content to the body's end is bounded like a stall", async () => {
  // The terminal line, unterminated, 240 s after the content.
  await lateButExact("chat", [
    [0, [chat.role, chat.content("OK"), chat.stop, chat.usage].map(frame).join("")],
    [240_000, dataLine("[DONE]")],
  ]);
  // Every frame at once, then the body held open 240 s before it ends.
  const held = await lateButExact("chat", [
    [0, frame(chat.role) + frame(chat.content("OK")) + chatTail],
    [240_000, ""],
  ]);
  assert.ok(held.stallMs! >= 240_000);
});

test("pings, empty deltas and spaces neither start the answer nor end a stall", async () => {
  const every20s = (text: string) => Array.from({ length: 12 }, (): Step => [20_000, text]);
  const stalled = await lateButExact("chat", [
    [0, frame(chat.content("O"))],
    ...every20s(frame(chat.content(""))),
    [20_000, frame(chat.content("K")) + chatTail],
  ]);
  assert.ok(stalled.stallMs! >= 260_000);
  await lateButExact("messages", [
    [0, frame(messages.start) + frame(messages.text("OK"))],
    ...every20s(`event: ping\n${frame(messages.ping)}`),
    [20_000, messages.tail],
  ]);
  const spaced = await lateButExact("chat", [
    [0, frame(chat.content(" "))],
    [20_000, frame(chat.content(" "))],
    [40_000, frame(chat.content("OK")) + chatTail],
  ]);
  assert.ok(spaced.firstContentMs! >= 60_000);
});

test("a pass reports when its content came, not when its headers did", async () => {
  const { call, attempt, lines } = await paced("chat", [
    [0, frame(chat.role) + chatTail],
    [250, dataLine(chat.content("OK"))],
  ]);
  assert.equal(call.pass, true);
  assert.ok(attempt.firstContentMs! >= 250);
  const p50 = Number(/^load first_content_ms passes p50=(\d+) /mu.exec(lines.join("\n"))?.[1]);
  assert.ok(p50 >= 250, `first_content_ms p50 ${p50}`);
});

test("the timer counts only frames that add text, and the end of the body", () => {
  const timer = frameTimer("chat");
  timer.observe(": keep-alive\n\n", 1);
  timer.observe(frame(chat.role), 2);
  timer.observe(frame(chat.content(" ")), 3);
  assert.equal(
    timer.firstContentMs,
    undefined,
    "a comment, a role frame and a space are not content",
  );
  timer.observe(frame(chat.content("O")), 150);
  timer.observe(frame(chat.content("")), 120_000);
  timer.observe(`${frame(chat.content("K"))}${chatTail}`, 240_150);
  timer.end(240_200);
  assert.deepEqual([timer.firstContentMs, timer.stallMs], [150, 240_000]);
});

test("a frame whose text has no string form ends as a failed call that is counted", async () => {
  // `{"toString":"OK"}` has no string form: the pass rule throws on it, and the timer adds nothing.
  const bad = { toString: "OK" };
  for (const steps of [
    // Mid-stream, with its line ending.
    [[0, frame(chat.role) + frame(chat.content(bad)) + chatTail]],
    // As the last line, without one.
    [[0, frame(chat.role) + chatTail + dataLine(chat.content(bad))]],
  ] as const) {
    const { call, run, lines } = await paced("chat", steps as unknown as readonly Step[]);
    assert.equal(run.calls.length, 1);
    assert.equal(call.pass, false);
    assert.ok(call.classes.includes("failed"), call.classes.join(","));
    assert.equal(call.attempts[0]!.end, "complete");
    assert.equal(run.verdict.counts.failed, 1);
    assert.equal(run.verdict.passed, false);
    assert.equal(run.verdict.error, undefined);
    assert.match(lines[0]!, /^load status=failed calls=1 passes=0/u);
  }
});

test("the driver's own loop blocked inside the run is measured, and the run does not pass", async () => {
  const clock = testClock();
  // Right as the first call goes out, the driver's own loop stops for longer than the limit.
  const block = () => {
    const until = performance.now() + loopLagLimitMs + 200;
    while (performance.now() < until);
  };
  const pool = pacedPool(
    clock,
    [[0, frame(chat.role) + frame(chat.content("OK")) + chatTail]],
    true,
    block,
  );
  const loadShape = parseLoadShape(
    JSON.stringify({
      concurrency: 1,
      durationMinutes: 1,
      calls: 1,
      mix: [{ shape: "chat", weight: 1 }],
    }),
  );
  const run = await runLoad({
    client: pool.client,
    credential: acceptanceCredential(deviceEnv),
    shape: loadShape,
    clock,
  });
  assert.equal(run.calls[0]?.pass, true, "the call itself is clean");
  assert.ok((run.verdict.loopLagMaxMs ?? 0) >= loopLagLimitMs, String(run.verdict.loopLagMaxMs));
  assert.equal(run.verdict.passed, false);
  assert.match(
    summaryLines(run, loadShape).join("\n"),
    /loop_lag_max_ms=\d+ limit_ms=3000 timings_not_trusted/u,
  );
});
