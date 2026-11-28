import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runLoadFromEnvironment } from "./load-entry.ts";
import { deviceEnv, go, stage, streamed, type Answer } from "./test/load-fixtures.ts";

/** A run of up to 10 calls, one at a time, stopped as the second one reaches the pool. */
async function stopped(second: (stop: AbortController) => Answer, stopWaitMs?: number) {
  const stop = new AbortController();
  const pool = await stage([streamed(), second(stop), streamed()]);
  const directory = await mkdtemp(join(tmpdir(), "pool-load-"));
  try {
    const passed = await runLoadFromEnvironment(
      {
        ...deviceEnv,
        ...pool.witnessEnv,
        POOL_LOAD_GO: go,
        POOL_LOAD_OUTPUT_DIRECTORY: directory,
        POOL_LOAD_SHAPE: JSON.stringify({
          calls: 10,
          concurrency: 1,
          mix: [{ shape: "chat", weight: 1 }],
        }),
      },
      pool.client,
      () => {},
      { stop: stop.signal, stopWaitMs },
    );
    const text = (name: string) => readFile(join(directory, name), "utf8");
    return {
      passed,
      sent: pool.seen.length,
      calls: (await text("calls.jsonl"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      run: JSON.parse(await text("run.json")),
      summary: await text("summary.txt"),
    };
  } finally {
    pool.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a signal stops new calls, keeps the call in flight as it ends, and fails the run", async () => {
  const result = await stopped((stop) => (response, path) => {
    stop.abort("SIGTERM");
    streamed()(response, path);
  });
  assert.equal(result.passed, false);
  assert.equal(result.sent, 2, "no call starts after the signal");
  assert.equal(result.calls.length, 2, "the call in flight is recorded as it ends");
  assert.ok(result.calls.every((call) => call.pass));
  assert.equal(result.run.verdict.passed, false);
  assert.equal(result.run.verdict.error, "SIGTERM");
  assert.match(result.summary, /^load status=failed calls=2 passes=2 attempts=2$/mu);
  assert.match(result.summary, /^load error=SIGTERM$/mu);
});

test("past the stop's wait the run reports what ended and leaves a call that never answers", async () => {
  const result = await stopped((stop) => () => stop.abort("SIGINT"), 50);
  assert.equal(result.passed, false);
  assert.equal(result.sent, 2);
  assert.equal(result.calls.length, 1, "only the call that ended");
  assert.equal(result.run.verdict.passed, false);
  assert.equal(result.run.verdict.error, "SIGINT");
  assert.match(result.summary, /^load status=failed calls=1 passes=1 attempts=1$/mu);
  assert.match(result.summary, /^load error=SIGINT$/mu);
});
