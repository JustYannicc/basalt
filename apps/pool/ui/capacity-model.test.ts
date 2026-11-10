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
  candidateName,
  exclusionName,
  tooltipPlanRows,
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
  assert.equal(
    pressing(onceFresh, start + hourMs).text,
    "Weekly is more pressing: 0% left at the last reading vs 75%",
  );
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
    {
      key: "No plan reported",
      plan: "No plan reported",
      accounts: 2,
      flagged: true,
      note: "conservative estimate · 1x",
    },
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
  assert.equal(duration(0.01), "<0.1h");
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

test("an incomplete read picks a window from measured balances and never blames a forecast", () => {
  const ready = capacityLabs(
    history(
      [point(0, 3), point(0, 1, { windowSeconds: 18000 })],
      [forecast(604800, null), forecast(18000, start + 30 * hourMs)],
    ),
  )[0]!;
  const choice = pressing(ready, start, { withheld: true });
  assert.equal(ready.lines.find((line) => line.key === choice.key)!.label, "5-hour");
  assert.equal(choice.text, "5-hour is more pressing: 25% left now vs 75%");
  const unmeasured = capacityLabs(
    history([point(0, 3), point(0, 1, { windowSeconds: 18000, usable: null })]),
  )[0]!;
  assert.equal(pressing(unmeasured, start, { withheld: true }).text, null);
  const outNow = capacityLabs(history([point(0, 3), point(0, 0, { windowSeconds: 18000 })]))[0]!;
  assert.equal(
    pressing(outNow, start, { withheld: true }).text,
    "5-hour is more pressing: out now; weekly forecast withheld",
  );
});

test("plan aliases share one chip without changing capacity measurements", () => {
  const unverified = aggregate(1, 2, 2);
  const verified = aggregate(1, 2);
  const total = {
    ...aggregate(2, 4),
    accountCount: 4,
    unknownWeightCount: 2,
    weights: [...unverified.weights, ...verified.weights],
  };
  const snapshot = point(0, 2, {
    provider: "openai",
    minimum: total,
    last: total,
    plans: [
      { plan: "promax", minimum: unverified, last: unverified },
      { plan: "Pro (Max)", minimum: verified, last: verified },
    ],
  });
  const original = structuredClone(snapshot);
  assert.deepEqual(planChips(snapshot), [
    {
      key: "Pro (Max)",
      plan: "Pro (Max)",
      accounts: 4,
      flagged: true,
      note: "conservative estimate · 1x",
    },
  ]);
  assert.deepEqual(snapshot, original);
});

test("sizing names plan candidates while preserving unit labels", () => {
  assert.equal(
    candidateName({ label: "promax", source: "reported", capacity: 1 }, "openai"),
    "Pro (Max)",
  );
  assert.equal(candidateName({ label: "plus", source: "table", capacity: 1 }, "openai"), "Plus");
  assert.equal(
    candidateName({ label: "reference account", source: "unit", capacity: 1 }, "openai"),
    "reference account",
  );
});

test("forecast exclusions preserve explanations and format actual plan IDs", () => {
  for (const label of ["Unverified plan", "Unknown plan"])
    assert.equal(exclusionName(label, "openai"), label);
  assert.equal(exclusionName("pro", "openai"), "Pro (More)");
});

test("OpenAI chips pass their snapshot provider when naming raw Pro tiers", () => {
  const last = aggregate(1, 2);
  const chips = planChips(
    point(0, 1, {
      provider: "openai",
      plans: ["pro", "promax", "prolite"].map((plan) => ({ plan, minimum: last, last })),
    }),
  );
  assert.deepEqual(
    chips.map((chip) => chip.plan),
    ["Pro (More)", "Pro (Max)", "Pro"],
  );
});

test("tooltip aliases merge usable and raw readings without changing capacity history", () => {
  const a = aggregate(1, 2, 2),
    b = aggregate(2, 3);
  const snapshot = point(0, 3, {
    provider: "openai",
    windowSeconds: 18_000,
    plans: [
      { plan: "promax", minimum: a, last: a },
      { plan: "Pro (Max)", minimum: b, last: b },
    ],
    raw: {
      minimum: aggregate(9, 12),
      last: aggregate(9, 12),
      plans: [
        { plan: "promax", minimum: aggregate(4, 6), last: a },
        { plan: "Pro (Max)", minimum: aggregate(5, 6), last: b },
      ],
    },
  });
  const before = structuredClone(snapshot);
  assert.deepEqual(tooltipPlanRows(snapshot), [
    {
      plan: "Pro (Max)",
      accounts: 4,
      remaining: 3,
      full: 5,
      flagged: true,
      sources: ["unknown-plan", "reference-plan"],
      raw: { remaining: 9, full: 12 },
    },
  ]);
  assert.deepEqual(snapshot, before);
  const ungated = tooltipPlanRows({ ...snapshot, usable: null });
  assert.equal(ungated.length, 1);
  assert.equal(ungated[0]!.remaining, 9);
  assert.equal(ungated[0]!.full, 12);
  const partial = tooltipPlanRows({
    ...snapshot,
    raw: { ...snapshot.raw!, plans: snapshot.raw!.plans.slice(0, 1) },
  });
  assert.equal(partial[0]!.raw, null, "partial provider quota is not presented as the whole group");
});

test("Max 20x policy and retained weekly readings keep their recorded provenance", () => {
  const published = {
    ...aggregate(4, 10),
    weights: [
      { source: "published-weekly-multiplier" as const, revision: "2026-11-09", accountCount: 1 },
    ],
  };
  const policy = {
    ...aggregate(8, 20),
    weights: [
      { source: "plan-multiplier" as const, revision: "2026-11-09-max20x-20", accountCount: 1 },
    ],
  };
  const saved = aggregate(0.4, 1, 1);
  for (const [reading, conservative, note] of [
    [policy, false, "plan multiplier"],
    [published, false, "published weekly multiplier"],
    [saved, true, "conservative estimate · 1x"],
  ] as const) {
    const snapshot = point(0, reading.remaining, {
      provider: "claude",
      windowSeconds: 604_800,
      minimum: reading,
      last: reading,
      plans: [{ plan: "Max 20x", minimum: reading, last: reading }],
    });
    assert.deepEqual(planChips(snapshot), [
      {
        key: "Max 20x",
        plan: "Max 20x",
        accounts: reading.accountCount,
        flagged: conservative,
        note,
      },
    ]);
  }
});

test("supported five-hour limits stay selectable without inventing measured capacity", () => {
  const observed = history([point(0, 2)]);
  const snapshot = structuredClone(observed);
  const accounts = [{ provider: "claude", plan: "Max 20x", windows: [] }];
  const labs = capacityLabs(observed, accounts);
  assert.deepEqual(
    labs[0]?.lines.map((line) => line.windowSeconds),
    [604800, 18000],
  );
  const missing = labs[0]!.lines.find((line) => line.windowSeconds === 18000)!;
  assert.deepEqual(missing.points, []);
  assert.equal(missing.forecast, null);
  assert.deepEqual(missing.refills, []);
  assert.equal(missing.supportedAccounts, 1);
  assert.equal(lineFacts(missing, observed.to).latest, null);
  const unknown = verdict(missing, lineFacts(missing, observed.to), 7);
  assert.equal(unknown.short, "No current 5-hour reading");
  assert.doesNotMatch(JSON.stringify(unknown), /idle|full allowance|100%/i);
  assert.match(unknown.detail!, /No previous 5-hour reading/);
  assert.deepEqual(observed, snapshot);
});

test("a missing current five-hour window keeps its last reading time without claiming its balance", () => {
  const observed = history([point(0, 2), point(0, 4, { windowSeconds: 18000 })]);
  const snapshot = structuredClone(observed);
  for (const windows of [
    [],
    [
      {
        id: "five_hour",
        label: "5 hours",
        windowSeconds: 18000,
        remainingRatio: 1,
        resetAt: "2026-11-01T00:00:00Z",
        observedAt: new Date(start).toISOString(),
      },
    ],
  ]) {
    const [lab] = capacityLabs(observed, [
      { provider: "claude", plan: "Max 20x", freshness: "stale", windows },
    ]);
    const line = lab!.lines.find((entry) => entry.windowSeconds === 18000)!;
    assert.equal(line.missingCurrentReading, true);
    assert.equal(line.lastReadingAt, start);
    const unknown = verdict(line, lineFacts(line, observed.to), 7);
    assert.equal(unknown.short, "No current 5-hour reading");
    assert.match(unknown.detail!, /Last 5-hour reading: 2026-11-02 00:00 UTC/);
    assert.doesNotMatch(JSON.stringify(unknown), /idle|100%|full allowance|Enough/i);
    assert.deepEqual(observed, snapshot);
  }
});

test("limit support follows known subscription plans and never creates a measured point", () => {
  const accounts = [
    { provider: "codex", plan: "Pro 20x", windows: [] },
    { provider: "claude", plan: "Future plan", windows: [] },
    { provider: "typesafe", plan: "Pro", windows: [] },
  ];
  const labs = capacityLabs(history([]), accounts);
  assert.deepEqual(
    labs.map((lab) => lab.provider),
    ["codex"],
  );
  assert.deepEqual(
    labs[0]!.lines.map((line) => line.windowSeconds),
    [604800, 18000],
  );
  assert.ok(labs[0]!.lines.every((line) => line.points.length === 0 && line.forecast === null));
  assert.deepEqual(capacityLabs(history([]), []), []);
});

test("only a fresh provider value restores a current five-hour reading", () => {
  const observed = { ...history([point(0, 2), point(0, 4, { windowSeconds: 18000 })]), to: start };
  const window = {
    id: "five_hour",
    label: "5 hours",
    windowSeconds: 18000,
    remainingRatio: 1,
    resetAt: null,
    observedAt: new Date(start).toISOString(),
  };
  for (const freshness of ["stale", "never", undefined] as const) {
    const line = capacityLabs(observed, [
      { provider: "claude", plan: "Max 20x", freshness, windows: [window] },
    ])[0]!.lines.find((line) => line.windowSeconds === 18000)!;
    assert.equal(line.missingCurrentReading, true);
  }
  for (const [remainingRatio, age] of [
    [null, 0],
    [0, 0],
    [1, 0],
    [1, 30 * 60_000 - 1],
  ] as const) {
    const line = capacityLabs(observed, [
      {
        provider: "claude",
        plan: "Max 20x",
        freshness: "fresh",
        windows: [{ ...window, remainingRatio, observedAt: new Date(start - age).toISOString() }],
      },
    ])[0]!.lines.find((line) => line.windowSeconds === 18000)!;
    assert.equal(line.missingCurrentReading, remainingRatio === null);
  }
});

test("fresh weekly collection never makes an expired or invalid five-hour value current", () => {
  const observed = history([point(0, 2), point(0, 4, { windowSeconds: 18000 })]);
  for (const observedAt of [
    new Date(observed.to - 30 * 60_000).toISOString(),
    new Date(observed.to - 31 * 60_000).toISOString(),
    new Date(observed.to + 1).toISOString(),
    null,
    "invalid",
  ]) {
    const line = capacityLabs(observed, [
      {
        provider: "claude",
        plan: "Max 20x",
        freshness: "fresh",
        windows: [
          {
            id: "five_hour",
            label: "5 hours",
            windowSeconds: 18000,
            remainingRatio: 1,
            resetAt: null,
            observedAt,
          },
        ],
      },
    ])[0]!.lines.find((line) => line.windowSeconds === 18000)!;
    assert.equal(line.missingCurrentReading, true, String(observedAt));
    assert.equal(verdict(line, lineFacts(line, observed.to), 7).short, "No current 5-hour reading");
    const parsed = Date.parse(observedAt ?? "");
    assert.equal(
      line.lastReadingAt,
      Number.isFinite(parsed) && parsed <= observed.to ? parsed : start,
    );
  }
});
