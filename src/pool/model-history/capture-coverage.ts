import { brand } from "../../../brand.ts";
import type { HistoryDatabase } from "./schema.ts";

export interface HomeCaptureCoverage {
  readonly capturedAt: string | null;
  readonly incompleteHours: ReadonlySet<string> | null;
}

/** Reconcile the source to this pool's ledger in the caller's repeatable-read snapshot. */
export async function homeCaptureCoverage(
  db: HistoryDatabase,
  poolHash: string,
  homeSourceHash: string,
  from: string,
  to: string,
): Promise<HomeCaptureCoverage> {
  const schema =
    await db.query(`SELECT to_regclass('usage') AS usage,to_regclass('billing_charge') AS charge,
    to_regclass('api_key') AS api_key,to_regclass('user') AS users,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at`);
  const available = schema.rows[0];
  const value = available?.captured_at;
  if (value !== null && value !== undefined && typeof value !== "string")
    throw new Error("Invalid capture time");
  const capturedAt = value ?? null;
  if (!available?.usage || !available.charge || !available.api_key || !available.users)
    return { capturedAt, incompleteHours: null };
  const setupId = brand.setup.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const username = `^${setupId}-[0-9a-f]{64}-${poolHash}$`;
  const missing = await db.query(
    `SELECT DISTINCT to_char(date_trunc('hour',u.timestamp AT TIME ZONE 'UTC'),
      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour
    FROM usage u
    LEFT JOIN billing_charge c ON c.usage_id=u.id
    LEFT JOIN api_key k ON k.diagnostic_fingerprint=u.api_key AND u.api_key ~ '^sha256:[0-9a-f]{64}$'
    LEFT JOIN "user" a ON a.id=COALESCE(c.user_id,k.user_id)
    WHERE a.username ~ $1 AND u.timestamp >= $2::timestamptz AND u.timestamp < $3::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM basalt_model_requests r
        WHERE r.pool=$4 AND r.source=$5
          AND r.source_record=encode(sha256(convert_to('["usage","'||u.id::text||'"]','UTF8')),'hex')
      )
    ORDER BY hour LIMIT 800`,
    [username, from, to, poolHash, homeSourceHash],
  );
  if (missing.rows.length >= 800) return { capturedAt, incompleteHours: null };
  return { capturedAt, incompleteHours: new Set(missing.rows.map((row) => String(row.hour))) };
}
