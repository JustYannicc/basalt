import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSummaryBucket, UsageSummaryGroup } from "../usage-overview-contract.ts";
import {
  breakdown,
  delta,
  incident,
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
  const range = summaryRange(7, now);
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
