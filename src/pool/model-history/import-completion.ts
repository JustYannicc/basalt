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
import {
  inLimitedTransaction,
  ReconcileIncomplete,
  reconcileRanges,
  reconcileStep,
  reconciledProgress,
  resetReconcile,
} from "./import-reconcile.ts";

const reconcileBudgetMs = 8_000;

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
  const actual = await reconciledProgress(db, scope);
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

const refused = (differences: unknown[]) =>
  Response.json({ error: "import_completion_refused", differences }, { status: 409 });

/** Plans, and with approval records, inside one REPEATABLE READ snapshot over stored progress. */
async function settle(
  db: HistoryDatabase,
  raw: Record<string, unknown>,
  selection: ImportCompletionSelection,
  scope: { pool: string; source: string },
  apply: boolean,
) {
  try {
    return await inLimitedTransaction(
      db,
      apply
        ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ"
        : "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      async () => {
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
        )
          throw refused([
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
          ]);
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
      },
    );
  } catch (outcome) {
    // A refusal rolls back like any error but is the operation's answer.
    if (outcome instanceof Response || outcome instanceof ReconcileIncomplete) return outcome;
    throw outcome;
  }
}

/**
 * Only the existing private operations entrypoint can approve a reconciled completion plan. A dry
 * run first advances stored reconciliation within its budget and answers 202 until every range is
 * stored, so a large source finishes across operator calls; a small one still plans in one call.
 * The plan's writes describe the completion record; dry runs do write reconciliation progress.
 */
export async function handleImportCompletion(
  request: Request,
  db: HistoryDatabase,
  options: { budgetMs?: number } = {},
): Promise<Response> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? reconcileBudgetMs;
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const raw = historyObject(await request.json()),
    selection = importCompletionSelection(raw.selection);
  const apply = raw.go === true;
  if (apply && !completionHash(raw.digest)) throw new HistoryInputError();
  const scope = await importCompletionScope(selection);
  const reconciling = (ranges: number) =>
    Response.json(
      { status: "reconciling", progressWrites: true, ranges, totalRanges: reconcileRanges },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  for (let attempt = 0; ; attempt++) {
    if (!apply) {
      const step = await reconcileStep(db, scope, budgetMs - (Date.now() - started));
      if (!step.complete || (step.computed && Date.now() - started >= budgetMs))
        return reconciling(step.ranges);
    }
    const outcome = await settle(db, raw, selection, scope, apply);
    if (!(outcome instanceof ReconcileIncomplete)) return outcome;
    if (outcome.ranges === 0) await resetReconcile(db, scope);
    // A small source that grew since its last plan reconciles again within the same call; a large
    // one answers 202 rather than spend a second fence inside the session deadline.
    if (!apply && attempt === 0 && Date.now() - started < budgetMs / 4) continue;
    if (!apply) return reconciling(0);
    return refused([
      {
        field: "reconciledRanges",
        comparison: "equal",
        expected: String(reconcileRanges),
        observed: String(outcome.ranges),
      },
    ]);
  }
}
