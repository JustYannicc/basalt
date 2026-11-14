import assert from "node:assert/strict";
import { test } from "node:test";
import { localPostgres } from "./account-change-postgres-fixture.ts";
import { sourceReadLocks, type SourceState } from "./account-source-read-locks-fixture.ts";

for (const state of ["selected", "revoked"] satisfies SourceState[]) {
  test(
    `reconciling a ${state} account source finishes while an app reader holds FOR SHARE`,
    { skip: !localPostgres, timeout: 20000 },
    () =>
      sourceReadLocks(async (fixture) => {
        await fixture.setState(state);
        const before = await fixture.readStored();
        await fixture.reconcile();
        assert.deepEqual(
          await fixture.readStored(),
          before,
          "uncontended reconciliation preserves the saved source",
        );
        const result = await fixture.underReadLock();
        assert.equal(
          result.blocked,
          false,
          "a saved source read must not wait for the app's write lock",
        );
        assert.equal(result.finishedUnderReadLock, true);
        assert.equal(result.lockStatements, 0);
        assert.equal(result.writes, 0);
        assert.deepEqual(
          await fixture.readStored(),
          before,
          "encrypted selection, enabled state and revision stay unchanged",
        );
      }),
  );
}

test(
  "reconciling a missing account source still takes the app write lock",
  { skip: !localPostgres, timeout: 20000 },
  () =>
    sourceReadLocks(async (fixture) => {
      await fixture.setState("missing");
      const before = await fixture.readStored();
      await fixture.reconcile();
      assert.deepEqual(await fixture.readStored(), before);
      const result = await fixture.underReadLock();
      assert.equal(
        result.blocked,
        true,
        "the actual PostgreSQL wait graph must identify the held app row",
      );
      assert.equal(result.finishedUnderReadLock, false);
      assert.ok(result.lockStatements > 0);
      assert.equal(result.writes, 0);
      assert.deepEqual(
        await fixture.readStored(),
        before,
        "this fixture has no unambiguous source to backfill",
      );
    }),
);
