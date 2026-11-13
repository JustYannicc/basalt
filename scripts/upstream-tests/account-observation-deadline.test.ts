import assert from "node:assert/strict";
import { test } from "node:test";
import { observationDeadline } from "../../.upstream/packages/sdk/src/core.ts";
import {
  freshObservation,
  validObservationTime,
} from "../../.upstream/packages/sdk/src/implementation/account-observation-state.ts";
import type { AccountObservationResult } from "../../.upstream/packages/apps/src/contracts/account-observation.ts";

const now = Date.parse("2026-11-13T02:00:00.000Z");
const at = (offset: number) => new Date(now + offset).toISOString();
const fiveMinutes = 5 * 60_000;
type Observation = AccountObservationResult["observation"];
const report = (
  readings: Partial<Observation> = {},
  observedAt = at(0),
): AccountObservationResult => ({
  observedAt,
  observation: { offering: "subscription", windows: [], balances: [], ...readings },
});
const plan = (changes: Partial<NonNullable<Observation["plan"]>> = {}) => ({
  observedAt: at(0),
  label: "Plan",
  ...changes,
});
const window = (changes: Partial<Observation["windows"][number]> = {}) => ({
  observedAt: at(0),
  id: "window",
  label: "Window",
  measure: { unit: "requests" },
  ...changes,
});
const balance = (changes: Partial<Observation["balances"][number]> = {}) => ({
  observedAt: at(0),
  id: "balance",
  label: "Balance",
  unit: "credits",
  available: 10,
  ...changes,
});

function assertCutoff(result: AccountObservationResult, deadline: number) {
  const original = structuredClone(result);
  assert.equal(observationDeadline(result), deadline);
  assert.equal(freshObservation(result, deadline - 1), true);
  assert.equal(freshObservation(result, deadline), false);
  assert.equal(freshObservation(result, deadline + 1), false);
  assert.deepEqual(result, original, "deadline and freshness reads must retain source timestamps");
}

test("each source defaults to five minutes from its own timestamp, not the newest collection", () => {
  const sources = [
    { plan: plan({ observedAt: at(-120_000) }) },
    { windows: [window({ observedAt: at(-120_000) })] },
    { balances: [balance({ observedAt: at(-120_000) })] },
  ];
  for (const source of sources) {
    const result = report(source);
    result.collection = { attemptedAt: at(0), outcome: "success" };
    assertCutoff(result, now - 120_000 + fiveMinutes);
  }
  assertCutoff(
    report({
      plan: plan({ observedAt: at(-120_000) }),
      windows: [window({ observedAt: at(-60_000) })],
      balances: [balance({ observedAt: at(-30_000) })],
    }),
    now - 120_000 + fiveMinutes,
  );
});

test("the earliest explicit staleAt across plan, windows and balances determines the cutoff", () => {
  for (const source of ["plan", "window", "balance"]) {
    const result = report({
      plan: plan({ staleAt: at(source === "plan" ? 30_000 : 90_000) }),
      windows: [window({ staleAt: at(source === "window" ? 30_000 : 90_000) })],
      balances: [balance({ staleAt: at(source === "balance" ? 30_000 : 90_000) })],
    });
    assertCutoff(result, now + 30_000);
  }
});

test("window resets and balance expiries can end freshness before staleAt", () => {
  assertCutoff(
    report({
      plan: plan({ staleAt: at(90_000) }),
      windows: [window({ staleAt: at(60_000), resetsAt: at(20_000) })],
      balances: [balance({ staleAt: at(60_000), expiresAt: at(40_000) })],
    }),
    now + 20_000,
  );
  assertCutoff(
    report({
      windows: [window({ staleAt: at(60_000), resetsAt: at(40_000) })],
      balances: [balance({ staleAt: at(60_000), expiresAt: at(10_000) })],
    }),
    now + 10_000,
  );
  assertCutoff(report({ windows: [window({ resetsAt: at(15_000) })] }), now + 15_000);
  assertCutoff(report({ balances: [balance({ expiresAt: at(15_000) })] }), now + 15_000);
});

test("an explicit staleAt replaces the five-minute default rather than being clamped to it", () => {
  assertCutoff(report({ plan: plan({ staleAt: at(10 * 60_000) }) }), now + 10 * 60_000);
});

test("a result with no sources falls back to its report timestamp plus five minutes", () => {
  assertCutoff(report({}, at(-60_000)), now - 60_000 + fiveMinutes);
});

test("report and individual source timestamps retain the one-minute future guard", () => {
  for (const source of [
    report({ plan: plan() }, at(60_001)),
    report({ plan: plan({ observedAt: at(60_001) }) }),
    report({ windows: [window({ observedAt: at(60_001) })] }),
    report({ balances: [balance({ observedAt: at(60_001) })] }),
    report({}, at(60_001)),
  ]) {
    assert.ok(observationDeadline(source) > now);
    assert.equal(freshObservation(source, now), false);
    assert.equal(validObservationTime(source, now), false);
  }
  const boundary = report(
    {
      plan: plan({ observedAt: at(60_000) }),
      windows: [window({ observedAt: at(60_000) })],
      balances: [balance({ observedAt: at(60_000) })],
    },
    at(60_000),
  );
  assert.equal(freshObservation(boundary, now), true);
  assert.equal(validObservationTime(boundary, now), true);
});

test("invalid source and cutoff timestamps remain stale instead of being ignored", () => {
  for (const source of [
    report({}, "invalid"),
    report({ plan: plan({ observedAt: "invalid" }) }),
    report({ windows: [window({ observedAt: "invalid" })] }),
    report({ balances: [balance({ observedAt: "invalid" })] }),
    report({ plan: plan({ staleAt: "invalid" }) }),
    report({ windows: [window({ staleAt: "invalid" })] }),
    report({ windows: [window({ resetsAt: "invalid" })] }),
    report({ balances: [balance({ staleAt: "invalid" })] }),
    report({ balances: [balance({ expiresAt: "invalid" })] }),
  ]) {
    assert.equal(Number.isNaN(observationDeadline(source)), true);
    assert.equal(freshObservation(source, now), false);
  }
  const malformedReport = report({ plan: plan() }, "invalid");
  assert.equal(observationDeadline(malformedReport), now + fiveMinutes);
  assert.equal(freshObservation(malformedReport, now), true);
  assert.equal(
    validObservationTime(malformedReport, now),
    false,
    "report validation remains separate from source freshness",
  );
  const futureAttempt = report({ plan: plan() });
  futureAttempt.collection = { attemptedAt: at(60_001), outcome: "success" };
  assert.equal(freshObservation(futureAttempt, now), true);
  assert.equal(validObservationTime(futureAttempt, now), false);
});
