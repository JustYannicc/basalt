import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import {
  RuntimeForcedStop,
  forcedStopGraceMs,
  restartStartBoundMs,
  runtimeStopTiming,
  supervisorStopGraceMs,
} from "./runtime-slots/forced-stop.ts";
import { SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";

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
    activity: { inspect: async () => undefined },
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
