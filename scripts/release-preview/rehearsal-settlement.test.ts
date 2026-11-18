import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireSettlementApplied,
  settlementPacket,
  settlementPlanRequest,
} from "./rehearsal-settlement.ts";

const previous = "a".repeat(40);
const digest = "d".repeat(64);

test("the plan settles the previous candidate as adopted under its own controller code", () => {
  const request = settlementPlanRequest({
    previous,
    workerInput: "c".repeat(64),
    number: 81211,
    now: 1_000,
  });
  assert.deepEqual(request, {
    kind: "release-settlement",
    sourceCandidate: previous,
    operationId: "rehearsal-81211-settlement",
    coordinatorGo: "release-rehearsal",
    expiresAt: 1_000 + 30 * 60_000,
    disposition: "controller-active-adopted",
    sourceController: { candidate: previous, workerInput: "c".repeat(64) },
  });
  assert.throws(() =>
    settlementPlanRequest({ previous: "main", workerInput: "c".repeat(64), number: 1, now: 0 }),
  );
});

test("the packet carries the planned operation under a GO for exactly its digest", () => {
  const operation = { kind: "release-settlement", manifest: { candidate: "b".repeat(40) } };
  const packet = settlementPacket({ disposition: "plan", operation, operationDigest: digest }, 5);
  assert.deepEqual(packet, {
    operation,
    go: { coordinatorGo: "release-rehearsal", manifest: digest, expiresAt: 5 + 30 * 60_000 },
  });
  for (const receipt of [
    {},
    { disposition: "apply", operation, operationDigest: digest },
    { disposition: "plan", operation: { kind: "runtime" }, operationDigest: digest },
    { disposition: "plan", operation, operationDigest: "x" },
  ])
    assert.throws(() => settlementPacket(receipt, 5), /no release-settlement operation/);
  requireSettlementApplied({ disposition: "apply", manifest: digest }, digest);
  assert.throws(() =>
    requireSettlementApplied({ disposition: "inspect", manifest: digest }, digest),
  );
  assert.throws(() =>
    requireSettlementApplied({ disposition: "apply", manifest: "e".repeat(64) }, digest),
  );
});
