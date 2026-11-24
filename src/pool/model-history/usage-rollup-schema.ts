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

/** Every column a rollup may be keyed by: the v15 keys, and the person and app a wider rollup adds. */
export type UsageRollupKey = (typeof usageRollupKeys)[number] | "person" | "app_id";

/** The grouped projection of a set of request rows `s`; the trigger and the backfill share it. */
export function usageRollupProjection(
  rows: string,
  keys: readonly UsageRollupKey[] = usageRollupKeys,
) {
  const keyExpressions: Record<UsageRollupKey, string> = {
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
    price_class: `CASE WHEN s.input_tokens IS NULL OR s.output_tokens IS NULL
        OR s.cache_read_tokens IS NULL OR s.cache_write_tokens IS NULL
        OR s.token_quality NOT IN ('complete','legacy') THEN 'missing_tokens'
      WHEN s.token_quality='complete'
        AND s.input_tokens::numeric < s.cache_read_tokens::numeric+s.cache_write_tokens::numeric
        THEN 'inconsistent' ELSE 'priced' END`,
    context_band: `coalesce(${band},0)`,
    person: "s.person",
    // A request table at the base schema has no app column; see `app` below.
    app_id: "app_row.app_id",
  };
  // The app by name: inside `app_row`, a bare app_id is the row's own column where the table has
  // one, and otherwise resolves outward to `app_none`'s NULL, so a row at the base schema keys as a
  // row whose app is unknown and the trigger runs there as v15's does. Only rollups keyed by app
  // join it.
  const app = keys.includes("app_id")
    ? ` CROSS JOIN (SELECT NULL::varchar(256) AS app_id) app_none
      CROSS JOIN LATERAL (SELECT app_id FROM (SELECT s.*) z) app_row`
    : "";
  return `SELECT ${keys.map((key) => `${keyExpressions[key]} AS ${key}`).join(",")},
      ${values.map(([name, , aggregate]) => `${aggregate} AS ${name}`).join(",")}
    FROM ${rows} s${app} ${counterShapeSql}
    WHERE s.pool IS NOT NULL
    GROUP BY ${keys.map((_, index) => index + 1).join(",")}`;
}

/**
 * One pool's base rows whose exact time falls in [from, to), as the recompute reads them: the
 * indexed time narrows the scan, the exact time decides the hour. The v16 apply's read passes the
 * same bounds, so it aggregates exactly the rows a recompute of that hour would.
 */
export const usageRollupBaseRows = (pool: string, from: string, to: string) =>
  `(SELECT * FROM basalt_model_requests r WHERE r.pool=${pool}
        AND r.timestamp >= ${from} - interval '1 second' AND r.timestamp < ${to} + interval '1 second'
        AND date_trunc('hour',left(r.timestamp_exact,19)::timestamp) AT TIME ZONE 'UTC' >= ${from}
        AND date_trunc('hour',left(r.timestamp_exact,19)::timestamp) AT TIME ZONE 'UTC' < ${to})`;

/**
 * One lock per pool. A bulk insert can span thousands of hours, and a lock per hour would exhaust
 * the shared lock table; a recompute holds the pool's writers only for one hour's recompute.
 */
const poolLock = (pool: string) => `${usageRollupLockClass}, hashtext(${pool})`;

/** The names one rollup's objects take; each rollup has its own, and shares the pool's lock. */
export interface UsageRollupNames {
  readonly hourly: string;
  readonly hours: string;
  readonly ready: string;
  /** The trigger and its function. */
  readonly rollup: string;
  readonly recompute: string;
  /** The apply function, for a rollup whose backfill writes an hour it read outside the lock. */
  readonly apply?: string;
}

/**
 * Writes one pool-hour's aggregate that the backfill read outside the lock, if nothing landed in
 * that hour since: it compares the trigger-kept request count with the count the read saw in the
 * same snapshot as its rows. Equal, it replaces the hour's groups with `rows` and marks the hour;
 * different, it changes nothing and returns -1, so the backfill reads again. NULL means another
 * session holds the pool: it takes the pool's lock with a try-lock, so it never queues.
 *
 * Why an equal count means the read is still exact. Request rows are append only: the
 * no_rewrite and no_truncate triggers refuse UPDATE, DELETE and TRUNCATE, and no code path does
 * either (those triggers do not fire in replica mode, which only an import's insert uses). Every
 * insert into the request table, COPY and ON CONFLICT DO NOTHING included, runs this rollup's
 * statement trigger, enabled ALWAYS so replica mode too, which upserts exactly the statement's
 * inserted rows, grouped by the same projection that keys the read's rows, under the pool's
 * shared lock held until its transaction ends; nothing writes a partition directly, which would
 * skip it. Each row adds at least one request to its hour's groups. So, between the read's snapshot and this
 * function's count, the hour's count moves exactly when a transaction committed rows into that
 * hour, or when a recompute or apply rewrote it, which raises the count to the base rows' own
 * whenever the read saw it short. Holding the pool exclusively, no insert's trigger has upserted
 * without committing; one whose rows are in the table but whose trigger waits for the lock was
 * not committed at the read either, so its rows are in neither, and its trigger merges them on
 * top once this commits.
 */
const applyStatement = (names: UsageRollupNames & { readonly apply: string }) =>
  `CREATE FUNCTION ${names.apply}(target_pool varchar, at_hour timestamptz, seen bigint,
      rows jsonb) RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE written bigint; BEGIN
      IF at_hour IS NULL OR at_hour <> date_trunc('hour',at_hour,'UTC') OR seen IS NULL
        OR rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN
        RAISE EXCEPTION 'basalt_usage_rollup: apply takes one whole hour, its count and its rows'
          USING ERRCODE = '22023';
      END IF;
      IF NOT pg_try_advisory_xact_lock(${poolLock("target_pool")}) THEN RETURN NULL; END IF;
      IF (SELECT coalesce(sum(h.requests),0) FROM ${names.hourly} h
        WHERE h.pool=target_pool AND h.hour=at_hour) IS DISTINCT FROM seen THEN
        RETURN -1;
      END IF;
      DELETE FROM ${names.hourly} WHERE pool=target_pool AND hour=at_hour;
      INSERT INTO ${names.hourly} SELECT g.* FROM jsonb_populate_recordset(NULL::${names.hourly}, rows) g
        WHERE g.pool=target_pool AND g.hour=at_hour;
      GET DIAGNOSTICS written = ROW_COUNT;
      IF written <> jsonb_array_length(rows) THEN
        RAISE EXCEPTION 'basalt_usage_rollup: apply rows must all be its own pool-hour'
          USING ERRCODE = '22023';
      END IF;
      INSERT INTO ${names.hours} AS d (pool,hour) VALUES (target_pool,at_hour)
        ON CONFLICT (pool,hour) DO UPDATE SET recomputed_at=CURRENT_TIMESTAMP;
      RETURN written;
    END $$`;

/**
 * One rollup's tables, trigger function, recompute function and trigger, keyed by `keys`, whose
 * columns past the v15 keys `extraColumns` declares. The trigger comes last, so the statements
 * before it never hold the request table.
 */
export function usageRollupStatements(
  names: UsageRollupNames,
  keys: readonly UsageRollupKey[],
  extraColumns = "",
) {
  const columns = [...keys, ...values.map(([name]) => name)].join(",");
  const upsert = (rows: string) => `INSERT INTO ${names.hourly} AS t (${columns})
  ${usageRollupProjection(rows, keys)}
  ON CONFLICT (${keys.join(",")}) DO UPDATE SET
    ${values.map(([name, , , merge]) => `${name}=${merge}`).join(",")}`;
  return [
    `CREATE TABLE ${names.hourly} (
    pool varchar(16) NOT NULL, hour timestamptz NOT NULL, source char(64) NOT NULL,
    account char(64), attribution varchar(32) NOT NULL, provider varchar(256), model varchar(256),
    service_tier varchar(256), api_type varchar(64), token_quality varchar(16) NOT NULL,
    failed boolean NOT NULL, limited boolean NOT NULL, cost_basis varchar(32) NOT NULL,
    currency varchar(16), has_snapshot boolean NOT NULL, has_version boolean NOT NULL,
    price_class varchar(16) NOT NULL, context_band bigint NOT NULL,${extraColumns}
    ${values.map(([name, type]) => `${name} ${type}`).join(",\n    ")},
    CONSTRAINT ${names.hourly}_key UNIQUE NULLS NOT DISTINCT (${keys.join(",")})
  )`,
    `CREATE INDEX ${names.hourly}_pool_hour ON ${names.hourly} (pool, hour)`,
    // Which of a pool's hours a backfill has recomputed from the base rows; reads use the rollup only
    // for a pool whose backfill finished.
    `CREATE TABLE ${names.hours} (
    pool varchar(16) NOT NULL, hour timestamptz NOT NULL,
    recomputed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (pool, hour))`,
    `CREATE TABLE ${names.ready} (
    pool varchar(16) PRIMARY KEY, through timestamptz NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    // A shared lock per pool, taken in key order, lets a backfill recompute a pool's hour exclusively.
    `CREATE FUNCTION ${names.rollup}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock_shared(${poolLock("k.pool")})
        FROM (SELECT DISTINCT s.pool FROM inserted s WHERE s.pool IS NOT NULL ORDER BY 1) k;
      ${upsert("inserted")};
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'basalt_usage_rollup: %', SQLERRM USING ERRCODE = SQLSTATE;
    END $$`,
    // Replaces one pool's hours [from_hour, to_hour) with the aggregate of their base rows. It waits for
    // writers already inside those hours, holds new ones until it commits, and is safe to repeat.
    `CREATE FUNCTION ${names.recompute}(target_pool varchar, from_hour timestamptz,
      to_hour timestamptz) RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE written bigint; BEGIN
      IF from_hour <> date_trunc('hour',from_hour,'UTC') OR to_hour <> date_trunc('hour',to_hour,'UTC')
        OR to_hour <= from_hour OR to_hour - from_hour > interval '48 hours' THEN
        RAISE EXCEPTION 'basalt_usage_rollup: recompute takes whole hours, at most 48'
          USING ERRCODE = '22023';
      END IF;
      PERFORM pg_advisory_xact_lock(${poolLock("target_pool")});
      DELETE FROM ${names.hourly}
        WHERE pool=target_pool AND hour >= from_hour AND hour < to_hour;
      ${upsert(usageRollupBaseRows("target_pool", "from_hour", "to_hour"))};
      GET DIAGNOSTICS written = ROW_COUNT;
      INSERT INTO ${names.hours} AS d (pool,hour)
        SELECT target_pool,h.at FROM generate_series(from_hour, to_hour - interval '1 hour',
          interval '1 hour') AS h(at)
        ON CONFLICT (pool,hour) DO UPDATE SET recomputed_at=CURRENT_TIMESTAMP;
      RETURN written;
    END $$`,
    ...(names.apply ? [applyStatement({ ...names, apply: names.apply })] : []),
    `CREATE TRIGGER ${names.rollup} AFTER INSERT ON basalt_model_requests
    REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT
    EXECUTE FUNCTION ${names.rollup}()`,
    // An import may write with session_replication_role = replica to skip the change journal; the
    // rollup must still see those rows, or a ready pool's summary would undercount for good.
    `ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER ${names.rollup}`,
  ];
}

export const usageRollupNames: UsageRollupNames = {
  hourly: "basalt_model_usage_hourly",
  hours: "basalt_model_usage_hours",
  ready: "basalt_model_usage_ready",
  rollup: "basalt_model_usage_rollup",
  recompute: "basalt_model_usage_recompute",
};

export const historyUsageRollupStatements = [
  `CREATE FUNCTION basalt_numeric_sum(a numeric, b numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a ELSE a+b END
  $$`,
  ...usageRollupStatements(usageRollupNames, usageRollupKeys),
];
