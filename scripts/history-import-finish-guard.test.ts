import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  diskHeadroom,
  errorSummary,
  isConnectionReset,
  type FinishGuardState,
} from "./history-import-finish-guard.ts";

const t = Date.parse("2026-11-18T01:00:00Z");
const fresh = (): FinishGuardState => ({ throttled: false, criticalSince: null, lastAt: null });
const observe = (ms: number, cpu: unknown, extra = {}) => ({
  observedAt: new Date(ms).toISOString(),
  cpu,
  queryErrors: 0,
  sentryNew: 0,
  releaseActive: false,
  diskPct: 25,
  capacityBytes: 41_875_931_136,
  usedBytes: 10_606_493_696,
  ...extra,
});

test("CPU pauses at 70 and resumes only below 60", () => {
  const state = fresh();
  assert.equal(decide(state, observe(t, 69.9), t).kind, "go");
  assert.deepEqual(decide(state, observe(t, 70), t), { kind: "wait", reason: "cpu_high" });
  assert.equal(decide(state, observe(t, 65), t).kind, "wait");
  assert.equal(decide(state, observe(t, 60), t).kind, "wait");
  assert.equal(decide(state, observe(t, 59.9), t).kind, "go");
});

test("90 sustained for 120 s stops; a dip or a reading gap restarts the window", () => {
  const state = fresh();
  assert.equal(decide(state, observe(t, 95), t).kind, "wait");
  assert.equal(decide(state, observe(t + 60_000, 80), t + 60_000).kind, "wait");
  assert.equal(decide(state, observe(t + 70_000, 92), t + 70_000).kind, "wait");
  assert.equal(decide(state, observe(t + 180_000, 92), t + 180_000).kind, "wait");
  assert.equal(decide(state, observe(t + 300_000, 92), t + 300_000).kind, "wait");
  assert.equal(decide(state, observe(t + 360_000, 92), t + 360_000).kind, "wait");
  assert.deepEqual(decide(state, observe(t + 420_000, 92), t + 420_000), {
    kind: "stop",
    reason: "critical_cpu",
  });
});

test("missing, stale, future or malformed observations hold the load", () => {
  assert.deepEqual(decide(fresh(), null, t), { kind: "wait", reason: "guard_stale" });
  assert.equal(decide(fresh(), observe(t - 90_001, 10), t).kind, "wait");
  assert.equal(decide(fresh(), observe(t + 60_000, 10), t).kind, "wait");
  assert.equal(decide(fresh(), { ...observe(t, 10), observedAt: "nonsense" }, t).kind, "wait");
  for (const bad of [
    { observedAt: new Date(t).toISOString() },
    observe(t, null),
    observe(t, "40"),
    observe(t, 140),
    observe(t, 10, { queryErrors: -1 }),
    observe(t, 10, { releaseActive: "no" }),
  ])
    assert.deepEqual(decide(fresh(), bad, t), { kind: "wait", reason: "guard_invalid" });
});

test("query errors, new Sentry errors and a running release pause for a person", () => {
  assert.deepEqual(decide(fresh(), observe(t, 10, { queryErrors: 1 }), t), {
    kind: "pause",
    reason: "query_errors",
  });
  assert.deepEqual(decide(fresh(), observe(t, 10, { sentryNew: 2 }), t), {
    kind: "pause",
    reason: "sentry_errors",
  });
  assert.deepEqual(decide(fresh(), observe(t, 10, { releaseActive: true }), t), {
    kind: "pause",
    reason: "release_active",
  });
});

test("only dropped or stalled connections count as retryable", () => {
  assert.equal(isConnectionReset({ code: "57P01" }), true);
  assert.equal(isConnectionReset({ code: "ECONNRESET" }), true);
  assert.equal(isConnectionReset(new Error("Connection terminated unexpectedly")), true);
  assert.equal(
    isConnectionReset(new Error("Client has encountered a connection error and is not queryable")),
    true,
  );
  assert.equal(isConnectionReset(new Error("Query read timeout")), true);
  assert.equal(isConnectionReset({ code: "23505" }), false);
  assert.equal(isConnectionReset({ code: "57014" }), false);
  assert.equal(isConnectionReset(new Error("Receipt mismatch")), false);
});

test("error summaries drop detail lines", () => {
  assert.deepEqual(errorSummary({ code: "22P02", message: 'invalid input syntax: "secret"' }), {
    code: "22P02",
    message: "data exception",
  });
  assert.deepEqual(errorSummary({ code: "57P01", message: "terminating\nDETAIL: x" }), {
    code: "57P01",
    message: "terminating",
  });
});

test("a primary volume above 60% stops the load for good", () => {
  assert.equal(
    decide(fresh(), observe(t, 10, { diskPct: 60, usedBytes: 25_125_558_682 }), t).kind,
    "go",
  );
  assert.deepEqual(
    decide(fresh(), observe(t, 10, { diskPct: 60.1, usedBytes: 25_167_434_613 }), t),
    {
      kind: "stop",
      reason: "disk_high",
    },
  );
  assert.deepEqual(decide(fresh(), observe(t, 10, { diskPct: 0.25 }), t), {
    kind: "wait",
    reason: "guard_invalid",
  });
  assert.deepEqual(decide(fresh(), observe(t, 10, { diskPct: undefined }), t), {
    kind: "wait",
    reason: "guard_invalid",
  });
});

test("headroom refuses a WAL budget that cannot fit under half the volume", () => {
  const gib = 1024 ** 3;
  // The incident: 8 GiB WAL budget, ~4 GiB used, 10 GiB volume.
  assert.equal(
    diskHeadroom({ capacityBytes: 10 * gib, usedBytes: 4 * gib }, 8 * gib, 2_070_994, 2048).ok,
    false,
  );
  // After autoscaling: 39 GiB volume, 10.6 GB used, 228,794 rows left.
  assert.equal(
    diskHeadroom(
      { capacityBytes: 41_875_931_136, usedBytes: 10_606_493_696 },
      8 * gib,
      228_794,
      2048,
    ).ok,
    true,
  );
});
