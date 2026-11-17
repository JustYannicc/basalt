import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { historyInsertFixture, insertAudit } from "./history-insert-fixture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";

async function pauseInsert(a: pg.Client, owner: pg.Client) {
  await owner.query("SELECT pg_advisory_lock(66011234),pg_advisory_lock(66011235)");
  await a.query(`CREATE FUNCTION fixture_row_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE NOTICE 'fixture_row_gate'; PERFORM pg_advisory_xact_lock(66011234); RETURN NULL; END $$;
  CREATE TRIGGER zz_fixture_row_gate AFTER INSERT ON basalt_model_requests FOR EACH ROW EXECUTE FUNCTION fixture_row_gate();
  CREATE FUNCTION fixture_end_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   RAISE NOTICE 'fixture_end_gate'; PERFORM pg_advisory_xact_lock(66011235); RETURN NULL; END $$;
  CREATE TRIGGER zz_fixture_end_gate AFTER INSERT ON basalt_model_requests FOR EACH STATEMENT EXECUTE FUNCTION fixture_end_gate()`);
  let enterRow!: () => void, enterEnd!: () => void;
  const row = new Promise<void>((resolve) => {
    enterRow = resolve;
  });
  const end = new Promise<void>((resolve) => {
    enterEnd = resolve;
  });
  a.on("notice", (notice) => {
    if (notice.message === "fixture_row_gate") enterRow();
    if (notice.message === "fixture_end_gate") enterEnd();
  });
  return {
    row,
    end,
    releaseRow: () => owner.query("SELECT pg_advisory_unlock(66011234)"),
    releaseEnd: () => owner.query("SELECT pg_advisory_unlock(66011235)"),
  };
}

for (const mutation of ["create", "delete", "rename"] as const) {
  test(`coarse bulk invalidates a newly registered reader after concurrent mapping ${mutation}`, async () => {
    await historyInsertFixture(async ({ a, b, reader, rows }) => {
      await migrateModelHistory(a);
      const pool = "app_fixture_bulk_race";
      if (mutation !== "create")
        await b.query("INSERT INTO channel_group VALUES(3,$1,false,NULL)", [
          `signalbox-pool-${pool}`,
        ]);
      const incoming = await rows([pool]);
      const gate = await pauseInsert(a, reader);
      const pending = insertBulkRequests(a, incoming, pool);
      const premature = pending.then(() => {
        throw new Error("bulk ended before advisory gate");
      });
      try {
        await Promise.race([gate.row, premature]);
        if (mutation === "create")
          await b.query("INSERT INTO channel_group VALUES(3,$1,false,NULL)", [
            `signalbox-pool-${pool}`,
          ]);
        else if (mutation === "delete") await b.query("DELETE FROM channel_group WHERE id=3");
        else
          await b.query("UPDATE channel_group SET channel_name=$1 WHERE id=3", [
            "signalbox-pool-app_fixture_bulk_renamed",
          ]);
        await gate.releaseRow();
        await Promise.race([gate.end, premature]);
        const before = await readPoolHistoryChanges(reader, pool);
        const cached = (
          await reader.query("SELECT count(*)::int AS n FROM basalt_model_requests WHERE pool=$1", [
            incoming[0]!.pool,
          ])
        ).rows[0]!.n;
        await gate.releaseEnd();
        await pending;
        const after = await readPoolHistoryChanges(reader, pool);
        assert.equal(cached, 0);
        assert.equal(
          (
            await reader.query(
              "SELECT count(*)::int AS n FROM basalt_model_requests WHERE pool=$1",
              [incoming[0]!.pool],
            )
          ).rows[0]!.n,
          1,
        );
        assert.notEqual(
          after.find((h) => h.topic === "pool-usage")!.revision,
          before.find((h) => h.topic === "pool-usage")!.revision,
        );
        assert.deepEqual(
          (await insertAudit(a)).keys.filter((row) => row.topic === "pool-usage"),
          [{ pool, topic: "pool-usage" }],
        );
      } finally {
        await gate.releaseRow();
        await gate.releaseEnd();
        await pending.catch(() => {});
      }
    });
  });
}
