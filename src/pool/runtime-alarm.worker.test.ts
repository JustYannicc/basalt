import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { runtimeGrant } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { runtimeWorkerClasses } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";
import { RuntimeActivity } from "./runtime-slots/activity.ts";
import { poolLifecycle } from "./lifecycle.ts";

for (const color of ["blue", "green"] as const) {
  test(`${color} runtime starts once, restores its alarm ownership and renews only its admitted live boot`, async (context) => {
    const target = {
      format: "pool-runtime-slot-v1" as const,
      controllerId: "a".repeat(64),
      slotId: "alarm-runtime",
      applicationId: color,
      applicationVersion: "1",
      instanceId: "b".repeat(64),
      imageDigest: `sha256:${"c".repeat(64)}`,
      imageInput: "2".repeat(16),
      homePeerOrdinal: 1,
    };
    const f = await handoffRuntime(target, {
      POOL_RUNTIME_APPLICATION_ID: color,
      POOL_CONTAINER_APPLICATION_ID: "legacy",
      POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
      POOL_MANAGEMENT_KEY: "fixture-management",
      POOL_APP_SIGNING_KEY: "d".repeat(64),
      POOL_IMAGE_HASH: target.imageInput,
      POOL_DEPLOYMENT_KEY: "e".repeat(64),
    });
    const controller = new RuntimeSqlite();
    context.after(async () => {
      await f.cleanup();
      await controller.close();
    });
    const grant = await runtimeGrant(f, controller, "initial-start");
    const store = new RuntimeWitnessStore(f.storage, f.env.POOL_DEPLOYMENT_KEY!);
    await f.endpoint.admit(grant.envelope);
    const originalSetAlarm = f.storage.setAlarm.bind(f.storage);
    const env = {
      ...f.env,
      [`POOL_${color.toUpperCase()}_APPLICATION_ID`]: color,
      [`POOL_${color.toUpperCase()}_IMAGE_HASH`]: target.imageInput,
    };
    let worker = new runtimeWorkerClasses[color](f.ctx, env);
    f.storage.setAlarm = async (at) => {
      if (typeof worker.alarm !== "function")
        throw new TypeError("Durable Object must have an alarm() handler to call setAlarm()");
      await originalSetAlarm(at);
    };
    // This endpoint uses the same admitted capsule as the DO and isolates launch from release-code imports.
    const started = await f.endpoint.start(target, AbortSignal.timeout(2_000));
    assert.equal(f.calls.start, 1);
    assert.ok((await f.storage.getAlarm())! > Date.now());
    assert.deepEqual(await store.alarmTarget(), target);
    const keepAlive = f.calls.keepAlive,
      health = f.calls.health;
    worker = new runtimeWorkerClasses[color](f.ctx, env);
    await worker.alarm();
    assert.equal(f.calls.start, 1);
    assert.equal(f.calls.keepAlive, keepAlive + 1);
    assert.equal(f.calls.health, health + 1);
    assert.ok((await f.storage.getAlarm())! >= Date.now() + poolLifecycle.refreshMs - 100);
    f.crash();
    await worker.alarm();
    assert.equal(f.calls.start, 1);
    assert.equal(f.calls.keepAlive, keepAlive + 1);
    const identity = started.identity;
    const before = await new RuntimeActivity(f.storage).inspect(identity);
    const failed = await f.endpoint.failed(identity, AbortSignal.timeout(2_000));
    assert.equal(failed.stopped, true);
    assert.deepEqual(await new RuntimeActivity(f.storage).inspect(identity), before);
    assert.equal((await store.retained(target.slotId))?.failed, true);
    assert.equal((await store.retained(target.slotId))?.retired, true);
    await assert.rejects(f.endpoint.start(target, AbortSignal.timeout(2_000)));
    assert.equal(f.calls.start, 1);
    assert.equal(f.calls.destroy, 0);
  });
}
