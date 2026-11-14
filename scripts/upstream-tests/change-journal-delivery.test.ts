import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import { fixture, key } from "./account-change-fixture.ts";
import {
  activateChangeJournal,
  prepareChangeJournal,
} from "../../.upstream/apps/hosted/server/src/implementation/change-journal-schema.ts";
import { projectCommittedChanges } from "../../.upstream/apps/hosted/server/src/implementation/change-projection.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";

const scope = "organization:team-a";
const account = key("accounts");

test("the same reader works before preparation, after preparation and with a stopped queue projector", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = makeChangeJournal(sql);
      assert.deepEqual(yield* journal.current(scope, [account]), [{ ...account, revision: "0" }]);
      yield* prepareChangeJournal;
      yield* sql`select hosted_queue_change(${scope},'accounts','*')`;
      assert.deepEqual(yield* journal.current(scope, [account]), [{ ...account, revision: "1" }]);
      yield* activateChangeJournal;
      yield* sql`select hosted_queue_change(${scope},'accounts','*')`;
      yield* sql`select hosted_queue_change(${scope},'accounts','*')`;
      assert.deepEqual(yield* journal.current(scope, [account]), [{ ...account, revision: "3" }]);
      assert.deepEqual(
        yield* sql`select revision::text from hosted_change_heads where topic='accounts'`,
        [{ revision: "1" }],
      );
      assert.deepEqual(yield* sql`select count(*)::int as n from hosted_change_dirty`, [{ n: 2 }]);
      const delivered: unknown[] = [];
      yield* makeChangeJournal(sql).deliver((target, hint) =>
        Effect.sync(() => {
          delivered.push({ target, ...hint });
        }),
      );
      assert.deepEqual(delivered, [{ target: scope, ...account, revision: "3" }]);
      assert.deepEqual(yield* sql`select * from hosted_change_dirty`, []);
      assert.deepEqual(yield* sql`select * from hosted_change_batches`, []);
      assert.deepEqual(yield* sql`select * from hosted_change_pending`, []);
      assert.deepEqual(yield* journal.current(scope, [account]), [{ ...account, revision: "3" }]);
    }),
  ));

test("projection refuses an ambient producer transaction without rolling it back", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* prepareChangeJournal;
      yield* activateChangeJournal;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`set transaction isolation level serializable`;
          yield* sql`update executor_accounts set label='Retained producer write' where id='acc_a'`;
          const refusal = yield* projectCommittedChanges(sql).pipe(Effect.result);
          assert.ok(Result.isFailure(refusal));
          assert.equal(refusal.failure._tag, "ChangeProjectionInTransaction");
          assert.deepEqual(yield* sql`select label from executor_accounts where id='acc_a'`, [
            { label: "Retained producer write" },
          ]);
        }),
      );
      assert.deepEqual(yield* sql`select count(*)::int as n from hosted_change_batches`, [
        { n: 1 },
      ]);
      assert.equal(yield* projectCommittedChanges(sql), 1);
      assert.deepEqual(yield* makeChangeJournal(sql).current(scope, [account]), [
        { ...account, revision: "1" },
      ]);
    }),
  ));

test("delivery keeps failed hints and an old acknowledgement cannot delete a newer projected hint", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* prepareChangeJournal;
      yield* activateChangeJournal;
      yield* sql`select hosted_queue_change(${scope},'accounts','*')`;
      const journal = makeChangeJournal(sql);
      const failed = yield* journal.deliver(() => Effect.fail("offline")).pipe(Effect.result);
      assert.ok(Result.isFailure(failed));
      assert.equal(failed.failure._tag, "ChangeDispatchFailed");
      assert.deepEqual(yield* sql`select revision::text from hosted_change_pending`, [
        { revision: "1" },
      ]);
      yield* journal.deliver((_, hint) =>
        Effect.gen(function* () {
          assert.equal(hint.revision, "1");
          yield* sql`select hosted_queue_change(${scope},'accounts','*')`;
          assert.equal(yield* projectCommittedChanges(sql), 1);
        }),
      );
      assert.deepEqual(yield* sql`select revision::text from hosted_change_pending`, [
        { revision: "2" },
      ]);
      const recovered: unknown[] = [];
      yield* makeChangeJournal(sql).deliver((_, hint) =>
        Effect.sync(() => {
          recovered.push(hint);
        }),
      );
      assert.deepEqual(recovered, [{ ...account, revision: "2" }]);
      assert.deepEqual(yield* sql`select * from hosted_change_pending`, []);
    }),
  ));
