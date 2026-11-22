import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { RuntimeForcedStop, runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import {
  auditDeferralMs,
  forcedRestartServesWithinHeldStreamsMs,
  forcedRestartServesWithinMs,
  forcedStopGraceMs,
  leakedStreamsMs,
  readinessReadMs,
  restartStartBoundMs,
  runtimeStartupMs,
  supervisorStopGraceMs,
  unservingBoundMs,
} from "./runtime-slots/forced-restart-timing.ts";
import { poolLifecycle } from "./lifecycle.ts";
import { policyHealthLeaseMs } from "./runtime-health.ts";
import { SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";
import { RuntimeActivity } from "./runtime-slots/activity.ts";
import type { TransactionStorage } from "./runtime-slots/storage.ts";

test("the timing module has no imports and matches the values the runtime enforces", async () => {
  const timing = await readFile(
    new URL("./runtime-slots/forced-restart-timing.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    timing,
    /^\s*import\b/mu,
    "release tooling imports it into a stricter program",
  );
  assert.equal(runtimeStartupMs, poolLifecycle.startupTimeoutMs);
  assert.equal(readinessReadMs, policyHealthLeaseMs);
  assert.equal(forcedRestartServesWithinMs, 298_000);
  assert.equal(forcedRestartServesWithinHeldStreamsMs, 538_000);
});

test("a forced stop waits longer than the supervisor's own shutdown grace", async () => {
  const supervisor = await readFile(
    new URL("../../containers/pool/supervisor.py", import.meta.url),
    "utf8",
  );
  // terminate_children: SIGTERM, a grace, then kill and a one-second wait.
  const grace =
    /grace_until = time\.monotonic\(\) \+ remaining\(\d+ if deadline else (\d+)\)/u.exec(
      supervisor,
    );
  assert.ok(grace, "the supervisor's child grace moved: update supervisorStopGraceMs with it");
  assert.equal(supervisorStopGraceMs, (Number(grace[1]) + 1) * 1_000);
  assert.ok(
    forcedStopGraceMs > supervisorStopGraceMs,
    "destroy() must never cut into the supervisor's own grace",
  );
});

const selected: SlotIdentity = {
  format: "pool-runtime-slot-v1",
  controllerId: "a".repeat(64),
  slotId: "legacy",
  applicationId: "legacy-app",
  applicationVersion: "1",
  instanceId: "b".repeat(64),
  imageDigest: `sha256:${"c".repeat(64)}`,
  imageInput: "1".repeat(16),
  bootId: "old-boot",
};
const launch = { generation: "restart-generation", tokenHash: "restart-token" };

function stopper(
  context: TestContext,
  record: Record<string, unknown>,
  readiness: () => Promise<unknown>,
  streams?: { active: number; changedAt?: number },
  audit: () => Promise<{ listingMs: number } | undefined> = async () => undefined,
) {
  context.mock.method(runtimeStopTiming, "stopGrace", async () => {});
  context.mock.method(console, "error", () => {});
  const signals: number[] = [];
  const container = {
    running: true,
    signal(number: number) {
      signals.push(number);
      container.running = false;
    },
    monitor: async () => {},
    destroy: async () => {
      container.running = false;
    },
  };
  const stored = new Map<string, unknown>();
  const stop = new RuntimeForcedStop({
    ctx: {
      container,
      storage: {
        get: async (key: string) => stored.get(key),
        put: async (key: string, value: unknown) => void stored.set(key, value),
      },
    },
    store: { read: async () => ({ record, configuration: {} }) },
    activity: { inspect: async () => streams },
    health: async () => {
      throw new SlotRefused("identity");
    },
    readiness,
    audit,
  } as unknown as ConstructorParameters<typeof RuntimeForcedStop>[0]);
  return { stop, signals, stored };
}
const restartOver = (witness?: unknown, at = Date.now()) => ({
  authorization: { kind: "restart", previous: selected, at },
  ...(witness ? { witness } : {}),
});
const notAnswering = async () => {
  throw new Error("readiness refused, late or unreachable");
};

test("a restart's own boot is never stopped, while the old container under it is", async (context) => {
  const cases: [string, Record<string, unknown>, () => Promise<unknown>, boolean][] = [
    [
      "admitted, never started: the running container is the old one",
      restartOver(),
      async () => ({}),
      true,
    ],
    [
      "started, and the running container answers with another launch",
      restartOver({ launch }),
      async () => ({ launch: { generation: "old-generation", tokenHash: "old-token" } }),
      true,
    ],
    [
      "started, and the running container answers with no launch headers (a legacy launch)",
      restartOver({ launch }),
      async () => ({}),
      true,
    ],
    [
      "started, and the running container answers with this restart's launch",
      restartOver({ launch }),
      async () => ({ launch }),
      false,
    ],
    [
      "started, and readiness doesn't answer yet (a cold start)",
      restartOver({ launch }),
      notAnswering,
      false,
    ],
    [
      "started past any startup, and the container doesn't answer (503, late or refused)",
      restartOver({ launch }, Date.now() - restartStartBoundMs - 1),
      notAnswering,
      true,
    ],
    [
      "the restart recorded its own boot",
      {
        ...restartOver({ launch, bootId: "new-boot" }),
        identity: { ...selected, bootId: "new-boot" },
      },
      async () => ({ launch }),
      false,
    ],
  ];
  for (const [name, record, readiness, stops] of cases) {
    const { stop, signals } = stopper(context, record, readiness);
    const result = stop.stop(selected, Date.now(), AbortSignal.timeout(5_000));
    if (stops) assert.deepEqual(await result, { stopped: true, hard: false }, name);
    else await assert.rejects(result, (error) => error instanceof SlotRefused, name);
    assert.deepEqual(signals, stops ? [15] : [], name);
  }
});

test("a stamped stream count holds the stop until it has stood still for leakedStreamsMs", async (context) => {
  const stuck = { identity: selected, authorization: { kind: "start" } };
  for (const [age, stops] of [
    [leakedStreamsMs - 1_000, false],
    [leakedStreamsMs + 1_000, true],
  ] as const) {
    const { stop, signals } = stopper(context, stuck, async () => ({}), {
      active: 2,
      changedAt: Date.now() - age,
    });
    const result = await stop.stop(selected, Date.now(), AbortSignal.timeout(5_000));
    if (stops) assert.deepEqual(result, { stopped: true, hard: false });
    else assert.equal(result.waiting?.active, 2);
    assert.deepEqual(signals, stops ? [15] : []);
  }
});

test("every stream acquire and release stamps when the count last changed", async (context) => {
  let now = 1_000;
  context.mock.method(Date, "now", () => now);
  const rows = new Map<string, unknown>();
  const storage: TransactionStorage = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void rows.set(key, value),
    transaction: async (work) => work(storage),
  };
  const activity = new RuntimeActivity(storage);
  const release = await activity.acquire(selected);
  assert.equal((await activity.inspect(selected))?.changedAt, 1_000);
  now = 5_000;
  await release();
  const row = await activity.inspect(selected);
  assert.equal(row?.active, 0);
  assert.equal(row?.changedAt, 5_000);
});

const refusing = { identity: selected, authorization: { kind: "start" } };
const slowAudit = async () => ({ listingMs: 2_440 });
const pastBound = (extraMs: number) => Date.now() - unservingBoundMs - extraMs;

test("a refusal explained only by a slow readiness audit defers the stop, uncounted and told apart in the log", async (context) => {
  const lines: unknown[][] = [];
  context.mock.method(console, "info", (...line: unknown[]) => void lines.push(line));
  const { stop, signals, stored } = stopper(
    context,
    refusing,
    async () => ({}),
    undefined,
    slowAudit,
  );
  await assert.rejects(
    stop.stop(selected, pastBound(30_000), AbortSignal.timeout(5_000)),
    (error) => error instanceof SlotRefused && error.reason === "selection",
  );
  assert.deepEqual(signals, []);
  assert.equal(stored.size, 0, "a deferred stop is not counted against the hourly limit");
  assert.deepEqual(lines, [
    [
      "POOL_SELECTED_RECOVERY",
      {
        phase: "stop_deferred",
        cause: "audit_slow",
        slot: "legacy",
        deferredSeconds: 30,
        listingMs: 2_440,
      },
    ],
  ]);
});

test("the deferral ends auditDeferralMs past the bound, even while a slow audit still explains the refusal", async (context) => {
  let asked = 0;
  const { stop, signals } = stopper(
    context,
    refusing,
    async () => ({}),
    undefined,
    async () => {
      asked++;
      return { listingMs: 2_440 };
    },
  );
  const result = await stop.stop(selected, pastBound(auditDeferralMs), AbortSignal.timeout(5_000));
  assert.deepEqual(result, { stopped: true, hard: false });
  assert.deepEqual(signals, [15]);
  assert.equal(asked, 0);
});

test("evidence that arrives after the deferral ran out defers nothing", async (context) => {
  let now = 10_000_000;
  context.mock.method(Date, "now", () => now);
  const refusingSince = now - unservingBoundMs - auditDeferralMs + 1_000;
  const { stop, signals } = stopper(
    context,
    refusing,
    async () => ({}),
    undefined,
    async () => {
      now += 2_000; // a slow probe: the bound runs out while it reads
      return { listingMs: 2_440 };
    },
  );
  const result = await stop.stop(selected, refusingSince, AbortSignal.timeout(5_000));
  assert.deepEqual(result, { stopped: true, hard: false });
  assert.deepEqual(signals, [15]);
});

test("another cause, or the probe's own failure, stops exactly as before", async (context) => {
  const cases: [string, () => Promise<{ listingMs: number } | undefined>][] = [
    ["no evidence: another cause", async () => undefined],
    ["the probe rejects", async () => Promise.reject(new Error("probe failed"))],
    [
      "the probe throws before it starts",
      () => {
        throw new Error("no container port");
      },
    ],
  ];
  for (const [name, audit] of cases) {
    const { stop, signals } = stopper(context, refusing, async () => ({}), undefined, audit);
    const result = await stop.stop(selected, pastBound(1_000), AbortSignal.timeout(5_000));
    assert.deepEqual(result, { stopped: true, hard: false }, name);
    assert.deepEqual(signals, [15], name);
  }
});

test("the audit deferral fits inside the bounds release tooling already waits out", () => {
  assert.equal(auditDeferralMs, 180_000);
  // The stop it defers still serves within the held-streams worst case the heal's wait is built on.
  assert.ok(
    forcedRestartServesWithinMs + auditDeferralMs <= forcedRestartServesWithinHeldStreamsMs,
  );
  assert.ok(unservingBoundMs + auditDeferralMs <= leakedStreamsMs);
});
