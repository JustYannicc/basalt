import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolLifecycle } from "./lifecycle.ts";
import { RuntimeRecovery } from "./runtime-recovery.ts";
import { slotFixture, SlotMemory } from "../../scripts/pool-tests/runtime-slots-fixture.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";

test("the existing lifecycle ignores additive slot selection and automatic-recovery state", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  await f.slots.promote(await f.intent());
  const before = await f.memory.get(slotSelectionKey);
  await f.memory.put("runtime-recovery-v1:automatic-budget", { attempts: [{ status: "started" }] });
  await f.memory.put("revision", "existing-image");
  await f.memory.put("ready-revision", "existing-image");
  let starts = 0,
    stops = 0;
  const lifecycle = new PoolLifecycle(
    {
      running: () => true,
      start: () => {
        starts++;
      },
      stop: async () => {
        stops++;
      },
      keepAlive: async () => {},
      status: async () => ({ boot_id: "existing-boot", started_at: "existing-start" }),
    },
    {
      get: <T>(key: string) => f.memory.get<T>(key),
      put: async (key, value) => {
        await f.memory.put(key, value);
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    "existing-image",
  );
  assert.equal((await lifecycle.warm()).boot_id, "existing-boot");
  assert.equal((await lifecycle.deploymentReady()).bootId, "existing-boot");
  assert.deepEqual(await f.memory.get(slotSelectionKey), before);
  assert.equal(starts, 0);
  assert.equal(stops, 0);
});

test("the old reviewed-recovery reader ignores unfamiliar slot and automatic-attempt keys", async () => {
  const storage = new SlotMemory();
  const untouched = { arbitrary: "retained future layout" };
  await storage.put(slotSelectionKey, untouched);
  await storage.put("runtime-recovery-v1:automatic-budget", untouched);
  let restarts = 0;
  const recovery = new RuntimeRecovery(
    {
      instanceId: "a".repeat(64),
      imageHash: "existing-image",
      running: () => false,
      status: async () => {
        throw new Error("stopped");
      },
      restart: async () => {
        restarts++;
        return { boot_id: "replacement-boot", started_at: "new-start" };
      },
    },
    {
      get: <T>(key: string) => storage.get<T>(key),
      put: async (key, value) => {
        await storage.put(key, value);
      },
    },
  );
  const approval = {
    version: 1 as const,
    action: "restart" as const,
    operationId: crypto.randomUUID(),
    instanceId: "a".repeat(64),
    imageHash: "existing-image",
    at: Date.now(),
    expiresAt: Date.now() + 30_000,
  };
  assert.equal((await recovery.inspect()).running, false);
  assert.equal((await recovery.run(approval)).status, "ready");
  assert.equal((await recovery.run(approval)).status, "ready");
  assert.equal(restarts, 1);
  assert.deepEqual(await storage.get(slotSelectionKey), untouched);
  assert.deepEqual(await storage.get("runtime-recovery-v1:automatic-budget"), untouched);
});
