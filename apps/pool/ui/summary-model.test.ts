import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSummaryBucket, UsageSummaryGroup } from "../usage-overview-contract.ts";
import {
  breakdown,
  cacheShare,
  calendarDays,
  dayTotal,
  delta,
  heatHours,
  stack,
  incident,
  knownRuns,
  personalRange,
  sinceOption,
  summaryRange,
  total,
  zurichDay,
  zurichMidnight,
} from "./summary-model.ts";

const tokens = (total: string | null) => {
  const sum = { sum: total, known: 1, missing: 0 };
  return { input: sum, output: sum, cacheRead: sum, cacheWrite: sum, reasoning: sum, total: sum };
};

function bucket(requests: number, amount: string | null, priced = requests): UsageSummaryBucket {
  return {
    at: "2026-11-10T23:00:00.000Z",
    end: "2026-11-11T23:00:00.000Z",
    partial: false,
    requests,
    failed: 0,
    limited: 0,
    details: {
      tokens: tokens(String(requests * 10)),
      apiEstimate: {
        status: amount === null ? "unavailable" : "available",
        amount,
        currency: "USD",
        pricedRequests: priced,
        excluded: { unknownKind: 0, unknownKindValue: null, unpriced: requests - priced },
        price: null,
      },
    },
  };
}

const group = (provider: string, buckets: UsageSummaryBucket[], countsOnly = false) =>
  ({ provider, countsOnly, buckets }) satisfies UsageSummaryGroup;

test("counts-only usage adds requests but never a token or money value", () => {
  const countsOnly = group("kimi", [{ ...bucket(7, null), details: null }], true);
  const groups = [group("codex", [bucket(10, "1.5")]), countsOnly];
  assert.deepEqual(total(groups, "requests"), { value: 17, missing: 0 });
  assert.deepEqual(total(groups, "tokens"), { value: 100, missing: 7 });
  assert.deepEqual(total(groups, "cost"), { value: 1.5, missing: 7 });
  assert.deepEqual(total([countsOnly], "cost"), { value: null, missing: 7 });
});

test("a partly priced bucket keeps its unpriced requests visible", () => {
  assert.deepEqual(total([group("claude", [bucket(10, "2", 8)])], "cost"), {
    value: 2,
    missing: 2,
  });
});

test("a change needs both sides and a non-zero base", () => {
  assert.equal(delta(12, 10), 0.2);
  assert.equal(delta(5, 0), null);
  assert.equal(delta(null, 10), null);
});

test("a client hang-up is never counted as a pool failure", () => {
  const now = incident({
    from: "",
    to: "",
    status: "available",
    requests: 40,
    failed: 4,
    failures: [
      { status: 499, count: 1 },
      { status: 502, count: 3 },
    ],
  });
  assert.equal(now.state, "failing");
  assert.equal(now.state === "failing" && now.failed, 3);
  assert.deepEqual(now.state === "failing" && now.failures, [{ status: 502, count: 3 }]);
  const hungUp = incident({
    from: "",
    to: "",
    status: "available",
    requests: 9,
    failed: 2,
    failures: [{ status: 499, count: 2 }],
  });
  assert.equal(hungUp.state, "clear");
  assert.equal(
    incident({ from: "", to: "", status: "unavailable", requests: 0, failed: 0, failures: [] })
      .state,
    "unknown",
  );
});

test("a range is whole Zurich days ending today, across a DST change", () => {
  // 2026-10-25 is the autumn change in Zurich.
  const now = Date.parse("2026-10-27T10:00:00Z");
  const range = summaryRange({ kind: "days", days: 7 }, now);
  assert.equal(range.from, "2026-10-20T22:00:00.000Z");
  assert.equal(zurichDay(range.from), "2026-10-21");
  assert.equal(new Date(zurichMidnight("2026-10-26")).toISOString(), "2026-10-25T23:00:00.000Z");
});

test("a lab's cost comes from the official usage slices of that lab", () => {
  const rows = breakdown(
    [group("codex", [bucket(10, "1")]), group("claude", [bucket(30, "3")])],
    [
      { provider: "claude", model: null, apiBilled: "4.5", apiUnpriced: 2 },
      { provider: "codex", model: null, apiBilled: null, apiUnpriced: 5 },
    ].map((slice) => ({
      person: null,
      requests: 1,
      apiPricedRequests: 1,
      subscriptionValue: null,
      subscriptionPricedRequests: 0,
      subscriptionUnpriced: 0,
      unknownKind: 0,
      unknownKindValue: null,
      price: null,
      ...slice,
    })),
    "provider",
    "requests",
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.share, row.cost]),
    [
      ["claude", 0.75, { amount: 4.5, unpriced: 2 }],
      ["codex", 0.25, { amount: null, unpriced: 5 }],
    ],
  );
});

test("partly counted tokens keep their sum and say how many requests lack counts", () => {
  const partly = bucket(10, "1");
  const counted = partly.details!;
  const missing = {
    ...partly,
    details: {
      ...counted,
      tokens: { ...counted.tokens, total: { sum: "60", known: 6, missing: 4 } },
    },
  };
  assert.deepEqual(total([group("codex", [missing])], "tokens"), { value: 60, missing: 4 });
  // A real zero stays a known zero.
  const zero = { ...partly, details: { ...counted, tokens: tokens("0") } };
  assert.deepEqual(total([group("codex", [zero])], "tokens"), { value: 0, missing: 0 });
});

test("cache share leaves out partly counted days and says so", () => {
  const whole = bucket(10, "1");
  const partly = {
    ...whole,
    details: {
      ...whole.details!,
      tokens: { ...whole.details!.tokens, total: { sum: "50", known: 5, missing: 5 } },
    },
  };
  assert.deepEqual(cacheShare([group("codex", [whole])]), { share: 1, partial: false });
  assert.deepEqual(cacheShare([group("codex", [whole, partly])]), { share: 1, partial: true });
});

test("an unknown day splits a sparkline instead of reading as zero", () => {
  assert.deepEqual(
    knownRuns([3, null, 0, 2]).map((run) => run.map((point) => point.value)),
    [[3], [0, 2]],
  );
});

test("a since-start range begins at the first retained day, capped at 400 days", () => {
  const now = Date.parse("2026-11-14T03:00:00Z");
  assert.equal(sinceOption(null, now), null);
  assert.equal(sinceOption(undefined, now), null);
  const recent = sinceOption("2026-05-03T09:15:00.000Z", now)!;
  assert.equal(recent.bounds.from, "2026-05-02T22:00:00.000Z");
  assert.equal(recent.bounds.bounded, false);
  assert.equal(recent.bounds.days, 196);
  const old = sinceOption("2024-01-02T00:00:00.000Z", now)!;
  assert.equal(old.bounds.bounded, true);
  assert.ok(now - Date.parse(old.bounds.from) <= 400 * 86_400_000);
  assert.equal(zurichDay(old.bounds.from), "2025-10-11");
  assert.equal(old.bounds.days, 400);
});

test("the member route never receives a since-start range", () => {
  const now = Date.parse("2026-11-14T03:00:00Z");
  const since = sinceOption("2026-05-03T09:15:00.000Z", now)!;
  const week = summaryRange({ kind: "days", days: 7 }, now);
  assert.deepEqual(personalRange(since.choice, since.bounds, now), {
    from: week.from,
    to: week.to,
    days: 7,
  });
  const thirty = summaryRange({ kind: "days", days: 30 }, now);
  assert.deepEqual(personalRange({ kind: "days", days: 30 }, thirty, now), {
    from: thirty.from,
    to: thirty.to,
    days: 30,
  });
});

test("a sparse week has seven calendar days; absent days stay unknown unless proven", () => {
  const now = Date.parse("2026-11-14T10:00:00Z");
  const week = summaryRange({ kind: "days", days: 7 }, now);
  const days = calendarDays(week.from, week.to);
  assert.equal(days.length, 7);
  assert.deepEqual([days[0], days[6]], ["2026-11-08", "2026-11-14"]);
  const one = { ...bucket(10, "7"), at: "2026-11-12T23:00:00.000Z" };
  const known = stack([group("codex", [one])], "provider", "cost", {
    ...week,
    knownDays: ["2026-11-09"],
  });
  assert.deepEqual(
    known.days.map((day) => [day.day, dayTotal(day)]),
    [
      ["2026-11-08", null],
      ["2026-11-09", 0],
      ["2026-11-10", null],
      ["2026-11-11", null],
      ["2026-11-12", null],
      ["2026-11-13", 7],
      ["2026-11-14", null],
    ],
  );
});

test("the calendar follows Zurich days across DST and the 400-day bound", () => {
  const dst = summaryRange({ kind: "days", days: 7 }, Date.parse("2026-10-27T10:00:00Z"));
  assert.deepEqual(calendarDays(dst.from, dst.to), [
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
    "2026-10-27",
  ]);
  const now = Date.parse("2026-11-14T03:00:00Z");
  const old = sinceOption("2024-01-02T00:00:00.000Z", now)!;
  const days = calendarDays(old.bounds.from, old.bounds.to);
  assert.equal(days.length, 400);
  assert.deepEqual([days[0], days.at(-1)], ["2025-10-11", "2026-11-14"]);
});

test("hourly values name unrecorded tokens instead of a zero", () => {
  const cell = (weekday: number, hour: number, sum: string | null) => ({
    provider: "codex",
    weekday,
    hour,
    requests: 1,
    tokens: { sum, known: 1, missing: 0 },
    sampleHours: 8,
  });
  assert.deepEqual(
    heatHours({
      from: "",
      to: "",
      basis: "recorded-usage",
      status: "available",
      cells: [cell(2, 12, null), cell(0, 10, "16000"), { ...cell(1, 3, "5"), sampleHours: 0 }],
    }),
    [
      { weekday: 0, hour: 10, value: 2000 },
      { weekday: 2, hour: 12, value: null },
    ],
  );
});
