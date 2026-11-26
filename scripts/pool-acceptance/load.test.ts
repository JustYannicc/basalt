import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JudgedCall } from "./load-classes.ts";
import { verdictOf } from "./load-classes.ts";
import { runLoadFromEnvironment } from "./load-entry.ts";
import {
  boot,
  device,
  deviceEnv,
  go,
  load,
  stage,
  streamed,
  streams,
  testClock,
  unavailable,
} from "./test/load-fixtures.ts";
import { callBody, judgesUnstreamed } from "./load-verdict.mjs";
import { defaultMix, kindRotation, parseLoadShape, workerStartMs } from "./load-shape.ts";

const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))(
  "yaml",
) as { parse: (text: string) => unknown };

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

test("a clean answer whose content came more than 30 s past its profile is delayed, not a pass", async () => {
  const clock = testClock();
  const { run } = await load(
    [streamed({ beforeFirstByte: () => clock.advance(31_000) })],
    1,
    clock,
  );
  assert.deepEqual(run.calls[0]!.classes, ["delayed"]);
  assert.equal(run.calls[0]!.attempts[0]!.verdict?.pass, true);
  assert.ok(run.calls[0]!.attempts[0]!.firstContentMs! > 30_200);
  assert.equal(run.verdict.passed, false);
});

test("a clean answer without the pool's boot is missing its boot, not a pass", async () => {
  const { run } = await load([streamed({ withBoot: false })], 1);
  assert.deepEqual(run.calls[0]!.classes, ["missing_boot"]);
  assert.equal(run.calls[0]!.attempts[0]!.verdict?.pass, true);
  assert.equal(run.verdict.passed, false);
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
        // A dispatch's empty input arms no kill.
        POOL_LOAD_KILL_AT: "",
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
    assert.doesNotMatch(summary, /^load restart/mu);
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

test("an answer the pass rule cannot read fails its call, stops the run and still leaves every artifact", async () => {
  // `data: null` makes the shapes' verdict throw on a null frame.
  const frames = streams["/v1/chat/completions"]!("OK");
  frames.splice(1, 0, "data: null\n\n");
  const pool = await stage([streamed({ body: frames.join("") }), streamed()]);
  const directory = await mkdtemp(join(tmpdir(), "pool-load-"));
  try {
    const passed = await runLoadFromEnvironment(
      {
        ...deviceEnv,
        POOL_LOAD_GO: go,
        POOL_LOAD_OUTPUT_DIRECTORY: directory,
        POOL_LOAD_SHAPE: JSON.stringify({
          concurrency: 2,
          calls: 40,
          mix: [{ shape: "chat", weight: 1 }],
        }),
      },
      pool.client,
      () => {},
    );
    assert.equal(passed, false);
    const calls = (await readFile(join(directory, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(pool.seen.length < 40, "the failure stopped the run before its budget");
    assert.equal(calls.length, pool.seen.length, "every send that ended is recorded");
    const failed = calls.filter((call) => !call.pass);
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0].classes, ["failed"]);
    assert.equal(failed[0].attempts[0].verdict.reason, "verdict threw");
    const run = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
    assert.equal(run.verdict.passed, false);
    assert.equal(run.verdict.firstFailure, failed[0].call);
    assert.match(
      await readFile(join(directory, "summary.txt"), "utf8"),
      /^load stopped_by call=\d+ kind=chat-short classes=failed attempts=1 status=200 end=complete reason=verdict_threw$/mu,
    );
  } finally {
    pool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a long armed run is judged without spreading its calls into one call's arguments", () => {
  const call: JudgedCall = {
    call: 1,
    worker: 0,
    kind: "chat-short",
    traceId: "0".repeat(32),
    startedAt: 1,
    endedAt: 2,
    attempts: [],
    classes: [],
    pass: true,
  };
  const verdict = verdictOf(
    Array.from({ length: 200_000 }, () => call),
    undefined,
    { armed: true, at: 1 },
  );
  assert.equal(verdict.calls, 200_000);
  assert.equal(verdict.restart?.kill, "seen");
});

test("a dispatch from a ref other than main goes red, and every other job runs only from main", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/pool-acceptance.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, { if?: string; steps: { run?: string }[] }> };
  const { "refuse-other-refs": refuse, ...jobs } = workflow.jobs;
  assert.equal(refuse?.if, "github.ref != 'refs/heads/main'");
  assert.match(refuse!.steps.at(-1)!.run ?? "", /\bexit 1\b/u);
  assert.deepEqual(Object.keys(jobs).sort(), ["acceptance", "load"]);
  for (const job of Object.values(jobs))
    assert.match(job.if ?? "", /^github\.ref == 'refs\/heads\/main' && /u);
});
