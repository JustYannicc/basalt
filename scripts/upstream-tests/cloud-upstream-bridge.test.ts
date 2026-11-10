import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Effect,
  pgliteLayer,
  cloudMigrationSteps,
  migrateCloudProductSteps,
  expectedIds,
  mappedIds,
  seedHistory,
  journal,
  objects,
  retainedCloud,
  dump,
  refused,
  importsStayDisabled,
} from "./cloud-upstream-bridge-fixtures.ts";
import {
  seedEncryptedSdk,
  retainedSdk,
  decryptRetained,
} from "./cloud-upstream-bridge-retained.ts";

for (const maximum of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, ...mappedIds])
  test(`Cloud bridge accepts the Basalt prefix ending at ${maximum}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedHistory(maximum);
        const before = maximum >= 10 ? yield* retainedCloud : undefined;
        yield* migrateCloudProductSteps();
        const first = yield* journal;
        assert.deepEqual(
          first.map((row) => row.migration_id),
          expectedIds,
        );
        assert.deepEqual(
          first.map((row) => `${row.migration_id}_${row.name}`),
          Object.keys(cloudMigrationSteps),
        );
        if (before) assert.deepEqual(yield* retainedCloud, before);
        const firstObjects = yield* objects;
        yield* migrateCloudProductSteps();
        assert.deepEqual(yield* journal, first, "repeat must retain journal timestamps");
        assert.deepEqual(yield* objects, firstObjects, "repeat must not rebuild tables or indexes");
        yield* importsStayDisabled;
      }).pipe(Effect.provide(pgliteLayer())),
    );
  });

test("a copied Basalt database retains UUID, receipts, policies, targets and ciphertext after restart", async () => {
  const fixture = await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedHistory(10);
      const encrypted = yield* seedEncryptedSdk;
      return {
        encrypted,
        cloud: yield* retainedCloud,
        sdk: yield* retainedSdk,
        journal: yield* journal,
        snapshot: yield* dump,
      };
    }).pipe(Effect.provide(pgliteLayer())),
  );
  const upgraded = await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrateCloudProductSteps();
      assert.deepEqual(yield* retainedCloud, fixture.cloud);
      assert.deepEqual(yield* retainedSdk, fixture.sdk);
      assert.deepEqual(
        (yield* journal).filter((row) => row.migration_id <= 10),
        fixture.journal,
      );
      yield* decryptRetained(fixture.encrypted);
      return yield* dump;
    }).pipe(Effect.provide(pgliteLayer({ loadDataDir: fixture.snapshot }))),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* journal;
      const firstObjects = yield* objects;
      yield* migrateCloudProductSteps();
      assert.deepEqual(yield* journal, first);
      assert.deepEqual(yield* objects, firstObjects);
      assert.deepEqual(yield* retainedCloud, fixture.cloud);
      assert.deepEqual(yield* retainedSdk, fixture.sdk);
      yield* decryptRetained(fixture.encrypted);
      yield* importsStayDisabled;
    }).pipe(Effect.provide(pgliteLayer({ loadDataDir: upgraded }))),
  );
});

for (const id of mappedIds)
  test(`failure after Cloud ${id} SQL rolls back every pending operation and retries`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedHistory(10);
        const before = {
          journal: yield* journal,
          cloud: yield* retainedCloud,
          objects: yield* objects,
        };
        const failing = Object.fromEntries(
          Object.entries(cloudMigrationSteps).map(([key, step]) => [
            key,
            Number.parseInt(key) === id
              ? Effect.gen(function* () {
                  yield* step;
                  return yield* Effect.fail(new Error("injected after SQL"));
                })
              : step,
          ]),
        );
        yield* refused(migrateCloudProductSteps(failing));
        assert.deepEqual(yield* journal, before.journal);
        assert.deepEqual(yield* retainedCloud, before.cloud);
        assert.deepEqual(yield* objects, before.objects);
        yield* migrateCloudProductSteps();
        assert.deepEqual(
          (yield* journal).map((row) => row.migration_id),
          expectedIds,
        );
        assert.deepEqual(yield* retainedCloud, before.cloud);
      }).pipe(Effect.provide(pgliteLayer())),
    );
  });
