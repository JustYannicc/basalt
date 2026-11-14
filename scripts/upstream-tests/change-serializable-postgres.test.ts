import assert from "node:assert/strict";
import { test } from "node:test";
import { localPostgres, postgresChanges } from "./account-change-postgres-fixture.ts";

for (const triggers of [true, false]) {
  test(
    `serializable connection removal ignores another connection's change with journal ${triggers ? "enabled" : "disabled control"}`,
    { skip: !localPostgres, timeout: 20000 },
    () =>
      postgresChanges(async ({ a, b, observer }) => {
        for (const id of ["expired-target", "fresh-unrelated"])
          await a.query(
            `insert into executor_account_connections
          (id,owner,provider,state,revision,created_at,expires_at,target)
          values($1::text,'organization:team-a','prv_a','{"status":"pending"}','initial',
            now()-interval '3 days',case when $1::text='expired-target'
              then now()-interval '2 days' else now()+interval '1 hour' end,'{}')`,
            [id],
          );
        if (!triggers)
          await observer.query(
            "alter table executor_account_connections disable trigger hosted_committed_change",
          );
        await a.query("begin isolation level serializable");
        const selected = await a.query(`select id from executor_account_connections
        where expires_at < now()-interval '25 hours' order by id`);
        assert.deepEqual(selected.rows, [{ id: "expired-target" }]);
        await b.query(
          "update executor_account_connections set revision='changed' where id='fresh-unrelated'",
        );
        let outcome: { committed: boolean; code?: string; phase?: string } = { committed: false };
        let phase = "delete";
        try {
          await a.query("delete from executor_account_connections where id='expired-target'");
          phase = "commit";
          await a.query("commit");
          outcome = { committed: true };
        } catch (error) {
          await a.query("rollback");
          const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[0-9A-Z]{5}$/.test(error.code)
              ? error.code
              : "unknown";
          outcome = { committed: false, code, phase };
        }
        assert.deepEqual(outcome, { committed: true });
        assert.deepEqual(
          (await observer.query("select id from executor_account_connections order by id")).rows,
          [{ id: "fresh-unrelated" }],
        );
      }, "activate"),
  );
}
