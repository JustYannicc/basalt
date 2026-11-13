import type { OverviewPriceTable } from "../../../apps/pool/overview-contract.ts";
import { officialCostMetric } from "./official-cost.ts";
import type { HistoryDatabase } from "./schema.ts";
import {
  apiEquivalentUnavailable,
  type PoolUsageSeriesInput,
  type PoolUsageSeriesResult,
  type SeriesAuthority,
  type SeriesBucket,
  type SeriesCounts,
  type SeriesKey,
} from "./series-contract.ts";
import {
  authorizeSeries,
  cursorScope,
  maxSeriesBytes,
  maxSeriesGroups,
  maxSeriesRows,
  nanos,
  readSeriesCursor,
  seriesBounds,
  seriesInput,
  successRate,
  writeSeriesCursor,
} from "./series-input.ts";
import { requestCount, seriesCoverage } from "./series-coverage.ts";
import { seriesQuery, tokenColumns } from "./series-query.ts";
import { HistoryInputError, historyObject, timestamp } from "./record.ts";
import { digest } from "../backend-users.ts";
import { importedAccountPattern } from "../usage-account-labels.ts";

function bucket(
  row: Record<string, unknown>,
  input: PoolUsageSeriesInput,
  prices?: OverviewPriceTable,
): SeriesBucket | SeriesCounts {
  const at = timestamp(String(row.at)),
    bounds = seriesBounds(input);
  const span = input.bucket === "hour" ? 3_600_000_000_000n : 86_400_000_000_000n;
  const requests = requestCount(row.requests),
    failed = requestCount(row.failed);
  const counts: SeriesCounts = {
    at,
    partial: nanos(at) < nanos(bounds.from) || nanos(at) + span > nanos(bounds.to),
    requests,
    failed,
    unassignedFailures: requestCount(row.unassigned),
    successRate: successRate(requests, failed),
  };
  if (row.counts_only === true) return counts;
  const tokens = Object.fromEntries(
    Object.keys(tokenColumns).map((name) => [
      name,
      {
        sum: row[`${name}Sum`] === null ? null : String(row[`${name}Sum`]),
        known: requestCount(row[`${name}Known`]),
        missing: requestCount(row[`${name}Missing`]),
      },
    ]),
  ) as SeriesBucket["tokens"];
  const key = historyObject(JSON.parse(String(row.group_key)));
  const currency = key.currency;
  const unit = currency === null ? null : String(currency);
  const cost = (amount: unknown, priced: unknown) => ({
    amount: amount === null ? null : String(amount),
    currency: amount === null ? null : unit,
    priced: requestCount(priced),
    unpriced: requestCount(row.unpriced),
  });
  return {
    ...counts,
    lastSuccessAtInRange: row.last_success === null ? null : timestamp(String(row.last_success)),
    tokens,
    tokenQuality: {
      complete: requestCount(row.complete),
      legacy: requestCount(row.legacy),
      unclassified: requestCount(row.unclassified),
      inconsistent: requestCount(row.inconsistent),
    },
    cost: {
      homeCharge: cost(row.home_amount, row.home_priced),
      importedApiPrice: cost(row.imported_amount, row.imported_priced),
      apiEquivalent: apiEquivalentUnavailable,
      ...(prices
        ? {
            apiEstimate: {
              ...officialCostMetric(
                [
                  {
                    person: null,
                    account: null,
                    app: null,
                    requirement: null,
                    provider: typeof key.provider === "string" ? key.provider : null,
                    model: typeof key.model === "string" ? key.model : null,
                    day: at.slice(0, 10),
                    requests,
                    priced: requestCount(row.api_priced),
                    missingPrices: requestCount(row.api_missing_prices),
                    missingTokens: requestCount(row.api_missing_tokens),
                    tokenCountEstimates: requestCount(row.api_token_count_estimates),
                    cost: row.api_amount === null ? null : String(row.api_amount),
                  },
                ],
                prices.prices,
                undefined,
                prices.issues,
              ),
              price:
                requestCount(row.api_priced) > 0
                  ? {
                      source: "models.dev",
                      asOf: String(row.api_price_as_of),
                      version: String(row.api_price_version),
                      basis: row.api_price_baseline === true ? "baseline" : "live",
                      ...(row.api_price_refresh_failed === true ? { refreshFailed: true } : {}),
                      ...(requestCount(row.api_token_count_estimates) > 0
                        ? { calculation: "token-counts" as const }
                        : {}),
                    }
                  : null,
            },
          }
        : {}),
      unpricedRequests: requestCount(row.unpriced),
    },
    attribution: {
      chargeSnapshot: requestCount(row["charge-snapshot"]),
      keyAtCapture: requestCount(row["key-at-capture"]),
      importOwner: requestCount(row["import-owner"]),
      unknown: requestCount(row.unknown),
    },
  };
}

/** Each page is a repeatable-read observation. A later import can change a previously read range. */
async function readUsageSeries(
  db: HistoryDatabase,
  raw: unknown,
  authority: SeriesAuthority,
  transaction: "owned" | "caller" = "owned",
  personScope?: string,
  priceInput?:
    | OverviewPriceTable
    | ((targets: readonly { provider: string; model: string }[]) => Promise<OverviewPriceTable>),
  labels: Readonly<Record<string, string>> = {},
): Promise<PoolUsageSeriesResult> {
  const input = seriesInput(raw);
  if (personScope === undefined) authorizeSeries(input, authority);
  else {
    if (
      !/^[a-f0-9]{64}$/.test(personScope) ||
      input.accounts !== undefined ||
      input.by.some((dimension) => ["account", "app", "attribution", "source"].includes(dimension))
    )
      throw new HistoryInputError();
  }
  const scope = await cursorScope(input, authority, personScope),
    after = readSeriesCursor(input.after, scope, input.by);
  if (transaction === "owned")
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    let prices = typeof priceInput === "function" ? undefined : priceInput;
    let query = await seriesQuery(db, input, authority, after, personScope, prices);
    if (typeof priceInput === "function") {
      const targets = (await db.query(query.targetsText, query.targetsValues)).rows;
      prices =
        targets.length > 100
          ? { prices: [], issues: [] }
          : await priceInput(
              targets.map((row) => ({ provider: String(row.provider), model: String(row.model) })),
            );
      query = await seriesQuery(db, input, authority, after, personScope, prices);
    }
    const { coverage, asOf } = await seriesCoverage(
      db,
      query,
      input,
      authority,
      personScope !== undefined,
    );
    const rows = (await db.query(query.text, query.values)).rows;
    const result: PoolUsageSeriesResult = {
      from: input.from,
      to: input.to,
      bucket: input.bucket,
      ...(input.window ? { window: input.window } : {}),
      asOf,
      coverage,
      groups: [],
      next: null,
    };
    let last: Record<string, unknown> | undefined;
    let used = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    const groups = new Map<string, (typeof result.groups)[number]>();
    for (const [index, row] of rows.entries()) {
      const key = String(row.group_key),
        known = groups.get(key);
      if (index === maxSeriesRows || (!known && groups.size === maxSeriesGroups)) break;
      const value = bucket(row, input, prices);
      const groupKey = historyObject(JSON.parse(key)) as unknown as SeriesKey;
      const group = known ?? {
        key: groupKey,
        ...(typeof groupKey.account === "string" && importedAccountPattern.test(groupKey.account)
          ? {
              accountDisplay: {
                kind: "imported-only" as const,
                label: labels[groupKey.account] ?? null,
              },
            }
          : groupKey.account === null
            ? { accountDisplay: { kind: "no-account-recorded" as const, label: null } }
            : {}),
        buckets: [],
      };
      // Include group framing, commas, the complete cursor, and its JSON escaping in the byte bound.
      const previousNext = result.next;
      result.next = writeSeriesCursor(scope, key, String(row.at));
      const cursorBytes = new TextEncoder().encode(JSON.stringify(result.next)).byteLength;
      result.next = previousNext;
      const added =
        new TextEncoder().encode(JSON.stringify(known ? value : { ...group, buckets: [value] }))
          .byteLength + 1;
      if (used + added + cursorBytes > maxSeriesBytes) break;
      if (!known) {
        groups.set(key, group);
        result.groups.push(group);
      }
      group.buckets.push(value);
      used += added;
      last = row;
    }
    const count = result.groups.reduce((total, group) => total + group.buckets.length, 0);
    if (count < rows.length) {
      if (!last) throw new Error("Usage coverage exceeds the page byte bound");
      result.next = writeSeriesCursor(scope, String(last.group_key), String(last.at));
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxSeriesBytes)
      throw new Error("Usage page exceeds its byte bound");
    if (transaction === "owned") await db.query("COMMIT");
    return result;
  } catch (error) {
    if (transaction === "owned") await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function poolUsageSeries(
  db: HistoryDatabase,
  raw: unknown,
  authority: SeriesAuthority,
  transaction: "owned" | "caller" = "owned",
  prices?:
    | OverviewPriceTable
    | ((targets: readonly { provider: string; model: string }[]) => Promise<OverviewPriceTable>),
  labels: Readonly<Record<string, string>> = {},
): Promise<PoolUsageSeriesResult> {
  return readUsageSeries(db, raw, authority, transaction, undefined, prices, labels);
}

/** Signed personal overview only: account bindings stay absent and the caller hash is the SQL scope. */
export async function poolPersonalUsageSeries(
  db: HistoryDatabase,
  raw: unknown,
  person: string,
  transaction: "owned" | "caller" = "owned",
): Promise<PoolUsageSeriesResult> {
  if (!/^[a-f0-9]{64}$/.test(person)) throw new HistoryInputError();
  const input = seriesInput(raw);
  const allowedSources = [await digest("home-local-v1"), await digest("pool-gateway-v1")];
  if (
    input.sources?.length !== allowedSources.length ||
    !allowedSources.every((source) => input.sources?.includes(source))
  )
    throw new HistoryInputError();
  return readUsageSeries(
    db,
    raw,
    { canManage: false, mappingProven: false, accounts: [] },
    transaction,
    person,
  );
}
