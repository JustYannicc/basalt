import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleDeploymentReadiness,
  deploymentReadinessPrefix,
  decodeRuntimeReady,
} from "./deployment-readiness.ts";
import { signEnvelope } from "./token.ts";
const target = { candidate: "a".repeat(40), workerInput: "b".repeat(64), imageHash: "1234abcd" };
const key = "c".repeat(64),
  now = 100_000;
const receipt = {
  ...target,
  desiredRevisionMatch: true as const,
  instanceId: "d".repeat(64),
  bootId: "boot",
  readyAt: now,
};
const request = (envelope: string) =>
  new Request("http://private/deployment-readiness", {
    method: "POST",
    body: JSON.stringify({ envelope }),
  });

test("only the release's own signed target can warm or adopt", async () => {
  let calls = 0;
  const invoke = (input: Request) =>
    handleDeploymentReadiness(
      input,
      target,
      key,
      async () => {
        calls++;
        return receipt;
      },
      () => now,
    );
  for (const input of [
    new Request("http://private/deployment-readiness"),
    request("invalid"),
    request(
      await signEnvelope("e".repeat(64), deploymentReadinessPrefix, {
        ...target,
        at: now,
        expiresAt: now + 60_000,
      }),
    ),
    request(
      await signEnvelope(key, "ordinary-pool-token", {
        ...target,
        at: now,
        expiresAt: now + 60_000,
      }),
    ),
    request(
      await signEnvelope(key, deploymentReadinessPrefix, {
        ...target,
        candidate: "old",
        at: now,
        expiresAt: now + 60_000,
      }),
    ),
    request(
      await signEnvelope(key, deploymentReadinessPrefix, {
        ...target,
        at: now - 60_000,
        expiresAt: now,
      }),
    ),
  ])
    assert.notEqual((await invoke(input)).status, 200);
  assert.equal(calls, 0);
  const valid = await signEnvelope(key, deploymentReadinessPrefix, {
    ...target,
    at: now,
    expiresAt: now + 60_000,
  });
  assert.deepEqual(await (await invoke(request(valid))).json(), receipt);
  assert.equal(calls, 1);
});

test("an old or malformed runtime never qualifies as target readiness", () => {
  assert.throws(() => decodeRuntimeReady({ ...receipt, desiredRevisionMatch: false }, target));
  assert.throws(() => decodeRuntimeReady({ ...receipt, workerInput: "old" }, target));
  assert.throws(() => decodeRuntimeReady({ ...receipt, bootId: "secret@host.invalid" }, target));
  assert.deepEqual(
    decodeRuntimeReady({ ...receipt, privateField: "never-output" }, target),
    receipt,
  );
});

for (const field of ["candidate", "workerInput", "imageHash"] as const)
  test(`a previous Durable Object ${field} reports pending adoption`, async () => {
    const signed = await signEnvelope(key, deploymentReadinessPrefix, {
      ...target,
      at: now,
      expiresAt: now + 60_000,
    });
    const response = await handleDeploymentReadiness(
      request(signed),
      target,
      key,
      async () => ({ ...receipt, [field]: "previous-runtime" }),
      () => now,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { outcome: "readiness-error", stage: "readiness" });
  });
