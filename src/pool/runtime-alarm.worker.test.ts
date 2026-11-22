import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import {
  runtimeFixtureCode,
  runtimeGrant,
} from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { runtimeWorkerClasses } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";
import { RuntimeActivity } from "./runtime-slots/activity.ts";
import { RuntimeEndpoint } from "./runtime-slots/endpoint.ts";
import { SlotIdentity } from "./runtime-slots/contract.ts";
import { poolLifecycle } from "./lifecycle.ts";

const alarmTarget = (color: "blue" | "green") => ({
  format: "pool-runtime-slot-v1" as const,
  controllerId: "a".repeat(64),
  slotId: "alarm-runtime",
  applicationId: color,
  applicationVersion: "1",
  instanceId: "b".repeat(64),
  imageDigest: `sha256:${"c".repeat(64)}`,
  imageInput: "2".repeat(16),
  homePeerOrdinal: 1,
});

/** A started runtime behind the production Durable Object class, with its refresh alarm armed. */
async function startedRuntime(color: "blue" | "green") {
  const target = alarmTarget(color);
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
  const grant = await runtimeGrant(f, controller, "initial-start");
  const env = {
    ...f.env,
    [`POOL_${color.toUpperCase()}_APPLICATION_ID`]: color,
    [`POOL_${color.toUpperCase()}_IMAGE_HASH`]: target.imageInput,
  };
  const worker = new runtimeWorkerClasses[color](f.ctx, env);
  const call = (path: string, body: unknown) =>
    worker.fetch(
      new Request(`http://runtime${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const post = async (path: string, body: unknown) => {
    const response = await call(path, body);
    assert.ok(response.ok, `${path} answered ${response.status}`);
    return response.status === 204 ? undefined : ((await response.json()) as unknown);
  };
  await post("/admit", { envelope: grant.envelope });
  const { identity } = Schema.decodeUnknownSync(Schema.Struct({ identity: SlotIdentity }))(
    await post("/start", { target }),
  );
  const store = new RuntimeWitnessStore(f.storage, f.env.POOL_DEPLOYMENT_KEY!);
  assert.ok((await f.storage.getAlarm())! > Date.now());
  assert.deepEqual(await store.alarmTarget(), target);
  return {
    f,
    target,
    identity,
    store,
    post,
    call,
    cleanup: async () => {
      await f.cleanup();
      await controller.close();
    },
  };
}

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

type Started = Awaited<ReturnType<typeof startedRuntime>>;
/** Every way a slot's life ends on its own Durable Object. */
const endings: Record<string, (started: Started) => Promise<void>> = {
  retirement: async ({ post, target, identity }) => {
    await post("/drain", { identity });
    await post("/retire", { target, identity });
  },
  "retirement recovered after a lost destroy reply": async ({
    f,
    post,
    call,
    target,
    identity,
  }) => {
    await post("/drain", { identity });
    const destroy = f.ctx.container.destroy.bind(f.ctx.container);
    f.ctx.container.destroy = async () => {
      await destroy();
      throw new Error("lost destroy response");
    };
    assert.equal((await call("/retire", { target, identity })).ok, false);
    assert.equal(
      Schema.decodeUnknownSync(Schema.Struct({ retired: Schema.Boolean }))(
        await post("/retirement", { identity }),
      ).retired,
      true,
    );
  },
  quarantine: async ({ f, post, identity }) => {
    f.crash();
    assert.deepEqual(await post("/failed", { identity }), { identity, stopped: true });
  },
  abandon: async ({ post, target }) => {
    await post("/abandon-start", { target });
  },
  "aborted start": async ({ post, store, target }) => {
    const record = (await store.retained(target.slotId))!;
    const intent = {
      operationId: "alarm-abort",
      target,
      startupOperationId: record.authorization.operationId,
      witness: record.witness ?? null,
    };
    const aborted = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(
      await post("/startup-abort", { intent }),
    );
    assert.equal(aborted.status, "aborted");
  },
};

for (const color of ["blue", "green"] as const) {
  test(`a ${color} slot that has ended leaves no alarm or alarm target that could wake its Durable Object`, async (context) => {
    for (const [ending, end] of Object.entries(endings))
      await context.test(ending, async (step) => {
        const started = await startedRuntime(color);
        step.after(started.cleanup);
        await end(started);
        assert.equal(await started.f.storage.getAlarm(), null, `${ending} left the refresh alarm`);
        assert.equal(
          await started.store.alarmTarget(),
          undefined,
          `${ending} left the alarm target`,
        );
      });
  });
}

test("the primary's legacy endpoint never drops its object's alarm, which carries the pool's own deadlines", async (context) => {
  const started = await startedRuntime("blue");
  context.after(started.cleanup);
  const { f, target, identity } = started;
  const legacy = new RuntimeEndpoint(
    f.ctx,
    { ...f.env, POOL_CONTAINER_APPLICATION_ID: "blue" },
    "legacy",
    runtimeFixtureCode,
    f.wrap,
    { ownStorage: f.storage },
  );
  const armed = await f.storage.getAlarm();
  await legacy.drain(identity, AbortSignal.timeout(2_000));
  await legacy.retire(target, identity, AbortSignal.timeout(2_000));
  assert.equal(f.calls.destroy, 1);
  assert.equal(await f.storage.getAlarm(), armed);
  assert.deepEqual(await started.store.alarmTarget(), target);
});
