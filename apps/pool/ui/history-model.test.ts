import assert from "node:assert/strict";
import test from "node:test";
import type { PoolUsageSeriesResult, SeriesGroup } from "../usage-series-contract.ts";
import type { SeriesFetch } from "./series-model.ts";
import {
  historyDateBounds,
  historyWindows,
  monthCounts,
  readHistorySeries,
} from "./history-model.ts";

const coverage: PoolUsageSeriesResult["coverage"] = {
  sources: [],
  firstAt: null,
  lastAt: null,
  capturedThrough: null,
  mapping: {
    current: true,
    historicalGenerations: "unknown",
    proof: "unavailable",
    mapped: 0,
    unmapped: 0,
    otherAccounts: 0,
  },
  pricing: {
    homeCharge: 0,
    importedApiPrice: 0,
    unpriced: 0,
    missing: 0,
    missingSnapshot: 0,
    missingVersion: 0,
    apiEquivalent: { status: "unavailable", reason: "Not exposed" },
  },
  priceProjection: { status: "unavailable", reason: "Not exposed" },
  percentiles: { status: "unavailable", reason: "Not exposed" },
  seasonalTrainingRange: { status: "unavailable", reason: "Not exposed" },
};

test("All time uses retained coverage, and one-sided dates stay open", () => {
  const firstAt = "2026-05-05T11:20:00.000Z";
  const now = Date.parse("2026-11-07T13:00:00.000Z");

  assert.deepEqual(historyDateBounds({}, firstAt, now), {
    from: "2026-05-05T11:19:59.999Z",
    to: "2026-11-07T13:00:00.000Z",
  });
  assert.deepEqual(historyDateBounds({ from: "2026-08-06" }, firstAt, now), {
    from: "2026-08-06T00:00:00.000Z",
    to: "2026-11-07T13:00:00.000Z",
  });
  assert.deepEqual(historyDateBounds({ to: "2026-08-06" }, firstAt, now), {
    from: "2026-05-05T11:19:59.999Z",
    to: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(historyDateBounds({ from: "2026-08-07", to: "2026-08-06" }, firstAt, now), null);
  assert.equal(
    historyDateBounds({}, "2026-08-06T00:00:00.000000100Z", now)?.from,
    "2026-08-05T23:59:59.999Z",
    "include nanosecond rows that share a rounded PostgreSQL timestamp",
  );
});

test("All-time series queries cover long history without the overview's 7/30-day choices", () => {
  const from = "2024-09-01T00:00:00.000Z";
  const to = "2026-11-07T13:00:00.000Z";
  const windows = historyWindows(from, to);

  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.from, from);
  assert.equal(windows.at(-1)!.to, to);
  assert.equal(windows[0]!.to, windows[1]!.from);
  assert.ok(
    windows.every(
      ({ from: start, to: end }) => Date.parse(end) - Date.parse(start) <= 400 * 86_400_000,
    ),
  );
});

test("monthly totals merge people, native and unattributed imported rows from the series", () => {
  const groups: SeriesGroup[] = [
    {
      key: { currency: null, person: "person-a" },
      buckets: [
        {
          at: "2026-08-06T00:00:00.000000000Z",
          partial: false,
          requests: 4,
          failed: 0,
          unassignedFailures: 0,
          successRate: 100,
        },
      ],
    },
    {
      key: { currency: null, person: null, attribution: "import-owner", source: "import-a" },
      buckets: [
        {
          at: "2026-08-07T00:00:00.000000000Z",
          partial: false,
          requests: 6,
          failed: 1,
          unassignedFailures: 0,
          successRate: 83.3,
        },
        {
          at: "2026-09-01T00:00:00.000000000Z",
          partial: false,
          requests: 2,
          failed: 0,
          unassignedFailures: 0,
          successRate: 100,
        },
      ],
    },
  ];

  assert.deepEqual(monthCounts(groups), [
    { month: "2026-08", requests: 10 },
    { month: "2026-09", requests: 2 },
  ]);
});

test("history series follow cursors and merge retained imports across long-range windows", async () => {
  const counts = (at: string, requests: number) => ({
    at,
    partial: false,
    requests,
    failed: 0,
    unassignedFailures: 0,
    successRate: 100,
  });
  const page = (
    from: string,
    to: string,
    groups: SeriesGroup[],
    next: string | null,
    asOf: string,
  ) => ({
    from,
    to,
    bucket: "day" as const,
    asOf,
    coverage,
    groups,
    next,
  });
  const bounds = { from: "2024-09-01T00:00:00.000Z", to: "2026-11-07T13:00:00.000Z" };
  const requests: { from: string; to: string; after?: string }[] = [];
  const fetch: SeriesFetch = async (input) => {
    requests.push(input);
    const imported: SeriesGroup = {
      key: { currency: null, source: "source-a", attribution: "import-owner", person: null },
      buckets: [],
    };
    if (input.after === undefined && requests.length === 1)
      return {
        ok: true,
        value: page(
          input.from,
          input.to,
          [{ ...imported, buckets: [counts("2024-10-01T00:00:00.000000000Z", 3)] }],
          "cursor-a",
          "snapshot-a",
        ),
      };
    if (input.after === "cursor-a")
      return {
        ok: true,
        value: page(
          input.from,
          input.to,
          [{ ...imported, buckets: [counts("2025-02-01T00:00:00.000000000Z", 4)] }],
          null,
          "snapshot-a",
        ),
      };
    return {
      ok: true,
      value: page(
        input.from,
        input.to,
        [{ ...imported, buckets: [counts("2026-08-01T00:00:00.000000000Z", 5)] }],
        null,
        "snapshot-b",
      ),
    };
  };

  const result = await readHistorySeries(fetch, bounds, 3);

  assert.ok(result.ok);
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.from, bounds.from);
  assert.equal(requests[0]!.to, requests[2]!.from);
  assert.equal(requests[2]!.to, bounds.to);
  assert.equal(requests[1]!.after, "cursor-a");
  assert.equal(result.value.groups.length, 1);
  assert.deepEqual(
    result.value.groups[0]!.buckets.map(({ requests }) => requests),
    [3, 4, 5],
  );
  assert.equal(
    result.value.changed,
    false,
    "different ranges have independent ingestion watermarks",
  );
  assert.equal(result.value.asOf, "snapshot-b");
  assert.equal(result.value.partial, false);
});

test("dates before retention return an empty readable range and invalid calendar dates are rejected", () => {
  const now = Date.parse("2026-11-07T13:00:00Z");
  assert.deepEqual(historyDateBounds({ to: "2025-01-01" }, "2026-05-05T11:20:00.000Z", now), {
    from: "1970-01-01T00:00:00.000Z",
    to: "2025-01-02T00:00:00.000Z",
  });
  assert.equal(historyDateBounds({ from: "2026-02-30" }, null, now), null);
  assert.deepEqual(historyDateBounds({ from: "2026-08-06", to: "2026-08-06" }, null, now), {
    from: "2026-08-06T00:00:00.000Z",
    to: "2026-08-07T00:00:00.000Z",
  });
});

test("series windows preserve nanosecond bounds without exceeding the server's 400-day limit", () => {
  const from = "2024-09-01T00:00:00.000000001Z";
  const to = "2026-11-07T13:00:00.000000002Z";
  const windows = historyWindows(from, to);
  assert.equal(windows[0]!.from, from);
  assert.equal(windows.at(-1)!.to, to);
  assert.equal(windows[0]!.to, windows[1]!.from);
  assert.deepEqual(historyWindows(from, "2024-09-01T00:00:00.000000002Z"), [
    { from, to: "2024-09-01T00:00:00.000000002Z" },
  ]);
  const justOver = historyWindows("2024-01-01T00:00:00.000Z", "2025-02-04T00:00:00.000000001Z");
  assert.equal(justOver.length, 2);
});

test("history retains bounded totals and reports a remaining cursor", async () => {
  const bounds = { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" };
  const queries: string[] = [];
  const fetch: SeriesFetch = async (input) => {
    queries.push(input.after ?? "first");
    return {
      ok: true,
      value: {
        ...input,
        bucket: "day",
        coverage,
        groups: [],
        next: "next-page",
        asOf: input.after ? "2026-11-07T12:01:00Z" : "2026-11-07T12:00:00Z",
      },
    };
  };
  const result = await readHistorySeries(fetch, bounds, 2);
  assert.ok(result.ok);
  assert.deepEqual(queries, ["first", "next-page"]);
  assert.equal(result.value.partial, true);
  assert.equal(result.value.changed, true);
});

test("history returns an authorization failure instead of turning it into an empty total", async () => {
  const failure = { ok: false as const, error: "unauthorized", message: "Managers only" };
  let reads = 0;
  const result = await readHistorySeries(
    async () => {
      reads++;
      return failure;
    },
    {
      from: "2024-01-01T00:00:00Z",
      to: "2026-11-07T00:00:00Z",
    },
  );
  assert.equal(result, failure);
  assert.equal(reads, 1);
});
