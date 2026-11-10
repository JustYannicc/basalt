import assert from "node:assert/strict";
import { test } from "node:test";
import { failureReceipt } from "./production-ops/failure.ts";

const failure = {
  format: "basalt-production-ops-failure-v1",
  category: "refused",
  phase: "sql",
  causeKind: "failure",
};
const source = {
  code: "code_source-proof",
  version: "dpl_version-proof",
  expected: "a".repeat(64),
  actual: "b".repeat(64),
};

test("source refusal receipts retain the exact resource and fingerprint delta without source or credentials", () => {
  const receipt = failureReceipt({
    ...failure,
    source: { ...source, token: "private fixture token" },
    message: "SQL and source details must stay private",
    query: "private query",
  });
  assert.deepEqual(receipt, { ...failure, source });
  assert.equal(JSON.stringify(receipt).includes("private"), false);
});

test("unvalidated source refusal fields cannot enter the operator receipt", () => {
  for (const unsafe of [
    { ...source, actual: "private source text" },
    { ...source, code: "code_ secret" },
    { ...source, expected: "arbitrary response" },
  ])
    assert.equal(failureReceipt({ ...failure, source: unsafe })?.source, undefined);
  assert.deepEqual(
    failureReceipt({ ...failure, source: { ...source, actual: "missing" } })?.source,
    { ...source, actual: "missing" },
  );
});
