import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolView } from "../contract.ts";
import type { PoolOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSeriesResult } from "../usage-series-contract.ts";
import { coherentOverview, currentCapacity } from "./overview-snapshot.ts";

const range = { from: "2026-10-28T08:00:00.000Z", to: "2026-11-04T08:23:00.000Z" };
const series = (overrides: Partial<PoolUsageSeriesResult> = {}) => ({
  ...range,
  asOf: "capture-v1",
  next: null,
  ...overrides,
});
// The guard reads only bounds, pagination and watermarks. Unrelated measurements stay absent here.
function fixture() {
  const capacity = {
    from: Date.parse(range.from),
    to: Date.parse(range.to),
  } as PoolCapacityHistory;
  const usage = {
    ...range,
    asOf: "capture-v1",
    partial: false,
    consistency: "consistent",
    people: series(),
    models: series(),
  } as PoolOverviewResult;
  return { capacity, usage };
}

test("an overview verdict requires matching bounds and a complete unchanged usage snapshot", () => {
  const { capacity, usage } = fixture();
  assert.equal(coherentOverview(capacity, usage, range), true);
  assert.equal(coherentOverview(capacity, { ...usage, partial: true }, range), false);
  assert.equal(coherentOverview(capacity, { ...usage, consistency: "changed" }, range), false);
  assert.equal(
    coherentOverview(
      capacity,
      { ...usage, models: { ...usage.models, asOf: "new-capture" } },
      range,
    ),
    false,
  );
  assert.equal(coherentOverview({ ...capacity, to: capacity.to - 1 }, usage, range), false);
  assert.equal(
    coherentOverview(capacity, { ...usage, people: { ...usage.people, next: "more" } }, range),
    false,
  );
});

test("capacity from accounts the pool no longer has never shows as current", () => {
  const reading = (provider: string) =>
    ({ provider, windowSeconds: 604_800 }) as PoolCapacityHistory["points"][number];
  const capacity = {
    ok: true as const,
    value: {
      from: 0,
      to: 1,
      points: [reading("codex"), reading("claude")],
      forecasts: [{ provider: "codex" }, { provider: "claude" }],
      refillEvents: [{ provider: "codex" }],
    } as unknown as PoolCapacityHistory,
  };
  const pool = (providers: string[]) =>
    ({
      isOwner: true,
      providers: [],
      accounts: providers.map((provider) => ({ provider })),
    }) as unknown as PoolView;
  const empty = currentCapacity(capacity, pool([]));
  assert.ok(empty?.ok);
  assert.deepEqual(
    [empty.value.points, empty.value.forecasts, empty.value.refillEvents],
    [[], [], []],
  );
  const claude = currentCapacity(capacity, pool(["claude"]));
  assert.ok(claude?.ok);
  assert.deepEqual(
    claude.value.points.map((point) => point.provider),
    ["claude"],
  );
  assert.equal(claude.value.refillEvents.length, 0);
  // Before the pool view arrives nothing is filtered: absence isn't known yet.
  assert.equal(currentCapacity(capacity, undefined), capacity);
});
