import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityOverview } from "./overview.ts";
import { CapacityHistory, type CapacityExpectedCohort } from "./history.ts";
import { ChunkStorage, type UsageStorage } from "../usage-storage.ts";
import type { CapacityReading } from "./normalize.ts";

class Memory implements UsageStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

const minute = 60_000;
const hour = 60 * minute;
const week = 7 * 24 * hour;
const windowSeconds = 7 * 24 * 60 * 60;
const start = Date.UTC(2026, 9, 5); // Monday UTC.
const regular = Array.from(
  { length: 168 },
  (_, index) => 2 + (index % 24 >= 9 && index % 24 < 17 ? 4 : 0),
);
const spike = regular.map((value, index) => (index === 2 * 24 + 12 ? value * 6 : value * 0.97));
const normalize = (values: readonly number[]) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => (value * 900) / total);
};

async function sampleWeeks(
  weeks: readonly (readonly number[])[],
  policy: Partial<CapacityReading> = {},
  peers: readonly Partial<CapacityReading>[] = [],
) {
  const storage = new Memory();
  const history = new CapacityHistory(storage);
  const account = "overview-fixture";
  const full = policy.full ?? 1_000;
  const expected: CapacityExpectedCohort[] = [
    { provider: "claude", windowSeconds, accounts: 1 },
    ...peers.map((peer) => ({
      provider: peer.provider!,
      windowSeconds: peer.windowSeconds!,
      accounts: 1,
    })),
  ];
  const withPeers = (reading: CapacityReading) => [
    reading,
    ...peers.map((peer) => ({
      ...reading,
      ...peer,
      remaining: (reading.remaining / reading.full) * (peer.full ?? reading.full),
    })),
  ];
  const unit = { id: "claude-pro-equivalent", label: "Pro-eq" };
  let at = start;
  for (const [weekIndex, raw] of weeks.entries()) {
    const hourly = normalize(raw).map((value) => value * (full / 1_000));
    let consumed = 0;
    for (let step = 0; step < week / (5 * minute); step++) {
      const weekHour = Math.floor(step / 12);
      if (step > 0 && step % 12 === 0) consumed += hourly[weekHour - 1]!;
      const resetAt = start + (weekIndex + 1) * week;
      const reading: CapacityReading = {
        account,
        provider: "claude",
        plan: "Pro",
        windowSeconds,
        mode: null,
        observedAt: at,
        resetAt,
        staleAt: at + 6 * minute,
        observationSource: "fixture",
        full,
        remaining: full - consumed,
        unit,
        source: "reference-plan",
        knownWeight: true,
        revision: "fixture-v1",
        ...policy,
      };
      await history.observe("pool", {
        at,
        expected,
        readings: withPeers(reading),
        accountStates: withPeers(reading).map((entry) => ({
          account: entry.account,
          provider: entry.provider,
          windowSeconds: entry.windowSeconds,
          usable: true,
          bankedAvailable: 0,
        })),
      });
      at += 5 * minute;
    }
  }
  // Observe the next scheduled reset before reading current balances.
  const finalReading: CapacityReading = {
    account,
    provider: "claude",
    plan: "Pro",
    windowSeconds,
    mode: null,
    observedAt: at,
    resetAt: start + (weeks.length + 1) * week,
    staleAt: at + 6 * minute,
    observationSource: "fixture",
    full,
    remaining: full,
    unit,
    source: "reference-plan",
    knownWeight: true,
    revision: "fixture-v1",
    ...policy,
  };
  await history.observe("pool", {
    at,
    expected,
    readings: withPeers(finalReading),
    accountStates: withPeers(finalReading).map((entry) => ({
      account: entry.account,
      provider: entry.provider,
      windowSeconds: entry.windowSeconds,
      usable: true,
      bankedAvailable: 0,
    })),
  });
  return {
    history,
    storage,
    latest: finalReading,
    peers: withPeers(finalReading).slice(1),
    expected,
    to: at,
  };
}

test("serialized quota samples reach a seasonal service forecast after two weeks and advice after four", async () => {
  const thin = await sampleWeeks([regular, regular]);
  const learning = await capacityOverview(thin.history, "pool", thin.to - 7 * 24 * hour, thin.to);
  const learned = learning.forecasts.find((forecast) => forecast.provider === "claude");
  assert.equal(learned?.status, "estimated");
  assert.equal(learned?.points.length, 72);
  assert.equal(learned?.backtest?.heldOutWeeks, 0);
  assert.equal(learned?.ordinary?.accounts, null);

  const enough = await sampleWeeks([regular, regular, spike, regular]);
  const advised = await capacityOverview(
    enough.history,
    "pool",
    enough.to - 7 * 24 * hour,
    enough.to,
  );
  const forecast = advised.forecasts.find((entry) => entry.provider === "claude");
  assert.equal(forecast?.status, "estimated");
  assert.equal(forecast?.history.completedWeeks, 4);
  assert.equal(forecast?.backtest?.beatsSeasonalNaive, true);
  assert.ok(forecast?.ordinary);
  assert.equal(typeof forecast.ordinary.accounts, "number");
  assert.ok(forecast.ordinary.accounts! >= 0);
});

for (const membership of ["connected", "removed", "legacy-removed", "legacy-removed-other"]) {
  test(`retained conservative demand cannot train new weekly weights: ${membership}`, async () => {
    const retained = await sampleWeeks([regular, regular, regular, regular], {
      plan: "Max 20x",
      full: 1,
      knownWeight: false,
      source: "unknown-plan",
      revision: "2026-10-30",
    });
    const before = await capacityOverview(retained.history, "pool", start, retained.to);
    assert.equal(before.forecasts[0]?.status, "estimated");
    assert.equal(before.forecasts[0]?.history.completedWeeks, 4);
    const displayed = await retained.history.read("pool", { to: retained.to });
    const oldDemand = await retained.history.demandData("pool");
    assert.ok(
      Object.values(oldDemand.accountDemandTotals).some((accounts) =>
        Object.values(accounts).some((total) => total > 0),
      ),
    );

    const observe = async (minutes: number, remaining: number, current: boolean) => {
      const at = retained.to + minutes * minute;
      await new CapacityHistory(retained.storage).observe("pool", {
        at,
        expected: retained.expected,
        accountStates: [
          {
            account: retained.latest.account,
            provider: "claude",
            windowSeconds,
            usable: true,
            bankedAvailable: 0,
          },
        ],
        readings: [
          {
            ...retained.latest,
            observedAt: at,
            staleAt: at + 6 * minute,
            remaining,
            ...(current
              ? {
                  full: 10,
                  knownWeight: true,
                  source: "published-weekly-multiplier" as const,
                  revision: "2026-11-09",
                }
              : {}),
          },
        ],
      });
    };
    await observe(5, 0.9, false);
    if (membership !== "connected") {
      await retained.history.observe("pool", {
        at: retained.to + 6 * minute,
        expected: [],
        readings: [],
        accountStates: [],
      });
      assert.deepEqual((await retained.history.demandData("pool")).latestReadings, []);
      if (membership.startsWith("legacy-removed")) {
        const chunks = new ChunkStorage(retained.storage);
        const key = "capacity-v1:pool:index";
        const index = await chunks.get<Record<string, unknown>>(key);
        assert.ok(index);
        delete index.demandRevisions;
        if (membership === "legacy-removed-other") {
          index.demandRevisions = {
            [JSON.stringify(["openai", windowSeconds, null, "chatgpt-plus-equivalent"])]: {
              revision: "2026-10-30",
              at: retained.to,
            },
          };
        }
        await chunks.put(key, index);
      }
    }
    await observe(10, 9, true);
    await observe(15, 8.9, true);
    const resumed = new CapacityHistory(retained.storage);
    const transitioned = await resumed.demandData("pool");
    assert.equal(transitioned.trackingSince, start);
    assert.equal(
      transitioned.cohortTrackingSince?.[
        JSON.stringify(["claude", windowSeconds, null, retained.latest.unit.id])
      ],
      retained.to + hour,
    );
    assert.equal(transitioned.completedWeeks, 4);
    assert.deepEqual(transitioned.points, []);
    assert.deepEqual(transitioned.accountDemandTotals, {});
    assert.deepEqual(await resumed.read("pool", { to: retained.to }), displayed);

    await observe(65, 8.8, true);
    await observe(70, 8.7, true);
    const fresh = await resumed.demandData("pool");
    assert.equal(
      fresh.cohortTrackingSince?.[
        JSON.stringify(["claude", windowSeconds, null, retained.latest.unit.id])
      ],
      retained.to + hour,
    );
    assert.equal(fresh.points.length, 1);
    assert.equal(fresh.points[0]?.hour, retained.to + hour);
    assert.ok(Math.abs(fresh.points[0]!.demand! - 0.1) < 1e-9);
    const totals = Object.values(fresh.accountDemandTotals).flatMap((accounts) =>
      Object.values(accounts),
    );
    assert.equal(totals.length, 1);
    assert.ok(Math.abs(totals[0]! - 0.1) < 1e-9);
    const after = await capacityOverview(resumed, "pool", start, retained.to + 70 * minute);
    assert.equal(after.forecasts[0]?.status, "learning");
    assert.equal(after.forecasts[0]?.history.completedWeeks, 0);
    assert.equal(after.forecasts[0]?.ordinary, null);
    assert.equal(after.forecasts[0]?.busy, null);
  });
}

test("mixed mature forecasts retain Codex and five-hour training when Claude weekly changes", async () => {
  const retained = await sampleWeeks(
    [regular, regular, regular, regular],
    {
      plan: "Max 20x",
      full: 1,
      source: "unknown-plan",
      knownWeight: false,
      revision: "2026-10-30",
    },
    [
      {
        account: "codex",
        provider: "codex",
        plan: "Plus",
        windowSeconds,
        full: 1,
        unit: { id: "chatgpt-plus-equivalent", label: "Plus-eq" },
        source: "reference-plan",
        knownWeight: true,
        revision: "2026-10-30",
      },
      {
        account: "overview-fixture",
        provider: "claude",
        windowSeconds: 18_000,
        full: 20,
        source: "published-session-multiplier",
        knownWeight: true,
        revision: "2026-10-30",
      },
    ],
  );
  const before = await capacityOverview(retained.history, "pool", start, retained.to);
  assert.equal(before.forecasts.length, 3);
  assert.ok(
    before.forecasts.every((forecast) => forecast.history.completedWeeks === 4),
    JSON.stringify(
      before.forecasts.map((f) => ({
        provider: f.provider,
        seconds: f.windowSeconds,
        status: f.status,
        history: f.history,
      })),
    ),
  );
  const at = retained.to + 5 * minute;
  await retained.history.observe("pool", {
    at,
    expected: retained.expected,
    readings: [
      {
        ...retained.latest,
        full: 10,
        remaining: 10,
        knownWeight: true,
        source: "published-weekly-multiplier",
        revision: "2026-11-09",
        observedAt: at,
        staleAt: at + 6 * minute,
      },
      ...retained.peers,
    ],
    accountStates: [retained.latest, ...retained.peers].map((entry) => ({
      account: entry.account,
      provider: entry.provider,
      windowSeconds: entry.windowSeconds,
      usable: true,
      bankedAvailable: 0,
    })),
  });
  const after = await capacityOverview(retained.history, "pool", start, at);
  for (const forecast of after.forecasts) {
    const changed = forecast.provider === "claude" && forecast.windowSeconds === windowSeconds;
    assert.equal(forecast.history.completedWeeks, changed ? 0 : 4);
    if (changed) assert.equal(forecast.status, "learning");
    if (forecast.provider === "codex") assert.equal(forecast.status, "estimated");
  }
});
