import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { runtimeGrant } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";

/**
 * A slot started on an endpoint of `role` from a grant of `kind`, its container running, then
 * fenced by an abandon that asks for the stop. Only a fleet cell's own endpoint, a runtime
 * object, holds an initial start with a home peer ordinal.
 */
async function abandoned(
  context: TestContext,
  role: "legacy" | "runtime",
  kind: "initial-start" | "start",
) {
  context.mock.method(console, "warn", () => {});
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "a".repeat(64),
    slotId: "abandoned",
    applicationId: "runtime-app",
    applicationVersion: "3",
    instanceId: "b".repeat(64),
    imageDigest: `sha256:${"d".repeat(64)}`,
    imageInput: "2".repeat(16),
    ...(kind === "initial-start" ? { homePeerOrdinal: 1 } : {}),
  };
  const f = await handoffRuntime(
    target,
    {
      POOL_RUNTIME_APPLICATION_ID: target.applicationId,
      // The root's own endpoint is the one bound to the controller's container application.
      POOL_CONTAINER_APPLICATION_ID: role === "legacy" ? target.applicationId : "root-app",
      POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
      POOL_MANAGEMENT_KEY: "fixture-runtime-key",
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      POOL_IMAGE_HASH: target.imageInput,
      POOL_DEPLOYMENT_KEY: "e".repeat(64),
    },
    { role },
  );
  const controller = new RuntimeSqlite();
  context.after(async () => {
    await f.cleanup();
    await controller.close();
  });
  if (kind === "start") {
    const root = {
      ...target,
      slotId: "root",
      applicationId: "root-app",
      instanceId: target.controllerId,
      bootId: "root-boot",
    };
    await controller.put(slotSelectionKey, {
      epoch: 1,
      active: { target: root, identity: root, fenced: false },
    });
  }
  await f.endpoint.admit((await runtimeGrant(f, controller, kind)).envelope);
  await f.endpoint.start(target, AbortSignal.timeout(5_000));
  assert.equal(f.ctx.container.running, true);
  const answer = await f.endpoint.abandonStart(target, true);
  await f.settle();
  return { f, answer };
}

test("the root's own endpoint never stops its container on this path", async (context) => {
  for (const kind of ["initial-start", "start"] as const)
    await context.test(`over a slot started as ${kind}`, async (step) => {
      const { f, answer } = await abandoned(step, "legacy", kind);
      assert.deepEqual(answer, { stopped: false });
      assert.deepEqual(f.calls.signals, [], "the root was signalled");
      assert.equal(f.calls.destroy, 0);
      assert.equal(f.ctx.container.running, true);
    });
});

test("a start that isn't a fleet cell's first start is never stopped on this path", async (context) => {
  // A primary's start on a runtime object, as a blue/green image update stages one.
  const { f, answer } = await abandoned(context, "runtime", "start");
  assert.deepEqual(answer, { stopped: false });
  assert.deepEqual(f.calls.signals, []);
  assert.equal(f.calls.destroy, 0);
});

test("a fleet cell's first start that never attested is stopped gracefully", async (context) => {
  const { f } = await abandoned(context, "runtime", "initial-start");
  assert.deepEqual(f.calls.signals, [15]);
  assert.equal(f.ctx.container.running, false);
});
