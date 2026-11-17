import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { historyInsertFixture, insertAudit, insertPools } from "./history-insert-fixture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { readPoolHistoryChanges } from "../../src/pool/model-history/change-revisions.ts";

async function pauseInsert(a: pg.Client, owner: pg.Client, id: string) {
  await owner.query("SELECT pg_advisory_lock(66011234),pg_advisory_lock(66011235)");
  await a.query(`CREATE FUNCTION fixture_row_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id=TG_ARGV[0] THEN RAISE NOTICE 'fixture_row_gate';
      PERFORM pg_advisory_xact_lock(66011234); END IF; RETURN NULL; END $$;
    CREATE TRIGGER zz_fixture_row_gate AFTER INSERT ON basalt_model_requests FOR EACH ROW
      EXECUTE FUNCTION fixture_row_gate('${id}');
    CREATE FUNCTION fixture_end_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE NOTICE 'fixture_end_gate'; PERFORM pg_advisory_xact_lock(66011235); RETURN NULL; END $$;
    CREATE TRIGGER zz_fixture_end_gate AFTER INSERT ON basalt_model_requests FOR EACH STATEMENT
      EXECUTE FUNCTION fixture_end_gate()`);
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
  test(`per-row v11 matches legacy during concurrent mapping ${mutation}`, async () => {
    const run = (upgraded: boolean) =>
      historyInsertFixture(async ({ a, b, reader, rows, insert }) => {
        if (upgraded) await migrateModelHistory(a);
        const pool = "app_fixture_race_target";
        if (mutation !== "create")
          await b.query("INSERT INTO channel_group VALUES(3,$1,false,NULL)", [
            `signalbox-pool-${pool}`,
          ]);
        const incoming = await rows(mutation === "create" ? [pool, insertPools[0]!] : [pool]);
        const gate = await pauseInsert(a, reader, incoming[0]!.id);
        const pending = insert(a, incoming);
        const premature = pending.then(() => {
          throw new Error("history finished before advisory gate");
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
              "signalbox-pool-app_fixture_renamed",
            ]);
          await gate.releaseRow();
          await Promise.race([gate.end, premature]);
          const before = await readPoolHistoryChanges(reader, pool);
          const cached = Number(
            (
              await reader.query("SELECT count(*) AS n FROM basalt_model_requests WHERE pool=$1", [
                incoming[0]!.pool,
              ])
            ).rows[0]!.n,
          );
          await gate.releaseEnd();
          await pending;
          const after = await readPoolHistoryChanges(reader, pool);
          const actual = Number(
            (
              await reader.query("SELECT count(*) AS n FROM basalt_model_requests WHERE pool=$1", [
                incoming[0]!.pool,
              ])
            ).rows[0]!.n,
          );
          return { keys: (await insertAudit(a)).keys, before, after, cached, actual };
        } finally {
          await gate.releaseRow();
          await gate.releaseEnd();
          await pending.catch(() => {});
        }
      });
    const legacy = await run(false);
    const current = await run(true);
    assert.deepEqual(current, legacy);
    assert.equal(current.cached, 0);
    assert.equal(current.actual, 1);
    const usage = current.keys.filter((key) => key.topic === "pool-usage");
    if (mutation === "create") {
      assert.deepEqual(usage, [{ pool: insertPools[0], topic: "pool-usage" }]);
      assert.equal(current.after.find((hint) => hint.topic === "pool-usage")!.revision, "0");
    } else {
      assert.deepEqual(usage, [{ pool: "app_fixture_race_target", topic: "pool-usage" }]);
      assert.equal(current.after.find((hint) => hint.topic === "pool-usage")!.revision, "1");
    }
  });
}
