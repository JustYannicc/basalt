import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockedOrDone,
  code,
  localPostgres,
  pid,
  postgresChanges,
  transaction,
} from "./account-change-postgres-fixture.ts";

const insertAccount = `insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at)
 values ('acc_new','organization:team-a','prv_a','key','New',decode('01','hex'),now())`;
const status = "update hosted_provisioning set status='succeeded' where organization_id='team-a'";
const lockApp = "select id from executor_apps where id='app_a' for no key update";
const noDeadlock = (results: PromiseSettledResult<unknown>[]) => {
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => code(result.reason));
  assert.equal(failures.includes("40P01"), false, `PostgreSQL reported a deadlock: ${failures}`);
  return failures;
};

for (const scenario of [
  "duplicate provisioning",
  "backfill vs provisioning",
  "first-time defaults vs rename",
]) {
  test(
    `${scenario} orders domain locks before committed change heads`,
    { skip: !localPostgres, timeout: 20000 },
    () =>
      postgresChanges(async ({ a, b, observer }) => {
        const [ap, bp] = await Promise.all([pid(a), pid(b)]);
        if (scenario === "duplicate provisioning") {
          await a.query("begin");
          await a.query("update executor_accounts set label='Provisioning' where id='acc_a'");
          let done = false;
          const duplicate = transaction(b, async () => {
            await b.query(`insert into executor_apps (id,code,owner,name,slug,created_at)
          values ('app_duplicate','code_duplicate','organization:team-a','Pool','duplicate',now())`);
          }).finally(() => {
            done = true;
          });
          const result = Promise.allSettled([duplicate]);
          await blockedOrDone(observer, bp, ap, () => done);
          const completion = (async () => {
            try {
              await a.query(status);
              await a.query("commit");
            } catch (error) {
              await a.query("rollback");
              throw error;
            }
          })();
          const outcomes = await Promise.all([result, Promise.allSettled([completion])]);
          assert.deepEqual(
            noDeadlock(outcomes.flat()),
            ["23505"],
            "Only the existing app-name conflict is allowed",
          );
        } else if (scenario === "backfill vs provisioning") {
          await a.query("begin");
          await a.query(
            "select pg_advisory_xact_lock(hashtextextended('executor-access:team-a',0))",
          );
          await a.query("select id from member where id='member-a' for share");
          await a.query(lockApp);
          const provisioning = transaction(b, async () => {
            await b.query(status);
            await b.query(lockApp);
          });
          const result = Promise.allSettled([provisioning]);
          await blockedOrDone(observer, bp, ap, () => false);
          const backfill = (async () => {
            try {
              await a.query(
                "insert into hosted_model_bindings (app_id,pool_id) values ('app_a','app_a')",
              );
              await a.query("commit");
            } catch (error) {
              await a.query("rollback");
              throw error;
            }
          })();
          assert.deepEqual(
            noDeadlock([...(await result), ...(await Promise.allSettled([backfill]))]),
            [],
          );
        } else {
          await a.query("begin");
          await a.query(insertAccount);
          await b.query("begin");
          await b.query(lockApp);
          let changed = false;
          const rename = b
            .query("update executor_apps set name='Renamed' where id='app_a'")
            .finally(() => {
              changed = true;
            });
          const renameResult = Promise.allSettled([rename]);
          await blockedOrDone(observer, bp, ap, () => changed);
          const defaults = (async () => {
            try {
              await a.query(lockApp);
              await a.query("commit");
            } catch (error) {
              await a.query("rollback");
              throw error;
            }
          })();
          const defaultsResult = Promise.allSettled([defaults]);
          const renamed = (async () => {
            const [outcome] = await renameResult;
            if (outcome.status === "rejected") {
              await b.query("rollback");
              throw outcome.reason;
            }
            await b.query("commit");
          })();
          const renamedResult = Promise.allSettled([renamed]);
          assert.deepEqual(noDeadlock([...(await defaultsResult), ...(await renamedResult)]), []);
        }
        assert.deepEqual(
          (
            await observer.query(
              "select scope,topic,resource,revision from hosted_change_heads order by scope,topic,resource",
            )
          ).rows.length > 0,
          true,
        );
        assert.equal(
          (await observer.query("select count(*)::int as count from hosted_change_pending")).rows[0]
            .count > 0,
          true,
        );
      }),
  );
}

test(
  "many keys schedule one deferred flush; commit is atomic and rollback leaves no pending",
  { skip: !localPostgres },
  () =>
    postgresChanges(async ({ a, observer }) => {
      await a.query(`create table flush_audit (event text);
    create table head_order (id bigserial,scope text,topic text,resource text);
    create function audit_head() returns trigger language plpgsql as $$begin insert into head_order(scope,topic,resource) values (NEW.scope,NEW.topic,NEW.resource);return NEW;end$$;
    create trigger audit_head after insert or update on hosted_change_heads for each row execute function audit_head();
    create function audit_batch() returns trigger language plpgsql as $$begin insert into flush_audit values (TG_OP);return coalesce(NEW,OLD);end$$;
    create trigger audit_batch after insert or delete on hosted_change_batches for each row execute function audit_batch()`);
      const before = (
        await observer.query(
          "select scope,topic,resource,revision::text from hosted_change_heads order by scope,topic,resource",
        )
      ).rows;
      await a.query("begin");
      await a.query(insertAccount);
      await a.query("update executor_apps set name='Many keys' where id='app_a'");
      await a.query("update member set role='admin' where id='member-a'");
      await a.query("update executor_accounts set label='Changed again' where id='acc_new'");
      await a.query(`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at)
    select 'acc_many_'||n,'organization:team-'||n,'prv_a','key','Many',decode('01','hex'),now() from generate_series(2,9) n`);
      assert.equal(
        (await a.query("select count(*)::int as count from hosted_change_batches")).rows[0].count,
        1,
      );
      assert.ok(
        (await a.query("select count(*)::int as count from hosted_change_dirty")).rows[0].count >=
          3,
      );
      assert.deepEqual(
        (
          await observer.query(
            "select scope,topic,resource,revision::text from hosted_change_heads order by scope,topic,resource",
          )
        ).rows,
        before,
      );
      assert.equal(
        (await observer.query("select count(*)::int as count from hosted_change_pending")).rows[0]
          .count,
        0,
      );
      await a.query("commit");
      assert.deepEqual(
        (await observer.query("select event from flush_audit order by event")).rows,
        [{ event: "DELETE" }, { event: "INSERT" }],
      );
      const after = (
        await observer.query(
          "select scope,topic,resource,revision::text from hosted_change_heads order by scope,topic,resource",
        )
      ).rows;
      const own = after.filter((row) => row.scope === "organization:team-a");
      // Account label edits publish a separate observations head alongside the account directory.
      assert.deepEqual(own, [
        { scope: "organization:team-a", topic: "accounts", resource: "*", revision: "2" },
        { scope: "organization:team-a", topic: "apps", resource: "*", revision: "2" },
        { scope: "organization:team-a", topic: "membership", resource: "*", revision: "1" },
        { scope: "organization:team-a", topic: "observations", resource: "*", revision: "1" },
      ]);
      const applied = (
        await observer.query("select scope,topic,resource from head_order order by id")
      ).rows;
      const expected = [...applied].sort((left, right) =>
        JSON.stringify([left.scope, left.topic, left.resource]).localeCompare(
          JSON.stringify([right.scope, right.topic, right.resource]),
          "en",
        ),
      );
      assert.equal(applied.length, 12);
      assert.deepEqual(applied, expected, "The one flush applies every key in canonical order");
      assert.equal(
        (await observer.query("select count(*)::int as count from hosted_change_batches")).rows[0]
          .count,
        0,
      );
      assert.equal(
        (await observer.query("select count(*)::int as count from hosted_change_dirty")).rows[0]
          .count,
        0,
      );
      await a.query("delete from hosted_change_pending");
      await a.query("begin");
      await a.query("update executor_accounts set label='Rolled back' where id='acc_new'");
      await a.query("rollback");
      assert.deepEqual(
        (
          await observer.query(
            "select scope,topic,resource,revision::text from hosted_change_heads order by scope,topic,resource",
          )
        ).rows,
        after,
      );
      for (const table of ["hosted_change_pending", "hosted_change_dirty", "hosted_change_batches"])
        assert.equal(
          (await observer.query(`select count(*)::int as count from ${table}`)).rows[0].count,
          0,
        );
    }),
);
