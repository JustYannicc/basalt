import { counterShapeSql } from "./counter-shape-sql.ts";

export const historyUsageRollupVersion = "model_request_history_v15_usage_rollup";

/** Advisory lock class for one pool's rollup; unused by any other lock in this database. */
export const usageRollupLockClass = 1415;

/**
 * Every context-input threshold a shipped public price uses. A request's band is the largest of them
 * not above its context input, so any price whose tiers fall on these values selects the same rate
 * from the band as from the request. A price tier outside them makes that pair's estimate unavailable.
 */
export const usageRollupBands = [
  0, 32001, 32002, 100001, 100002, 128001, 128002, 200001, 200002, 256001, 256002, 262145, 272001,
  272002, 512001, 524289,
] as const;

const band = `CASE ${[...usageRollupBands]
  .reverse()
  .map((value) => `WHEN context.context_input >= ${value} THEN ${value}`)
  .join(" ")} ELSE 0 END`;

/** The columns a group is keyed by; every one of them is a value some summary aggregate filters on. */
export const usageRollupKeys = [
  "pool",
  "hour",
  "source",
  "account",
  "attribution",
  "provider",
  "model",
  "service_tier",
  "api_type",
  "token_quality",
  "failed",
  "limited",
  "cost_basis",
  "currency",
  "has_snapshot",
  "has_version",
  "separate_cache",
  "price_class",
  "context_band",
] as const;

const tokens = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "total_tokens",
] as const;

/** One row per group: the counts and sums the summary's statements read, never a request's identity. */
const values = [
  ["requests", "bigint NOT NULL", "count(*)", "t.requests+EXCLUDED.requests"],
  ...tokens.flatMap((column) => [
    [
      `${column}_sum`,
      "numeric",
      `sum(s.${column})`,
      `basalt_numeric_sum(t.${column}_sum,EXCLUDED.${column}_sum)`,
    ],
    [
      `${column}_known`,
      "bigint NOT NULL",
      `count(s.${column})`,
      `t.${column}_known+EXCLUDED.${column}_known`,
    ],
  ]),
  ["cost_sum", "numeric", "sum(s.cost)", "basalt_numeric_sum(t.cost_sum,EXCLUDED.cost_sum)"],
  [
    "context_input_sum",
    "numeric",
    "sum(context.context_input)",
    "basalt_numeric_sum(t.context_input_sum,EXCLUDED.context_input_sum)",
  ],
  [
    "output_total_sum",
    "numeric",
    "sum(output.output_total)",
    "basalt_numeric_sum(t.output_total_sum,EXCLUDED.output_total_sum)",
  ],
  [
    "uncached_input_sum",
    "numeric",
    "sum(GREATEST(s.input_tokens::numeric-s.cache_read_tokens::numeric,0))",
    "basalt_numeric_sum(t.uncached_input_sum,EXCLUDED.uncached_input_sum)",
  ],
  [
    "unwritten_input_sum",
    "numeric",
    "sum(GREATEST(s.input_tokens::numeric-s.cache_read_tokens::numeric-s.cache_write_tokens::numeric,0))",
    "basalt_numeric_sum(t.unwritten_input_sum,EXCLUDED.unwritten_input_sum)",
  ],
  [
    "first_at",
    "varchar(30) NOT NULL",
    "min(s.timestamp_exact)",
    "LEAST(t.first_at,EXCLUDED.first_at)",
  ],
  [
    "last_at",
    "varchar(30) NOT NULL",
    "max(s.timestamp_exact)",
    "GREATEST(t.last_at,EXCLUDED.last_at)",
  ],
  [
    "ingested_at",
    "timestamptz NOT NULL",
    "max(s.ingested_at)",
    "GREATEST(t.ingested_at,EXCLUDED.ingested_at)",
  ],
] as const;

/** The grouped projection of a set of request rows `s`; the trigger and the backfill share it. */
export function usageRollupProjection(rows: string) {
  const keyExpressions: Record<(typeof usageRollupKeys)[number], string> = {
    pool: "s.pool",
    hour: "date_trunc('hour',left(s.timestamp_exact,19)::timestamp) AT TIME ZONE 'UTC'",
    source: "s.source",
    account: "s.account",
    attribution: "s.attribution",
    provider: "s.provider",
    model: "s.model",
    service_tier: "s.service_tier",
    api_type: "s.api_type",
    token_quality: "s.token_quality",
    failed: "s.failed",
    limited: "coalesce(s.status_code=429,false)",
    cost_basis: "s.cost_basis",
    currency: "s.currency",
    has_snapshot: "s.price_snapshot IS NOT NULL",
    has_version: "s.price_version IS NOT NULL",
    separate_cache: "coalesce(shape.separate_cache,false)",
    price_class: `CASE WHEN s.input_tokens IS NULL OR s.output_tokens IS NULL
        OR s.cache_read_tokens IS NULL OR s.cache_write_tokens IS NULL
        OR s.token_quality NOT IN ('complete','legacy') THEN 'missing_tokens'
      WHEN s.token_quality='complete'
        AND s.input_tokens::numeric < s.cache_read_tokens::numeric+s.cache_write_tokens::numeric
        THEN 'inconsistent' ELSE 'priced' END`,
    context_band: `coalesce(${band},0)`,
  };
  return `SELECT ${usageRollupKeys.map((key) => `${keyExpressions[key]} AS ${key}`).join(",")},
      ${values.map(([name, , aggregate]) => `${aggregate} AS ${name}`).join(",")}
    FROM ${rows} s ${counterShapeSql}
    WHERE s.pool IS NOT NULL
    GROUP BY ${usageRollupKeys.map((_, index) => index + 1).join(",")}`;
}

/**
 * One lock per pool. A bulk insert can span thousands of hours, and a lock per hour would exhaust
 * the shared lock table; a recompute holds the pool's writers only for one day's recompute.
 */
const poolLock = (pool: string) => `${usageRollupLockClass}, hashtext(${pool})`;

const columns = [...usageRollupKeys, ...values.map(([name]) => name)].join(",");
const upsert = (rows: string) => `INSERT INTO basalt_model_usage_hourly AS t (${columns})
  ${usageRollupProjection(rows)}
  ON CONFLICT (${usageRollupKeys.join(",")}) DO UPDATE SET
    ${values.map(([name, , , merge]) => `${name}=${merge}`).join(",")}`;

export const historyUsageRollupStatements = [
  `CREATE FUNCTION basalt_numeric_sum(a numeric, b numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a ELSE a+b END
  $$`,
  `CREATE TABLE basalt_model_usage_hourly (
    pool varchar(16) NOT NULL, hour timestamptz NOT NULL, source char(64) NOT NULL,
    account char(64), attribution varchar(32) NOT NULL, provider varchar(256), model varchar(256),
    service_tier varchar(256), api_type varchar(64), token_quality varchar(16) NOT NULL,
    failed boolean NOT NULL, limited boolean NOT NULL, cost_basis varchar(32) NOT NULL,
    currency varchar(16), has_snapshot boolean NOT NULL, has_version boolean NOT NULL,
    separate_cache boolean NOT NULL, price_class varchar(16) NOT NULL, context_band bigint NOT NULL,
    ${values.map(([name, type]) => `${name} ${type}`).join(",\n    ")},
    CONSTRAINT basalt_model_usage_hourly_key UNIQUE NULLS NOT DISTINCT (${usageRollupKeys.join(",")})
  )`,
  `CREATE INDEX basalt_model_usage_hourly_pool_hour ON basalt_model_usage_hourly (pool, hour)`,
  // Which of a pool's hours a backfill has recomputed from the base rows; reads use the rollup only
  // for a pool whose backfill finished.
  `CREATE TABLE basalt_model_usage_hours (
    pool varchar(16) NOT NULL, hour timestamptz NOT NULL,
    recomputed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (pool, hour))`,
  `CREATE TABLE basalt_model_usage_ready (
    pool varchar(16) PRIMARY KEY, through timestamptz NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  // A shared lock per pool, taken in key order, lets a backfill recompute a pool's day exclusively.
  `CREATE FUNCTION basalt_model_usage_rollup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock_shared(${poolLock("k.pool")})
        FROM (SELECT DISTINCT s.pool FROM inserted s WHERE s.pool IS NOT NULL ORDER BY 1) k;
      ${upsert("inserted")};
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'basalt_usage_rollup: %', SQLERRM USING ERRCODE = SQLSTATE;
    END $$`,
  // Replaces one pool's hours [from_hour, to_hour) with the aggregate of their base rows. It waits for
  // writers already inside those hours, holds new ones until it commits, and is safe to repeat.
  `CREATE FUNCTION basalt_model_usage_recompute(target_pool varchar, from_hour timestamptz,
      to_hour timestamptz) RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE written bigint; BEGIN
      IF from_hour <> date_trunc('hour',from_hour) OR to_hour <> date_trunc('hour',to_hour)
        OR to_hour <= from_hour OR to_hour - from_hour > interval '48 hours' THEN
        RAISE EXCEPTION 'basalt_usage_rollup: recompute takes whole hours, at most 48'
          USING ERRCODE = '22023';
      END IF;
      PERFORM pg_advisory_xact_lock(${poolLock("target_pool")});
      DELETE FROM basalt_model_usage_hourly
        WHERE pool=target_pool AND hour >= from_hour AND hour < to_hour;
      ${upsert(`(SELECT * FROM basalt_model_requests r WHERE r.pool=target_pool
        AND r.timestamp >= from_hour - interval '1 second' AND r.timestamp < to_hour + interval '1 second'
        AND date_trunc('hour',left(r.timestamp_exact,19)::timestamp) AT TIME ZONE 'UTC' >= from_hour
        AND date_trunc('hour',left(r.timestamp_exact,19)::timestamp) AT TIME ZONE 'UTC' < to_hour)`)};
      GET DIAGNOSTICS written = ROW_COUNT;
      INSERT INTO basalt_model_usage_hours AS d (pool,hour)
        SELECT target_pool,h.at FROM generate_series(from_hour, to_hour - interval '1 hour',
          interval '1 hour') AS h(at)
        ON CONFLICT (pool,hour) DO UPDATE SET recomputed_at=CURRENT_TIMESTAMP;
      RETURN written;
    END $$`,
  `CREATE TRIGGER basalt_model_usage_rollup AFTER INSERT ON basalt_model_requests
    REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT
    EXECUTE FUNCTION basalt_model_usage_rollup()`,
];
