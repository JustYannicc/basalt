import { test } from "node:test";
import assert from "node:assert/strict";
import { observedRoutingDemand } from "./routing-observed-demand.ts";
import type { CapacityDemandData } from "./capacity/history.ts";

const hour = 3_600_000;
const now = Date.UTC(2026, 10, 13, 12);
function history(): CapacityDemandData {
  return {
    trackingSince: now - 6 * hour,
    readAt: now,
    completedWeeks: 0,
    points: [2, 1].map((ago) => ({
      provider: "claude",
      windowSeconds: 604800,
      mode: "fixed",
      unit: { id: "claude-pro-equivalent", label: "Pro-eq" },
      hour: now - ago * hour,
      demand: 0.05,
      coverage: 1,
      censored: false,
      membershipIncomplete: false,
      sourceAt: { from: now - ago * hour, to: now - (ago - 1) * hour },
    })),
    latestReadings: [
      {
        account: "synthetic-a",
        provider: "claude",
        plan: "Pro",
        windowSeconds: 604800,
        mode: "fixed",
        observedAt: now,
        resetAt: now + 24 * hour,
        staleAt: now + hour,
        observationSource: "probe",
        full: 1,
        remaining: 0.8,
        unit: { id: "claude-pro-equivalent", label: "Pro-eq" },
        source: "reference-plan",
        knownWeight: true,
        revision: "fixture",
      },
    ],
    accountStates: [],
    unclassifiedProviders: [],
    accountDemandTotals: {},
    rollingUse: {},
    rollingComplete: {},
    refills: [],
  };
}

test("observed quota burn supplies low-confidence targets before history calibration exists", () => {
  const inputs = observedRoutingDemand(history(), now);
  assert.equal(inputs.length, 1);
  const input = inputs[0]!;
  assert.equal(input.source, "observed-quota-burn");
  assert.equal(input.confidence, "low");
  assert.equal(input.windows[0]!.intervals[0]!.demand.upper80, null);
  assert.equal(input.windows[0]!.intervals[0]!.demand.median, 0.05 * 168);
  assert.equal(input.windows[0]!.accounts[0]!.full, 1);
  assert.equal(input.validUntil, new Date(now + 15 * 60_000).toISOString());
});

test("stale, censored, missing, changed and unknown-plan quota history never manufactures targets", () => {
  const data = history();
  const variants: CapacityDemandData[] = [
    { ...data, readAt: now - 7 * 60_000 },
    { ...data, points: data.points.slice(1) },
    { ...data, points: data.points.map((point) => ({ ...point, coverage: 0.8 })) },
    { ...data, points: data.points.map((point) => ({ ...point, censored: true })) },
    { ...data, points: data.points.map((point) => ({ ...point, membershipIncomplete: true })) },
    { ...data, points: data.points.map((point) => ({ ...point, demand: null })) },
    { ...data, points: data.points.map((point) => ({ ...point, demand: 0 })) },
    {
      ...data,
      latestReadings: data.latestReadings.map((reading) => ({ ...reading, knownWeight: false })),
    },
    {
      ...data,
      latestReadings: data.latestReadings.map((reading) => ({ ...reading, staleAt: now })),
    },
  ];
  for (const variant of variants) assert.deepEqual(observedRoutingDemand(variant, now), []);
});

test("a changed recent regime invalidates a long extrapolation", () => {
  const data = history();
  const seed = data.points[0]!;
  const points = Array.from({ length: 6 }, (_, index) => ({
    ...seed,
    hour: now - (6 - index) * hour,
    demand: index < 4 ? 1 : 0.01,
  }));
  assert.deepEqual(observedRoutingDemand({ ...data, points }, now), []);
});

test("weekly and short observations publish one coherent provider profile", () => {
  const data = history();
  const both = {
    ...data,
    points: [...data.points, ...data.points.map((point) => ({ ...point, windowSeconds: 18000 }))],
    latestReadings: [
      ...data.latestReadings,
      ...data.latestReadings.map((reading) => ({ ...reading, windowSeconds: 18000 })),
    ],
  };
  const inputs = observedRoutingDemand(both, now);
  assert.equal(inputs.length, 1);
  assert.deepEqual(
    inputs[0]!.windows.map((window) => window.seconds),
    [604800, 18000],
  );
});
