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
  await publishRoutingDemand(client, "pool", empty, now, [], [forecast]);
  assert.deepEqual(writes[0], {
    groups: [1],
    inputs: [forecast],
    capacity: [],
    replaceSources: ["observed-quota-burn", "history-forecast"],
  });
  await publishRoutingDemand(client, "pool", empty, now + 60_000, [], [forecast]);
  assert.deepEqual(writes[1], {
    groups: [1],
    inputs: [],
    capacity: [],
    replaceSources: ["observed-quota-burn", "history-forecast"],
  });
  await publishRoutingDemand(client, "pool", empty, now, []);
  assert.deepEqual(writes[2], {
    groups: [1],
    inputs: [],
    capacity: [],
    replaceSources: ["observed-quota-burn"],
  });
});

test("actual hashed capacity history resolves through current inventory and publishes duplicate groups as one scope", async () => {
  const { CapacityHistory } = await import("./capacity/history.ts");
  const values = new Map<string, unknown>();
  const history = new CapacityHistory({
    async get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
  });
  const hour = 3_600_000,
    start = now - 3 * hour;
  for (let index = 0; index <= 36; index++) {
    const at = start + index * 5 * 60_000;
    await history.observe("pool", {
      at,
      expected: [{ provider: "claude", windowSeconds: 604800, accounts: 2 }],
      readings: ["home-a", "home-b"].map((account) => ({
        account,
        provider: "claude",
        plan: "Pro",
        windowSeconds: 604800,
        mode: "fixed",
        observedAt: at,
        resetAt: now + 24 * hour,
        staleAt: at + 15 * 60_000,
        observationSource: "fixture",
        full: 1,
        remaining: 0.8 - index / 240,
        unit: { id: "weekly", label: "weekly units" },
        source: "reference-plan",
        knownWeight: true,
        revision: "fixture",
      })),
      accountStates: ["home-a", "home-b"].map((account) => ({
        account,
        provider: "claude",
        windowSeconds: 604800,
        usable: true,
        bankedAvailable: null,
      })),
    });
  }
  const data = await history.demandData("pool", start);
  assert.ok(data.latestReadings.every((reading) => /^[a-f0-9]{64}$/.test(reading.account)));
  assert.ok(data.points.length >= 2);
  const writes: { groups: number[]; inputs: RoutingDemandInput[] }[] = [];
  const client = new HomeClient(async (path, init) => {
    if (path.endsWith("/channel-groups"))
      return Response.json({
        channel_groups: [
          { id: 3, channel_name: "signalbox-pool-pool" },
          { id: 1, channel_name: "signalbox-pool-pool" },
        ],
      });
    const body: { groups: number[]; inputs: RoutingDemandInput[] } = JSON.parse(String(init?.body));
    writes.push(body);
    return Response.json({ success: true });
  });
  await publishRoutingDemand(client, "pool", data, now, ["home-a", "home-b"]);
  assert.deepEqual(
    [
      ...new Set(
        writes.flatMap((write) =>
          write.inputs.flatMap((input) =>
            input.windows.flatMap((window) => window.accounts.map((account) => account.account)),
          ),
        ),
      ),
    ].sort(),
    ["home-a", "home-b"],
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.groups, [1, 3]);
  assert.equal(writes[0]!.inputs[0]!.source, "observed-quota-burn");
  assert.ok(!JSON.stringify([...values.values()]).includes("home-a"));
  assert.ok(!JSON.stringify([...values.values()]).includes("home-b"));
  await publishRoutingDemand(client, "pool", data, now, []);
  assert.deepEqual(writes[1]!.inputs, []);
});
