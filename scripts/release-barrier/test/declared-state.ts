import assert from "node:assert/strict";
import { Effect } from "effect";
import { State, isResourceState } from "alchemy/State/State";

export const retainedRemovedBucket = (scope: { stack: string; stage: string }) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    yield* state.setOutput({
      ...scope,
      value: {
        $basaltDeclaredChanges: {
          schemaVersion: 1,
          buckets: {
            RemovedRecords: {
              entry: "a".repeat(64),
              declaration: "b".repeat(64),
              candidate: "c".repeat(40),
              instanceId: "d".repeat(32),
              target: {
                accountId: "fixture",
                bucketName: "retained-removed-records",
                jurisdiction: "eu",
                storageClass: "Standard",
              },
              status: "created",
              providerVersion: 0,
            },
          },
        },
      },
    });
  });

export const driftNativeProvider = (scope: { stack: string; stage: string }) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const current = yield* state.get({ ...scope, fqn: "DriveRecords" });
    assert.ok(isResourceState(current));
    yield* state.set({
      ...scope,
      fqn: "DriveRecords",
      value: { ...current, providerVersion: current.providerVersion + 1 },
    });
  });
