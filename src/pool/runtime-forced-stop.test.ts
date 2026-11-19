import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { RuntimeForcedStop, runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import {
  forcedRestartServesWithinHeldStreamsMs,
  forcedRestartServesWithinMs,
  forcedStopGraceMs,
  leakedStreamsMs,
  readinessReadMs,
  restartStartBoundMs,
  runtimeStartupMs,
  supervisorStopGraceMs,
} from "./runtime-slots/forced-restart-timing.ts";
import { poolLifecycle } from "./lifecycle.ts";
import { policyHealthLeaseMs } from "./runtime-health.ts";
import { SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";
import { RuntimeActivity } from "./runtime-slots/activity.ts";

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
  } as unknown as ConstructorParameters<typeof RuntimeForcedStop>[0]);
  return { stop, signals };
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
  const storage = {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: unknown) => void rows.set(key, value),
    transaction: async <T>(work: (transaction: typeof storage) => Promise<T>) => work(storage),
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
