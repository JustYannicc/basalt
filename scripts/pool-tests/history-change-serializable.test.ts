import assert from "node:assert/strict";
import { test } from "node:test";
import { localHomePostgres, postgresHomeChanges } from "./history-change-postgres-fixture.ts";

for (const triggers of [true, false]) {
  test(
    `serializable Home credential changes do not conflict through the pool journal with journal ${triggers ? "enabled" : "disabled control"}`,
    { skip: !localHomePostgres, timeout: 20000 },
    () =>
      postgresHomeChanges(async ({ a, b, observer }) => {
        if (!triggers)
          await observer.query("alter table auth disable trigger basalt_pool_change_write");
        await a.query("begin isolation level serializable");
        assert.deepEqual(
          (await a.query("select label from auth where uuid='target-credential'")).rows,
          [{ label: "Initial" }],
        );
        await b.query("update auth set label='Other changed' where uuid='unrelated-credential'");
        let outcome: { committed: boolean; code?: string; phase?: string } = { committed: false };
        let phase = "update";
        try {
          await a.query("update auth set label='Target changed' where uuid='target-credential'");
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
        assert.deepEqual((await observer.query("select label from auth order by uuid")).rows, [
          { label: "Target changed" },
          { label: "Other changed" },
        ]);
      }),
  );
}
