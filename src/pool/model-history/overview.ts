import type {
  OverviewApiPrice,
  OverviewMoneyMetric,
  PoolOverviewDirectory,
  PoolOverviewDirectoryInput,
  PoolOverviewInput,
  PoolOverviewResult,
  PoolOverviewSignedInput,
  PoolPersonalOverviewResult,
  PoolPersonalOverviewSignedInput,
} from "../../../apps/pool/overview-contract.ts";
import type { SeriesAuthority } from "./series-contract.ts";
import { digest } from "../backend-users.ts";
import type { HistoryDatabase } from "./schema.ts";
import { poolPersonalUsageSeries, poolUsageSeries } from "./series.ts";
import type {
  PoolUsageSeriesInput,
  PoolUsageSeriesResult,
  SeriesGroup,
} from "./series-contract.ts";
import { seriesAuthority, seriesInput } from "./series-input.ts";
import { requestCount } from "./series-coverage.ts";
import { HistoryInputError, historyObject, timestamp } from "./record.ts";
import { brand } from "../../../brand.ts";
import { homeAccountMappingProven } from "./series-mapping.ts";
import {
  officialCosts,
  officialCostMetric,
  officialCostTargets,
  officialCostSlices,
} from "./official-cost.ts";
import { priceQuery, percentileSql } from "./overview-sql.ts";

const homeSource = "home-local-v1";
const gatewaySource = "pool-gateway-v1";
const maxPages = 10;
const maxDimensionRows = 500;
const maxUsageSlices = 500;
const hourMs = 3_600_000;
const dayMs = 86_400_000;
const maxSafeCount = Number.MAX_SAFE_INTEGER;
const asCount = (value: unknown) => requestCount(value);
const asText = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid overview text value");
  return value;
};
const safePercentile = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "bigint")
    return value >= 0n && value <= BigInt(maxSafeCount) ? Number(value) : null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= BigInt(maxSafeCount) ? Number(parsed) : null;
};
const safeAddCount = (left: number, right: number) => {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("Overview count exceeds the response range");
  return total;
};

export interface OverviewReadInput extends PoolOverviewSignedInput {
  readonly prices: readonly OverviewApiPrice[];
  readonly pricesUnavailableReason?: string;
}

export interface OverviewPricesTarget {
  readonly provider: string;
  readonly model: string;
}

function interval(input: PoolOverviewInput) {
  const from = Date.parse(input.from),
    to = Date.parse(input.to);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    (input.days !== 7 && input.days !== 30) ||
    to - from > input.days * 86_400_000 + hourMs
  )
    throw new HistoryInputError();
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    fromExact: timestamp(input.from),
    toExact: timestamp(input.to),
    fromMs: from,
    toMs: to,
  };
}

function baseAuthority(raw: unknown): SeriesAuthority {
  const value = historyObject(raw);
  if (typeof value.mappingProven !== "boolean") throw new HistoryInputError();
  return seriesAuthority(value, value.mappingProven && homeAccountMappingProven);
}

function offerings(raw: unknown, authority: SeriesAuthority) {
  const value = raw as { accounts?: unknown };
  if (!Array.isArray(value?.accounts) || value.accounts.length !== authority.accounts.length)
    throw new HistoryInputError();
  const allowed = new Set(["subscription", "metered_api", "prepaid", "other", "unknown"]);
  const byHistory = new Map<string, { account: string; offering: string }>();
  const result = value.accounts.map((entry, index) => {
    const account = historyObject(entry);
    const normalized = authority.accounts[index]!;
    if (!allowed.has(String(account.offering)) || account.account !== normalized.account)
      throw new HistoryInputError();
    const offering = String(account.offering);
    if (normalized.account !== null)
      for (const history of normalized.history) {
        const prior = byHistory.get(history);
        if (prior && (prior.account !== normalized.account || prior.offering !== offering))
          throw new HistoryInputError();
        byHistory.set(history, { account: normalized.account, offering });
      }
    return { offering, account: normalized.account, history: normalized.history };
  });
  return result;
}

function safeDirectory(raw: PoolOverviewDirectoryInput): PoolOverviewDirectoryInput {
  if (
    !raw ||
    !Array.isArray(raw.members) ||
    raw.members.length > 500 ||
    !Number.isSafeInteger(raw.activeCount) ||
    !Number.isSafeInteger(raw.totalCount) ||
    raw.activeCount < 0 ||
    raw.totalCount < raw.activeCount ||
    raw.totalCount > 500 ||
    raw.activeCount > raw.members.length ||
    raw.totalCount < raw.members.length
  )
    throw new HistoryInputError();
  const seen = new Set<string>();
  const members = raw.members.map((entry) => {
    const member = historyObject(entry);
    if (
      typeof member.person !== "string" ||
      !/^[a-f0-9]{64}$/.test(member.person) ||
      seen.has(member.person) ||
      typeof member.displayName !== "string" ||
      member.displayName.length > 256 ||
      typeof member.active !== "boolean"
    )
      throw new HistoryInputError();
    seen.add(member.person);
    return { person: member.person, displayName: member.displayName, active: member.active };
  });
  const actualActive = members.filter((entry) => entry.active).length;
  if (actualActive !== raw.activeCount) throw new HistoryInputError();
  return { members, activeCount: raw.activeCount, totalCount: raw.totalCount };
}

function safePersonalOfferings(raw: unknown): PoolPersonalOverviewSignedInput["offerings"] {
  if (!Array.isArray(raw) || raw.length > 16_000) throw new HistoryInputError();
  const allowed = new Set(["subscription", "metered_api", "prepaid", "other", "unknown"]);
  const seen = new Set<string>();
  return raw.map((entry) => {
    const value = historyObject(entry);
    if (
      Object.keys(value).some((key) => key !== "history" && key !== "offering") ||
      typeof value.history !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.history) ||
      seen.has(value.history) ||
      !allowed.has(String(value.offering))
    )
      throw new HistoryInputError();
    seen.add(value.history);
    return {
      history: value.history,
      offering: value.offering as PoolPersonalOverviewSignedInput["offerings"][number]["offering"],
    };
  });
}

function directoryActivity(
  directory: PoolOverviewDirectoryInput,
  groups: readonly SeriesGroup[],
): PoolOverviewDirectory {
  const visible = new Set(directory.members.map((member) => member.person));
  const used = new Set<string>();
  for (const group of groups) {
    const person = group.key.person;
    if (
      typeof person === "string" &&
      visible.has(person) &&
      group.buckets.some((bucket) => bucket.requests > 0)
    )
      used.add(person);
  }
  return {
    members: directory.members.map((member) => ({ ...member, active: used.has(member.person) })),
    activeCount: used.size,
    totalCount: directory.totalCount,
  };
}

function safePrices(raw: readonly OverviewApiPrice[]): readonly OverviewApiPrice[] | null {
  if (!Array.isArray(raw) || raw.length > 3_200) return null;
  const seen = new Set<string>();
  const prices: OverviewApiPrice[] = [];
  for (const price of raw) {
    if (!price || typeof price !== "object") return null;
    const identity = JSON.stringify([price.provider, price.model, price.tier, price.minInput]);
    if (
      typeof price.provider !== "string" ||
      !price.provider ||
      price.provider.length > 256 ||
      typeof price.model !== "string" ||
      !price.model ||
      price.model.length > 256 ||
      price.currency !== "USD" ||
      price.source !== "models.dev" ||
      typeof price.version !== "string" ||
      !price.version ||
      price.version.length > 128 ||
      typeof price.asOf !== "string" ||
      !Number.isFinite(Date.parse(price.asOf)) ||
      (price.tier !== "*" &&
        price.tier !== null &&
        (typeof price.tier !== "string" || price.tier.length > 64)) ||
      typeof price.minInput !== "string" ||
      !/^(0|[1-9][0-9]{0,15})(?:\.[0-9]{1,12})?$/.test(price.minInput) ||
      [price.input, price.output, price.cacheRead, price.cacheWrite, price.request].some(
        (value) =>
          typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})(?:\.[0-9]{1,12})?$/.test(value),
      ) ||
      seen.has(identity)
    )
      return null;
    seen.add(identity);
    prices.push(price);
  }
  return prices;
}

/** A signed pool manager can price retained request totals even after an account is disconnected. */
export async function overviewTargets(
  db: HistoryDatabase,
  input: PoolOverviewSignedInput,
): Promise<{ readonly targets: OverviewPricesTarget[]; readonly unavailableReason?: string }> {
  interval(input);
  seriesInput({
    pool: input.pool,
    from: input.from,
    to: input.to,
    bucket: "day",
    by: ["provider"],
  });
  baseAuthority(input.authority);
  return officialCostTargets(db, input);
}

/** Price targets use only the caller's inspectable history references and own requests. */
export async function personalOverviewTargets(
  db: HistoryDatabase,
  raw: PoolPersonalOverviewSignedInput,
): Promise<{ readonly targets: OverviewPricesTarget[]; readonly unavailableReason?: string }> {
  const input = personalInput(raw);
  return officialCostTargets(db, input);
}

function personalInput(raw: unknown): PoolPersonalOverviewSignedInput {
  const value = historyObject(raw);
  const fields = new Set(["pool", "person", "from", "to", "days", "offerings"]);
  if (
    Object.keys(value).some((key) => !fields.has(key)) ||
    typeof value.pool !== "string" ||
    !value.pool ||
    typeof value.person !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.person)
  )
    throw new HistoryInputError();
  interval(value as unknown as PoolOverviewInput);
  return {
    pool: value.pool,
    person: value.person,
    from: String(value.from),
    to: String(value.to),
    days: value.days as 7 | 30,
    offerings: safePersonalOfferings(value.offerings),
  };
}

function personalMoney(
  amount: string | null,
  pricedRequests: number,
  categoryRequests: number,
  excluded: OverviewMoneyMetric["excluded"],
  price: OverviewMoneyMetric["price"],
  unavailableReason: string,
): OverviewMoneyMetric {
  if (
    (categoryRequests > 0 && pricedRequests === 0) ||
    (categoryRequests === 0 && excluded.unknownKind > 0 && pricedRequests === 0)
  )
    return unavailableMoney(unavailableReason, excluded);
  return {
    status: "available",
    amount: amount ?? "0.000000000000",
    currency: "USD",
    pricedRequests,
    excluded,
    price,
  };
}

/** One caller's typed usage and price estimates; no directory or pool-wide aggregate is read. */
export async function poolPersonalOverview(
  db: HistoryDatabase,
  raw: unknown,
  pricesRaw: readonly OverviewApiPrice[],
  pricesUnavailableReason?: string,
  transaction: "owned" | "caller" = "owned",
): Promise<PoolPersonalOverviewResult> {
  const input = personalInput(raw);
  const range = interval(input);
  const poolHash = (await digest(input.pool)).slice(0, 16);
  const [homeSourceHash, gatewaySourceHash] = await Promise.all([
    digest(homeSource),
    digest(gatewaySource),
  ]);
  const authority: SeriesAuthority = { canManage: false, mappingProven: false, accounts: [] };
  const sourceInput: PoolUsageSeriesInput = {
    pool: input.pool,
    from: range.from,
    to: range.to,
    bucket: "day",
    by: ["person", "provider", "model"],
    sources: [homeSourceHash, gatewaySourceHash],
  };
  if (transaction === "owned")
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const seriesResult = await readSeries(db, sourceInput, authority, input.person);
    const requestValues = [
      poolHash,
      sourceInput.sources,
      input.person,
      range.fromExact,
      range.toExact,
    ];
    const requestWhere = `FROM basalt_model_requests WHERE pool=$1 AND source=ANY($2::character(64)[])
      AND person=$3 AND attribution IS DISTINCT FROM 'import-owner'
      AND timestamp_exact >= $4 AND timestamp_exact < $5`;
    const percentiles = await db.query(
      `SELECT
        count(*) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy'))::text AS known,
        count(*) FILTER (WHERE total_tokens IS NULL OR token_quality NOT IN ('complete','legacy'))::text AS missing,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p50,
        percentile_disc(0.9) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p90,
        percentile_disc(0.99) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p99
      ${requestWhere}`,
      requestValues,
    );
    const homeRequests = await db.query(
      `SELECT count(*)::text AS requests FROM basalt_model_requests
      WHERE pool=$1 AND source=$2 AND person=$3 AND attribution IS DISTINCT FROM 'import-owner'
        AND timestamp_exact >= $4 AND timestamp_exact < $5`,
      [poolHash, homeSourceHash, input.person, range.fromExact, range.toExact],
    );
    const byModel = await db.query(
      `SELECT provider,model,
        count(*) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy'))::text AS known,
        count(*) FILTER (WHERE total_tokens IS NULL OR token_quality NOT IN ('complete','legacy'))::text AS missing,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p50,
        percentile_disc(0.9) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p90,
        percentile_disc(0.99) WITHIN GROUP (ORDER BY total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND token_quality IN ('complete','legacy')) AS p99
      ${requestWhere} GROUP BY provider,model ORDER BY provider,model LIMIT ${maxDimensionRows + 1}`,
      requestValues,
    );
    const overall = percentiles.rows[0] ?? {};
    const requestCount = safeAddCount(asCount(overall.known), asCount(overall.missing));
    const p50 = safePercentile(overall.p50),
      p90 = safePercentile(overall.p90),
      p99 = safePercentile(overall.p99);
    const hasKnown = asCount(overall.known) > 0;
    const unsafePercentile = [overall.p50, overall.p90, overall.p99].some(
      (value) => value !== null && safePercentile(value) === null,
    );
    const dimensionOverflow = byModel.rows.length > maxDimensionRows;
    const byModelRows = dimensionOverflow ? [] : percentileRows(byModel.rows);
    const requestTokens: PoolOverviewResult["metrics"]["requestTokens"] = {
      status: hasKnown && !unsafePercentile ? "available" : "unavailable",
      ...(!hasKnown || unsafePercentile
        ? {
            reason: unsafePercentile
              ? "Request token percentile exceeds the exact JSON number range."
              : "No request token totals are available.",
          }
        : {}),
      percentiles: p50 === null || p90 === null || p99 === null ? null : { p50, p90, p99 },
      requests: requestCount,
      excluded: { missing: asCount(overall.missing), unknownKind: 0 },
      byPerson: requestCount
        ? [{ person: input.person, p50, p90, p99, requests: requestCount }]
        : [],
      byModel: byModelRows.flatMap((row) =>
        row.provider && row.model
          ? [
              {
                provider: row.provider,
                model: row.model,
                p50: row.p50,
                p90: row.p90,
                p99: row.p99,
                requests: row.requests,
              },
            ]
          : [],
      ),
      byModelPerson: byModelRows.flatMap((row) =>
        row.provider && row.model
          ? [
              {
                person: input.person,
                provider: row.provider,
                model: row.model,
                p50: row.p50,
                p90: row.p90,
                p99: row.p99,
                requests: row.requests,
              },
            ]
          : [],
      ),
    };

    const offerings = input.offerings.map(({ history, offering }) => ({
      account: history,
      history: [history],
      offering,
    }));
    const normalizedPrices = safePrices(pricesRaw);
    const prices = normalizedPrices ?? [];
    const noPrices =
      pricesUnavailableReason ??
      (normalizedPrices === null
        ? "Current API price data was invalid and has been excluded."
        : "No current official USD model prices were available.");
    const priceRows = prices.map((price) => ({
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
    const values = [
      poolHash,
      [homeSourceHash],
      JSON.stringify(offerings),
      range.fromExact,
      range.toExact,
      [input.person],
      JSON.stringify(priceRows),
      homeSourceHash,
      [input.person],
    ];
    const cte = priceQuery(true);
    const totalsQuery = await db.query(
      `${cte}SELECT
        count(*) FILTER (WHERE offering='metered_api')::text AS api_requests,
        count(*) FILTER (WHERE offering='subscription')::text AS subscription_requests,
        count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NOT NULL)::text AS api_priced,
        count(*) FILTER (WHERE offering='subscription' AND api_cost IS NOT NULL)::text AS subscription_priced,
        count(*) FILTER (WHERE offering='unknown')::text AS unknown_kind,
        count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NULL)::text AS api_unpriced,
        count(*) FILTER (WHERE offering='subscription' AND api_cost IS NULL)::text AS subscription_unpriced,
        round(sum(api_cost) FILTER (WHERE offering='metered_api'),12)::text AS api_cost,
        round(sum(api_cost) FILTER (WHERE offering='subscription'),12)::text AS subscription_value,
        round(sum(api_cost) FILTER (WHERE offering='unknown'),12)::text AS unknown_kind_value
      FROM priced`,
      values,
    );
    const costRows = await db.query(
      `${cte}SELECT person,provider,model,count(*)::text AS requests,
        count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NOT NULL)::text AS api_priced,
        count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NULL)::text AS api_unpriced,
        count(*) FILTER (WHERE offering='subscription' AND api_cost IS NOT NULL)::text AS subscription_priced,
        count(*) FILTER (WHERE offering='subscription' AND api_cost IS NULL)::text AS subscription_unpriced,
        count(*) FILTER (WHERE offering='unknown')::text AS unknown_kind,
        round(sum(api_cost) FILTER (WHERE offering='unknown'),12)::text AS unknown_kind_value,
        round(sum(api_cost) FILTER (WHERE offering='metered_api'),12)::text AS api_cost,
        round(sum(api_cost) FILTER (WHERE offering='subscription'),12)::text AS subscription_value
      FROM priced WHERE offering IN ('metered_api','subscription','unknown')
      GROUP BY person,provider,model ORDER BY provider,model LIMIT ${maxUsageSlices + 1}`,
      values,
    );
    const totalsRow = totalsQuery.rows[0] ?? {};
    const homeRequestCount = asCount(homeRequests.rows[0]?.requests ?? "0");
    const totals = {
      apiRequests: asCount(totalsRow.api_requests),
      subscriptionRequests: asCount(totalsRow.subscription_requests),
      apiPriced: asCount(totalsRow.api_priced),
      subscriptionPriced: asCount(totalsRow.subscription_priced),
      unknown: asCount(totalsRow.unknown_kind),
      apiUnpriced: asCount(totalsRow.api_unpriced),
      subscriptionUnpriced: asCount(totalsRow.subscription_unpriced),
      apiAmount: asText(totalsRow.api_cost),
      subscriptionAmount: asText(totalsRow.subscription_value),
      unknownValue: asText(totalsRow.unknown_kind_value),
    };
    const classified = totals.apiRequests + totals.subscriptionRequests + totals.unknown;
    const hiddenUnknown = Math.max(0, homeRequestCount - classified);
    const unknownKind = safeAddCount(totals.unknown, hiddenUnknown);
    const excluded = (unpriced: number): OverviewMoneyMetric["excluded"] => ({
      unknownKind,
      unknownKindValue: totals.unknownValue,
      unpriced,
    });
    const price = priceProvenance(prices);
    const noKindReason =
      "Some of your requests could not be classified from inspectable account history, so separate estimates are incomplete.";
    const official = await officialCosts(db, input, prices);
    const apiBilled = officialCostMetric(official, prices, pricesUnavailableReason);
    const subscriptionValue = personalMoney(
      totals.subscriptionAmount,
      totals.subscriptionPriced,
      totals.subscriptionRequests,
      excluded(totals.subscriptionUnpriced),
      price,
      unknownKind ? noKindReason : noPrices,
    );
    const usageOverflow = costRows.rows.length > maxUsageSlices;
    const usageSlices: PoolOverviewResult["metrics"]["usageSlices"] =
      unknownKind > 0 || usageOverflow
        ? []
        : costRows.rows.map((row) => ({
            person: asText(row.person),
            provider: asText(row.provider),
            model: asText(row.model),
            requests: asCount(row.requests),
            apiBilled: asText(row.api_cost),
            apiPricedRequests: asCount(row.api_priced),
            apiUnpriced: asCount(row.api_unpriced),
            subscriptionValue: asText(row.subscription_value),
            subscriptionPricedRequests: asCount(row.subscription_priced),
            subscriptionUnpriced: asCount(row.subscription_unpriced),
            unknownKind: asCount(row.unknown_kind),
            unknownKindValue: asText(row.unknown_kind_value),
            price:
              price && (row.api_cost !== null || row.subscription_value !== null) ? price : null,
          }));
    const partial = seriesResult.next !== null || dimensionOverflow || usageOverflow;
    const result: PoolPersonalOverviewResult = {
      from: range.from,
      to: range.to,
      person: input.person,
      asOf: seriesResult.asOf,
      consistency: "consistent",
      series: seriesResult,
      metrics: {
        requestTokens,
        apiBilled,
        subscriptionValue,
        usageSlices: officialCostSlices(official, prices, [input.person]).map((slice) => {
          const known = usageSlices.find(
            (entry) => entry.provider === slice.provider && entry.model === slice.model,
          );
          return {
            ...slice,
            subscriptionValue: known?.subscriptionValue ?? null,
            subscriptionPricedRequests: known?.subscriptionPricedRequests ?? 0,
            subscriptionUnpriced: known?.subscriptionUnpriced ?? 0,
          };
        }),
      },
      partial,
    };
    if (transaction === "owned") await db.query("COMMIT");
    return result;
  } catch (error) {
    if (transaction === "owned") await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function readSeries(
  db: HistoryDatabase,
  input: PoolUsageSeriesInput,
  authority: SeriesAuthority,
  personScope?: string,
): Promise<PoolUsageSeriesResult> {
  const groups = new Map<string, SeriesGroup>();
  let first: PoolUsageSeriesResult | undefined;
  let next: string | null = null;
  let page = 0;
  do {
    const pageInput: PoolUsageSeriesInput = { ...input, ...(next ? { after: next } : {}) };
    const result: PoolUsageSeriesResult = personScope
      ? await poolPersonalUsageSeries(db, pageInput, personScope, "caller")
      : await poolUsageSeries(db, pageInput, authority, "caller");
    if (first === undefined) first = result;
    else if (result.asOf !== first.asOf) throw new Error("Overview series snapshots differ");
    for (const group of result.groups) {
      const key = JSON.stringify(group.key);
      const previous = groups.get(key);
      groups.set(
        key,
        previous ? { ...previous, buckets: [...previous.buckets, ...group.buckets] } : group,
      );
    }
    next = result.next;
    page++;
  } while (next && page < maxPages);
  const firstResult = first;
  if (!firstResult) throw new Error("Overview series unavailable");
  return { ...firstResult, groups: [...groups.values()], next };
}

async function homeCoverage(
  db: HistoryDatabase,
  poolHash: string,
  homeSourceHash: string,
  from: string,
  to: string,
): Promise<{
  readonly capturedAt: string | null;
  readonly incompleteHours: ReadonlySet<string> | null;
}> {
  const schema =
    await db.query(`SELECT to_regclass('usage') AS usage,to_regclass('billing_charge') AS charge,
    to_regclass('api_key') AS api_key,to_regclass('user') AS users,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at`);
  const available = schema.rows[0];
  if (!available?.usage || !available.charge || !available.api_key || !available.users)
    return { capturedAt: asText(available?.captured_at), incompleteHours: null };
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
  if (missing.rows.length >= 800)
    return { capturedAt: asText(available.captured_at), incompleteHours: null };
  return {
    capturedAt: asText(available.captured_at),
    incompleteHours: new Set(missing.rows.map((row) => String(row.hour))),
  };
}

function completeHomeDays(
  fromMs: number,
  toMs: number,
  incompleteHours: ReadonlySet<string> | null,
): string[] {
  if (incompleteHours === null) return [];
  const days: string[] = [];
  for (let start = Math.ceil(fromMs / dayMs) * dayMs; start + dayMs <= toMs; start += dayMs) {
    let complete = true;
    for (let hour = start; hour < start + dayMs; hour += hourMs) {
      const key = `${new Date(hour).toISOString().slice(0, 19)}Z`;
      if (incompleteHours.has(key)) {
        complete = false;
        break;
      }
    }
    if (complete) days.push(new Date(start).toISOString().slice(0, 10));
  }
  return days;
}

function percentileRows(rows: readonly Record<string, unknown>[]) {
  return rows.slice(0, maxDimensionRows).map((row) => ({
    person: asText(row.person),
    provider: asText(row.provider),
    model: asText(row.model),
    p50: safePercentile(row.p50),
    p90: safePercentile(row.p90),
    p99: safePercentile(row.p99),
    requests: safeAddCount(asCount(row.known), asCount(row.missing)),
  }));
}

function unavailableMoney(
  reason: string,
  excluded: OverviewMoneyMetric["excluded"] = {
    unknownKind: 0,
    unknownKindValue: null,
    unpriced: 0,
  },
): OverviewMoneyMetric {
  return {
    status: "unavailable",
    reason,
    amount: null,
    currency: "USD",
    pricedRequests: 0,
    excluded,
    price: null,
  };
}

function priceProvenance(prices: readonly OverviewApiPrice[]) {
  const versions = new Set(prices.map((price) => price.version));
  const asOf = prices
    .map((price) => price.asOf)
    .sort()
    .at(-1);
  return versions.size === 1 && asOf
    ? { source: "models.dev", version: [...versions][0]!, asOf }
    : null;
}

/** Reads one repeatable-read overview. Raw requests stay inside SQL and only bounded groups leave it. */
export async function poolUsageOverview(
  db: HistoryDatabase,
  raw: OverviewReadInput,
  transaction: "owned" | "caller" = "owned",
): Promise<PoolOverviewResult> {
  interval(raw);
  if (typeof raw.pool !== "string" || !raw.pool) throw new HistoryInputError();
  const authority = baseAuthority(raw.authority);
  const accountOfferings = offerings(raw.authority, authority);
  const directoryInput = safeDirectory(raw.directory);
  const normalizedPrices = safePrices(raw.prices);
  const prices = normalizedPrices ?? [];
  const priceUnavailableReason =
    raw.pricesUnavailableReason ??
    (normalizedPrices === null
      ? "Current API price data was invalid and has been excluded."
      : "No current official USD model prices were available.");
  const pool = (await digest(raw.pool)).slice(0, 16);
  const hashes = directoryInput.members.map((entry) => entry.person);
  const entitlements = authority.accounts.map((entry, index) => ({
    ...entry,
    offering: accountOfferings[index]!.offering,
  }));
  const homeSourceHash = await digest(homeSource);
  const range = interval(raw);
  if (transaction === "owned")
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const readInput = (
      bucket: "day" | "hour",
      by: PoolUsageSeriesInput["by"],
    ): PoolUsageSeriesInput => ({
      pool: raw.pool,
      from: range.from,
      to: range.to,
      bucket,
      by,
    });
    const people = await readSeries(
      db,
      readInput("day", ["person", "provider", "model"]),
      authority,
    );
    const models = people;
    const directory = directoryActivity(directoryInput, people.groups);
    const requestSeries = await readSeries(db, readInput("hour", ["provider"]), authority);
    const homeSeries = await readSeries(
      db,
      { ...readInput("hour", ["provider"]), sources: [homeSourceHash] },
      authority,
    );
    const homeCoverageResult = await homeCoverage(
      db,
      pool,
      homeSourceHash,
      range.fromExact,
      range.toExact,
    );
    const asOfs = [people.asOf, models.asOf, requestSeries.asOf];
    let partial =
      people.next !== null ||
      models.next !== null ||
      requestSeries.next !== null ||
      homeSeries.next !== null ||
      !authority.mappingProven;
    const requestsByHour: PoolOverviewResult["requestsByHour"][number][] = [];
    const byHour = new Map<number, { requests: number; failed: number }>();
    for (const group of requestSeries.groups)
      for (const bucket of group.buckets) {
        if (!("requests" in bucket)) continue;
        const at = Math.floor(Date.parse(bucket.at) / hourMs) * hourMs;
        const current = byHour.get(at) ?? { requests: 0, failed: 0 };
        current.requests = safeAddCount(current.requests, bucket.requests);
        current.failed = safeAddCount(current.failed, bucket.failed);
        byHour.set(at, current);
      }
    const incompleteHours = homeCoverageResult.incompleteHours;
    const providerCoverageProven =
      authority.mappingProven &&
      incompleteHours !== null &&
      homeSeries.coverage.mapping.unmapped === 0 &&
      homeSeries.coverage.mapping.otherAccounts === 0;
    for (const group of homeSeries.groups)
      for (const bucket of group.buckets) {
        if (!group.key.provider || !("requests" in bucket)) continue;
        const at = Math.floor(Date.parse(bucket.at) / hourMs) * hourMs;
        const key = `${new Date(at).toISOString().slice(0, 19)}Z`;
        const coverage =
          incompleteHours !== null &&
          homeSeries.coverage.mapping.unmapped === 0 &&
          homeSeries.coverage.mapping.otherAccounts === 0 &&
          !incompleteHours.has(key)
            ? 1
            : null;
        requestsByHour.push({
          provider: group.key.provider,
          at: new Date(at).toISOString(),
          requests: bucket.requests,
          coverage,
          sourceAt: homeCoverageResult.capturedAt,
        });
        if (coverage === null) partial = true;
      }
    if (incompleteHours === null || incompleteHours.size > 0) partial = true;
    const completeHours: string[] = [];
    if (providerCoverageProven && incompleteHours !== null) {
      for (
        let at = Math.ceil(range.fromMs / hourMs) * hourMs;
        at + hourMs <= range.toMs;
        at += hourMs
      ) {
        const key = `${new Date(at).toISOString().slice(0, 19)}Z`;
        if (!incompleteHours.has(key)) completeHours.push(new Date(at).toISOString());
      }
    }
    if (!providerCoverageProven) partial = true;
    const shares = [...byHour.values()]
      .filter((hour) => hour.requests > 0)
      .map((hour) => (100 * hour.failed) / hour.requests)
      .sort((a, b) => a - b);
    const failureP95 = shares.length
      ? shares[Math.min(shares.length - 1, Math.ceil(shares.length * 0.95) - 1)]!
      : null;

    let requestTokens: PoolOverviewResult["metrics"]["requestTokens"] = {
      status: "unavailable" as const,
      reason: "Usage account mapping is not verified or no pool accounts are inspectable.",
      percentiles: null,
      requests: 0,
      excluded: { missing: 0, unknownKind: 0 },
      byPerson: [],
      byModel: [],
      byModelPerson: [],
    };
    const accountReason =
      authority.accounts.length === 0
        ? "No accounts in this pool yet."
        : !authority.mappingProven
          ? "Usage account mapping is not verified."
          : "No pool accounts have inspectable usage history.";
    let apiBilled = unavailableMoney(accountReason);
    let subscriptionValue = unavailableMoney(accountReason);
    let usageSlices: PoolOverviewResult["metrics"]["usageSlices"] = [];
    let perActivePersonPerDay: PoolOverviewResult["metrics"]["perActivePersonPerDay"] = {
      status: "unavailable",
      reason: "No eligible subscription usage was priced.",
      p50: null,
      p90: null,
      currency: "USD",
      activePeople: 0,
      completeDays: 0,
    };
    let failureShareWorstHourP95: PoolOverviewResult["metrics"]["failureShareWorstHourP95"] = {
      status: "unavailable",
      reason: "Request history has no observed hours.",
      p95: null,
      unit: "percent",
      hours: 0,
    };
    if (
      authority.mappingProven &&
      entitlements.some((entry) => entry.account !== null && entry.history.length > 0)
    ) {
      const cte = priceQuery();
      const priceRows = prices.map((price) => ({
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
      const requestSources = [homeSourceHash, await digest(gatewaySource)];
      const completeDays = providerCoverageProven
        ? completeHomeDays(range.fromMs, range.toMs, incompleteHours)
        : [];
      const values = [
        pool,
        requestSources,
        JSON.stringify(entitlements),
        range.fromExact,
        range.toExact,
        hashes,
        JSON.stringify(priceRows),
        homeSourceHash,
      ];
      const dailyValues = [...values, completeDays];
      const allPercentiles = await db.query(
        `${cte}${percentileSql("NULL::text AS person,NULL::text AS provider,NULL::text AS model", "", maxDimensionRows)}`,
        values,
      );
      const personPercentiles = await db.query(
        `${cte}${percentileSql("person,NULL::text AS provider,NULL::text AS model", "person", maxDimensionRows)}`,
        values,
      );
      const modelPercentiles = await db.query(
        `${cte}${percentileSql("NULL::text AS person,provider,model", "provider,model", maxDimensionRows)}`,
        values,
      );
      const modelPersonPercentiles = await db.query(
        `${cte}${percentileSql("person,provider,model", "person,provider,model", maxDimensionRows)}`,
        values,
      );
      const totalsQuery = await db.query(
        `${cte}SELECT count(*) FILTER (WHERE offering='metered_api')::text AS api_requests,
        count(*) FILTER (WHERE offering='subscription')::text AS subscription_requests,
        count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NOT NULL)::text AS api_priced,
        count(*) FILTER (WHERE offering='subscription' AND api_cost IS NOT NULL)::text AS subscription_priced,
        count(*) FILTER (WHERE offering='unknown')::text AS unknown_kind,
        count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NULL)::text AS api_unpriced,
        count(*) FILTER (WHERE offering='subscription' AND api_cost IS NULL)::text AS subscription_unpriced,
        round(sum(api_cost) FILTER (WHERE offering='metered_api'),12)::text AS api_cost,
        round(sum(api_cost) FILTER (WHERE offering='subscription'),12)::text AS subscription_value,
        round(sum(api_cost) FILTER (WHERE offering='unknown'),12)::text AS unknown_kind_value
        FROM priced`,
        values,
      );
      const costs = await db.query(
        `${cte}SELECT person,provider,model,count(*)::text AS requests,
          count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NOT NULL)::text AS api_priced,
          count(*) FILTER (WHERE offering='metered_api' AND api_cost IS NULL)::text AS api_unpriced,
          count(*) FILTER (WHERE offering='subscription' AND api_cost IS NOT NULL)::text AS subscription_priced,
          count(*) FILTER (WHERE offering='subscription' AND api_cost IS NULL)::text AS subscription_unpriced,
          count(*) FILTER (WHERE offering='unknown')::text AS unknown_kind,
          round(sum(api_cost) FILTER (WHERE offering='unknown'),12)::text AS unknown_kind_value,
          round(sum(api_cost) FILTER (WHERE offering='metered_api'),12)::text AS api_cost,
          round(sum(api_cost) FILTER (WHERE offering='subscription'),12)::text AS subscription_value
          FROM priced WHERE offering IN ('metered_api','subscription','unknown')
          GROUP BY person,provider,model ORDER BY provider,model,person LIMIT ${maxUsageSlices + 1}`,
        values,
      );
      const personDays = await db.query(
        `${cte}, daily AS (
          SELECT person,left(timestamp_exact,10) AS day,
            sum(api_cost) FILTER (WHERE offering='subscription') AS value,
            count(*) FILTER (WHERE offering='subscription') AS subscriptions,
            count(*) FILTER (WHERE offering='subscription' AND api_cost IS NULL) AS unpriced
          FROM priced WHERE person IS NOT NULL GROUP BY person,left(timestamp_exact,10)
        ), complete AS (
          SELECT * FROM daily WHERE subscriptions > 0 AND unpriced = 0
            AND day::date = ANY($9::date[])
        ) SELECT count(DISTINCT person)::text AS people,count(DISTINCT day)::text AS days,
          percentile_disc(0.5) WITHIN GROUP (ORDER BY value) AS p50,
          percentile_disc(0.9) WITHIN GROUP (ORDER BY value) AS p90
          FROM complete`,
        dailyValues,
      );

      const overall = allPercentiles.rows[0];
      const dimOverflow = [personPercentiles, modelPercentiles, modelPersonPercentiles].some(
        (result) => result.rows.length > maxDimensionRows,
      );
      const usageOverflow = costs.rows.length > maxUsageSlices;
      if (dimOverflow || usageOverflow) partial = true;
      if (overall) {
        const p50 = safePercentile(overall.p50),
          p90 = safePercentile(overall.p90),
          p99 = safePercentile(overall.p99);
        const hasKnown = asCount(overall.known) > 0;
        const unsafePercentile = [overall.p50, overall.p90, overall.p99].some(
          (value) => value !== null && safePercentile(value) === null,
        );
        requestTokens = {
          status: hasKnown && !unsafePercentile ? "available" : "unavailable",
          ...(!hasKnown || unsafePercentile
            ? {
                reason: unsafePercentile
                  ? "Request token percentile exceeds the exact JSON number range."
                  : "No request token totals are available.",
              }
            : {}),
          percentiles: p50 === null || p90 === null || p99 === null ? null : { p50, p90, p99 },
          requests: safeAddCount(asCount(overall.known), asCount(overall.missing)),
          excluded: { missing: asCount(overall.missing), unknownKind: 0 },
          byPerson: dimOverflow
            ? []
            : percentileRows(personPercentiles.rows).flatMap((row) =>
                row.person
                  ? [
                      {
                        person: row.person,
                        p50: row.p50,
                        p90: row.p90,
                        p99: row.p99,
                        requests: row.requests,
                      },
                    ]
                  : [],
              ),
          byModel: dimOverflow
            ? []
            : percentileRows(modelPercentiles.rows).flatMap((row) =>
                row.provider && row.model
                  ? [
                      {
                        provider: row.provider,
                        model: row.model,
                        p50: row.p50,
                        p90: row.p90,
                        p99: row.p99,
                        requests: row.requests,
                      },
                    ]
                  : [],
              ),
          byModelPerson: dimOverflow
            ? []
            : percentileRows(modelPersonPercentiles.rows).flatMap((row) =>
                row.person && row.provider && row.model
                  ? [
                      {
                        person: row.person,
                        provider: row.provider,
                        model: row.model,
                        p50: row.p50,
                        p90: row.p90,
                        p99: row.p99,
                        requests: row.requests,
                      },
                    ]
                  : [],
              ),
        };
      }
      const price = priceProvenance(prices);
      const costRows = costs.rows.slice(0, maxUsageSlices);
      usageSlices = usageOverflow
        ? []
        : costRows.map((row) => ({
            person: asText(row.person),
            provider: asText(row.provider),
            model: asText(row.model),
            requests: asCount(row.requests),
            apiBilled: asText(row.api_cost),
            apiPricedRequests: asCount(row.api_priced),
            apiUnpriced: asCount(row.api_unpriced),
            subscriptionValue: asText(row.subscription_value),
            subscriptionPricedRequests: asCount(row.subscription_priced),
            subscriptionUnpriced: asCount(row.subscription_unpriced),
            unknownKind: asCount(row.unknown_kind),
            unknownKindValue: asText(row.unknown_kind_value),
            price:
              price && (row.api_cost !== null || row.subscription_value !== null) ? price : null,
          }));
      const totalRow = totalsQuery.rows[0] ?? {};
      const totals = {
        apiAmount: asText(totalRow.api_cost),
        subscriptionAmount: asText(totalRow.subscription_value),
        apiPriced: asCount(totalRow.api_priced),
        subscriptionPriced: asCount(totalRow.subscription_priced),
        apiRequests: asCount(totalRow.api_requests),
        subscriptionRequests: asCount(totalRow.subscription_requests),
        unknown: asCount(totalRow.unknown_kind),
        unknownValue: asText(totalRow.unknown_kind_value),
        apiUnpriced: asCount(totalRow.api_unpriced),
        subscriptionUnpriced: asCount(totalRow.subscription_unpriced),
      };
      const metric = (
        amount: string | null,
        priced: number,
        requests: number,
        unpriced: number,
      ): OverviewMoneyMetric => {
        const excluded = {
          unknownKind: totals.unknown,
          unknownKindValue: totals.unknownValue,
          unpriced,
        };
        if (requests > 0 && priced === 0)
          return unavailableMoney(
            priceUnavailableReason ?? "No current official USD price matched these requests.",
            excluded,
          );
        return {
          status: "available",
          amount: amount ?? "0.000000000000",
          currency: "USD",
          pricedRequests: priced,
          excluded,
          price,
        };
      };
      apiBilled = metric(
        totals.apiAmount,
        totals.apiPriced,
        totals.apiRequests,
        totals.apiUnpriced,
      );
      subscriptionValue = metric(
        totals.subscriptionAmount,
        totals.subscriptionPriced,
        totals.subscriptionRequests,
        totals.subscriptionUnpriced,
      );
      const daily = personDays.rows[0];
      if (daily && price && asCount(daily.people) > 0)
        perActivePersonPerDay = {
          status: "available",
          p50: asText(daily.p50),
          p90: asText(daily.p90),
          currency: "USD",
          activePeople: asCount(daily.people),
          completeDays: asCount(daily.days),
        };
      else if (!providerCoverageProven || completeDays.length === 0)
        perActivePersonPerDay = {
          status: "unavailable",
          reason: "No fully captured UTC days are proven for subscription-value percentiles.",
          p50: null,
          p90: null,
          currency: "USD",
          activePeople: 0,
          completeDays: 0,
        };
    }
    const official = await officialCosts(db, raw, prices);
    apiBilled = officialCostMetric(official, prices, raw.pricesUnavailableReason);
    const apiSlices = officialCostSlices(official, prices, hashes);
    const oldSlices = usageSlices;
    usageSlices =
      apiSlices.length > maxUsageSlices
        ? []
        : apiSlices.map((slice) => {
            const known = oldSlices.find(
              (entry) =>
                entry.person === slice.person &&
                entry.provider === slice.provider &&
                entry.model === slice.model,
            );
            return {
              ...slice,
              subscriptionValue: known?.subscriptionValue ?? null,
              subscriptionPricedRequests: known?.subscriptionPricedRequests ?? 0,
              subscriptionUnpriced: known?.subscriptionUnpriced ?? 0,
            };
          });
    if (apiSlices.length > maxUsageSlices) partial = true;
    if (
      authority.accounts.length === 0 &&
      apiBilled.pricedRequests === 0 &&
      apiBilled.excluded.unpriced === 0
    )
      apiBilled = unavailableMoney("No accounts in this pool yet.");
    if (failureP95 !== null)
      failureShareWorstHourP95 = {
        status: "available",
        p95: failureP95,
        unit: "percent",
        hours: byHour.size,
      };

    const sameSnapshot = asOfs.every((value) => value === asOfs[0]);
    const asOf = sameSnapshot ? asOfs[0] : null;
    const consistency = sameSnapshot ? "consistent" : "changed";
    if (!sameSnapshot) partial = true;
    const result: PoolOverviewResult = {
      from: range.from,
      to: range.to,
      asOf,
      consistency,
      homeCapture: { capturedAt: homeCoverageResult.capturedAt, completeHours },
      directory,
      people,
      models,
      requestsByHour,
      metrics: {
        requestTokens,
        apiBilled,
        subscriptionValue,
        perActivePersonPerDay,
        failureShareWorstHourP95,
        usageSlices,
      },
      partial,
    };
    if (transaction === "owned") await db.query("COMMIT");
    return result;
  } catch (error) {
    if (transaction === "owned") await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
