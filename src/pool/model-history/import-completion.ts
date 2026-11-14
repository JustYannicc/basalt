import { digest } from "../backend-users.ts";
import { historyObject, HistoryInputError } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import {
  completionHash,
  importCompletionScope,
  importCompletionSelection,
  type ImportCompletionSelection,
  type CompletionDifference,
} from "./import-completion-contract.ts";

/** Prefix groups bound each ordered aggregate; no source IDs or request rows leave the database. */
async function reconciled(db: HistoryDatabase, scope: { pool: string; source: string }) {
  const result = await db.query(
    `WITH buckets AS (
    SELECT left(id,2) AS bucket, count(*) AS rows,
      min(timestamp_exact) AS first_at, max(timestamp_exact) AS last_at,
      encode(sha256(convert_to(string_agg(id::text,E'\\n' ORDER BY id),'UTF8')),'hex') AS digest
    FROM basalt_model_requests WHERE pool=$1 AND source=$2 GROUP BY left(id,2)
  ) SELECT COALESCE(sum(rows),0)::text AS rows,min(first_at) AS "frozenFrom",
    max(last_at) AS "frozenTo",
    encode(sha256(convert_to(COALESCE(string_agg(bucket||':'||digest,E'\\n' ORDER BY bucket),''),'UTF8')),'hex') AS "idsDigest"
    FROM buckets`,
    [scope.pool, scope.source],
  );
  return result.rows[0]!;
}
async function savedCompletion(db: HistoryDatabase, scope: { pool: string; source: string }) {
  return (
    (
      await db.query(
        `SELECT frozen_from AS "frozenFrom",frozen_to AS "frozenTo",
    upper_source_id::text AS "upperSourceId",manifest_digest AS "manifestDigest",
    map_digest AS "accountMappingDigest",ids_digest AS "idsDigest",verified_rows::text AS "verifiedRows"
    FROM basalt_model_import_completion WHERE pool=$1 AND source=$2`,
        [scope.pool, scope.source],
      )
    ).rows[0] ?? null
  );
}
export async function planImportCompletion(
  db: HistoryDatabase,
  selection: ImportCompletionSelection,
) {
  const scope = await importCompletionScope(selection);
  const current = await savedCompletion(db, scope);
  const actual = await reconciled(db, scope);
  const exact =
    actual.rows === selection.verifiedRows &&
    actual.idsDigest === selection.idsDigest &&
    actual.frozenFrom === selection.frozenFrom &&
    actual.frozenTo === selection.frozenTo;
  const same =
    current !== null &&
    [
      "frozenFrom",
      "frozenTo",
      "upperSourceId",
      "manifestDigest",
      "accountMappingDigest",
      "idsDigest",
      "verifiedRows",
    ].every((key) => current[key] === selection[key as keyof ImportCompletionSelection]);
  const contiguous =
    current === null
      ? selection.afterSourceId === "0"
      : selection.afterSourceId === current.upperSourceId &&
        BigInt(selection.upperSourceId) > BigInt(String(current.upperSourceId)) &&
        BigInt(selection.verifiedRows) > BigInt(String(current.verifiedRows)) &&
        selection.frozenFrom <= String(current.frozenFrom) &&
        selection.frozenTo >= String(current.frozenTo);
  const differences: CompletionDifference[] = [];
  for (const key of ["verifiedRows", "idsDigest", "frozenFrom", "frozenTo"] as const) {
    const observed = key === "verifiedRows" ? actual.rows : actual[key];
    if (observed !== selection[key])
      differences.push({
        field: key,
        comparison: "equal",
        expected: selection[key],
        observed: observed === null ? null : String(observed),
      });
  }
  if (!same) {
    const after = current === null ? "0" : String(current.upperSourceId);
    if (selection.afterSourceId !== after)
      differences.push({
        field: "afterSourceId",
        comparison: "equal",
        expected: after,
        observed: selection.afterSourceId,
      });
    if (current) {
      if (BigInt(selection.upperSourceId) <= BigInt(String(current.upperSourceId)))
        differences.push({
          field: "upperSourceId",
          comparison: "greater-than",
          expected: String(current.upperSourceId),
          observed: selection.upperSourceId,
        });
      if (BigInt(selection.verifiedRows) <= BigInt(String(current.verifiedRows)))
        differences.push({
          field: "verifiedRows",
          comparison: "greater-than",
          expected: String(current.verifiedRows),
          observed: selection.verifiedRows,
        });
      if (selection.frozenFrom > String(current.frozenFrom))
        differences.push({
          field: "frozenFrom",
          comparison: "at-most",
          expected: String(current.frozenFrom),
          observed: selection.frozenFrom,
        });
      if (selection.frozenTo < String(current.frozenTo))
        differences.push({
          field: "frozenTo",
          comparison: "at-least",
          expected: String(current.frozenTo),
          observed: selection.frozenTo,
        });
    }
  }
  const plan = {
    selection,
    current,
    actual,
    reconciled: exact,
    contiguous,
    alreadyComplete: same,
    differences,
  };
  return {
    status: "dry-run" as const,
    writes: false,
    ...plan,
    digest: await digest(JSON.stringify(plan)),
  };
}

/** Only the existing private operations entrypoint can approve a reconciled completion plan. */
export async function handleImportCompletion(
  request: Request,
  db: HistoryDatabase,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const raw = historyObject(await request.json()),
    selection = importCompletionSelection(raw.selection);
  const apply = raw.go === true;
  if (apply && !completionHash(raw.digest)) throw new HistoryInputError();
  await db.query(
    apply
      ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ"
      : "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    await db.query("SET LOCAL work_mem = '8MB'");
    const scope = await importCompletionScope(selection);
    if (apply)
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `model-import-completion:${scope.pool}:${scope.source}`,
      ]);
    const plan = await planImportCompletion(db, selection);
    if (
      apply &&
      (raw.digest !== plan.digest ||
        !plan.reconciled ||
        (!plan.contiguous && !plan.alreadyComplete))
    ) {
      await db.query("ROLLBACK");
      return Response.json(
        {
          error: "import_completion_refused",
          differences: [
            ...plan.differences,
            ...(raw.digest === plan.digest
              ? []
              : [
                  {
                    field: "planDigest",
                    comparison: "equal",
                    expected: raw.digest,
                    observed: plan.digest,
                  },
                ]),
          ],
        },
        { status: 409 },
      );
    }
    if (apply && !plan.alreadyComplete)
      await db.query(
        `INSERT INTO basalt_model_import_completion
      (pool,source,frozen_from,frozen_to,upper_source_id,manifest_digest,map_digest,ids_digest,verified_rows)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(pool,source) DO UPDATE SET
      frozen_from=EXCLUDED.frozen_from,frozen_to=EXCLUDED.frozen_to,upper_source_id=EXCLUDED.upper_source_id,
      manifest_digest=EXCLUDED.manifest_digest,map_digest=EXCLUDED.map_digest,ids_digest=EXCLUDED.ids_digest,
      verified_rows=EXCLUDED.verified_rows,completed_at=CURRENT_TIMESTAMP`,
        [
          scope.pool,
          scope.source,
          selection.frozenFrom,
          selection.frozenTo,
          selection.upperSourceId,
          selection.manifestDigest,
          selection.accountMappingDigest,
          selection.idsDigest,
          selection.verifiedRows,
        ],
      );
    await db.query("COMMIT");
    return Response.json(
      apply
        ? {
            status: "complete",
            digest: plan.digest,
            selection,
            alreadyComplete: plan.alreadyComplete,
          }
        : plan,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
