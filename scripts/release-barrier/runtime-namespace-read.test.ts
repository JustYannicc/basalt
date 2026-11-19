import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { runtimeNamespaceReader } from "./runtime-namespace-read.ts";
import { productionWorker, productionWorkerApi } from "./test/production-worker-api.ts";

const readBaseline = (worker: ReturnType<typeof productionWorker>) => {
  const api = productionWorkerApi(worker);
  return Effect.runPromise(
    Effect.gen(function* () {
      const reader = yield* runtimeNamespaceReader(worker.accountId, worker.scriptName);
      return yield* Effect.promise(() => reader.baseline());
    }).pipe(Effect.provide(api.layer)),
  ).then((baseline) => ({ baseline, counts: api.counts }));
};

test("a migrations-based PoolWorker version with no exports key reads as a namespace baseline", async () => {
  const { baseline, counts } = await readBaseline(productionWorker());
  assert.equal("exports" in baseline.version && baseline.version.exports !== undefined, false);
  assert.deepEqual(baseline.namespaces, [
    {
      id: "legacy-namespace",
      className: "PoolContainer",
      binding: "PoolContainer",
      storage: "sqlite",
    },
  ]);
  assert.deepEqual(baseline.containers, [{ className: "PoolContainer" }]);
  assert.equal(counts.writes, 0);
});

test("classes the alchemy deploy created read back with their own namespace ids, foreign bindings excluded", async () => {
  const { baseline } = await readBaseline(
    productionWorker({ PoolRuntimeBlue: "blue-namespace", PoolRuntimeGreen: "green-namespace" }),
  );
  assert.deepEqual(
    baseline.namespaces.map((row) => [row.className, row.id]),
    [
      ["PoolContainer", "legacy-namespace"],
      ["PoolRuntimeBlue", "blue-namespace"],
      ["PoolRuntimeGreen", "green-namespace"],
    ],
  );
});
