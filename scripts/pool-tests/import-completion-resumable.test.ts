import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { handleImportCompletion } from "../../src/pool/model-history/import-completion.ts";
import { reconcileRanges } from "../../src/pool/model-history/import-reconcile.ts";
import {
  completionRefusal,
  importCompletionScope,
} from "../../src/pool/model-history/import-completion-contract.ts";
import {
  historySchemaMigrations,
  historySchemaVersion,
} from "../../src/pool/model-history/schema.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

// The schema operator applies the registry up to the reported version, so a version that is not the
// last registered migration would silently drop every migration after it.
test("the reported history version is the last registered migration", () => {
  assert.equal(historySchemaMigrations.at(-1)!.name, historySchemaVersion);
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const source = "11111111-2222-4333-8444-555555555555";
const at = "2026-01-01T00:45:00.000000000Z";
function idsDigest(ids: string[]) {
  const prefixes = [...new Set(ids.map((id) => id.slice(0, 2)))].sort();
  return sha(
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
}
const selectionFor = (ids: string[]) => ({
  pool,
  source,
  frozenFrom: at,
  frozenTo: at,
  afterSourceId: "0",
  upperSourceId: String(ids.length),
  manifestDigest: sha("manifest"),
  accountMappingDigest: sha("map"),
  idsDigest: idsDigest(ids),
  verifiedRows: String(ids.length),
});
type Database = Parameters<typeof handleImportCompletion>[1];
const call = (db: Database, body: unknown, budgetMs: number) =>
  handleImportCompletion(
    new Request("http://private-operations/model-history/import-completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    db,
    { budgetMs },
  );
// A zero budget does one range of work per call, standing in for a source too large for a session.
const oneRange = (db: Database, ids: string[]) => call(db, { selection: selectionFor(ids) }, 0);
const unbounded = (db: Database, ids: string[]) =>
  call(db, { selection: selectionFor(ids) }, Number.POSITIVE_INFINITY);

test("import completion reconciles across calls, restarts when the source grows, and applies only current progress", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const scope = await importCompletionScope({ pool, source });
    const ids: string[] = [];
    for (let batch = 0; batch < 3; batch++)
      ids.push(
        ...(await insert(...Array.from({ length: 200 }, () => ({ source: scope.source })))).map(
          (row) => row.id,
        ),
      );
    let progress: { status: string; ranges: number } | undefined;
    for (let calls = 0; calls < 10; calls++) progress = await (await oneRange(db, ids)).json();
    assert.deepEqual(progress, {
      status: "reconciling",
      progressWrites: true,
      ranges: 10,
      totalRanges: reconcileRanges,
    });
    const early = await call(
      db,
      { selection: selectionFor(ids), digest: sha("plan"), go: true },
      0,
    );
    assert.equal(early.status, 409);
    assert.equal(
      completionRefusal(await early.json()),
      `reconciledRanges must be equal ${reconcileRanges}; observed 10`,
    );

    // A row added after the fence was taken makes the finished progress stale; it starts over.
    const [late] = await insert({ source: scope.source });
    const grown = [...ids, late!.id];
    let ranges = 10;
    for (let calls = 0; ranges !== 0 && calls <= reconcileRanges + 1; calls++)
      ranges = (await (await oneRange(db, grown)).json()).ranges;
    assert.equal(ranges, 0);
    const response = await unbounded(db, grown);
    assert.equal(response.status, 200);
    const plan = await response.json();
    assert.equal(plan.reconciled, true, JSON.stringify(plan.differences));
    assert.equal(plan.actual.rows, String(grown.length));
    const done = await call(
      db,
      { selection: selectionFor(grown), digest: plan.digest, go: true },
      0,
    );
    assert.equal(done.status, 200, await done.clone().text());
    assert.equal((await done.json()).status, "complete");

    // A later import into the same source is seen, never answered from the old progress.
    const [topUp] = await insert({ source: scope.source });
    const next = await (await unbounded(db, [...grown, topUp!.id])).json();
    assert.equal(next.actual.rows, String(grown.length + 1));
  });
});

test("a small source still reconciles and plans in one call", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const scope = await importCompletionScope({ pool, source });
    const rows = await insert({ source: scope.source }, { source: scope.source });
    const response = await call(db, { selection: selectionFor(rows.map((row) => row.id)) }, 8_000);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reconciled, true);
  });
});
