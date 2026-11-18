import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { planImportCompletion } from "../../src/pool/model-history/import-completion.ts";
import { importCompletionScope } from "../../src/pool/model-history/import-completion-contract.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const source = "11111111-2222-4333-8444-555555555555";
const at = "2026-01-01T00:45:00.000000000Z";
const rows = 200_000;
// One ordered aggregate over every source row overran the production operation's statement
// bound at 2.26M rows. The fixture scales the same ratio down: one statement over 200k rows
// cannot finish inside 150 ms, while one prefix range (~800 rows) takes a few milliseconds.
const bound = "150ms";

test("import completion reconciles a large source inside the statement bound and keeps the exact digest", async () => {
  await seriesFixture(async ({ db, client, insert }) => {
    const scope = await importCompletionScope({ pool, source });
    const [template] = await insert({ source: scope.source });
    // Synthetic copies of one row; the history trigger is irrelevant to reconciliation.
    await client.query("SET session_replication_role = replica");
    await client.query(
      `INSERT INTO basalt_model_requests
      SELECT (jsonb_populate_record(NULL::basalt_model_requests, to_jsonb(t) || jsonb_build_object(
        'id', encode(sha256(convert_to('bounded-'||g,'UTF8')),'hex'),
        'source_record', encode(sha256(convert_to('record-'||g,'UTF8')),'hex')))).*
      FROM basalt_model_requests t CROSS JOIN generate_series(2,$2::int) g WHERE t.id=$1`,
      [template!.id, rows],
    );
    await client.query("RESET session_replication_role");
    await client.query("ANALYZE basalt_model_requests");
    const ids = (
      await db.query("SELECT id FROM basalt_model_requests WHERE source=$1", [scope.source])
    ).rows.map((row) => String(row.id));
    assert.equal(ids.length, rows);
    const prefixes = [...new Set(ids.map((id) => id.slice(0, 2)))].sort();
    const idsDigest = sha(
      prefixes
        .map(
          (prefix) =>
            `${prefix}:${sha(
              ids
                .filter((id) => id.startsWith(prefix))
                .sort()
                .join("\n"),
            )}`,
        )
        .join("\n"),
    );
    const selection = {
      pool,
      source,
      frozenFrom: at,
      frozenTo: at,
      afterSourceId: "0",
      upperSourceId: String(rows),
      manifestDigest: sha("manifest"),
      accountMappingDigest: sha("map"),
      idsDigest,
      verifiedRows: String(rows),
    };
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await db.query(`SET LOCAL statement_timeout = '${bound}'`);
      const plan = await planImportCompletion(db, selection);
      assert.equal(plan.reconciled, true, JSON.stringify(plan.differences));
      assert.equal(plan.contiguous, true);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});
