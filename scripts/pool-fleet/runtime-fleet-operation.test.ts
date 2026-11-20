import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../pool-tests/runtime-fleet-worker.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { runtimeBridgeKeyDigest } from "./runtime-slot-manifest.ts";
import {
  freezeRuntimeFleetOperation,
  inspectRuntimeFleetOperation,
  runtimeFleetOperationDigest,
  runtimeFleetRequest,
} from "./runtime-fleet-operation.ts";

async function harness() {
  const f = await fleetWorkerFixture();
  const signingKey = f.old.env.POOL_DEPLOYMENT_KEY!;
  let now = Date.now(),
    lost = false,
    openDelay = 0;
  const calls = { opened: 0, sent: 0, closed: 0 };
  const target: PoolOperationsTarget = {
    accountId: f.configuration.applications[0]!.accountId,
    worker: "synthetic-pool",
    connect: async () => {
      calls.opened++;
      now += openDelay;
      return {
        env: {
          POOL_OPERATIONS: {
            fetch: async (request) => {
              calls.sent++;
              const response = await f.worker.runtimeHandoff(request);
              if (lost) {
                lost = false;
                await response.body?.cancel();
                throw new Error("synthetic lost acknowledgment");
              }
              return response;
            },
          },
        },
        dispose: async () => {
          calls.closed++;
        },
      };
    },
  };
  const operation = freezeRuntimeFleetOperation({
    candidate: f.configuration.controllerCode.candidate,
    controller: { accountId: target.accountId, scriptName: target.worker },
    bridgeKeyDigest: runtimeBridgeKeyDigest(signingKey),
    command: {
      action: "fleet-configure",
      operationId: "reviewed-enable-1",
      controllerCode: f.configuration.controllerCode,
      configuration: f.configuration,
    },
  });
  const enable = {
    coordinatorGo: "synthetic-go",
    writerLease: "exclusive-fixture-writer",
    manifest: runtimeFleetOperationDigest(operation),
    expiresAt: now + 60_000,
  };
  return {
    ...f,
    signingKey,
    calls,
    target,
    operation,
    enable,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    loseReply: () => {
      lost = true;
    },
    delayOpen: (milliseconds: number) => {
      openDelay = milliseconds;
    },
  };
}

test("the reviewed full configuration crosses the actual signed Worker bridge and has an explicit reverse operation", async (context) => {
  const h = await harness();
  context.after(h.cleanup);
  const response = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ digest: Schema.String, enabled: Schema.Boolean }) }),
  )(await runtimeFleetRequest(h.operation, h.enable, h.signingKey, h.target, h.now));
  assert.equal(response.result.enabled, true);
  assert.equal(h.instances.size, 0);
  const disable = freezeRuntimeFleetOperation({
    ...h.operation,
    command: {
      action: "fleet-disable",
      operationId: "reviewed-disable-1",
      expectedDigest: response.result.digest,
      controllerCode: h.configuration.controllerCode,
    },
  });
  const reversed = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ enabled: Schema.Boolean }) }),
  )(
    await runtimeFleetRequest(
      disable,
      { ...h.enable, manifest: runtimeFleetOperationDigest(disable) },
      h.signingKey,
      h.target,
      h.now,
    ),
  );
  assert.equal(reversed.result.enabled, false);
  assert.deepEqual(h.calls, { opened: 2, sent: 2, closed: 2 });
  assert.equal(h.old.calls.start, 0);
});

test("a committed configuration with a lost acknowledgment is inspected after lease expiry without another mutation", async (context) => {
  const h = await harness();
  context.after(h.cleanup);
  context.mock.method(Date, "now", h.now);
  h.loseReply();
  await assert.rejects(
    runtimeFleetRequest(h.operation, h.enable, h.signingKey, h.target, h.now),
    /lost acknowledgment/,
  );
  h.advance(60_001);
  const inspected = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({
        permission: Schema.Struct({ operationId: Schema.String, enabled: Schema.Boolean }),
      }),
    }),
  )(await inspectRuntimeFleetOperation(h.operation, h.signingKey, h.target, h.now));
  assert.equal(inspected.result.permission.operationId, h.operation.command.operationId);
  assert.equal(inspected.result.permission.enabled, true);
  await assert.rejects(
    runtimeFleetRequest(h.operation, h.enable, h.signingKey, h.target, h.now),
    /runtime-fleet-not-enabled/,
  );
  assert.deepEqual(h.calls, { opened: 2, sent: 2, closed: 2 });
  assert.equal(h.instances.size, 0);
});

test("changed payload, signer, destination, controller and absent GO cannot open the private bridge", async (context) => {
  const h = await harness();
  context.after(h.cleanup);
  const send = (
    operation = h.operation,
    enable: typeof h.enable | undefined = h.enable,
    key = h.signingKey,
    target = h.target,
  ) => runtimeFleetRequest(operation, enable, key, target, h.now);
  await assert.rejects(
    send({ ...h.operation, command: { ...h.operation.command, action: "fleet-inspect" } }),
    /invalid|not-enabled/,
  );
  assert.equal(h.operation.command.action, "fleet-configure");
  if (h.operation.command.action !== "fleet-configure") throw new Error("fixture operation");
  await assert.rejects(
    send({
      ...h.operation,
      command: { ...h.operation.command, configuration: { ...h.configuration, maximum: 3 } },
    }),
    /not-enabled/,
  );
  await assert.rejects(send(h.operation, { ...h.enable, coordinatorGo: "" }), /not-enabled/);
  await assert.rejects(send(h.operation, h.enable, "c".repeat(64)), /input-drift/);
  await assert.rejects(
    send(h.operation, h.enable, h.signingKey, { ...h.target, worker: "foreign" }),
    /input-drift/,
  );
  await assert.rejects(send({ ...h.operation, candidate: "f".repeat(40) }), /input-drift/);
  assert.deepEqual(h.calls, { opened: 0, sent: 0, closed: 0 });
});

test("a lease expiring during bridge establishment sends nothing and still closes it", async (context) => {
  const h = await harness();
  context.after(h.cleanup);
  h.delayOpen(60_001);
  await assert.rejects(
    runtimeFleetRequest(h.operation, h.enable, h.signingKey, h.target, h.now),
    /not-enabled/,
  );
  assert.deepEqual(h.calls, { opened: 1, sent: 0, closed: 1 });
});

test("a reviewed configuration keeps its identity while dispatch receives a fresh short-lived transport envelope", async (context) => {
  const h = await harness();
  context.after(h.cleanup);
  context.mock.method(Date, "now", h.now);
  const reviewed = runtimeFleetOperationDigest(h.operation);
  h.advance(3_600_000);
  const enable = { ...h.enable, expiresAt: h.now() + 60_000 };
  const result = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ enabled: Schema.Boolean }) }),
  )(await runtimeFleetRequest(h.operation, enable, h.signingKey, h.target, h.now));
  assert.equal(result.result.enabled, true);
  assert.equal(runtimeFleetOperationDigest(h.operation), reviewed);
  assert.deepEqual(h.calls, { opened: 1, sent: 1, closed: 1 });
});
