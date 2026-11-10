import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  evaluateMarkerRows,
  requireVersionMarker,
  type ExecutorMarkerReceipt,
} from "../../.upstream/apps/hosted/cloud/src/implementation/executor-version-gate.ts";

const precondition = {
  transition: {
    baseGitCommit: "a".repeat(40),
    candidateGitCommit: "b".repeat(40),
    baseToolsCommit: "f69c667936e4c02c75f9d7cc79fb750c230839b9",
    candidateToolsCommit: "2f4c398f3906e0570f0e25a16fa3602329baba29",
  },
  marker: "public.private_executor_settings.key=version",
  expected: "4.0.29",
} as const;
const attempt = "00000000-0000-4000-8000-000000000001";

test("only one exact unnormalized 4.0.29 row is accepted with full transition identity", () => {
  const receipt = evaluateMarkerRows([{ value: "4.0.29" }], precondition, attempt);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    transition: precondition.transition,
    attempt,
    marker: precondition.marker,
    expected: "4.0.29",
    observed: "4.0.29",
    outcome: "accepted",
  });
  assert.equal(evaluateMarkerRows([{ value: "4.0.29 " }], precondition, attempt).outcome, "refused");
  assert.equal(evaluateMarkerRows([{ value: "4.0.28" }], precondition, attempt).observed, "4.0.28");
});

test("missing, duplicate and non-version values fail closed without copying arbitrary data", () => {
  assert.equal(evaluateMarkerRows([], precondition, attempt).reason, "missing");
  assert.equal(evaluateMarkerRows([{ value: "4.0.29" }, { value: "4.0.29" }], precondition, attempt).reason, "multiple_rows");
  const invalid = evaluateMarkerRows([{ value: "password=must-not-escape" }], precondition, attempt);
  assert.equal(invalid.outcome, "refused");
  assert.equal(invalid.observed, null);
  assert.equal(JSON.stringify(invalid).includes("must-not-escape"), false);
});

test("a refusal retains evidence and does not continue into migration work", async () => {
  const retained: Array<unknown> = [];
  const continued: Array<string> = [];
  const gate = requireVersionMarker({
    precondition,
    attempt,
    read: Effect.succeed([{ value: "4.0.28" }]),
    retain: (receipt: unknown) => Effect.sync(() => void retained.push(receipt)),
  });
  const exit = await Effect.runPromiseExit(
    gate.pipe(Effect.andThen(Effect.sync(() => continued.push("migration")))),
  );
  assert.equal(exit._tag, "Failure");
  assert.equal(retained.length, 1);
  assert.deepEqual(continued, []);
});

test("a SQL read failure retains only a safe refusal", async () => {
  const retained: Array<ExecutorMarkerReceipt> = [];
  const gate = requireVersionMarker({
    precondition,
    attempt,
    read: Effect.fail(new Error("password=must-not-escape")),
    retain: (receipt: ExecutorMarkerReceipt) => Effect.sync(() => void retained.push(receipt)),
  });
  const exit = await Effect.runPromiseExit(gate);
  assert.equal(exit._tag, "Failure");
  assert.equal(retained[0]?.outcome, "read_failed");
  assert.equal(retained[0]?.observed, null);
  assert.equal(JSON.stringify(retained[0]).includes("must-not-escape"), false);
});

test("an accepted retry repeats only the read and receipt for the same pin transition", async () => {
  const reads: Array<string> = [];
  const receipts: Array<unknown> = [];
  for (const retryAttempt of [attempt, "00000000-0000-4000-8000-000000000002"]) {
    const gate = requireVersionMarker({
      precondition,
      attempt: retryAttempt,
      read: Effect.sync(() => {
        reads.push(precondition.transition.candidateToolsCommit);
        return [{ value: "4.0.29" }];
      }),
      retain: (receipt: unknown) => Effect.sync(() => void receipts.push(receipt)),
    });
    assert.equal((await Effect.runPromiseExit(gate))._tag, "Success");
  }
  assert.deepEqual(reads, [
    precondition.transition.candidateToolsCommit,
    precondition.transition.candidateToolsCommit,
  ]);
  assert.equal(receipts.length, 2);
});

test("receipt retention failure stops an otherwise accepted migration preflight", async () => {
  let continued = false;
  const exit = await Effect.runPromiseExit(requireVersionMarker({
    precondition,
    attempt,
    read: Effect.succeed([{ value: "4.0.29" }]),
    retain: () => Effect.fail(new Error("fixture receipt disk failure")),
  }).pipe(Effect.andThen(Effect.sync(() => { continued = true; }))));
  assert.equal(exit._tag, "Failure");
  assert.equal(continued, false);
});
