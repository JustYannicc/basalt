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
import { historyObject, timestamp } from "./record.ts";

function bucket(
  row: Record<string, unknown>,
  input: PoolUsageSeriesInput,
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
  const currency = historyObject(JSON.parse(String(row.group_key))).currency;
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
export async function poolUsageSeries(
  db: HistoryDatabase,
  raw: unknown,
  authority: SeriesAuthority,
  transaction: "owned" | "caller" = "owned",
): Promise<PoolUsageSeriesResult> {
  const input = seriesInput(raw);
  authorizeSeries(input, authority);
  const scope = await cursorScope(input, authority),
    after = readSeriesCursor(input.after, scope, input.by);
  if (transaction === "owned") await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const query = await seriesQuery(db, input, authority, after);
    const { coverage, asOf } = await seriesCoverage(db, query, input, authority);
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
      const value = bucket(row, input);
      const group = known ?? {
        key: historyObject(JSON.parse(key)) as unknown as SeriesKey,
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
