import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolLifecycle } from "./lifecycle.ts";
import {
  RuntimeRecovery,
  RecoveryRefused,
  type RecoveryApproval,
  type RecoveryReceipt,
} from "./runtime-recovery.ts";

function fixture() {
  let boot = crypto.randomUUID(),
    stops = 0;
  const values = new Map<string, RecoveryReceipt>();
  const lifecycleValues = new Map<string, string>();
  const initialBoot = boot;
  const driver = {
    running: () => true,
    start() {},
    keepAlive: async () => {},
    stop: async () => {
      stops++;
      boot = crypto.randomUUID();
    },
    status: async () => ({ boot_id: boot, started_at: "2026-11-09T00:00:00Z" }),
  };
  const lifecycle = new PoolLifecycle(
    driver,
    {
      get: async <T>(key: string) => lifecycleValues.get(key) as T | undefined,
      put: async (key, value) => {
        lifecycleValues.set(key, value);
      },
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    "image",
  );
  lifecycleValues.set("revision", "image");
  lifecycleValues.set("ready-revision", "image");
  const runtime = {
    instanceId: "a".repeat(64),
    imageHash: "b".repeat(16),
    release: "c".repeat(40),
    running: () => true,
    status: async () => ({ boot_id: boot, started_at: "2026-11-09T00:00:00Z" }),
    restart: (beforeStop?: () => Promise<void>) => lifecycle.restart(beforeStop),
  };
  const storage = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, receipt: RecoveryReceipt) => {
      values.set(key, structuredClone(receipt));
    },
  };
  const approval: RecoveryApproval = {
    version: 1,
    action: "restart-reviewed",
    operationId: crypto.randomUUID(),
    instanceId: runtime.instanceId,
    imageHash: runtime.imageHash,
    release: runtime.release,
    bootId: boot,
    at: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  return {
    initialBoot,
    runtime,
    storage,
    approval,
    values,
    lifecycle,
    driver,
    recovery: new RuntimeRecovery(runtime, storage),
    stops: () => stops,
    changeBoot: () => {
      boot = crypto.randomUUID();
    },
  };
}

test("reviewed recovery binds the release and boot and records them before destruction", async () => {
  const f = fixture();
  const put = f.storage.put;
  f.storage.put = async (key, receipt) => {
    assert.equal(f.stops(), receipt.status === "started" ? 0 : 1);
    await put(key, receipt);
  };
  const receipt = await f.recovery.run(f.approval);
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.previousBootId, f.initialBoot);
  assert.notEqual(receipt.bootId, f.initialBoot);
  assert.equal(receipt.release, f.runtime.release);
  assert.deepEqual(await f.recovery.run(f.approval), receipt);
  assert.equal(f.stops(), 1);
});

test("every runtime pin refuses before its started receipt or stop", async () => {
  for (const pin of ["release", "instanceId", "imageHash", "bootId"] as const) {
    const f = fixture();
    if (pin === "bootId") f.changeBoot();
    else
      f.runtime[pin] =
        pin === "release" ? "d".repeat(40) : pin === "instanceId" ? "d".repeat(64) : "d".repeat(16);
    await assert.rejects(
      f.recovery.run(f.approval),
      (error: unknown) =>
        error instanceof RecoveryRefused &&
        error.status === 409 &&
        error.drift?.some((d) => d.property === pin) === true,
    );
    assert.equal(f.stops(), 0);
    assert.equal(f.values.size, 0);
  }
});

test("a boot changed by queued warming is checked after warming, directly before stop", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Awaited<ReturnType<typeof f.driver.status>>>();
  f.driver.status = () => {
    entered.resolve();
    return release.promise;
  };
  const warm = f.lifecycle.warm();
  await entered.promise;
  const guarded = f.recovery.run(f.approval);
  f.changeBoot();
  assert.equal(f.stops(), 0);
  release.resolve(await f.runtime.status());
  await warm;
  await assert.rejects(guarded, RecoveryRefused);
  assert.equal(f.stops(), 0);
  assert.equal(f.values.size, 0);
});

test("a failed durable audit and an expired approval cannot reach destruction", async () => {
  const f = fixture();
  f.storage.put = async () => {
    throw new Error("audit unavailable");
  };
  await assert.rejects(f.recovery.run(f.approval), /audit unavailable/);
  assert.equal(f.stops(), 0);
  await assert.rejects(
    f.recovery.run({ ...f.approval, expiresAt: Date.now() - 1 }),
    RecoveryRefused,
  );
  assert.equal(f.stops(), 0);
});
