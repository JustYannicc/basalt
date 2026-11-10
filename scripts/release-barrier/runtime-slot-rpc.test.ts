import assert from "node:assert/strict";
import { test } from "node:test";
import { openEnvelope } from "../../src/pool/token.ts";
import {
  decodeRuntimeHandoffCommand,
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { readRuntimeStartupWitness, runtimeHandoffRequest } from "./runtime-slot-rpc.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";

async function harness(foreignController = false) {
  const f = await runtimeProofFixture();
  const calls = { opened: 0, sent: 0, closed: 0 };
  const target: PoolOperationsTarget = {
    accountId: f.manifest.controller.accountId,
    worker: f.manifest.controller.scriptName,
    connect: async () => {
      calls.opened++;
      return {
        env: {
          POOL_OPERATIONS: {
            fetch: async (request) => {
              calls.sent++;
              assert.equal(new URL(request.url).pathname, runtimeHandoffPath);
              assert.equal(request.method, "POST");
              const body = (await request.json()) as { envelope: string };
              const command = decodeRuntimeHandoffCommand(
                await openEnvelope(f.signingKey, runtimeHandoffCommandPrefix, body.envelope),
                f.now,
              );
              assert.equal(command.action, "witness");
              assert.deepEqual(command.controllerCode, f.manifest.controllerCode);
              if (command.action === "witness") assert.deepEqual(command.target, f.manifest.target);
              return Response.json({
                result: {
                  kind: "witness",
                  controllerCode: foreignController
                    ? { ...f.manifest.controllerCode, candidate: "f".repeat(40) }
                    : f.manifest.controllerCode,
                  witness: f.witness,
                },
              });
            },
          },
        },
        dispose: async () => {
          calls.closed++;
        },
      };
    },
  };
  return { ...f, calls, target };
}

test("the existing private bridge carries the exact outer command and returns the retained witness", async () => {
  const h = await harness();
  const result = await readRuntimeStartupWitness(
    h.manifest,
    h.enable,
    h.signingKey,
    h.target,
    () => h.now,
  );
  assert.deepEqual(result, h.witness);
  assert.deepEqual(h.calls, { opened: 1, sent: 1, closed: 1 });
});

test("a witness response from different controller code is refused after closing the bridge", async () => {
  const h = await harness(true);
  await assert.rejects(
    readRuntimeStartupWitness(h.manifest, h.enable, h.signingKey, h.target, () => h.now),
    /provisioning-input-drift/,
  );
  assert.deepEqual(h.calls, { opened: 1, sent: 1, closed: 1 });
});

test("missing enable, foreign private destination and expired outer command do not open the bridge", async () => {
  const h = await harness();
  await assert.rejects(
    readRuntimeStartupWitness(h.manifest, undefined, h.signingKey, h.target, () => h.now),
    /runtime-handoff-not-enabled|expired/,
  );
  await assert.rejects(
    readRuntimeStartupWitness(
      h.manifest,
      h.enable,
      h.signingKey,
      { ...h.target, worker: "foreign-worker" },
      () => h.now,
    ),
    /provisioning-input-drift/,
  );
  await assert.rejects(
    runtimeHandoffRequest(
      h.manifest,
      h.enable,
      h.signingKey,
      { action: "inspect", controllerCode: h.manifest.controllerCode, at: h.now, expiresAt: h.now },
      h.target,
      () => h.now,
    ),
    /expired/,
  );
  assert.deepEqual(h.calls, { opened: 0, sent: 0, closed: 0 });
});
