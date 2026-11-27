import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { RuntimeForcedStop, runtimeStopTiming } from "./runtime-slots/forced-stop.ts";
import {
  forcedRestartServesWithinHeldStreamsMs,
  forcedRestartServesWithinMs,
  forcedStopGraceMs,
  aliveRefusingMs,
  leakedStreamsMs,
  readinessReadMs,
  restartStartBoundMs,
  runtimeStartupMs,
  supervisorStopGraceMs,
  unservingBoundMs,
} from "./runtime-slots/forced-restart-timing.ts";
import { poolLifecycle } from "./lifecycle.ts";
import { policyHealthLeaseMs, readRuntimeLiveness } from "./runtime-health.ts";
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
  assert.equal(forcedRestartServesWithinMs, 351_500);
  assert.equal(forcedRestartServesWithinHeldStreamsMs, 591_500);
});

test("the controller's startup allowance is the supervisor's own startup budget", async () => {
  const supervisor = await readFile(
    new URL("../../containers/pool/supervisor.py", import.meta.url),
    "utf8",
  );
  const budget = /^STARTUP_TIMEOUT_SECONDS = (\d+)$/mu.exec(supervisor);
  assert.ok(budget, "the supervisor's startup budget moved: update runtimeStartupMs with it");
  assert.equal(runtimeStartupMs, Number(budget[1]) * 1_000);
});

test("a forced stop waits longer than the supervisor's own shutdown grace", async () => {
  const supervisor = await readFile(
    new URL("../../containers/pool/supervisor.py", import.meta.url),
    "utf8",
  );
  // terminate_children: SIGTERM, the named grace, then kill and a one-second wait.
  const grace = /^CHILD_STOP_GRACE_SECONDS = (\d+)$/mu.exec(supervisor);
  assert.ok(grace, "the supervisor's child grace moved: update supervisorStopGraceMs with it");
  assert.match(
    supervisor,
    /def terminate_children[\s\S]*?CHILD_STOP_GRACE_SECONDS - 1 if deadline else CHILD_STOP_GRACE_SECONDS/u,
    "terminate_children must use the named grace",
  );
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
  alive: (identity: SlotIdentity, signal: AbortSignal) => Promise<unknown> = async () => {
    throw new SlotRefused("identity");
  },
) {
  context.mock.method(runtimeStopTiming, "stopGrace", async () => {});
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "info", () => {});
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
    alive,
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

test("a boot that answers ready in time is never stopped, and one that answers late only from aliveRefusingMs", async (context) => {
  const record = { identity: selected, authorization: { kind: "start" } };
  const ready = (leaseFromNow: number) => async () => ({
    boot_id: selected.bootId,
    started_at: "started",
    policyLeaseUntil: performance.now() + leaseFromNow,
  });
  const cases: [string, () => Promise<unknown>, number, boolean][] = [
    ["in time to serve, long past aliveRefusingMs", ready(1_000), aliveRefusingMs + 60_000, false],
    ["late, inside aliveRefusingMs", ready(-1), aliveRefusingMs - 1_000, false],
    ["late, from aliveRefusingMs", ready(-1), aliveRefusingMs, true],
    [
      "no ready answer",
      async () => Promise.reject(new SlotRefused("unhealthy")),
      unservingBoundMs,
      true,
    ],
  ];
  for (const [name, alive, refusingMs, stops] of cases) {
    const { stop, signals } = stopper(context, record, async () => ({}), undefined, alive);
    const result = stop.stop(selected, Date.now() - refusingMs, AbortSignal.timeout(5_000));
    if (stops) assert.deepEqual(await result, { stopped: true, hard: false }, name);
    else await assert.rejects(result, (error) => error instanceof SlotRefused, name);
    assert.deepEqual(signals, stops ? [15] : [], name);
  }
});

/** The liveness read over a readiness port that answers `status` with `body`. */
const answering =
  (status: 200 | 503, body: Record<string, unknown>) =>
  (_identity: SlotIdentity, signal: AbortSignal) =>
    readRuntimeLiveness(
      {
        fetch: async () =>
          Response.json({ boot_id: selected.bootId, started_at: "started", ...body }, { status }),
      },
      "synthetic-management",
      signal,
    );
const stuckStart = { identity: selected, authorization: { kind: "start" } };
const draining = (error: unknown) => error instanceof SlotRefused && error.reason === "draining";

test("a stop waits while the readiness answer it reads reports a refresh in flight", async (context) => {
  const cases: [string, 200 | 503, number][] = [
    ["a refusal reporting one", 503, 1],
    ["a late ready answer reporting two", 200, 2],
  ];
  for (const [name, status, count] of cases) {
    const { stop, signals } = stopper(
      context,
      stuckStart,
      async () => ({}),
      undefined,
      answering(status, { refresh_in_flight: count }),
    );
    await assert.rejects(
      stop.stop(selected, Date.now() - aliveRefusingMs, AbortSignal.timeout(5_000)),
      draining,
      name,
    );
    assert.deepEqual(signals, [], name);
  }
});

test("a stop goes ahead when the answer reports no refresh in flight or no usable count", async (context) => {
  const cases: [string, 200 | 503, Record<string, unknown>][] = [
    ["none in flight", 503, { refresh_in_flight: 0 }],
    ["an image that reports no count", 503, {}],
    ["a late ready answer without a count", 200, {}],
    ["a negative count", 503, { refresh_in_flight: -1 }],
    ["a fraction", 503, { refresh_in_flight: 1.5 }],
    ["text", 503, { refresh_in_flight: "1" }],
    ["a flag", 503, { refresh_in_flight: true }],
    ["past a safe integer", 503, { refresh_in_flight: 2 ** 60 }],
  ];
  for (const [name, status, body] of cases) {
    const { stop, signals } = stopper(
      context,
      stuckStart,
      async () => ({}),
      undefined,
      answering(status, body),
    );
    const result = await stop.stop(
      selected,
      Date.now() - aliveRefusingMs,
      AbortSignal.timeout(5_000),
    );
    assert.deepEqual(result, { stopped: true, hard: false }, name);
    assert.deepEqual(signals, [15], name);
  }
});

test("a refresh that never ends holds a stop for one stop grace from its first wait, then not", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const { stop, signals } = stopper(
    context,
    stuckStart,
    async () => ({}),
    undefined,
    answering(503, { refresh_in_flight: 1 }),
  );
  const attempt = () => stop.stop(selected, now - aliveRefusingMs, AbortSignal.timeout(5_000));
  await assert.rejects(attempt(), draining, "the first answer starts the wait");
  now += forcedStopGraceMs - 1;
  await assert.rejects(attempt(), draining, "still inside one stop grace");
  assert.deepEqual(signals, []);
  now += 1;
  assert.deepEqual(await attempt(), { stopped: true, hard: false });
  assert.deepEqual(signals, [15], "SIGTERM still gives Home its drain");
});

test("a caller that gives up during the liveness read stops nothing", async (context) => {
  const caller = new AbortController();
  const { stop, signals } = stopper(
    context,
    { identity: selected, authorization: { kind: "start" } },
    async () => ({}),
    undefined,
    (_identity, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        caller.abort();
      }),
  );
  await assert.rejects(stop.stop(selected, Date.now() - aliveRefusingMs, caller.signal));
  assert.deepEqual(signals, []);
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
