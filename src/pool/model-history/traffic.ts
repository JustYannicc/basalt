import { digest } from "../backend-users.ts";
import { HistoryInputError, historyObject } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";

export const historyTrafficPath = "/model-history/traffic";
export interface TrafficSelection {
  pool: string;
  purpose: "real" | "proof";
  evidence: string;
  keys: { source: string; clientKey: string }[];
}
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function trafficSelection(raw: unknown): Promise<TrafficSelection> {
  const value = historyObject(raw);
  if (
    typeof value.pool !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,511}$/.test(value.pool) ||
    (value.purpose !== "real" && value.purpose !== "proof") ||
    !hash(value.evidence) ||
    !Array.isArray(value.keys) ||
    !value.keys.length ||
    value.keys.length > 50
  )
    throw new HistoryInputError();
  const sources = await Promise.all([digest("home-local-v1"), digest("pool-gateway-v1")]);
  const keys = value.keys
    .map((raw) => {
      const key = historyObject(raw);
      if (!hash(key.source) || !sources.includes(key.source) || !hash(key.clientKey))
        throw new HistoryInputError();
      return { source: key.source, clientKey: key.clientKey };
    })
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) || left.clientKey.localeCompare(right.clientKey),
    );
  if (new Set(keys.map((key) => `${key.source}:${key.clientKey}`)).size !== keys.length)
    throw new HistoryInputError();
  return { pool: value.pool, purpose: value.purpose, evidence: value.evidence, keys };
}

/** The private plan names every affected immutable row. It never reads keys, labels or payloads. */
export async function planTraffic(db: HistoryDatabase, selection: TrafficSelection) {
  const pool = (await digest(selection.pool)).slice(0, 16);
  const keys = JSON.stringify(selection.keys);
  const current = (
    await db.query(
      `SELECT t.source,t.client_key AS "clientKey",t.purpose,t.evidence
    FROM basalt_model_traffic t JOIN jsonb_to_recordset($2::jsonb) AS k(source text,"clientKey" text)
      ON t.source=k.source AND t.client_key=k."clientKey"
    WHERE t.pool=$1 ORDER BY t.source,t.client_key`,
      [pool, keys],
    )
  ).rows;
  const records = (
    await db.query(
      `SELECT r.id,r.source,r.client_key AS "clientKey",r.timestamp_exact AS at,
      r.failed,r.status_code AS status,r.account IS NULL AS unassigned
    FROM basalt_model_requests r JOIN jsonb_to_recordset($2::jsonb) AS k(source text,"clientKey" text)
      ON r.source=k.source AND r.client_key=k."clientKey"
    WHERE r.pool=$1 ORDER BY r.id LIMIT 5001`,
      [pool, keys],
    )
  ).rows;
  if (records.length > 5000) throw new HistoryInputError();
  const plan = { selection, current, records };
  return {
    status: "dry-run" as const,
    writes: false,
    ...plan,
    digest: await digest(JSON.stringify(plan)),
  };
}

/** Callers hold the existing private operations boundary; no app or browser can tag its traffic. */
export async function handleTrafficOperation(
  request: Request,
  db: HistoryDatabase,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const raw = historyObject(await request.json());
  const selection = await trafficSelection(raw.selection);
  const apply = raw.go === true;
  if (apply && !hash(raw.digest)) throw new HistoryInputError();
  await db.query(apply ? "BEGIN" : "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    if (apply) await db.query("SELECT pg_advisory_xact_lock(1409, 20)");
    const plan = await planTraffic(db, selection);
    if (apply && plan.digest !== raw.digest) {
      await db.query("ROLLBACK");
      return Response.json(
        {
          error: "traffic_plan_changed",
          message: "The selected records or classification changed. Review a fresh dry run.",
        },
        { status: 409 },
      );
    }
    if (apply) {
      const pool = (await digest(selection.pool)).slice(0, 16);
      await db.query(
        `INSERT INTO basalt_model_traffic (pool,source,client_key,purpose,evidence)
        SELECT $1,k.source,k."clientKey",$3,$4 FROM jsonb_to_recordset($2::jsonb) AS k(source text,"clientKey" text)
        ON CONFLICT (pool,source,client_key) DO UPDATE SET purpose=EXCLUDED.purpose,
          evidence=EXCLUDED.evidence,changed_at=CURRENT_TIMESTAMP`,
        [pool, JSON.stringify(selection.keys), selection.purpose, selection.evidence],
      );
    }
    await db.query("COMMIT");
    return Response.json(
      apply
        ? {
            status: "complete",
            digest: plan.digest,
            keys: selection.keys.length,
            records: plan.records.length,
            purpose: selection.purpose,
          }
        : plan,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
