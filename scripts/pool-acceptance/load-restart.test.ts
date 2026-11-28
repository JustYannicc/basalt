import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";
import type { CallRecord } from "./load-call.ts";
import { judge, verdictOf } from "./load-classes.ts";
import { runLoadFromEnvironment } from "./load-entry.ts";
import { parseLoadShape } from "./load-shape.ts";
import {
  boot,
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

const replacement = "boot-load-2c48";

/** A clock and a kill that an answer sets while its own call is in flight. */
function killSwitch() {
  const clock = testClock();
  let killAt: number | undefined;
  const kill = () => {
    killAt = clock.wall();
    clock.advance(5);
  };
  return { clock, kill, killAt: () => killAt };
}

test("a call cut at the kill counts as an in-flight cut even when its resend succeeds", async () => {
  const { clock, kill, killAt } = killSwitch();
  const cutAfterFirstFrame: Answer = (response: ServerResponse, path: string) => {
    response.writeHead(200, streamHeaders());
    response.write(streams[path]!("OK")[0], () => {
      kill();
      response.socket?.end();
    });
  };
  const { run, seen, lines } = await load([cutAfterFirstFrame, streamed()], 1, clock, killAt);
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
  // The mock recorded the resend too, and the driver knows it as its own send.
  assert.equal(run.verdict.witness.sends, 2);
  assert.equal(run.verdict.counts.driver_missing, 0);
  // The resend is no evidence of a new boot: only the run's own sends are.
  assert.deepEqual(run.verdict.restart, {
    kill: "seen",
    inFlight: 1,
    resendPassed: 1,
    newBoots: 0,
    goneBoots: 1,
    passed: false,
  });
  assert.equal(run.verdict.passed, false);
  assert.ok(
    lines.some((line) => line.includes("in_flight_cut=1") && line.endsWith("verdict=not_passed")),
  );
});

test("an armed kill that never came leaves the restart phase not passed", async () => {
  const { run } = await load([streamed()], 2, testClock(), () => undefined);
  assert.equal(run.verdict.passes, 2);
  assert.deepEqual(run.verdict.restart, {
    kill: "unseen",
    inFlight: 0,
    resendPassed: 0,
    newBoots: 0,
    goneBoots: 0,
    passed: false,
  });
  assert.equal(run.verdict.passed, false);
});

test("the restart phase passes only when a boot in flight at the kill goes and a new one answers", async () => {
  const restart = async (after: readonly string[]) => {
    const { clock, kill, killAt } = killSwitch();
    const inFlightAtKill: Answer = (response, path) => {
      kill();
      streamed()(response, path);
    };
    const answers = after.map((answeredBy) => streamed({ withBoot: answeredBy }));
    const { run } = await load(
      [streamed(), inFlightAtKill, ...answers],
      2 + after.length,
      clock,
      killAt,
    );
    assert.equal(run.verdict.passes, run.verdict.calls, "every call itself is clean");
    assert.equal(run.calls[1]!.inFlight?.ending, "ok");
    return run.verdict;
  };
  const restarted = await restart([replacement]);
  assert.deepEqual(restarted.restart, {
    kill: "seen",
    inFlight: 1,
    resendPassed: 0,
    newBoots: 1,
    goneBoots: 1,
    passed: true,
  });
  assert.equal(restarted.passed, true);
  // The same boot kept answering: nothing restarted, whatever the kill time says.
  const unchanged = await restart([boot]);
  assert.equal(unchanged.restart?.newBoots, 0);
  assert.equal(unchanged.passed, false);
  // A boot came but the one in flight never went: a scale-out, not a restart.
  const grown = await restart([boot, replacement]);
  assert.deepEqual([grown.restart?.newBoots, grown.restart?.goneBoots], [1, 0]);
  assert.equal(grown.passed, false);
});

test("a kill time that holds only spaces or names no exact time is refused before any call", async () => {
  const pool = await stage([streamed()]);
  try {
    for (const [value, refusal] of [
      ["   ", /POOL_LOAD_KILL_AT holds only spaces/u],
      ["1", /epoch milliseconds or an ISO time/u],
      ["2026-11-26 12:00", /epoch milliseconds or an ISO time/u],
      // Off the calendar: the parser would roll these into 2 March and the next midnight.
      ["2026-02-30T00:00:00Z", /epoch milliseconds or an ISO time/u],
      ["2026-11-26T24:00:00Z", /epoch milliseconds or an ISO time/u],
      ["0000000000000", /epoch milliseconds or an ISO time/u],
    ] as const)
      await assert.rejects(
        runLoadFromEnvironment(
          { ...deviceEnv, POOL_LOAD_GO: go, POOL_LOAD_KILL_AT: value },
          pool.client,
          () => {},
        ),
        refusal,
      );
    await assert.rejects(
      runLoadFromEnvironment(
        { ...deviceEnv, POOL_LOAD_GO: go, POOL_LOAD_KILL_MARKER: " " },
        pool.client,
        () => {},
      ),
      /POOL_LOAD_KILL_MARKER holds only spaces/u,
    );
    assert.equal(pool.seen.length, 0);
  } finally {
    pool.close();
  }
});

test("a boot that only stopped getting calls is no evidence: it must have been in flight at the kill", () => {
  const [kind] = parseLoadShape('{"mix":[{"shape":"chat","weight":1}]}').mix;
  const call = (
    index: number,
    startedAt: number,
    endedAt: number,
    answeredBy: string,
  ): CallRecord => ({
    call: index,
    worker: 0,
    kind: "chat-short",
    traceId: "0".repeat(32),
    startedAt,
    endedAt,
    attempts: [
      {
        attempt: 1,
        startedAt,
        endedAt,
        end: "complete",
        status: 200,
        boot: answeredBy,
        firstContentMs: 1,
        totalMs: endedAt - startedAt,
        verdict: { pass: true, reason: undefined },
        retryable: false,
      },
    ],
  });
  const restart = (calls: readonly CallRecord[], killAt: number) =>
    verdictOf(
      calls.map((record) => judge(record, kind!, killAt)),
      undefined,
      { armed: true, at: killAt },
    ).restart;
  // Nothing in flight at the kill: the boot before it went quiet, which proves no restart.
  assert.deepEqual(
    restart([call(1, 1_000, 1_010, boot), call(2, 1_020, 1_030, replacement)], 1_015),
    { kill: "seen", inFlight: 0, resendPassed: 0, newBoots: 1, goneBoots: 0, passed: false },
  );
  // The same boots with the first call in flight at the kill.
  assert.equal(
    restart([call(1, 1_000, 1_020, boot), call(2, 1_021, 1_030, replacement)], 1_015)?.passed,
    true,
  );
});
