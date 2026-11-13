import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { publishRoutingDemand } from "./routing-demand.ts";
import type { CapacityDemandData } from "./capacity/history.ts";
import type { RoutingDemandInput } from "./routing-demand-contract.ts";

const now = Date.UTC(2026, 10, 13);
const empty: CapacityDemandData = {
  trackingSince: null,
  readAt: null,
  completedWeeks: 0,
  points: [],
  latestReadings: [],
  accountStates: [],
  unclassifiedProviders: [],
  accountDemandTotals: {},
  rollingUse: {},
  rollingComplete: {},
  refills: [],
};
const forecast: RoutingDemandInput = {
  revision: "test",
  provider: "claude",
  modelFamily: null,
  calculatedAt: new Date(now).toISOString(),
  validUntil: new Date(now + 60_000).toISOString(),
  source: "history-forecast",
  confidence: "medium",
  history: {
    from: new Date(now - 7 * 86400_000).toISOString(),
    through: new Date(now).toISOString(),
    coverageRatio: 1,
    censored: false,
    heldOutPeriods: 2,
    relativeError: 0.1,
  },
  windows: [],
};

test("alarm publishes forecast replacement atomically and clears stale producer inputs", async () => {
  const writes: unknown[] = [];
  const client = new HomeClient(async (path, init) => {
    if (path.endsWith("/channel-groups"))
      return Response.json({
        channel_groups: [
          { id: 1, channel_name: "signalbox-pool-pool" },
          { id: 2, channel_name: "signalbox-pool-other" },
        ],
      });
    assert.equal(path, "/v8/management/channel-groups/1/routing-demand");
    assert.equal(init?.method, "PUT");
    writes.push(JSON.parse(String(init?.body)));
    return Response.json({ success: true });
  });
  await publishRoutingDemand(client, "pool", empty, now, [forecast]);
  assert.deepEqual(writes[0], {
    inputs: [forecast],
    capacity: [],
    replaceSources: ["observed-quota-burn", "history-forecast"],
  });
  await publishRoutingDemand(client, "pool", empty, now + 60_000, [forecast]);
  assert.deepEqual(writes[1], {
    inputs: [],
    capacity: [],
    replaceSources: ["observed-quota-burn", "history-forecast"],
  });
  await publishRoutingDemand(client, "pool", empty, now);
  assert.deepEqual(writes[2], {
    inputs: [],
    capacity: [],
    replaceSources: ["observed-quota-burn"],
  });
});
