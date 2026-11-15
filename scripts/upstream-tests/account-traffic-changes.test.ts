import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { AccountId } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import { makeAccountTrafficStore } from "../../.upstream/packages/sdk/src/implementation/account-traffic-store.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import {
  migrateProductSteps,
  activateHostedChangeJournal,
} from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import { prepareChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-journal-schema.ts";
import { migrateAccountTrafficChanges } from "../../.upstream/apps/hosted/server/src/implementation/account-traffic-change-schema.ts";
import { fixture } from "./account-change-fixture.ts";

test("normal hosted migration 23 preserves retained traffic without activation 22; counter commits publish only their account", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const account = AccountId.make("acc_a");
      const store = makeAccountTrafficStore(sql);
      const journal = makeChangeJournal(sql);
      const at = Date.now();
      const read = () => store.read({ accounts: [account], from: at - 3_600_000 });
      const heads = () =>
        journal.current("organization:team-a", [
          { topic: "account-traffic", resource: account },
          { topic: "account-traffic", resource: "*" },
        ]);
      yield* store.record({ accounts: [account], at, ok: true });
      assert.equal(
        (yield* read())[0]?.hours[0]?.requests,
        1,
        "an install before migration 23 still stores and reads traffic correctly",
      );
      const migrate = migrateProductSteps("private_hosted_migrations", {
        "21_change_journal_prepare": prepareChangeJournal,
        "23_account_traffic_changes": migrateAccountTrafficChanges,
      });
      yield* migrate;
      yield* migrate;
      assert.deepEqual(
        yield* sql`select migration_id from private_hosted_migrations order by migration_id`,
        [{ migration_id: 21 }, { migration_id: 23 }],
      );
      assert.equal(
        (yield* read())[0]?.hours[0]?.requests,
        1,
        "installing and repeating migration 23 do not replay or delete retained counts",
      );
      assert.ok((yield* heads()).every(({ revision }) => revision === "0"));
      yield* store.record({ accounts: [account], at: at + 1, ok: true });
      assert.deepEqual(
        (yield* heads()).map(({ revision }) => revision),
        ["1", "0"],
        "a counter changes its account key, never an org-wide traffic head",
      );
      assert.equal((yield* read())[0]?.hours[0]?.requests, 2);
      const accepted = yield* heads();
      yield* sql`update executor_account_tool_calls set requests=requests where account=${account}`;
      yield* sql
        .withTransaction(
          store
            .record({ accounts: [account], at: at + 2, ok: false })
            .pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.result);
      assert.deepEqual(yield* heads(), accepted, "a no-op and a rollback publish no revision");
      assert.equal((yield* read())[0]?.hours[0]?.requests, 2);
      yield* sql`update executor_accounts set label='A different topic' where id=${account}`;
      assert.deepEqual(yield* heads(), accepted, "an account label does not change traffic");
      const delivered: { topic: string; resource: string }[] = [];
      yield* journal.deliver((_scope, hint) => Effect.sync(() => delivered.push(hint)));
      assert.deepEqual(
        delivered.filter(({ topic }) => topic === "account-traffic"),
        [{ topic: "account-traffic", resource: account, revision: "1" }],
      );
      yield* journal.deliver(() => Effect.die("a committed revision cannot deliver twice"));
      yield* activateHostedChangeJournal;
      yield* activateHostedChangeJournal;
      assert.deepEqual(
        yield* sql`select migration_id from private_hosted_migrations order by migration_id`,
        [{ migration_id: 21 }, { migration_id: 22 }, { migration_id: 23 }],
        "later migration 23 does not skip the explicit operator activation 22",
      );
      yield* store.record({ accounts: [account], at: at + 3, ok: true });
      assert.deepEqual(
        (yield* heads()).map(({ revision }) => revision),
        ["2", "0"],
      );
      assert.equal((yield* read())[0]?.hours[0]?.requests, 3);
    }),
  ));

test("retention purge adds no traffic revision while deleting a retained hour does", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const account = AccountId.make("acc_a");
      const store = makeAccountTrafficStore(sql);
      const journal = makeChangeJournal(sql);
      const at = Date.now();
      yield* sql`insert into executor_account_tool_calls
        (account,hour,requests,failed,last_success)
        values (${account},now()-interval '32 days',1,0,now()-interval '32 days')`;
      yield* prepareChangeJournal;
      yield* migrateAccountTrafficChanges;
      const head = () =>
        journal.current("organization:team-a", [{ topic: "account-traffic", resource: account }]);
      yield* store.record({ accounts: [account], at, ok: true });
      assert.equal(
        (yield* head())[0]?.revision,
        "1",
        "one call and its expired-row purge publish once",
      );
      assert.equal(
        (yield* sql`select count(*)::int as count from executor_account_tool_calls`)[0]?.count,
        1,
      );
      assert.equal((yield* store.read({ accounts: [account], from: 0 }))[0]?.hours[0]?.requests, 1);
      yield* sql`delete from executor_account_tool_calls where account=${account}`;
      assert.equal(
        (yield* head())[0]?.revision,
        "2",
        "deleting readable traffic still invalidates it",
      );
      assert.deepEqual(yield* store.read({ accounts: [account], from: 0 }), []);
    }),
  ));
