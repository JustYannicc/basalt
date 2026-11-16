import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { runtimeGrant } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { RuntimeActivity } from "./runtime-slots/activity.ts";

async function fixture() {
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "a".repeat(64),
    slotId: "candidate",
    applicationId: "candidate-app",
    applicationVersion: "3",
    instanceId: "b".repeat(64),
    imageDigest: `sha256:${"d".repeat(64)}`,
    imageInput: "2".repeat(16),
    homePeerOrdinal: 1,
  };
  const f = await handoffRuntime(target, {
    POOL_RUNTIME_APPLICATION_ID: target.applicationId,
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-runtime-key",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: target.imageInput,
    POOL_DEPLOYMENT_KEY: "e".repeat(64),
  });
  const controller = new RuntimeSqlite();
  const grant = await runtimeGrant(f, controller, "initial-start");
  await f.endpoint.admit(grant.envelope);
  const { identity } = await f.endpoint.start(target, AbortSignal.timeout(5_000));
  return {
    ...f,
    identity,
    cleanup: async () => {
      await f.cleanup();
      await controller.close();
    },
  };
}

test(
  "endpoint drain counts an earlier model call while its final health and headers are held",
  { timeout: 10_000 },
  async (context) => {
    const f = await fixture();
    const healthEntered = deferred(),
      healthRelease = deferred(),
      modelEntered = deferred(),
      headersRelease = deferred();
    let pending: Promise<Response> | undefined;
    context.after(async () => {
      healthRelease.resolve();
      headersRelease.resolve();
      const response = await pending;
      if (response && !response.bodyUsed) await response.body?.cancel();
      await f.cleanup();
    });
    let first = true;
    f.hooks.health = async () => {
      if (!first) return;
      first = false;
      healthEntered.resolve();
      await healthRelease.promise;
    };
    f.hooks.model = async () => {
      modelEntered.resolve();
      await headersRelease.promise;
      return new Response("terminal");
    };
    pending = f.endpoint.fetch(f.identity, new Request("http://pool/v1/responses"), 8317);
    await healthEntered.promise;
    assert.equal((await new RuntimeActivity(f.storage).inspect(f.identity))?.active, 1);
    assert.deepEqual(await f.endpoint.drain(f.identity, AbortSignal.timeout(2_000)), {
      active: 1,
      known: true,
    });
    healthRelease.resolve();
    await modelEntered.promise;
    assert.equal(f.calls.model, 1);
    assert.equal(f.calls.destroy, 0);
    await assert.rejects(
      f.endpoint.fetch(f.identity, new Request("http://pool/v1/responses"), 8317),
      /draining/,
    );
    headersRelease.resolve();
    assert.equal(await (await pending).text(), "terminal");
    await f.settle();
    assert.deepEqual(await f.endpoint.drain(f.identity, AbortSignal.timeout(2_000)), {
      active: 0,
      known: true,
    });
  },
);

for (const failure of ["health", "cancel", "keepalive"] as const) {
  test(
    `endpoint ${failure} failure releases its pre-health count without sending a model call`,
    { timeout: 10_000 },
    async (context) => {
      const f = await fixture();
      context.after(f.cleanup);
      const abort = new AbortController();
      if (failure === "health")
        f.hooks.health = async () => {
          throw new Error("health unavailable");
        };
      if (failure === "cancel")
        f.hooks.health = async () => {
          abort.abort();
        };
      if (failure === "keepalive")
        f.ctx.container.setInactivityTimeout = async () => {
          throw new Error("keepalive unavailable");
        };
      await assert.rejects(
        f.endpoint.fetch(
          f.identity,
          new Request("http://pool/v1/responses", { signal: abort.signal }),
          8317,
        ),
      );
      await f.settle();
      assert.equal((await new RuntimeActivity(f.storage).inspect(f.identity))?.active, 0);
      assert.equal(f.calls.model, 0);
    },
  );
}
