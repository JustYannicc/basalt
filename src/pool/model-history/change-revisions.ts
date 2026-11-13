import type { HistoryDatabase } from "./schema.ts";

export type PoolHistoryTopic = "pool-readings" | "pool-usage";
export interface RevisionHint {
  topic: PoolHistoryTopic;
  resource: string;
  revision: string;
}
export interface PoolHistoryChange {
  scope: `pool:${string}`;
  hint: RevisionHint;
}

const poolId = (value: unknown): value is string =>
  typeof value === "string" && /^app_[\s\S]+$/.test(value) && value.length <= 256;

function hint(row: Record<string, unknown>): RevisionHint {
  if (
    !poolId(row.pool) ||
    (row.topic !== "pool-readings" && row.topic !== "pool-usage") ||
    typeof row.revision !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(row.revision)
  )
    throw new Error("Invalid pool change revision");
  return { topic: row.topic, resource: row.pool, revision: row.revision };
}

/** This expression belongs in capture's existing cursor read, including its inactive case. */
export const poolHistoryPendingProjection = `COALESCE((SELECT jsonb_agg(pending)
  FROM (SELECT pool,topic,revision::text FROM basalt_pool_change_pending
    ORDER BY queued_at,pool,topic LIMIT 100) pending), '[]'::jsonb)`;

export function pendingPoolHistoryChanges(value: unknown): PoolHistoryChange[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid pending pool changes");
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("Invalid pending pool change");
    const current = hint(row as Record<string, unknown>);
    return { scope: `pool:${current.resource}`, hint: current };
  });
}

function currentPoolHistoryQuery(snapshot: boolean) {
  return `WITH registered AS (
      INSERT INTO basalt_pool_change_heads(pool,topic,revision)
      VALUES($1,'pool-readings',0),($1,'pool-usage',0)
      ON CONFLICT(pool,topic) DO NOTHING RETURNING pool,topic,revision
    )${snapshot ? ",deadline AS MATERIALIZED (SELECT basalt_pool_change_deadline($1) AS at)" : ""}
    SELECT $1::text AS pool,t.topic,COALESCE(h.revision,r.revision,0)::text AS revision
    ${
      snapshot
        ? `,(SELECT to_char(at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM deadline) AS deadline`
        : ""
    }
    FROM (VALUES ('pool-readings'),('pool-usage')) AS t(topic)
    LEFT JOIN basalt_pool_change_heads h ON h.pool=$1 AND h.topic=t.topic
    LEFT JOIN registered r ON r.pool=$1 AND r.topic=t.topic
    ORDER BY t.topic`;
}

/** The host authorizes this actual app ID before registering its durable hash mapping. */
export async function readPoolHistoryChanges(
  db: HistoryDatabase,
  pool: string,
): Promise<RevisionHint[]> {
  if (!poolId(pool)) throw new Error("Invalid pool ID");
  const result = await db.query(currentPoolHistoryQuery(false), [pool]);
  return result.rows.map(hint);
}

/** One current-read snapshot; the deadline changes no source observation or reset timestamp. */
export async function readPoolHistorySnapshot(db: HistoryDatabase, pool: string) {
  if (!poolId(pool)) throw new Error("Invalid pool ID");
  const result = await db.query(currentPoolHistoryQuery(true), [pool]);
  const deadline = result.rows[0]?.deadline;
  if (deadline !== null && (typeof deadline !== "string" || !Number.isFinite(Date.parse(deadline))))
    throw new Error("Invalid pool change deadline");
  return { revisions: result.rows.map(hint), deadline };
}

/** Publish only after capture commits. Network I/O holds no transaction or row locks. */
export async function deliverPoolHistoryChanges(
  db: HistoryDatabase,
  pending: readonly PoolHistoryChange[],
  publish: (changes: readonly PoolHistoryChange[]) => Promise<void>,
): Promise<void> {
  if (pending.length > 100) throw new Error("Pool change delivery batch exceeds its limit");
  const changes = pending.map((change) => {
    const current = hint({ pool: change.hint.resource, ...change.hint });
    if (change.scope !== `pool:${current.resource}` || current.revision === "0")
      throw new Error("Invalid pending pool change");
    return { scope: change.scope, hint: current };
  });
  if (!changes.length) return;
  await publish(changes);
  const delivered = changes.map(({ hint }) => ({
    pool: hint.resource,
    topic: hint.topic,
    revision: hint.revision,
  }));
  await db.query(
    `DELETE FROM basalt_pool_change_pending p USING jsonb_to_recordset($1::jsonb)
        AS sent(pool text,topic text,revision text)
      WHERE p.pool=sent.pool AND p.topic=sent.topic AND p.revision=sent.revision::bigint`,
    [JSON.stringify(delivered)],
  );
}
