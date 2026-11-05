import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSeriesResult } from "../usage-series-contract.ts";
import { coherentOverview } from "./overview-snapshot.ts";

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
