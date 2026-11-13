import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { migrateAccountChanges } from "../../.upstream/apps/hosted/server/src/implementation/account-change-schema.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { fixture, key } from "./account-change-fixture.ts";

test("migration 20 preserves saved accounts and repeated setup; real account, binding and observation writes move the head", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = makeChangeJournal(sql);
      const read = (topic = "accounts") =>
        journal
          .current("organization:team-a", [key(topic)])
          .pipe(Effect.map((heads) => heads[0]!.revision));
      yield* migrateAccountChanges;
      assert.equal(yield* read(), "0");
      assert.deepEqual(yield* sql`select label from executor_accounts`, [{ label: "Retained" }]);
      yield* sql`update executor_accounts set label='Renamed' where id='acc_a'`;
      assert.equal(yield* read(), "1");
      yield* sql`update executor_accounts set label='Renamed' where id='acc_a'`;
      assert.equal(yield* read(), "1");
      yield* sql`update executor_accounts set encrypted_credentials=${new Uint8Array([2])} where id='acc_a'`;
      assert.equal(yield* read(), "1", "token renewal does not change a visible account");
      yield* sql`update executor_accounts set credential_generation=credential_generation+1 where id='acc_a'`;
      assert.equal(yield* read(), "2");
      yield* sql`insert into hosted_app_account_links values ('app_a','acc_a',null,'models')`;
      assert.equal(yield* read(), "3");
      yield* sql`insert into executor_account_observations
      (id,account,owner,source,generation,data,next_allowed_at)
      values ('observation-a','acc_a','organization:team-a','quota',0,'{}',now())`;
      assert.equal(yield* read(), "4");
      yield* sql`update executor_account_observations set lease='collecting',lease_until=now()+interval '1 minute'`;
      assert.equal(yield* read(), "4", "collection leases do not invalidate a reading");
      yield* sql`update executor_account_observations set data='{"remaining":2}',checked_at=now()`;
      assert.equal(yield* read(), "5");
      const before = yield* read();
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`delete from hosted_app_account_links`;
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.result);
      assert.equal(yield* read(), before);
      yield* sql`delete from executor_accounts where id='acc_a'`;
      assert.equal(yield* read(), "6");
    }),
  ));

test("roles, groups, sharing, provisioning and session revocation have durable scoped hints", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = makeChangeJournal(sql);
      yield* sql`insert into hosted_groups values ('group-a','team-a','Group')`;
      yield* sql`insert into hosted_group_members values ('group-a','member-a')`;
      yield* sql`update member set role='admin' where id='member-a'`;
      yield* sql`insert into hosted_account_access values ('acc_a','team-a','everyone')`;
      yield* sql`insert into hosted_provisioning values ('team-a','queued',0,now())`;
      yield* sql`delete from session where id='session-a'`;
      const delivered: { scope: string; topic: string; revision: string }[] = [];
      yield* journal.deliver((scope, hint) =>
        Effect.sync(() => {
          delivered.push({ scope, ...hint });
        }),
      );
      assert.ok(
        delivered.some(
          (hint) => hint.scope === "organization:team-a" && hint.topic === "membership",
        ),
      );
      assert.ok(
        delivered.some((hint) => hint.scope === "organization:team-a" && hint.topic === "accounts"),
      );
      assert.ok(
        delivered.some((hint) => hint.scope === "organization:team-a" && hint.topic === "apps"),
      );
      assert.ok(
        delivered.some((hint) => hint.scope === "user:viewer-a" && hint.topic === "session"),
      );
      assert.equal(
        delivered.some((hint) => hint.scope === "organization:team-b"),
        false,
      );
      yield* journal.deliver(() => Effect.die("acknowledged hints cannot deliver twice"));
    }),
  ));

for (const writer of [
  {
    name: "personal-data reporting",
    table: "executor_account_reports",
    insert: `insert into executor_account_reports
      (id,owner,client_fingerprint,credential_generation,status)
      values ('acc_a','organization:team-a','synthetic-client',0,'active')`,
    change: "update executor_account_reports set status='refresh_pending'",
    bookkeeping:
      "update executor_account_reports set lease='reporting',lease_until=now()+interval '1 minute'",
  },
  {
    name: "driver health",
    table: "executor_account_driver_checks",
    insert: `insert into executor_account_driver_checks
      (account,owner,driver,driver_revision,binding_revision,generation,checkable,status,checked_at)
      values ('acc_a','organization:team-a','synthetic-driver','1','1',0,true,'healthy',now())`,
    change:
      "update executor_account_driver_checks set status='credentials_rejected',message='Synthetic grant revoked'",
    bookkeeping: undefined,
  },
  {
    name: "execution target",
    table: "executor_account_targets",
    insert: `insert into executor_account_targets
      (account,owner,revision,mode,enabled,device,device_name,binding,manifest_revision)
      values ('acc_a','organization:team-a',1,'device',true,'synthetic-device','Fixture device','synthetic-binding','1')`,
    change: "update executor_account_targets set enabled=false,revision=2",
    bookkeeping: undefined,
  },
])
  test(`${writer.name} commits invalidate account reads without crossing owners`, () =>
    fixture(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const journal = makeChangeJournal(sql);
        const read = () => journal.current("organization:team-a", [key("accounts")]);
        yield* sql.unsafe(writer.insert);
        const before = yield* read();
        yield* sql.unsafe(writer.change);
        const changed = yield* read();
        assert.equal(BigInt(changed[0]!.revision), BigInt(before[0]!.revision) + 1n);
        yield* sql.unsafe(writer.change);
        assert.deepEqual(yield* read(), changed, "identical persisted state is not a change");
        if (writer.bookkeeping !== undefined) {
          yield* sql.unsafe(writer.bookkeeping);
          assert.deepEqual(yield* read(), changed, "reporting leases do not change the report");
        }
        yield* sql
          .withTransaction(
            sql.unsafe(`delete from ${writer.table}`).pipe(Effect.andThen(Effect.fail("rollback"))),
          )
          .pipe(Effect.result);
        assert.deepEqual(yield* read(), changed, "rollback preserves source and revision");
        yield* sql.unsafe(`delete from ${writer.table}`);
        const removed = yield* read();
        assert.equal(BigInt(removed[0]!.revision), BigInt(changed[0]!.revision) + 1n);
        const delivered: string[] = [];
        yield* journal.deliver((scope) =>
          Effect.sync(() => {
            delivered.push(scope);
          }),
        );
        assert.ok(delivered.length > 0);
        assert.ok(delivered.every((scope) => scope === "organization:team-a"));
      }),
    ));
