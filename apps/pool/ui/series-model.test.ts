import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PoolUsageSeriesResult,
  SeriesBucket,
  SeriesCounts,
  SeriesGroup,
  SeriesKey,
} from "../usage-series-contract.ts";
import {
  addDecimal,
  decimal,
  decimalText,
  money,
  personalDirectory,
  readSeries,
  rows,
  total,
  type SeriesQuery,
} from "./series-model.ts";

const tokens = (sum: string | null, known = 1, missing = 0) => ({ sum, known, missing });

function bucket(overrides: {
  requests?: number;
  failed?: number;
  tokens?: string | null;
  home?: [string, string] | null;
  imported?: string | null;
  unpriced?: number;
}): SeriesBucket {
  const t = tokens(
    overrides.tokens === undefined ? "10" : overrides.tokens,
    overrides.tokens === null ? 0 : 1,
    overrides.tokens === null ? 1 : 0,
  );
  return {
    at: "2026-11-01T00:00:00.000000000Z",
    partial: false,
    requests: overrides.requests ?? 1,
    failed: overrides.failed ?? 0,
    unassignedFailures: 0,
    successRate: null,
    lastSuccessAtInRange: null,
    tokens: { input: t, output: t, cacheRead: t, cacheWrite: t, reasoning: t, total: t },
    tokenQuality: { complete: 1, legacy: 0, unclassified: 0, inconsistent: 0 },
    cost: {
      homeCharge: {
        amount: overrides.home?.[0] ?? null,
        currency: overrides.home?.[1] ?? null,
        priced: overrides.home ? 1 : 0,
        unpriced: 0,
      },
      importedApiPrice: {
        amount: overrides.imported ?? null,
        currency: overrides.imported ? "USD" : null,
        priced: overrides.imported ? 1 : 0,
        unpriced: 0,
      },
      apiEquivalent: { status: "unavailable", reason: "r" },
      unpricedRequests: overrides.unpriced ?? 0,
    },
    attribution: { chargeSnapshot: 0, keyAtCapture: 1, importOwner: 0, unknown: 0 },
  };
}
const counts = (requests: number): SeriesCounts => ({
  at: "2026-11-01T00:00:00.000000000Z",
  partial: false,
  requests,
  failed: 0,
  unassignedFailures: 0,
  successRate: null,
});
const group = (
  key: Partial<SeriesKey>,
  ...buckets: (SeriesBucket | SeriesCounts)[]
): SeriesGroup => ({ key: { currency: null, ...key }, buckets });

const coverage = {
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
    apiEquivalent: { status: "unavailable", reason: "r" },
  },
  priceProjection: { status: "unavailable", reason: "r" },
  percentiles: { status: "unavailable", reason: "r" },
  seasonalTrainingRange: { status: "unavailable", reason: "r" },
} as const satisfies PoolUsageSeriesResult["coverage"];
const page = (groups: SeriesGroup[], next: string | null, asOf = "a"): PoolUsageSeriesResult => ({
  from: "f",
  to: "t",
  bucket: "day",
  asOf,
  coverage,
  groups,
  next,
});
const input: SeriesQuery = { from: "f", to: "t", bucket: "day", by: ["person", "provider"] };

test("decimals add exactly across scales", () => {
  const sum = addDecimal(decimal("0.1")!, decimal("0.20000000000000001")!);
  assert.equal(decimalText(sum), "0.30000000000000001");
  assert.equal(decimal("1e5"), null);
});

test("token sums stay exact past Number precision", () => {
  const sum = total([
    group({ person: "p" }, bucket({ tokens: "9007199254740993" }), bucket({ tokens: "2" })),
  ]);
  assert.equal(sum.tokens, 9007199254740995n);
});

test("Home charges and imported USD prices never share a total", () => {
  const sum = total([
    group(
      { person: "p" },
      bucket({ home: ["1.5", "credits"], imported: "0.25" }),
      bucket({ home: ["2", "credits"] }),
    ),
  ]);
  assert.deepEqual(sum.home.map(money), ["3.5 credits"]);
  assert.deepEqual(sum.imported.map(money), ["$0.25"]);
});

test("a missing token count is not zero tokens", () => {
  const sum = total([group({ person: "p" }, bucket({ tokens: null }))]);
  assert.equal(sum.tokensKnown, 0);
  assert.equal(sum.tokensMissing, 1);
});

test("imports, unattributed and unmapped history keep their own labels", () => {
  const list = rows(
    [
      group({ person: null, attribution: "import-owner", provider: "claude" }, bucket({})),
      group({ person: null, provider: "claude" }, bucket({})),
      group({ account: "unmapped" }, counts(5)),
      group({ person: "abcdef123", provider: "claude" }, bucket({ tokens: "100" })),
    ],
    "person",
    (id) => id,
  );
  assert.deepEqual(
    list.map((row) => row.label),
    [
      "Person abcdef",
      "Imported history · no person attributed",
      "Unattributed",
      "Not mapped to an account yet",
    ],
  );
  assert.equal(list.at(-1)!.countsOnly, true);
  assert.equal(list.at(-1)!.totals.countsOnly, 5);
});

test("labs open to their people", () => {
  const list = rows(
    [
      group({ person: "a", provider: "claude" }, bucket({})),
      group({ person: "b", provider: "claude" }, bucket({})),
    ],
    "provider",
    () => "Claude",
  );
  assert.equal(list.length, 1);
  assert.equal(list[0]!.children.length, 2);
  assert.equal(list[0]!.byProvider.get("claude"), 20n);
});

test("pages merge by key and stop at the cap with a partial flag", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return {
      ok: true as const,
      value: page(
        [group({ person: "p", provider: "claude" }, bucket({}))],
        "more",
        calls === 2 ? "b" : "a",
      ),
    };
  };
  const result = await readSeries(fetch, input, 3);
  assert.ok(result.ok);
  assert.equal(calls, 3);
  assert.equal(result.value.truncated, true);
  assert.equal(result.value.asOfChanged, true);
  assert.equal(result.value.asOf, "a");
  assert.equal(result.value.groups.length, 1);
  assert.equal(result.value.groups[0]!.buckets.length, 3);
});

test("a failed page fails the read instead of showing a partial total as complete", async () => {
  let calls = 0;
  const fetch = async () =>
    ++calls === 1
      ? { ok: true as const, value: page([], "more") }
      : { ok: false as const, error: "backend_unavailable" as const, message: "down" };
  const result = await readSeries(fetch, input);
  assert.equal(result.ok, false);
});

test("people retain directory names and inactive rows, and open to exact model/person statistics", () => {
  const list = rows(
    [
      group({ person: "person-a", provider: "claude", model: "model-a" }, bucket({ tokens: "20" })),
      group({ person: "person-a", provider: "claude", model: "model-b" }, bucket({ tokens: "10" })),
    ],
    "person",
    () => "Claude",
    [
      { person: "person-a", displayName: "Pat Example", active: true },
      { person: "person-b", displayName: "Idle Example", active: false },
    ],
    {
      byPerson: [],
      byModel: [],
      byModelPerson: [
        { person: "person-a", provider: "claude", model: "model-a", p50: 10, p90: 20, p99: 30 },
      ],
    },
  );
  const pat = list.find((row) => row.label === "Pat Example")!;
  assert.deepEqual(
    pat.children.map((row) => row.label),
    ["model-a", "model-b"],
  );
  assert.deepEqual(pat.children[0]!.usageKey, {
    person: "person-a",
    provider: "claude",
    model: "model-a",
  });
  assert.equal(pat.children[0]!.requestTokens?.p90, 20);
  assert.equal(list.find((row) => row.label === "Idle Example")?.empty, true);
});

test("personal overview keeps the signed caller row visible before their first request", () => {
  const [you] = personalDirectory("caller-hash", false);
  const list = rows([], "person", (id) => id, you ? [you] : [], {
    byPerson: [],
    byModel: [],
    byModelPerson: [],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.label, "You");
  assert.equal(list[0]!.empty, true);
});
