import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityWeight } from "./weights.ts";
import { CapacityHistory, type CapacityExpectedCohort } from "./history.ts";
import type { CapacityReading } from "./normalize.ts";
import { ChunkStorage, type UsageStorage } from "../usage-storage.ts";

class Memory implements UsageStorage {
  values = new Map<string, unknown>();
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

const hour = 3_600_000;
const start = Date.parse("2026-11-03T10:05:00Z");
const expected = (accounts: number): CapacityExpectedCohort[] => [
  { provider: "claude", windowSeconds: 18_000, accounts },
];

function reading(
  account: string,
  remaining: number,
  options: Partial<CapacityReading> = {},
): CapacityReading {
  const base: CapacityReading = {
    account,
    provider: "claude",
    plan: "Pro",
    windowSeconds: 18_000,
    mode: "rolling",
    observedAt: start - 60_000,
    resetAt: null,
    staleAt: null,
    observationSource: "fixture",
    full: 5,
    remaining,
    unit: { id: "claude-pro-equivalent", label: "Pro-eq" },
    source: "reference-plan",
    knownWeight: true,
    revision: "r1",
  };
  return { ...base, ...options };
}

test("hourly totals keep weighted minimum and last with per-plan source-time ranges and no account IDs", async () => {
  const storage = new Memory(),
    history = new CapacityHistory(storage);
  const firstAt = start,
    minimumAt = start + 5 * 60_000,
    lastAt = start + 10 * 60_000;
  await history.observe("pool-a", {
    at: firstAt,
    expected: expected(2),
    readings: [
      reading("private-account-a", 2, { observedAt: firstAt - 30_000 }),
      reading("private-account-b", 10, {
        plan: "Max 20x",
        full: 20,
        remaining: 10,
        observedAt: firstAt - 10_000,
        source: "published-session-multiplier",
        revision: "session-v1",
      }),
    ],
  });
  await history.observe("pool-a", {
    at: minimumAt,
    expected: expected(2),
    readings: [
      reading("private-account-a", 1, { observedAt: minimumAt - 20_000 }),
      reading("private-account-b", 8, {
        plan: "Max 20x",
        full: 20,
        remaining: 8,
        observedAt: minimumAt - 5_000,
        source: "published-session-multiplier",
        revision: "session-v1",
      }),
    ],
  });
  await history.observe("pool-a", {
    at: lastAt,
    expected: expected(2),
    readings: [
      reading("private-account-a", 4, { observedAt: lastAt - 40_000 }),
      reading("private-account-b", 11, {
        plan: "Max 20x",
        full: 20,
        remaining: 11,
        observedAt: lastAt - 2_000,
        source: "published-session-multiplier",
        revision: "session-v1",
      }),
    ],
  });

  const points = await history.read("pool-a");
  assert.equal(points.length, 1);
  const point = points[0]!;
  assert.equal(point.hour, Date.parse("2026-11-03T10:00:00Z"));
  assert.deepEqual(point.minimum, {
    remaining: 9,
    full: 25,
    at: minimumAt,
    observedAt: { from: minimumAt - 20_000, to: minimumAt - 5_000 },
    accountCount: 2,
    knownWeightCount: 2,
    unknownWeightCount: 0,
    weights: [
      { source: "published-session-multiplier", revision: "session-v1", accountCount: 1 },
      { source: "reference-plan", revision: "r1", accountCount: 1 },
    ],
  });
  assert.deepEqual(point.last, {
    remaining: 15,
    full: 25,
    at: lastAt,
    observedAt: { from: lastAt - 40_000, to: lastAt - 2_000 },
    accountCount: 2,
    knownWeightCount: 2,
    unknownWeightCount: 0,
    weights: [
      { source: "published-session-multiplier", revision: "session-v1", accountCount: 1 },
      { source: "reference-plan", revision: "r1", accountCount: 1 },
    ],
  });
  assert.deepEqual(
    point.plans.map(({ plan, minimum, last }) => [plan, minimum.remaining, last?.remaining]),
    [
      ["Max 20x", 8, 11],
      ["Pro", 1, 4],
    ],
  );
  assert.equal(JSON.stringify(points).includes("private-account"), false);
  assert.equal(JSON.stringify([...storage.values]).includes("private-account"), false);
});

test("five-hour measurements gate each account by its weekly balance and retain raw quota by plan", async () => {
  const history = new CapacityHistory(new Memory());
  const weeklyWindow = 7 * 24 * 60 * 60;
  await history.observe("pool-a", {
    at: start,
    expected: [...expected(2), { provider: "claude", windowSeconds: weeklyWindow, accounts: 2 }],
    readings: [
      reading("private-account-a", 6, {
        plan: "Pro",
        full: 10,
        mode: "fixed",
        observedAt: start - 30_000,
      }),
      reading("private-account-b", 7, {
        plan: "Max",
        full: 20,
        mode: "fixed",
        observedAt: start - 20_000,
      }),
      reading("private-account-a", 0, {
        windowSeconds: weeklyWindow,
        mode: null,
        full: 100,
        observedAt: start - 30_000,
      }),
      reading("private-account-b", 50, {
        windowSeconds: weeklyWindow,
        mode: null,
        full: 100,
        observedAt: start - 20_000,
      }),
    ],
  });

  const point = (await history.read("pool-a")).find((entry) => entry.windowSeconds === 18_000)!;
  assert.equal(point.minimum.remaining, 7);
  assert.equal(point.minimum.full, 30);
  assert.deepEqual(
    point.plans.map((plan) => [plan.plan, plan.minimum.remaining]),
    [
      ["Max", 7],
      ["Pro", 0],
    ],
  );
  assert.equal(point.raw?.minimum.remaining, 13);
  assert.deepEqual(
    point.raw?.plans.map((plan) => [plan.plan, plan.minimum.remaining]),
    [
      ["Max", 7],
      ["Pro", 6],
    ],
  );
  assert.equal(point.usable?.remaining, 20);
});

test("mixed units validate provider/window cohort coverage before storing separate groups", async () => {
  const history = new CapacityHistory(new Memory());
  const absolute = reading("private-account-b", 70, {
    full: 100,
    remaining: 70,
    unit: { id: "credits-usd", label: "credits (USD)" },
    source: "reported-absolute",
    knownWeight: true,
  });
  const first = await history.observe("pool-a", {
    at: start,
    expected: expected(2),
    readings: [
      reading("private-account-a", 3, {
        plan: "Mystery",
        source: "unknown-plan",
        knownWeight: false,
      }),
      absolute,
    ],
  });
  assert.deepEqual(first, { accepted: true, groups: 2, incomplete: 0 });
  const points = await history.read("pool-a");
  assert.equal(points.length, 2);
  assert.deepEqual(points.map((point) => point.last.accountCount).sort(), [1, 1]);
  assert.equal(
    points.find((point) => point.unit.id === "claude-pro-equivalent")?.last.unknownWeightCount,
    1,
  );
  assert.deepEqual(points.find((point) => point.unit.id === "credits-usd")?.last.weights, [
    { source: "reported-absolute", revision: "r1", accountCount: 1 },
  ]);

  const missing = await history.observe("pool-a", {
    at: start + hour,
    expected: expected(2),
    readings: [reading("private-account-a", 0, { observedAt: start + hour - 1 })],
  });
  assert.deepEqual(missing, { accepted: true, groups: 0, incomplete: 1 });
  assert.equal((await history.read("pool-a")).length, 2);

  const duplicateAccount = await history.observe("pool-a", {
    at: start + 2 * hour,
    expected: expected(1),
    readings: [
      reading("private-account-a", 2, { observedAt: start + 2 * hour - 1 }),
      reading("private-account-a", 90, {
        full: 100,
        remaining: 90,
        unit: { id: "credits-usd", label: "credits (USD)" },
        source: "reported-absolute",
        observedAt: start + 2 * hour - 1,
      }),
    ],
  });
  assert.deepEqual(duplicateAccount, { accepted: true, groups: 2, incomplete: 0 });
  assert.equal((await history.read("pool-a")).length, 4);
});

test("unchanged source observations are deduplicated and older snapshots are rejected", async () => {
  const history = new CapacityHistory(new Memory()),
    sample = reading("private-account-a", 2);
  assert.deepEqual(
    await history.observe("pool-a", { at: start, expected: expected(1), readings: [sample] }),
    {
      accepted: true,
      groups: 1,
      incomplete: 0,
    },
  );
  assert.deepEqual(
    await history.observe("pool-a", {
      at: start + 5 * 60_000,
      expected: expected(1),
      readings: [sample],
    }),
    {
      accepted: true,
      groups: 0,
      incomplete: 0,
    },
  );
  assert.deepEqual(
    await history.observe("pool-a", {
      at: start + 2 * 60_000,
      expected: expected(1),
      readings: [sample],
    }),
    {
      accepted: false,
      groups: 0,
      incomplete: 0,
    },
  );
  const points = await history.read("pool-a");
  assert.equal(points.length, 1);
  assert.equal(points[0]!.last.at, start);
});

test("an expected account with no comparable reading keeps the forecast exposure incomplete", async () => {
  const storage = new Memory(),
    history = new CapacityHistory(storage);
  const accountStates = ["private-account-a", "private-account-never-read"].map((account) => ({
    account,
    provider: "claude",
    windowSeconds: 18_000,
    usable: true,
    bankedAvailable: null,
  }));
  await history.observe("pool-a", {
    at: start,
    expected: expected(2),
    accountStates,
    readings: [reading("private-account-a", 4, { observedAt: start - 1_000 })],
  });
  await history.observe("pool-a", {
    at: start + 5 * 60_000,
    expected: expected(2),
    accountStates,
    readings: [reading("private-account-a", 3, { observedAt: start + 5 * 60_000 - 1_000 })],
  });
  const demand = await history.demandData("pool-a");
  assert.equal(demand.points.length, 1);
  assert.equal(demand.points[0]!.membershipIncomplete, true);
  assert.equal(demand.points[0]!.coverage, 0);
  assert.equal(JSON.stringify([...storage.values]).includes("private-account-never-read"), false);
});

test("rolling expiry use is reconstructed from a persisted empty anchor and sample-time events", async () => {
  const storage = new Memory();
  const history = new CapacityHistory(storage);
  const account = "private-rolling-account";
  const accountStates = [
    { account, provider: "claude", windowSeconds: 18_000, usable: true, bankedAvailable: null },
  ];
  const sample = (sourceAt: number, remaining: number): CapacityReading =>
    reading(account, remaining, {
      windowSeconds: 18_000,
      mode: "rolling",
      full: 100,
      resetAt: null,
      observedAt: sourceAt,
      staleAt: sourceAt + 6 * 60_000,
      source: "reference-plan",
      revision: "rolling-r1",
    });
  const observe = (at: number, sourceAt: number, remaining: number) =>
    history.observe("pool-a", {
      at,
      expected: expected(1),
      accountStates,
      readings: [sample(sourceAt, remaining)],
    });

  await observe(start, start, 100); // The full window anchors a known empty-use queue.
  await observe(start + 5 * 60_000, start + 5 * 60_000, 80); // 20 units were consumed.
  await observe(start + 10 * 60_000, start + 5 * 60_000, 80); // An unchanged source sample preserves the chain.
  const resumed = new CapacityHistory(storage); // The chain and its event journal survive a sampler restart.
  for (let at = start + 15 * 60_000; at <= start + 5 * hour; at += 5 * 60_000)
    await resumed.observe("pool-a", {
      at,
      expected: expected(1),
      accountStates,
      readings: [sample(at, 80)],
    });
  // The sample interval covers the known expiry at +5:05 and 15 new units of use.
  await resumed.observe("pool-a", {
    at: start + 5 * hour + 10 * 60_000,
    expected: expected(1),
    accountStates,
    readings: [sample(start + 5 * hour + 10 * 60_000, 85)],
  });
  const complete = await resumed.demandData("pool-a");
  const group = Object.keys(complete.rollingComplete)[0]!;
  const hashedAccount = Object.keys(complete.rollingComplete[group]!)[0]!;
  assert.equal(complete.rollingComplete[group]![hashedAccount]!.complete, true);
  assert.deepEqual(complete.rollingUse[group]![hashedAccount], [
    { at: start + 5 * hour + 10 * 60_000, amount: 15 },
  ]);

  const unanchored = new CapacityHistory(new Memory());
  const unanchoredAccount = "private-unanchored-rolling-account";
  const unanchoredStates = [
    {
      account: unanchoredAccount,
      provider: "claude",
      windowSeconds: 18_000,
      usable: true,
      bankedAvailable: null,
    },
  ];
  await unanchored.observe("pool-b", {
    at: start,
    expected: expected(1),
    accountStates: unanchoredStates,
    readings: [sampleWithAccount(unanchoredAccount, start, 50)],
  });
  await unanchored.observe("pool-b", {
    at: start + 5 * 60_000,
    expected: expected(1),
    accountStates: unanchoredStates,
    readings: [sampleWithAccount(unanchoredAccount, start + 5 * 60_000, 45)],
  });
  const incomplete = await unanchored.demandData("pool-b");
  const incompleteGroup = Object.keys(incomplete.rollingComplete)[0]!;
  const incompleteAccount = Object.keys(incomplete.rollingComplete[incompleteGroup]!)[0]!;
  assert.equal(incomplete.rollingComplete[incompleteGroup]![incompleteAccount]!.complete, false);
  await unanchored.observe("pool-b", {
    at: start + 10 * 60_000,
    expected: expected(1),
    accountStates: unanchoredStates,
    readings: [sampleWithAccount(unanchoredAccount, start + 10 * 60_000, 100)],
  });
  const reanchored = await unanchored.demandData("pool-b");
  assert.equal(reanchored.rollingComplete[incompleteGroup]![incompleteAccount]!.complete, true);

  const conflicting = new CapacityHistory(new Memory());
  const conflictingStates = [
    { account, provider: "claude", windowSeconds: 18_000, usable: true, bankedAvailable: null },
  ];
  await conflicting.observe("pool-c", {
    at: start,
    expected: expected(1),
    accountStates: conflictingStates,
    readings: [sampleWithAccount(account, start, 100)],
  });
  await conflicting.observe("pool-c", {
    at: start + 5 * 60_000,
    expected: expected(1),
    accountStates: conflictingStates,
    readings: [sampleWithAccount(account, start + 5 * 60_000, 80)],
  });
  await conflicting.observe("pool-c", {
    at: start + 10 * 60_000,
    expected: expected(1),
    accountStates: conflictingStates,
    readings: [sampleWithAccount(account, start + 5 * 60_000, 75)],
  });
  const changedAtSameSource = await conflicting.demandData("pool-c");
  const conflictingGroup = Object.keys(changedAtSameSource.rollingComplete)[0]!;
  const conflictingAccount = Object.keys(
    changedAtSameSource.rollingComplete[conflictingGroup]!,
  )[0]!;
  assert.equal(
    changedAtSameSource.rollingComplete[conflictingGroup]![conflictingAccount]!.complete,
    false,
  );
});

function sampleWithAccount(account: string, at: number, remaining: number): CapacityReading {
  return reading(account, remaining, {
    windowSeconds: 18_000,
    mode: "rolling",
    full: 100,
    resetAt: null,
    observedAt: at,
    staleAt: at + 6 * 60_000,
    source: "reference-plan",
    revision: "rolling-r1",
  });
}

test("weight policy changes append frozen values without rewriting earlier hours", async () => {
  const history = new CapacityHistory(new Memory()),
    firstAt = start,
    secondAt = start + hour;
  await history.observe("pool-a", {
    at: firstAt,
    expected: expected(1),
    readings: [reading("private-account-a", 2)],
  });
  await history.observe("pool-a", {
    at: secondAt,
    expected: expected(1),
    readings: [
      reading("private-account-a", 4, {
        observedAt: secondAt - 60_000,
        full: 7,
        revision: "r2",
        source: "published-session-multiplier",
      }),
    ],
  });
  const points = await history.read("pool-a");
  assert.equal(points.length, 2);
  assert.equal(points[0]!.last.full, 5);
  assert.equal(points[0]!.last.remaining, 2);
  assert.equal(points[1]!.last.full, 7);
  assert.equal(points[1]!.last.remaining, 4);
});

test("history is partitioned by day and pruned to 400 rolling days", async () => {
  const storage = new Memory(),
    history = new CapacityHistory(storage);
  const firstAt = Date.parse("2025-01-01T10:00:00Z"),
    latestAt = firstAt + 400 * 24 * hour;
  await history.observe("pool-a", {
    at: firstAt,
    expected: expected(1),
    readings: [reading("private-account-a", 2, { observedAt: firstAt - 1 })],
  });
  await history.observe("pool-a", {
    at: latestAt,
    expected: expected(1),
    readings: [reading("private-account-a", 1, { observedAt: latestAt - 1 })],
  });

  const points = await history.read("pool-a");
  assert.equal(points.length, 1);
  assert.equal(points[0]!.hour, latestAt);
  const index = await new ChunkStorage(storage).get<{ days: string[]; fromHour: number }>(
    "capacity-v1:pool-a:index",
  );
  assert.deepEqual(index?.days, [new Date(latestAt).toISOString().slice(0, 10)]);
  assert.equal(index?.fromHour, latestAt - (400 * 24 - 1) * hour);
  assert.equal([...storage.values.keys()].filter((key) => key.includes(":day:")).length, 1);
});

test("plan contributions match the total minimum and an unknown plan can disappear safely", async () => {
  const history = new CapacityHistory(new Memory());
  await history.observe("pool-a", {
    at: start,
    expected: expected(2),
    readings: [reading("a", 1, { plan: null }), reading("b", 4, { plan: "Pro" })],
  });
  await history.observe("pool-a", {
    at: start + 60_000,
    expected: expected(2),
    readings: [
      reading("a", 4, { plan: "New", observedAt: start + 59_000 }),
      reading("b", 0, { plan: "Pro", observedAt: start + 59_000 }),
    ],
  });
  const [point] = await history.read("pool-a");
  assert.equal(point!.minimum.remaining, 4);
  assert.equal(
    point!.plans.reduce((sum, plan) => sum + plan.minimum.remaining, 0),
    4,
  );
  assert.equal(point!.plans.find((plan) => plan.plan === null)?.last, null);
  assert.equal(point!.plans.find((plan) => plan.plan === null)?.minimum.remaining, 0);
  assert.equal(
    point!.plans.reduce((sum, plan) => sum + (plan.last?.remaining ?? 0), 0),
    point!.last.remaining,
  );
});

for (const prior of [
  { full: 1, remaining: 0.4, source: "unknown-plan", known: false, revision: "2026-10-30" },
  {
    full: 10,
    remaining: 4,
    source: "published-weekly-multiplier",
    known: true,
    revision: "2026-11-09",
  },
] as const)
  test(`Max 20x policy leaves retained ${prior.full}x observations unchanged`, async () => {
    const storage = new Memory();
    const first = new CapacityHistory(storage);
    const weekly = [{ provider: "claude", windowSeconds: 604_800, accounts: 1 }];
    await first.observe("pool-weekly", {
      at: start,
      expected: weekly,
      readings: [
        reading("max-seat", prior.remaining, {
          plan: "Max 20x",
          windowSeconds: 604_800,
          full: prior.full,
          source: prior.source,
          knownWeight: prior.known,
          revision: prior.revision,
        }),
      ],
    });
    const history = new CapacityHistory(storage);
    const current = capacityWeight("claude", "Max 20x", 604_800);
    await history.observe("pool-weekly", {
      at: start + hour,
      expected: weekly,
      readings: [
        reading("max-seat", 8, {
          plan: "Max 20x",
          windowSeconds: 604_800,
          observedAt: start + hour - 60_000,
          full: current.multiplier,
          source: current.source,
          knownWeight: current.known,
          revision: current.revision,
        }),
      ],
    });
    const points = await history.read("pool-weekly");
    assert.equal(points.length, 2);
    assert.equal(points[0]!.last.full, prior.full);
    assert.equal(points[0]!.last.remaining, prior.remaining);
    assert.equal(points[0]!.last.unknownWeightCount, prior.known ? 0 : 1);
    assert.deepEqual(points[0]!.last.weights, [
      { source: prior.source, revision: prior.revision, accountCount: 1 },
    ]);
    assert.equal(points[1]!.last.full, 20);
    assert.equal(points[1]!.last.remaining, 8);
    assert.equal(points[1]!.last.unknownWeightCount, 0);
    assert.deepEqual(points[1]!.last.weights, [
      { source: "plan-multiplier", revision: "2026-11-09-max20x-20", accountCount: 1 },
    ]);
  });

test("a Claude weekly policy reset preserves Codex demand and Claude rolling training", async () => {
  const start = Date.parse("2026-11-03T10:55:00Z");
  const history = new CapacityHistory(new Memory());
  const key = (provider: string, seconds: number, mode: string | null, unit: string) =>
    JSON.stringify([provider, seconds, mode, unit]);
  const weeklyKey = key("claude", 604_800, "fixed", "claude-pro-equivalent");
  const codexKey = key("codex", 604_800, "fixed", "chatgpt-plus-equivalent");
  const sessionKey = key("claude", 18_000, "rolling", "claude-pro-equivalent");
  const expected = [
    { provider: "claude", windowSeconds: 604_800, accounts: 1 },
    { provider: "codex", windowSeconds: 604_800, accounts: 1 },
    { provider: "claude", windowSeconds: 18_000, accounts: 1 },
  ];
  const samples = (at: number, consumed: boolean) => [
    reading("claude-weekly", consumed ? 9 : 10, {
      plan: "Max 20x",
      windowSeconds: 604_800,
      mode: "fixed",
      full: 10,
      observedAt: at,
      resetAt: start + 7 * 24 * hour,
      revision: "2026-11-09",
    }),
    reading("codex-weekly", consumed ? 0.9 : 1, {
      provider: "codex",
      plan: "Plus",
      windowSeconds: 604_800,
      mode: "fixed",
      full: 1,
      unit: { id: "chatgpt-plus-equivalent", label: "Plus-eq" },
      observedAt: at,
      resetAt: start + 7 * 24 * hour,
      revision: "2026-10-30",
    }),
    sampleWithAccount("claude-weekly", at, consumed ? 80 : 100),
  ];
  const accountStates = samples(start, false).map((entry) => ({
    account: entry.account,
    provider: entry.provider,
    windowSeconds: entry.windowSeconds,
    usable: true,
    bankedAvailable: 0,
  }));
  await history.observe("mixed", {
    at: start,
    expected,
    accountStates,
    readings: samples(start, false),
  });
  const priorReadings = samples(start + 5 * 60_000, true);
  await history.observe("mixed", {
    at: start + 5 * 60_000,
    expected,
    accountStates,
    readings: priorReadings,
  });
  const before = await history.demandData("mixed");
  const displayed = await history.read("mixed", { to: start + 5 * 60_000 });
  assert.ok(before.accountDemandTotals[weeklyKey]);
  assert.ok(before.accountDemandTotals[codexKey]);
  assert.ok(before.rollingUse[sessionKey]);
  assert.ok(Object.values(before.rollingComplete[sessionKey]!).every((entry) => entry.complete));
  const at = start + 10 * 60_000;
  await history.observe("mixed", {
    at,
    expected,
    accountStates,
    readings: [
      {
        ...priorReadings[0]!,
        full: 20,
        remaining: 18,
        source: "plan-multiplier",
        revision: "2026-11-09-max20x-20",
        observedAt: at,
      },
      ...priorReadings.slice(1),
    ],
  });
  const after = await history.demandData("mixed");
  assert.equal(after.cohortTrackingSince?.[weeklyKey], Math.ceil(at / hour) * hour);
  assert.equal(after.cohortTrackingSince?.[codexKey], undefined);
  assert.equal(after.cohortTrackingSince?.[sessionKey], undefined);
  assert.equal(after.accountDemandTotals[weeklyKey], undefined);
  assert.deepEqual(after.accountDemandTotals[codexKey], before.accountDemandTotals[codexKey]);
  assert.deepEqual(after.accountDemandTotals[sessionKey], before.accountDemandTotals[sessionKey]);
  assert.deepEqual(after.rollingUse[sessionKey], before.rollingUse[sessionKey]);
  assert.deepEqual(after.rollingComplete[sessionKey], before.rollingComplete[sessionKey]);
  assert.deepEqual(
    after.points.filter(
      (point) =>
        (point.provider === "codex" || point.windowSeconds === 18_000) &&
        point.hour < Math.floor(at / hour) * hour,
    ),
    before.points.filter(
      (point) =>
        (point.provider === "codex" || point.windowSeconds === 18_000) &&
        point.hour < Math.floor(at / hour) * hour,
    ),
  );
  assert.equal(
    after.points.some((point) => point.provider === "claude" && point.windowSeconds === 604_800),
    false,
  );
  assert.deepEqual(await history.read("mixed", { to: start + 5 * 60_000 }), displayed);
});

test("unchanged Codex policy preserves training across the weekly-weight rollout", async () => {
  const history = new CapacityHistory(new Memory());
  const expected = [{ provider: "codex", windowSeconds: 604_800, accounts: 1 }];
  const sample = (at: number, remaining: number, revision: string) =>
    reading("codex", remaining, {
      provider: "codex",
      plan: "Plus",
      windowSeconds: 604_800,
      mode: "fixed",
      full: 1,
      observedAt: at,
      resetAt: start + 7 * 24 * hour,
      revision,
      unit: { id: "chatgpt-plus-equivalent", label: "Plus-eq" },
    });
  await history.observe("codex-only", {
    at: start,
    expected,
    readings: [sample(start, 1, "2026-10-30")],
  });
  await history.observe("codex-only", {
    at: start + 5 * 60_000,
    expected,
    readings: [sample(start + 5 * 60_000, 0.9, "2026-10-30")],
  });
  const before = await history.demandData("codex-only");
  await history.observe("codex-only", {
    at: start + 10 * 60_000,
    expected,
    readings: [sample(start + 10 * 60_000, 0.8, capacityWeight("codex", "Plus", 604_800).revision)],
  });
  const after = await history.demandData("codex-only");
  assert.deepEqual(after.cohortTrackingSince, {});
  assert.equal(after.trackingSince, before.trackingSince);
  assert.equal(after.points.length, before.points.length);
  assert.ok(after.points[0]!.demand! > before.points[0]!.demand!);
});
