import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptanceCredential } from "../release/acceptance-device.ts";
import type { Attempt } from "./load-call.ts";
import { delayed } from "./load-classes.ts";
import { runLoadFromEnvironment } from "./load-entry.ts";
import {
  chatOnly,
  deviceEnv,
  go,
  load,
  stage,
  streamed,
  streamHeaders,
  streams,
  testClock,
  type Answer,
} from "./test/load-fixtures.ts";
import { frameTimer } from "./load-stream.ts";
import { runLoad } from "./load.ts";

const redirectTo =
  (origin = ""): Answer =>
  (response, path) => {
    response.writeHead(307, { Location: `${origin}${path}` });
    response.end();
  };

test("a redirect is the send's own answer: never followed, the call fails and the run exits failed", async () => {
  const pool = await stage([redirectTo(), streamed()]);
  const directory = await mkdtemp(join(tmpdir(), "pool-load-"));
  try {
    const passed = await runLoadFromEnvironment(
      {
        ...deviceEnv,
        POOL_LOAD_GO: go,
        POOL_LOAD_OUTPUT_DIRECTORY: directory,
        POOL_LOAD_SHAPE: JSON.stringify({ calls: 1, mix: [{ shape: "chat", weight: 1 }] }),
      },
      pool.client,
      () => {},
    );
    assert.equal(passed, false);
    assert.equal(pool.seen.length, 1, "the redirect's target was never sent to");
    const [call] = (await readFile(join(directory, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(call.classes, ["failed", "missing_boot"]);
    assert.deepEqual(
      call.attempts.map((attempt: Attempt) => [attempt.status, attempt.end]),
      [[307, "status"]],
    );
  } finally {
    pool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a redirect to another origin sends that origin nothing, so no device assertion leaves", async () => {
  const other = await stage([streamed()]);
  const pool = await stage([redirectTo(other.origin)]);
  try {
    const run = await runLoad({
      client: pool.client,
      credential: acceptanceCredential(deviceEnv),
      shape: chatOnly(1),
      clock: testClock(),
    });
    assert.equal(pool.seen.length, 1);
    assert.equal(other.seen.length, 0);
    assert.equal(run.verdict.passed, false);
    assert.equal(run.calls[0]!.attempts[0]!.status, 307);
  } finally {
    pool.close();
    other.close();
  }
});

test("a keep-alive and a role frame at once do not hide content that came 60 s late", async () => {
  const clock = testClock();
  const lateContent: Answer = (response, path) => {
    const [role, ...rest] = streams[path]!("OK");
    response.writeHead(200, streamHeaders());
    // A moment for the client to read the early frames first; the content is late either way.
    response.write(`: keep-alive\n\n${role}`, () =>
      setTimeout(() => {
        clock.advance(60_000);
        response.end(rest.join(""));
      }, 20),
    );
  };
  const { run } = await load([lateContent], 1, clock);
  const [attempt] = run.calls[0]!.attempts;
  assert.equal(attempt!.verdict?.pass, true);
  assert.ok(attempt!.firstContentMs! > 60_000);
  assert.deepEqual(run.calls[0]!.classes, ["delayed"]);
  assert.equal(run.verdict.passed, false);
});

test("content behind early frames, and a stall after it began, are both timed from the content", () => {
  const [role, content, stop, usage, done] = streams["/v1/chat/completions"]!("OK");
  const timer = frameTimer("chat");
  timer.observe(": keep-alive\n\n", 1);
  timer.observe(role!, 2);
  assert.equal(timer.firstContentMs, undefined, "neither a comment nor a role frame is content");
  timer.observe(content!, 60_000);
  timer.observe(stop!, 60_010);
  timer.observe(`${usage}${done}`, 300_010);
  assert.deepEqual([timer.firstContentMs, timer.stallMs], [60_000, 240_000]);
  const [kind] = chatOnly(1).mix;
  const attempt = (firstContentMs: number, stallMs?: number): Attempt => ({
    attempt: 1,
    startedAt: 0,
    endedAt: 0,
    end: "complete",
    status: 200,
    headersMs: 1,
    firstByteMs: 1,
    firstContentMs,
    stallMs,
    totalMs: 300_010,
    retryable: false,
  });
  assert.equal(delayed(attempt(timer.firstContentMs!), kind!), true, "content 60 s late");
  assert.equal(delayed(attempt(150, timer.stallMs), kind!), true, "a 240 s stall");
  assert.equal(delayed(attempt(150, 30_000), kind!), false, "within 30 s past the 200 ms profile");
});
