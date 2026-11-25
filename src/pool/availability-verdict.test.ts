import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PoolReliability, PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";
import { runAvailabilityProbe } from "./availability-schedule.ts";
import { describeUndelivered } from "../telemetry/pool-monitor.ts";

// No alert service is configured, so nothing the probe sends is accepted: the verdict must still
// be readable, and the run's failure must say what went unanswered.
const env = { POOL_AVAILABILITY_TARGET: "fixture-pool" };
const historyPool = "0123456789abcdef";

const counts = (requests: number, failures: Record<number, number> = {}) => ({
  requests,
  failed: Object.values(failures).reduce((total, count) => total + count, 0),
  unassignedFailures: 0,
  successRate: null,
  failures: Object.entries(failures).map(([status, count]) => ({
    status: Number(status),
    count,
    unassigned: 0,
  })),
});
const window = (requests: number, failures: Record<number, number> = {}): PoolReliability => ({
  from: "2026-01-01T10:00:00.000Z",
  to: "2026-01-01T11:00:00.000Z",
  classification: "ready",
  real: counts(requests, failures),
  proof: counts(0),
});

/** One probe run with no alert service answering. Returns the probe's verdict lines and failure. */
async function probeRun(
  context: TestContext,
  options: {
    slo?: PoolReliabilitySlo;
    rollupStuck?: readonly string[] | "unread";
    captureStuck?: readonly string[];
  },
) {
  const lines: unknown[][] = [];
  for (const level of ["error", "warn", "info"] as const)
    context.mock.method(console, level, (...args: unknown[]) => {
      lines.push(args);
    });
  const failure = await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    options.slo ? async () => options.slo! : undefined,
    undefined,
    undefined,
    options.rollupStuck === "unread"
      ? async () => {
          throw new Error("synthetic read failure");
        }
      : options.rollupStuck
        ? async () => options.rollupStuck as readonly string[]
        : undefined,
    options.captureStuck ? async () => options.captureStuck! : undefined,
  ).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const verdicts = lines
    .filter(([name]) => name === "POOL_PROBE_VERDICT")
    .map(([, value]) => value);
  return { verdicts, failure };
}

test("a pool below its target writes its verdict, windows and counts though no alert is accepted", async (context) => {
  const { verdicts, failure } = await probeRun(context, {
    slo: {
      target: 99,
      state: "breached",
      captureAt: null,
      current: window(20, { 503: 2 }),
      hour: window(400, { 503: 6, 429: 4 }),
      day: window(4_000, { 503: 6, 429: 4 }),
    },
  });
  assert.equal(verdicts.length, 1);
  const verdict = verdicts[0] as {
    availability: unknown;
    reliability: {
      verdicts: { state: string; windows: string[] }[];
      objective: { state: string; windows: Record<string, { real: unknown }> };
    };
  };
  assert.equal(verdict.availability, null);
  assert.deepEqual(verdict.reliability.verdicts, [
    { state: "below_target", windows: ["current", "hour"] },
    { state: "failing_now", windows: ["current"] },
  ]);
  assert.equal(verdict.reliability.objective.state, "breached");
  assert.deepEqual(verdict.reliability.objective.windows.hour!.real, {
    requests: 400,
    failed: 10,
    unassigned: 0,
    failures: [
      { status: 429, count: 4, unassigned: 0 },
      { status: 503, count: 6, unassigned: 0 },
    ],
  });
  assert.deepEqual(Object.keys(verdict.reliability.objective.windows).sort(), ["current", "hour"]);
  // The delivery line names each refused part and what it carried, with Sentry's status.
  assert.equal(
    failure,
    "Pool availability alert delivery failed: check_in:in_progress:unconfigured check_in:ok:unconfigured " +
      "event:pool_request_success_below_target:unconfigured event:pool_request_failing_now:unconfigured",
  );
});

test("a call failing right now writes a failing_now verdict on the current window alone", async (context) => {
  const { verdicts } = await probeRun(context, {
    slo: {
      target: 99,
      state: "ok",
      captureAt: null,
      current: window(5, { 429: 1 }),
      hour: window(500, { 429: 1 }),
      day: window(5_000, { 429: 1 }),
    },
  });
  assert.equal(verdicts.length, 1);
  const verdict = verdicts[0] as {
    reliability: {
      verdicts: unknown[];
      objective: { windows: Record<string, { real: { failures: unknown[] } }> };
    };
  };
  assert.deepEqual(verdict.reliability.verdicts, [{ state: "failing_now", windows: ["current"] }]);
  assert.deepEqual(verdict.reliability.objective.windows.current!.real.failures, [
    { status: 429, count: 1, unassigned: 0 },
  ]);
});

test("a stuck usage rollup writes its verdict naming the pool's history id", async (context) => {
  const { verdicts } = await probeRun(context, { rollupStuck: [historyPool] });
  assert.deepEqual(verdicts, [
    {
      availability: null,
      reliability: {
        verdicts: [{ state: "usage_rollup_stuck", windows: [], pool: historyPool }],
        objective: null,
      },
    },
  ]);
});

test("stuck capture-hour counts write their verdict naming the pool's history id", async (context) => {
  const { verdicts } = await probeRun(context, { captureStuck: [historyPool] });
  assert.deepEqual(verdicts, [
    {
      availability: null,
      reliability: {
        verdicts: [{ state: "capture_hours_stuck", windows: [], pool: historyPool }],
        objective: null,
      },
    },
  ]);
});

test("a healthy minute writes no verdict, and a refused check-in says only that", async (context) => {
  const { verdicts, failure } = await probeRun(context, {
    slo: {
      target: 99,
      state: "ok",
      captureAt: null,
      current: window(5),
      hour: window(500),
      day: window(5_000),
    },
  });
  assert.deepEqual(verdicts, []);
  assert.equal(
    failure,
    "Pool availability alert delivery failed: check_in:in_progress:unconfigured check_in:ok:unconfigured",
  );
});

test("a stuck state that could not be read this minute writes a verdict saying so", async (context) => {
  const { verdicts } = await probeRun(context, { rollupStuck: "unread" });
  assert.deepEqual(verdicts, [
    {
      availability: null,
      reliability: {
        verdicts: [{ state: "usage_rollup_stuck", windows: [], unread: true }],
        objective: null,
      },
    },
  ]);
});

test("the verdict keeps every stuck pool, where an alert takes the first eight", async (context) => {
  const pools = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(16, "0"));
  const { verdicts } = await probeRun(context, { rollupStuck: pools });
  const verdict = verdicts[0] as { reliability: { verdicts: { pool: string }[] } };
  assert.deepEqual(
    verdict.reliability.verdicts.map((entry) => entry.pool),
    pools,
  );
});

test("each refused part is named with what it carried and the status the alert service gave", () => {
  assert.equal(
    describeUndelivered([
      { part: "check_in", status: "in_progress", http: 429 },
      { part: "check_in", status: "error", http: 429 },
      { part: "event", errorCode: "pool_availability_failure", http: 503 },
      { part: "event", errorCode: "pool_request_failing_now" },
      { part: "event", errorCode: "pool_capture_hours_stuck", unconfigured: true },
    ]),
    "check_in:in_progress:429 check_in:error:429 event:pool_availability_failure:503 " +
      "event:pool_request_failing_now:no_answer event:pool_capture_hours_stuck:unconfigured",
  );
});
