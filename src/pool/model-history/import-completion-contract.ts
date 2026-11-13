import { digest } from "../backend-users.ts";
import { counter, historyObject, invalidHistory, timestamp } from "./record.ts";

export const historyImportCompletionPath = "/model-history/import-completion";
export interface ImportCompletionSelection {
  pool: string;
  source: string;
  frozenFrom: string;
  frozenTo: string;
  afterSourceId: string;
  upperSourceId: string;
  manifestDigest: string;
  accountMappingDigest: string;
  idsDigest: string;
  verifiedRows: string;
}
export const completionHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function importCompletionSelection(raw: unknown): ImportCompletionSelection {
  const value = historyObject(raw);
  const after = counter(value.afterSourceId),
    upper = counter(value.upperSourceId),
    rows = counter(value.verifiedRows);
  if (
    typeof value.pool !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,511}$/.test(value.pool) ||
    typeof value.source !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.source) ||
    after === null ||
    upper === null ||
    rows === null ||
    BigInt(upper) <= BigInt(after) ||
    BigInt(rows) < 1n ||
    !completionHash(value.manifestDigest) ||
    !completionHash(value.accountMappingDigest) ||
    !completionHash(value.idsDigest)
  )
    return invalidHistory();
  const frozenFrom = timestamp(value.frozenFrom),
    frozenTo = timestamp(value.frozenTo);
  if (frozenFrom > frozenTo) return invalidHistory();
  return {
    pool: value.pool,
    source: value.source,
    frozenFrom,
    frozenTo,
    afterSourceId: after,
    upperSourceId: upper,
    verifiedRows: rows,
    manifestDigest: value.manifestDigest,
    accountMappingDigest: value.accountMappingDigest,
    idsDigest: value.idsDigest,
  };
}
export async function importCompletionScope(
  selection: Pick<ImportCompletionSelection, "pool" | "source">,
) {
  return {
    pool: (await digest(selection.pool)).slice(0, 16),
    source: await digest(JSON.stringify(["usage-import-v1", selection.pool, selection.source])),
  };
}

const differenceFields = [
  "verifiedRows",
  "idsDigest",
  "frozenFrom",
  "frozenTo",
  "afterSourceId",
  "upperSourceId",
  "planDigest",
] as const;
export interface CompletionDifference {
  field: (typeof differenceFields)[number];
  comparison: "equal" | "greater-than" | "at-most" | "at-least";
  expected: string | null;
  observed: string | null;
}
/** A closed diagnostic vocabulary keeps backend text and connection details out of operator errors. */
export function completionRefusal(raw: unknown): string {
  const value = historyObject(raw);
  if (
    value.error !== "import_completion_refused" ||
    !Array.isArray(value.differences) ||
    !value.differences.length ||
    value.differences.length > 16
  )
    return invalidHistory();
  const scalar = (v: unknown) =>
    v === null ||
    (typeof v === "string" && /^(?:[a-f0-9]{64}|[0-9]{1,20}|[0-9TZ:.+-]{20,30})$/.test(v));
  return value.differences
    .map((raw) => {
      const item = historyObject(raw);
      if (
        !differenceFields.includes(item.field as CompletionDifference["field"]) ||
        !["equal", "greater-than", "at-most", "at-least"].includes(String(item.comparison)) ||
        !scalar(item.expected) ||
        !scalar(item.observed)
      )
        return invalidHistory();
      return `${item.field} must be ${item.comparison} ${item.expected}; observed ${item.observed}`;
    })
    .join("; ");
}
