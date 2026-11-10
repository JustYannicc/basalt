import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeRuntimeHandoffCommand,
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "./runtime-slots/handoff-command.ts";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { openEnvelope, signEnvelope } from "./token.ts";

const code = { candidate: "a".repeat(40), workerInput: "b".repeat(64) };
function command() {
  const at = Date.now();
  return { controllerCode: code, at, expiresAt: at + 60_000 };
}

test("the outer signed handoff command keeps the existing bridge prefix and exact inner proof envelope", async () => {
  const value = { ...command(), action: "stage", proof: "fixture-inner-envelope" };
  const envelope = await signEnvelope("c".repeat(64), runtimeHandoffCommandPrefix, value);
  const decoded = decodeRuntimeHandoffCommand(
    await openEnvelope("c".repeat(64), runtimeHandoffCommandPrefix, envelope),
  );
  assert.deepEqual(decoded, value);
  assert.equal(runtimeHandoffCommandPrefix, deploymentReadinessPrefix);
  assert.equal(runtimeHandoffPath, "/runtime-handoff");
});

test("a readonly or legacy-shaped command cannot silently carry a mutation or omit its proof", () => {
  assert.throws(() => decodeRuntimeHandoffCommand({ ...command(), action: "stage" }));
  assert.throws(() =>
    decodeRuntimeHandoffCommand({
      ...command(),
      action: "adopt",
      identity: {},
      configurationDigest: "c".repeat(64),
    }),
  );
  assert.throws(() =>
    decodeRuntimeHandoffCommand({ ...command(), action: "inspect", proof: "ignored mutation" }),
  );
  assert.throws(() =>
    decodeRuntimeHandoffCommand({ ...command(), action: "destroy-provider-app" }),
  );
  assert.throws(() =>
    decodeRuntimeHandoffCommand({ ...command(), action: "receipt", operationId: "bad/id" }),
  );
});

test("inspection and reverse operations have explicit closed commands and short validity", () => {
  for (const action of ["receipt", "retirement", "drain", "discard"])
    assert.equal(
      decodeRuntimeHandoffCommand({ ...command(), action, operationId: "fixture-operation" })
        .action,
      action,
    );
  const now = Date.now();
  assert.throws(() =>
    decodeRuntimeHandoffCommand({ ...command(), action: "inspect", expiresAt: now - 1 }, now),
  );
  assert.throws(() =>
    decodeRuntimeHandoffCommand(
      { ...command(), action: "inspect", at: now, expiresAt: now + 60_001 },
      now,
    ),
  );
});
