import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimePolicyAssertion } from "./runtime-slots/policy-assertion.ts";
import { policyHeader, policyUsePrefix } from "./membership-contract.ts";
import { openEnvelope, signEnvelope } from "./token.ts";

test("selected old runtime receives the current exact revision under its preserved startup key", async () => {
  const claims = { pool: "fixture-pool", revision: 7, expiresAt: Date.now() + 30_000 };
  const current = "a".repeat(64),
    runtime = "b".repeat(64);
  const headers = new Headers({
    [policyHeader]: await signEnvelope(current, policyUsePrefix, claims),
  });
  await runtimePolicyAssertion(headers, { current, runtime });
  assert.deepEqual(
    await openEnvelope(runtime, policyUsePrefix, headers.get(policyHeader)!),
    claims,
  );
  assert.equal(await openEnvelope(current, policyUsePrefix, headers.get(policyHeader)!), undefined);
});

test("a bad signature or expired assertion cannot be translated into old-runtime authority", async () => {
  const current = "a".repeat(64),
    runtime = "b".repeat(64);
  const claims = { pool: "fixture-pool", revision: 7, expiresAt: Date.now() + 30_000 };
  const unsigned = new Headers({
    [policyHeader]: await signEnvelope("c".repeat(64), policyUsePrefix, claims),
  });
  await assert.rejects(runtimePolicyAssertion(unsigned, { current, runtime }));
  const expired = new Headers({
    [policyHeader]: await signEnvelope(current, policyUsePrefix, {
      ...claims,
      expiresAt: Date.now() - 1,
    }),
  });
  await assert.rejects(runtimePolicyAssertion(expired, { current, runtime }));
});
