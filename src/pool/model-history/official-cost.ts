import type {
  OverviewApiPrice,
  OverviewMoneyMetric,
  OverviewUsageSlice,
} from "../../../apps/pool/overview-contract.ts";
import { digest } from "../backend-users.ts";
import type { HistoryDatabase } from "./schema.ts";
import { timestamp } from "./record.ts";
import { priceQuery } from "./overview-sql.ts";

export const officialPriceRows = (prices: readonly OverviewApiPrice[]) =>
  prices.map((price) => ({
    provider: price.provider,
    model: price.model,
    currency: price.currency,
    input: price.input,
    output: price.output,
    cache_read: price.cacheRead,
    cache_write: price.cacheWrite,
    request: price.request,
    tier: price.tier,
    min_input: price.minInput,
    as_of: price.asOf,
    source: price.source,
    version: price.version,
  }));

/** Pool ownership and optional person scope are established by the caller before this read. */
export async function officialCostTargets(
  db: HistoryDatabase,
  input: {
    pool: string;
    from: string;
    to: string;
    person?: string;
  },
) {
  const result = await db.query(
    `SELECT DISTINCT provider,model FROM basalt_model_requests
    WHERE pool=$1 AND source=$2 AND timestamp_exact >= $3 AND timestamp_exact < $4
      AND ($5::text IS NULL OR person=$5 AND attribution IS DISTINCT FROM 'import-owner') AND provider IS NOT NULL AND model IS NOT NULL
    ORDER BY provider,model LIMIT 101`,
    [
      (await digest(input.pool)).slice(0, 16),
      await digest("home-local-v1"),
      timestamp(input.from),
      timestamp(input.to),
      input.person ?? null,
    ],
  );
  return result.rows.length > 100
    ? {
        targets: [],
        unavailableReason:
          "More than 100 provider/model pairs need prices; money estimates are unavailable.",
      }
    : {
        targets: result.rows.map((row) => ({
          provider: String(row.provider),
          model: String(row.model),
        })),
      };
}

export interface OfficialCostRow {
  person: string | null;
  account: string | null;
  provider: string | null;
  model: string | null;
  app: string | null;
  requirement: string | null;
  day: string;
  requests: number;
  priced: number;
  missingTokens: number;
  missingPrices: number;
  cost: string | null;
}

/** Both USD surfaces use this request-token calculation and the same official price table. Credits are never selected. */
export async function officialCosts(
  db: HistoryDatabase,
  input: {
    pool: string;
    from: string;
    to: string;
    person?: string;
  },
  prices: readonly OverviewApiPrice[],
): Promise<OfficialCostRow[]> {
  const source = await digest("home-local-v1");
  const result = await db.query(
    `${priceQuery(false, true)}
    SELECT person,account,provider,model,app_id,requirement,left(timestamp_exact,10) AS day,
      count(*)::text AS requests,count(api_cost)::text AS priced,
      count(*) FILTER (WHERE price_version IS NULL)::text AS missing_prices,
      count(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL
        OR cache_read_tokens IS NULL OR cache_write_tokens IS NULL
        OR token_quality NOT IN ('complete','legacy'))::text AS missing_tokens,
      round(sum(api_cost),12)::text AS cost
    FROM priced WHERE $6::text[] IS NOT NULL AND ($9::text IS NULL OR person=$9 AND attribution IS DISTINCT FROM 'import-owner')
    GROUP BY person,account,provider,model,app_id,requirement,left(timestamp_exact,10)
    ORDER BY person,account,provider,model,app_id,requirement,day LIMIT 10001`,
    [
      (await digest(input.pool)).slice(0, 16),
      [source],
      "[]",
      timestamp(input.from),
      timestamp(input.to),
      [],
      JSON.stringify(officialPriceRows(prices)),
      source,
      input.person ?? null,
    ],
  );
  if (result.rows.length > 10000)
    throw new Error("Official cost dimensions exceed the bounded read");
  const text = (value: unknown) => (value === null ? null : String(value));
  const count = (value: unknown) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid cost count");
    return n;
  };
  return result.rows.map((row) => ({
    person: text(row.person),
    account: text(row.account),
    provider: text(row.provider),
    model: text(row.model),
    app: text(row.app_id),
    requirement: text(row.requirement),
    day: String(row.day),
    requests: count(row.requests),
    priced: count(row.priced),
    missingTokens: count(row.missing_tokens),
    missingPrices: count(row.missing_prices),
    cost: text(row.cost),
  }));
}

export function officialCostMetric(
  rows: readonly OfficialCostRow[],
  prices: readonly OverviewApiPrice[],
  unavailableReason?: string,
): OverviewMoneyMetric {
  const requests = rows.reduce((n, row) => n + row.requests, 0),
    priced = rows.reduce((n, row) => n + row.priced, 0);
  const missing = rows.reduce((n, row) => n + row.missingTokens, 0);
  const missingPrices = rows.reduce((n, row) => n + row.missingPrices, 0);
  const units = rows.reduce(
    (n, row) => n + (row.cost === null ? 0n : BigInt(row.cost.replace(".", ""))),
    0n,
  );
  const amount = `${units / 1000000000000n}.${(units % 1000000000000n).toString().padStart(12, "0")}`;
  const excluded = { unknownKind: 0, unknownKindValue: null, unpriced: requests - priced };
  if (requests > 0 && priced === 0)
    return {
      status: "unavailable",
      amount: null,
      currency: "USD",
      pricedRequests: 0,
      excluded,
      price: null,
      reason:
        missing === requests
          ? "Request token counts are missing or incomplete."
          : missingPrices === requests
            ? (unavailableReason ??
              "No known official USD price matches these models or service tiers.")
            : missingPrices === 0
              ? "Request tokens use an incomplete or unsupported accounting format."
              : "Requests lack a matching official USD price or usable token counts.",
    };
  const versions = [...new Set(prices.map((price) => price.version))].sort();
  return {
    status: "available",
    amount,
    currency: "USD",
    pricedRequests: priced,
    excluded,
    price: prices.length
      ? {
          source: "models.dev",
          version: versions.join(","),
          asOf: prices.map((price) => price.asOf).sort()[0]!,
        }
      : null,
  };
}

/** Cost slices share the same estimate as the headline; subscription classification stays independent. */
export function officialCostSlices(
  rows: readonly OfficialCostRow[],
  prices: readonly OverviewApiPrice[],
  people: readonly string[],
): OverviewUsageSlice[] {
  const groups = new Map<string, OfficialCostRow[]>();
  for (const row of rows) {
    const person = row.person !== null && people.includes(row.person) ? row.person : null;
    const key = JSON.stringify([person, row.provider, row.model]);
    groups.set(key, [...(groups.get(key) ?? []), { ...row, person }]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!,
      metric = officialCostMetric(group, prices);
    return {
      person: first.person,
      provider: first.provider,
      model: first.model,
      requests: group.reduce((n, row) => n + row.requests, 0),
      apiBilled: metric.amount,
      apiPricedRequests: metric.pricedRequests,
      apiUnpriced: metric.excluded.unpriced,
      subscriptionValue: null,
      subscriptionPricedRequests: 0,
      subscriptionUnpriced: 0,
      unknownKind: 0,
      unknownKindValue: null,
      price: metric.price,
    };
  });
}
