import assert from "node:assert/strict";
import { test } from "node:test";
import type { PersistedState } from "alchemy/State/State";
import { Effect, Redacted } from "effect";
import { containerRelease } from "./test/container-fixture.ts";
import { readForwardStateObservation } from "./forward-state-observation.ts";
import { encodedRecordHash } from "./forward-model.ts";

test("the forward probe reads exact native bytes and strips private State and journal payloads", async () => {
  const fixture = containerRelease();
  const saved: PersistedState = {
    resourceType: "Cloudflare.Container",
    namespace: undefined,
    fqn: "PoolContainer",
    logicalId: "PoolContainer",
    instanceId: "instance",
    providerVersion: 1,
    status: "updated",
    downstream: ["PoolWorker"],
    bindings: [],
    props: { secret: Redacted.make("synthetic-secret") },
    attr: fixture.previous,
  };
  const reads: unknown[] = [];
  const result = await Effect.runPromise(
    readForwardStateObservation(
      {
        getVersion: () => Effect.succeed(7),
        get: (key) => {
          reads.push(key);
          return Effect.succeed(saved);
        },
        getOutput: (key) => {
          reads.push(key);
          return Effect.succeed({
            schemaVersion: 1,
            candidate: "a".repeat(40),
            manifest: "b".repeat(64),
            complete: false,
            sealed: "private-sealed-payload",
            previous: { sealed: "private-old-payload" },
          });
        },
      },
      { name: "basalt", stage: "production" },
    ),
  );
  assert.deepEqual(reads, [
    { stack: "basalt", stage: "production", fqn: "PoolContainer" },
    { stack: "basalt-release-barrier", stage: "production" },
  ]);
  assert.equal(result.resource.hash, encodedRecordHash(saved));
  assert.equal(result.resource.version, fixture.previous.version);
  assert.deepEqual(result.journal, {
    schemaVersion: 1,
    candidate: "a".repeat(40),
    manifest: "b".repeat(64),
    complete: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|private-|props|configuration/);
});
