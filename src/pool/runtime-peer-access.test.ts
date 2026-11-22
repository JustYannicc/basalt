import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import {
  runtimeGrant,
  runtimeFixtureCode,
} from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { HomePeerAccess, type HomePeerSource } from "./runtime-slots/peer-access.ts";
import { RuntimeEndpoint } from "./runtime-slots/endpoint.ts";
import { launchStorageKey } from "./launch-ledger.ts";

async function fixture(failInstall = false) {
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "a".repeat(64),
    slotId: "runtime-1",
    applicationId: "blue",
    applicationVersion: "3",
    instanceId: "b".repeat(64),
    imageDigest: `sha256:${"d".repeat(64)}`,
    imageInput: "2".repeat(16),
    homePeerOrdinal: 1,
  };
  let source: HomePeerSource | undefined;
  const f = await handoffRuntime(
    target,
    {
      POOL_RUNTIME_APPLICATION_ID: target.applicationId,
      POOL_CONTAINER_APPLICATION_ID: "legacy",
      POOL_DATABASE_URL: "postgresql://synthetic@database.invalid/pool",
      POOL_MANAGEMENT_KEY: "synthetic-key",
      POOL_APP_SIGNING_KEY: "a".repeat(64),
      POOL_DEPLOYMENT_KEY: "e".repeat(64),
      POOL_IMAGE_HASH: target.imageInput,
    },
    {
      endpoint: {
        beforeStart: async (witness) => {
          assert.equal(f.calls.start, 0);
          assert.ok(await f.endpoint.witness(target));
          source = { kind: "runtime", witness };
          await gate.retain(source);
          if (failInstall) throw new Error("synthetic interceptor failure");
        },
      },
    },
  );
  const gate = new HomePeerAccess(f.ctx, f.env.POOL_DEPLOYMENT_KEY!, (identity) =>
    f.endpoint.health(identity, AbortSignal.timeout(2_000)),
  );
  const controller = new RuntimeSqlite();
  const grant = await runtimeGrant(f, controller, "initial-start");
  await f.endpoint.admit(grant.envelope);
  return {
    ...f,
    gate,
    source: () => {
      assert.ok(source);
      return source;
    },
    cleanup: async () => {
      await f.cleanup();
      await controller.close();
    },
  };
}

test("actual-start witness precedes peer installation and readiness does not start another runtime", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  assert.equal(f.calls.start, 1);
  await f.gate.assert(f.source());
  const restored = new HomePeerAccess(f.ctx, f.env.POOL_DEPLOYMENT_KEY!, (identity) =>
    f.endpoint.health(identity, AbortSignal.timeout(2_000)),
  );
  assert.deepEqual(await restored.current(), f.source());
  assert.equal(f.calls.start, 1);
  f.replaceBoot();
  await assert.rejects(restored.assert(f.source()), /identity/);
  assert.equal(f.calls.start, 1);
});

test("failed interceptor installation leaves launch uncertain and cannot dispatch compute", async (context) => {
  const f = await fixture(true);
  context.after(f.cleanup);
  await assert.rejects(f.endpoint.start(f.target, AbortSignal.timeout(5_000)), /interceptor/);
  assert.equal(f.calls.start, 0);
  await assert.rejects(f.gate.assert(f.source()), /uncertain/);
  const restored = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap);
  await assert.rejects(restored.start(f.target, AbortSignal.timeout(5_000)));
  assert.equal(f.calls.start, 0);
});

test("a sibling, a changed launch generation and a stopped runtime cannot borrow peer authority", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const source = f.source();
  assert.equal(source.kind, "runtime");
  if (source.kind !== "runtime") throw new Error("runtime source required");
  await assert.rejects(
    f.gate.assert({
      ...source,
      witness: {
        ...source.witness,
        target: { ...source.witness.target, instanceId: "c".repeat(64) },
      },
    }),
    /identity/,
  );
  const launch = await f.storage.get<Record<string, unknown>>(launchStorageKey);
  await f.storage.put(launchStorageKey, { ...launch, generation: 2 });
  await assert.rejects(f.gate.assert(source), /identity/);
  await f.storage.put(launchStorageKey, launch);
  f.crash();
  await assert.rejects(f.gate.assert(source), /uncertain/);
  assert.equal(f.calls.start, 1);
});
