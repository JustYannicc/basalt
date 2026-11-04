import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forecastCapacity,
  recurringPeak,
  type CapacityForecastInput,
  type ForecastAccount,
  type HourlyDemand,
} from "./forecast.ts";
import { publicForecastStatus } from "./overview.ts";

const HOUR = 60 * 60 * 1_000;
const WEEK_HOURS = 168;
const WEEK = WEEK_HOURS * HOUR;
const MONDAY = Date.UTC(2026, 10, 2);
const WEEKLY_WINDOW = 7 * 24 * 60 * 60;
const DAY_WEIGHT = [1, 1.25, 1.3, 1.3, 0.95, 0.25, 0.15];
const hourWeight = (hour: number) => hour >= 8 && hour < 20 ? 1 : hour >= 6 && hour < 23 ? 0.35 : 0.05;
const shape = Array.from({ length: WEEK_HOURS }, (_, index) => DAY_WEIGHT[Math.floor(index / 24)]! * hourWeight(index % 24));
const weekAt = (total: number, hourlyShape: readonly number[] = shape) =>
  hourlyShape.map((value) => total * value / hourlyShape.reduce((sum, next) => sum + next, 0));

function accounts(now: number, capacities = [1, 1, 1]): ForecastAccount[] {
  return capacities.map((capacity, index) => ({
    id: `private-account-${index + 1}`,
    capacity,
    knownWeight: true,
    remaining: capacity * 0.6,
    resetAt: now + 30 * HOUR + index * HOUR,
    windowSeconds: WEEKLY_WINDOW,
    usable: true,
    share: [0.45, 0.35, 0.2][index]!,
  }));
}

function inputFromHours(
  now: number,
  historyFrom: number,
  demand: readonly HourlyDemand[],
  accountList = accounts(now),
): CapacityForecastInput {
  return {
    provider: "claude",
    unit: { id: "claude-pro-equivalent", label: "Pro-eq" },
    windowSeconds: WEEKLY_WINDOW,
    historyFrom,
    now,
    demand,
    accounts: accountList,
  };
}

function inputForWeeks(weeks: readonly number[], overrides: Partial<CapacityForecastInput> = {}): CapacityForecastInput {
  const historyFrom = MONDAY - weeks.length * WEEK;
  const demand = weeks.flatMap((total) => weekAt(total)).map((value, index) => ({
    at: historyFrom + index * HOUR,
    demand: value,
  }));
  return {
    ...inputFromHours(MONDAY, historyFrom, demand),
    ...overrides,
    historyFrom: overrides.historyFrom ?? historyFrom,
    demand: overrides.demand ?? demand,
    accounts: overrides.accounts ?? accounts(overrides.now ?? MONDAY),
    now: overrides.now ?? MONDAY,
  };
}

function addCurrentWeek(input: CapacityForecastInput, now: number, total: number): CapacityForecastInput {
  const elapsed = (now - MONDAY) / HOUR;
  const start = input.historyFrom + input.demand.length * HOUR;
  return { ...input, now, demand: [...input.demand, ...weekAt(total).slice(0, elapsed).map((demand, index) => ({ at: start + index * HOUR, demand }))] };
}

test("recurring peak caps a lone spike and preserves recurring crunch weeks", () => {
  assert.equal(recurringPeak([2.3, 2.4, 2.2, 2.45, 2.35, 3.6, 2.4, 2.3, 2.42, 2.38]), 2.45);
  assert.equal(recurringPeak([2.3, 3.4, 2.3, 2.4, 2.35, 3.5, 2.4, 2.3, 2.42, 3.45, 2.38]), 3.45);
});

test("seasonal basis reports measured weeks and ignores one exceptional completed week for sizing", () => {
  const result = forecastCapacity(inputForWeeks([2.3, 2.4, 2.2, 2.45, 2.35, 3.6, 2.4, 2.3, 2.42, 2.38]));
  assert.equal(result.status, "estimated");
  assert.equal(result.estimate?.label, "estimate");
  assert.equal(result.estimate?.basis, "seasonal-weekday-hour");
  assert.equal(result.measuredWeeks.length, 10);
  assert.ok(Math.abs(result.estimate!.recurringPeak! - 2.45) < 1e-9);
  assert.ok(Math.abs(result.estimate!.weeklyDemand! - 2.45) < 1e-9);
  assert.equal(result.accountAdvice, null);
});

test("a heavy current week is classified as temporary and a three-week rise is classified as trend", () => {
  const now = MONDAY + 83 * HOUR;
  const normal = inputForWeeks([2.3, 2.4, 2.2, 2.45, 2.35, 2.4, 2.3, 2.42, 2.38]);
  const temporary = forecastCapacity(addCurrentWeek(normal, now, 3.6));
  assert.equal(temporary.estimate?.classification, "above");
  assert.equal(temporary.estimate?.streak, 1);

  const rising = inputForWeeks([2.3, 2.4, 2.2, 2.45, 2.35, 2.4, 2.45, 2.35, 2.9, 3.0]);
  const trend = forecastCapacity(addCurrentWeek(rising, now, 3.1));
  assert.equal(trend.estimate?.classification, "trend");
  assert.equal(trend.estimate?.streak, 3);
});

test("two completed weeks start a seasonal forecast without current-rate fallback", () => {
  const now = MONDAY;
  const historyFrom = now - 2 * WEEK;
  const twoWeeks = Array.from({ length: 2 * WEEK_HOURS }, (_, index) => ({ at: historyFrom + index * HOUR, demand: 0.62 / WEEK_HOURS }));
  const estimate = forecastCapacity(inputFromHours(now, historyFrom, twoWeeks));
  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.estimate?.basis, "seasonal-weekday-hour");
  assert.equal(estimate.estimate?.label, "estimate");
  assert.equal(estimate.measuredWeeks.length, 2);
  assert.equal(estimate.accountAdvice, null);

  const shortFrom = now - 30 * HOUR;
  const oneDay = Array.from({ length: 30 }, (_, index) => ({ at: shortFrom + index * HOUR, demand: 0.01 }));
  const unavailable = forecastCapacity(inputFromHours(now, shortFrom, oneDay));
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.estimate, null);
  assert.ok(unavailable.reasons.includes("insufficient-history"));
});

test("fixed-window projection is unavailable when a usable account has no reset time", () => {
  const input = inputForWeeks([2.3, 2.4], {
    mode: "fixed",
    accounts: accounts(MONDAY).map((account) => ({ ...account, resetAt: null })),
  });
  const result = forecastCapacity(input);
  assert.equal(result.projection, null);
  assert.equal(result.accountAdvice, null);
  assert.ok(result.reasons.includes("missing-reset-time"));
  assert.equal(publicForecastStatus(result), "unavailable");
});

test("rolling projection stays unavailable when net quota changes lack an empty-window anchor", () => {
  const unanchored = forecastCapacity(inputForWeeks([2.3, 2.4], {
    mode: "rolling",
    windowSeconds: 18_000,
    accounts: [{
      id: "private-unanchored",
      capacity: 100,
      knownWeight: true,
      remaining: 45,
      resetAt: null,
      windowSeconds: 18_000,
      usable: true,
      share: 1,
      // A five-unit net decrease from an unknown prior balance cannot seed expiry timing.
      rollingUse: [{ at: MONDAY - HOUR, amount: 5 }],
      rollingHistoryComplete: false,
      weeklyUsabilityComplete: true,
    }],
  }));

  assert.equal(unanchored.status, "estimated");
  assert.equal(unanchored.projection, null);
  assert.ok(unanchored.reasons.includes("rolling-expiry-history-unavailable"));
});

test("four completed weeks with a passing held-out backtest enable a known-plan account count", () => {
  const historyFrom = MONDAY - 4 * WEEK;
  const unusual = Array.from({ length: WEEK_HOURS }, (_, index) => index === 2 * 24 + 12 ? 1 : 0);
  const weekly = [weekAt(2.4), weekAt(2.4, unusual), weekAt(2.4), weekAt(2.4)];
  const demand = weekly.flatMap((week) => week).map((value, index) => ({ at: historyFrom + index * HOUR, demand: value }));
  const input = inputFromHours(MONDAY, historyFrom, demand, accounts(MONDAY, [0.5]));
  const result = forecastCapacity({ ...input, candidateAccount: { label: "Pro-eq", capacity: 1, source: "unit" } });
  assert.equal(result.measuredWeeks.length, 4);
  assert.equal(result.backtest?.heldOutWeeks, 2);
  assert.equal(result.backtest?.beatsSeasonalNaive, true);
  assert.equal(result.accountAdvice?.candidate.label, "Pro-eq");
});

test("missing hourly observations break completed weeks and suppress account advice", () => {
  const base = inputForWeeks([2.3, 2.4, 2.2, 2.45, 2.35, 2.4, 2.3, 2.42]);
  const demand = base.demand.map((point, index) => index === WEEK_HOURS + 4 ? { ...point, demand: null } : point);
  const result = forecastCapacity({
    ...base,
    demand,
    candidateAccount: { label: "Pro-eq", capacity: 1, source: "unit" },
  });
  assert.equal(result.status, "estimated");
  assert.equal(result.history.missingHours, 1);
  assert.equal(result.measuredWeeks.length, 7);
  assert.ok(result.reasons.includes("history-gap"));
  assert.equal(result.accountAdvice, null);
});

test("only a known candidate plus complete coverage and a passing seasonal backtest permits account counts", () => {
  const a = shape;
  const b = Array.from({ length: WEEK_HOURS }, (_, index) => index === 2 * 24 + 12 ? 1 : 0);
  const historyFrom = MONDAY - 6 * WEEK;
  const weeklyHours = [weekAt(2.4, a), weekAt(2.4, a), weekAt(2.4, a), weekAt(2.4, a), weekAt(2.4, b), weekAt(2.4, a)];
  const demand = weeklyHours.flatMap((hourly) => hourly).map((value, index) => ({ at: historyFrom + index * HOUR, demand: value }));
  const input = inputFromHours(MONDAY, historyFrom, demand, accounts(MONDAY, [0.5]));
  const result = forecastCapacity({ ...input, candidateAccount: { label: "Pro-eq", capacity: 1, source: "unit" } });
  assert.equal(result.history.coverage, 1);
  assert.equal(result.estimate?.backtest.beatsSeasonalNaive, true);
  assert.equal(result.accountAdvice?.candidate.label, "Pro-eq");
  assert.equal(result.accountAdvice?.additionalAccounts, 1);
  assert.equal(result.accountAdvice?.busyAccounts, 1);
  assert.equal(result.accountAdvice?.exclusions?.length, 0);

  const withoutCandidate = forecastCapacity(input);
  assert.equal(withoutCandidate.accountAdvice, null);
  assert.ok(withoutCandidate.reasons.includes("candidate-weight-unavailable"));

  const unknownWeight = forecastCapacity({
    ...input,
    accounts: input.accounts.map((account, index) => index === 0 ? { ...account, knownWeight: false } : account),
    candidateAccount: { label: "Pro-eq", capacity: 1, source: "unit" },
  });
  assert.equal(unknownWeight.accountAdvice, null);
  assert.ok(unknownWeight.reasons.includes("unknown-account-weight"));
});

test("sticky allocation spills an exhausted share and scheduled refills recover a below-zero projection", () => {
  const now = MONDAY;
  const weeks = Array.from({ length: 6 }, () => Array(WEEK_HOURS).fill(2.4 / WEEK_HOURS) as number[]);
  const historyFrom = now - weeks.length * WEEK;
  const demand = weeks.flatMap((week) => week).map((value, index) => ({ at: historyFrom + index * HOUR, demand: value }));
  const spillAccounts = [
    { id: "private-a", capacity: 0.005, knownWeight: true, remaining: 0.005, resetAt: now + WEEK, windowSeconds: WEEKLY_WINDOW, usable: true, share: 0.9 },
    { id: "private-b", capacity: 0.1, knownWeight: true, remaining: 0.1, resetAt: now + WEEK, windowSeconds: WEEKLY_WINDOW, usable: true, share: 0.1 },
  ];
  const spill = forecastCapacity(inputFromHours(now, historyFrom, demand, spillAccounts));
  const spillProjection = spill.projection;
  assert.ok(spillProjection);
  assert.ok(spillProjection.points[0]!.balance > 0);

  const refillAccounts = [0, 1].map((index) => ({
    id: `private-refill-${index}`,
    capacity: 0.01,
    knownWeight: true,
    remaining: 0.005,
    resetAt: now + 8 * HOUR,
    windowSeconds: WEEKLY_WINDOW,
    usable: true,
    share: 0.5,
  }));
  const refill = forecastCapacity(inputFromHours(now, historyFrom, demand, refillAccounts));
  const refillProjection = refill.projection;
  assert.ok(refillProjection);
  assert.ok(refillProjection.points[0]!.balance < 0);
  assert.deepEqual(refillProjection.refills, [{ at: now + 8 * HOUR, amount: 0.02, windows: 2 }]);
  assert.ok(refillProjection.points[8]!.balance > 0);
  assert.equal(refillProjection.runsOutAt, now);
  assert.equal(JSON.stringify(refill).includes("private-refill"), false);
});

test("unusable accounts keep their last reading out of routing and no account identifier is returned", () => {
  const historyFrom = MONDAY - 6 * WEEK;
  const demand = Array.from({ length: 6 * WEEK_HOURS }, (_, index) => ({ at: historyFrom + index * HOUR, demand: 0.01 }));
  const accountList = accounts(MONDAY, [1]);
  accountList[0] = { ...accountList[0]!, usable: false, remaining: 0.8, resetAt: MONDAY + HOUR };
  const result = forecastCapacity(inputFromHours(MONDAY, historyFrom, demand, accountList));
  assert.ok(result.reasons.includes("unhealthy-account"));
  assert.equal(result.projection?.refills.length, 0);
  assert.equal(result.projection?.heldUnusableRemaining, 0.8);
  assert.equal(JSON.stringify(result).includes("private-account"), false);
});
