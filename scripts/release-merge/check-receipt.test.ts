import assert from "node:assert/strict";
import { test } from "node:test";
import { createCheckRunReceipt } from "./check-receipt.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const mergeCommit = "c".repeat(40);

function input(overrides: Partial<Parameters<typeof createCheckRunReceipt>[0]> = {}) {
  return {
    repository: "owner/repo",
    pullRequest: 19,
    runId: 700,
    runAttempt: 2,
    head,
    base,
    checkedOutCommit: mergeCommit,
    checkedOutParents: [base, head],
    ...overrides,
  };
}

test("captures the actual checked out PR merge commit and ordered parents", () => {
  assert.deepEqual(createCheckRunReceipt(input()), {
    version: 1,
    repository: "owner/repo",
    pullRequest: 19,
    runId: 700,
    runAttempt: 2,
    head,
    base,
    mergeCommit,
    parents: [base, head],
  });
});

test("refuses receipts for a wrong merge result", () => {
  assert.throws(() => createCheckRunReceipt(input({ checkedOutCommit: head })), /distinct merge result/);
  assert.throws(() => createCheckRunReceipt(input({ checkedOutParents: ["d".repeat(40), head] })), /base parent/);
  assert.throws(() => createCheckRunReceipt(input({ checkedOutParents: [base, "d".repeat(40)] })), /head parent/);
  assert.throws(() => createCheckRunReceipt(input({ checkedOutParents: [base] })), /exactly two parents/);
});
