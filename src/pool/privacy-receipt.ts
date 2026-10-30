import type pg from "pg";

// Schema12's durable receipt is independent of stdout and Home's maintenance lifecycle.
const receiptSql = `SELECT
  m.completed,
  m.audit_marker_emitted,
  a.rows_scanned AS usage_rows,
  m.usage_rows_updated AS purged_rows,
  a.active_api_key_count AS active_key_count,
  a.matched_active_api_key_copies AS matched_active_key_copies,
  a.deleted_api_key_count AS deleted_key_count,
  a.unknown_key_count AS unknown_key_count
FROM home_data_migration m
LEFT JOIN home_data_migration_audit a ON a.name = m.name
WHERE m.name = 'diagnostics_metadata_only_v1_1_6'`;

const countFields = [
  "usage_rows", "purged_rows", "active_key_count", "matched_active_key_copies",
  "deleted_key_count", "unknown_key_count",
] as const;

function count(value: unknown): number {
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid inventory count");
  }
  return parsed;
}

export async function privacyReceipt(client: Pick<pg.Client, "query">) {
  const { rows } = await client.query<Record<string, unknown>>(receiptSql);
  if (rows.length === 0) return { state: "missing_migration" as const };
  const row = rows[0];
  if (rows.length !== 1 || typeof row?.completed !== "boolean" || typeof row.audit_marker_emitted !== "boolean") {
    throw new Error("Invalid inventory receipt");
  }
  const booleans = { completed: row.completed, audit_marker_emitted: row.audit_marker_emitted };
  if (row.usage_rows === null) {
    if (countFields.some((field) => field !== "purged_rows" && row[field] !== null)) {
      throw new Error("Invalid inventory receipt");
    }
    return { state: "missing_audit" as const, ...booleans, purged_rows: count(row.purged_rows) };
  }
  const counts = Object.fromEntries(countFields.map((field) => [field, count(row[field])]));
  return {
    state: row.completed && row.audit_marker_emitted ? "complete" as const : "incomplete" as const,
    ...booleans,
    ...counts,
  };
}
