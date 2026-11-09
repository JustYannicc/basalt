import assert from "node:assert/strict";
import { test } from "node:test";
import {
  automaticEvidence,
  consumeAutomaticAttempt,
  finishAutomaticAttempt,
  type AutomaticSample,
} from "./automatic-recovery.ts";

const minute = 60_000;
const hour = 60 * minute;
const selection = "a".repeat(64);
const instanceId = "b".repeat(64);
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const sample = (at: number, condition: AutomaticSample["condition"] = "view-transport") => ({
  at,
  selection,
  condition,
});

test("automatic recovery requires three fresh, spaced failures of one exact selection", () => {
  const samples = [sample(0), sample(minute), sample(2 * minute)];
  assert.equal(automaticEvidence(samples, 2 * minute), "eligible");
  assert.equal(automaticEvidence(samples.slice(1), 2 * minute), "insufficient-failures");
  assert.equal(automaticEvidence(samples, 3 * minute), "stale-observation");
  assert.equal(automaticEvidence([sample(0), sample(1), sample(2)], 2), "sampling-gap");
  assert.equal(
    automaticEvidence([sample(0), sample(minute), sample(4 * minute)], 4 * minute),
    "sampling-gap",
  );
  assert.equal(
    automaticEvidence(
      [samples[0]!, samples[1]!, { ...samples[2]!, selection: "c".repeat(64) }],
      2 * minute,
    ),
    "target-drift",
  );
});

test("recovery, unknown faults and policy rejection interrupt the automatic failure sequence", () => {
  for (const condition of [
    "stopped",
    "unready",
    "stale-boot",
    "healthy",
    "unknown",
    "policy-invalid",
    "signature-invalid",
    "data-invalid",
  ] as const) {
    assert.equal(
      automaticEvidence([sample(0), sample(minute, condition), sample(2 * minute)], 2 * minute),
      "human-required",
    );
  }
});

test("a consumed operation blocks repeats and uncertain attempts survive controller reconstruction", () => {
  const state = consumeAutomaticAttempt(undefined, { operationId: id(1), instanceId }, 0);
  const retained = structuredClone(state);
  assert.throws(
    () => consumeAutomaticAttempt(retained, { operationId: id(1), instanceId }, hour),
    /already-consumed/,
  );
  assert.throws(
    () => consumeAutomaticAttempt(retained, { operationId: id(2), instanceId }, hour),
    /uncertain/,
  );
  assert.throws(
    () =>
      consumeAutomaticAttempt(retained, { operationId: id(2), instanceId: "c".repeat(64) }, hour),
    /uncertain/,
  );
});

test("completed attempts enforce a per-instance half-hour and a rolling global three-per-day limit", () => {
  let state = consumeAutomaticAttempt(undefined, { operationId: id(1), instanceId }, 0);
  state = finishAutomaticAttempt(state, id(1), "failed");
  assert.throws(
    () => consumeAutomaticAttempt(state, { operationId: id(2), instanceId }, 30 * minute - 1),
    /cooldown/,
  );
  state = consumeAutomaticAttempt(state, { operationId: id(2), instanceId }, 30 * minute);
  state = finishAutomaticAttempt(state, id(2), "ready");
  state = consumeAutomaticAttempt(
    state,
    { operationId: id(3), instanceId: "c".repeat(64) },
    31 * minute,
  );
  state = finishAutomaticAttempt(state, id(3), "ready");
  assert.throws(
    () =>
      consumeAutomaticAttempt(
        state,
        { operationId: id(4), instanceId: "d".repeat(64) },
        32 * minute,
      ),
    /daily-limit/,
  );
  assert.equal(
    consumeAutomaticAttempt(state, { operationId: id(4), instanceId }, 24 * hour).attempts.length,
    3,
  );
});

test("invalid retained budgets, unknown completions and a clock moving backwards refuse", () => {
  const state = consumeAutomaticAttempt(undefined, { operationId: id(1), instanceId }, hour);
  assert.throws(
    () => consumeAutomaticAttempt({ attempts: [] }, { operationId: id(2), instanceId }, hour),
    /invalid-state/,
  );
  assert.throws(() => finishAutomaticAttempt(state, id(2), "ready"), /unknown-operation/);
  const complete = finishAutomaticAttempt(state, id(1), "ready");
  assert.throws(
    () => consumeAutomaticAttempt(complete, { operationId: id(2), instanceId }, 0),
    /clock-regression/,
  );
});
