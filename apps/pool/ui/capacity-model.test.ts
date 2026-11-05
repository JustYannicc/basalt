import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CapacityAggregate,
  CapacityForecast,
  CapacityHistoryPoint,
  PoolCapacityHistory,
} from "../capacity-contract.ts";
import {
  capacityLabs,
  dailyRows,
  duration,
  gaps,
  hourMs,
  isOut,
  lineFacts,
  planChips,
  pressing,
  segments,
  verdict,
} from "./capacity-model.ts";

const start = Date.parse("2026-11-02T00:00:00Z");

function aggregate(remaining: number, full: number, unknown = 0): CapacityAggregate {
  return {
    remaining,
    full,
    at: start,
    observedAt: { from: start, to: start },
    accountCount: 2,
    knownWeightCount: 2 - unknown,
    unknownWeightCount: unknown,
    weights: [
      { source: unknown ? "unknown-plan" : "reference-plan", revision: "r1", accountCount: 2 },
    ],
  };
}

function point(
  hour: number,
  remaining: number,
  overrides: Partial<CapacityHistoryPoint> = {},
): CapacityHistoryPoint {
  const value = aggregate(remaining, 4);
  const windowSeconds = overrides.windowSeconds ?? 604800;
  const plans = [{ plan: "Pro", minimum: value, last: value }];
  return {
    provider: "claude",
    windowSeconds,
    mode: null,
    unit: { id: "pro-eq", label: "Pro-eq" },
    hour: start + hour * hourMs,
    minimum: value,
    last: value,
    plans,
    ...(windowSeconds === 18000
      ? { raw: { minimum: value, last: value, plans }, usable: aggregate(4, 4) }
      : {}),
    ...overrides,
  };
}

const history = (
  points: CapacityHistoryPoint[],
  forecasts: CapacityForecast[] = [],
): PoolCapacityHistory => ({
  from: start,
  to: start + 24 * hourMs,
  readAt: start,
  trackingSince: start,
  completedWeeks: 4,
  points,
  forecasts,
  refillEvents: [],
  estimate: { status: "learning", reason: "Not enough history." },
});

function forecast(windowSeconds: number, runsOutAt: number | null): CapacityForecast {
  return {
    provider: "claude",
    windowSeconds,
    mode: null,
    unit: { id: "pro-eq", label: "Pro-eq" },
    status: "estimated",
    reasons: [],
    history: { expectedHours: 672, observedHours: 672, coverage: 1, completedWeeks: 4 },
    backtest: { heldOutWeeks: 2, seasonalMae: 0.1, naiveMae: 0.2, beatsSeasonalNaive: true },
    residualCalibration: { heldOutWeeks: 2, residualHours: 336 },
    classification: "normal",
    streak: 0,
    recurringPeak: 2,
    busyRunsOutAt: runsOutAt,
    points: [{ at: start + 24 * hourMs, median: 2, low: 1, high: 3, busy: 0.5 }],
    runsOutAt,
    ordinary: null,
    busy: null,
    bankedAvailable: 0,
  };
}

test("labs split windows and only list the windows a lab reports", () => {
  const labs = capacityLabs(
    history([
      point(0, 2),
      point(0, 1, { windowSeconds: 18000 }),
      point(0, 3, { provider: "kimi", unit: { id: "requests", label: "requests" } }),
    ]),
  );
  assert.deepEqual(
    labs.map((lab) => [lab.provider, lab.lines.map((line) => line.label)]),
    [
      ["claude", ["Weekly", "5-hour"]],
      ["kimi", ["Weekly"]],
    ],
  );
});

test("missing hours stay gaps and split the line", () => {
  const points = [point(0, 2), point(1, 2), point(4, 1)];
  assert.equal(segments(points).length, 2);
  assert.deepEqual(
    gaps(points, start + 6 * hourMs).map((span) => [
      (span.from - start) / hourMs,
      (span.to - start) / hourMs,
    ]),
    [
      [2, 4],
      [5, 6],
    ],
  );
});

test("out hours count runs where every account was at its limit", () => {
  const [line] = capacityLabs(
    history([point(0, 2), point(1, 0), point(2, 0.01), point(3, 1), point(4, 0)]),
  )[0]!.lines;
  const facts = lineFacts(line!, start + 5 * hourMs);
  assert.equal(facts.outHours, 3);
  assert.equal(facts.episodes, 2);
  assert.equal(facts.longestHours, 2);
});

test("five-hour all-out detection uses weekly-gated remaining and leaves raw quota visible", () => {
  const raw = aggregate(2, 4);
  const gated = point(0, 0, {
    windowSeconds: 18000,
    raw: { minimum: raw, last: raw, plans: [{ plan: "Pro", minimum: raw, last: raw }] },
  });
  assert.equal(isOut(gated), true);
  assert.equal(gated.raw?.minimum.remaining, 2);

  const missingGate = point(0, 0, { windowSeconds: 18000, usable: null });
  assert.equal(isOut(missingGate), false);
  assert.equal(lineFacts(capacityLabs(history([missingGate]))[0]!.lines[0]!, start).latest, null);
});

test("the panel opens on an exhausted window before comparing projected run-out", () => {
  const [lab] = capacityLabs(history([point(0, 3), point(0, 0, { windowSeconds: 18000 })]));
  const choice = pressing(lab!);
  assert.equal(lab!.lines.find((line) => line.key === choice.key)!.label, "5-hour");
  assert.match(choice.text!, /^5-hour is more pressing: out now; weekly forecast learning$/);
});

test("an old exhausted reading does not make a window out now", () => {
  const staleAt = start - 10 * 60_000;
  const stalePoint = point(0, 0, {
    last: { ...aggregate(0, 4), observedAt: { from: staleAt, to: staleAt } },
  });
  const lab = capacityLabs(history([stalePoint, point(0, 3, { windowSeconds: 18000 })]))[0]!;
  assert.equal(lab.lines.find((line) => line.key === pressing(lab).key)!.label, "Weekly");
  assert.equal(pressing(lab).text, "Weekly is more pressing: 0% left at the last reading vs 75%");
  const onceFresh = capacityLabs(history([point(0, 0), point(0, 3, { windowSeconds: 18000 })]))[0]!;
  assert.doesNotMatch(pressing(onceFresh, start + hourMs).text!, /out now|left now/);
});

test("the panel opens on whichever projected window runs out first", () => {
  const weeklyOut = start + 24 * hourMs + 10 * hourMs;
  const fiveOut = start + 24 * hourMs + 20 * hourMs;
  const lab = capacityLabs(
    history(
      [point(0, 2), point(0, 1, { windowSeconds: 18000 })],
      [forecast(604800, weeklyOut), forecast(18000, fiveOut)],
    ),
  )[0]!;
  assert.equal(lab.lines.find((line) => line.key === pressing(lab).key)!.label, "Weekly");
  assert.match(pressing(lab).text!, /^Weekly is more pressing: out ~/);
});

test("the panel does not prefer the smaller remaining share when the other window runs out first", () => {
  const weeklyOut = start + 24 * hourMs + 20 * hourMs;
  const fiveOut = start + 24 * hourMs + 10 * hourMs;
  const lab = capacityLabs(
    history(
      [point(0, 3), point(0, 0.2, { windowSeconds: 18000 })],
      [forecast(604800, weeklyOut), forecast(18000, fiveOut)],
    ),
  )[0]!;
  assert.equal(lab.lines.find((line) => line.key === pressing(lab).key)!.label, "5-hour");
  assert.match(pressing(lab).text!, /^5-hour is more pressing: out ~/);
});

// Mock r2: with no run-out anywhere, the switch opens on the window with less left now.
test("without a projected run-out, the panel opens on the window with less left", () => {
  const lab = capacityLabs(
    history(
      [point(0, 3), point(0, 0.2, { windowSeconds: 18000 })],
      [forecast(604800, null), forecast(18000, null)],
    ),
  )[0]!;
  assert.equal(lab.lines.find((line) => line.key === pressing(lab).key)!.label, "5-hour");
  assert.equal(pressing(lab).text, "5-hour is more pressing: 5% left now vs 75%");
});

test("missing forecasts compare measured balances only, with no forecast claim", () => {
  const lab = capacityLabs(history([point(0, 3), point(0, 0.2, { windowSeconds: 18000 })]))[0]!;
  assert.equal(lab.lines.find((line) => line.key === pressing(lab).key)!.label, "5-hour");
  assert.doesNotMatch(pressing(lab).text!, /out ~|doesn't run out|projects/);
});

test("without measured balances on both windows, Weekly stays the default", () => {
  const lab = capacityLabs(
    history([point(0, 3), point(0, 0.2, { windowSeconds: 18000, usable: null })]),
  )[0]!;
  assert.equal(lab.lines.find((line) => line.key === pressing(lab).key)!.label, "Weekly");
  assert.equal(pressing(lab).text, "Forecast learning; showing Weekly.");
});

test("a lone window opens without a pressing note", () => {
  const [lab] = capacityLabs(history([point(0, 3)]));
  assert.equal(pressing(lab!).text, null);
});

test("unknown plans are flagged on their chip", () => {
  const flagged = aggregate(1, 2, 2);
  const chips = planChips(
    point(0, 1, { plans: [{ plan: null, minimum: flagged, last: flagged }] }),
  );
  assert.deepEqual(chips, [
    { plan: "No plan reported", accounts: 2, flagged: true, note: "plan unknown · 1x" },
  ]);
});

test("daily rows count hours without readings since the first one", () => {
  const rows = dailyRows([point(2, 3), point(3, 1)], start + 6 * hourMs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.missingHours, 2);
  assert.equal(rows[0]!.lowest!.remaining, 1);
});

test("a first-hour forecast shortfall does not claim the pool is already exhausted", () => {
  const projection = forecast(604800, start + 24 * hourMs);
  const line = capacityLabs(history([point(0, 2)], [projection]))[0]!.lines[0]!;
  const result = verdict(line, lineFacts(line, start + 24 * hourMs), 7);
  assert.equal(result.short, "Runs short");
  assert.doesNotMatch(result.text, /Out now/);
});

test("a refill label does not promise recovery when the dry stretch continues", () => {
  const projection = {
    ...forecast(604800, start + 24 * hourMs),
    ordinary: {
      amount: 4,
      stretches: [{ from: start + 24 * hourMs, to: start + 25 * hourMs, depth: 4 }],
      accounts: null,
      exclusions: [],
      accountBasis: null,
    },
  };
  const line = {
    ...capacityLabs(history([point(0, 2)], [projection]))[0]!.lines[0]!,
    refills: [
      {
        provider: "claude",
        windowSeconds: 604800,
        mode: null,
        unitId: "pro-eq",
        at: start + 24.5 * hourMs,
        amount: 1,
        kind: "expected" as const,
      },
    ],
  };
  assert.doesNotMatch(
    verdict(line, lineFacts(line, start + 24 * hourMs), 7).text,
    /until the|usable capacity returns/,
  );
});

test("weekly low markers compare remaining units when nominal capacity changes", () => {
  const points = [
    point(0, 10, { minimum: aggregate(10, 100) }),
    point(1, 1, { minimum: aggregate(1, 2) }),
  ];
  const line = capacityLabs(history(points))[0]!.lines[0]!;
  const facts = lineFacts(line, start + 2 * hourMs);
  assert.equal(facts.lowest?.hour, start + hourMs);
  assert.equal(facts.weeklyLows[0]?.hour, start + hourMs);
});

test("hour counts read as short durations, never raw fractions", () => {
  assert.equal(duration(16.77989138888889), "16.8h");
  assert.equal(duration(6), "6h");
  assert.equal(duration(0.25), "0.3h");
  assert.equal(duration(60), "2.5d");
});

test("with nothing running out, the window with less left now is the pressing one", () => {
  const fresh = { ...aggregate(1, 4), observedAt: { from: start, to: start } };
  const lab = capacityLabs(
    history([point(0, 3), point(0, 1, { windowSeconds: 18000, minimum: fresh, last: fresh })]),
  )[0]!;
  const choice = pressing(lab, start + 60_000);
  assert.equal(lab.lines.find((line) => line.key === choice.key)!.label, "5-hour");
  assert.equal(choice.text, "5-hour is more pressing: 25% left now vs 75%");
});
