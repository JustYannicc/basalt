import type { OverviewPriceTable } from "../../../apps/pool/overview-contract.ts";
import type { UsageSummaryGroup } from "../../../apps/pool/usage-overview-contract.ts";
import type { PoolUsageSeriesInput, SeriesGroup } from "./series-contract.ts";
import type { OfficialCostRow } from "./official-cost.ts";
import { requestCount } from "./series-coverage.ts";
import { seriesBucket } from "./series.ts";
import { timestamp } from "./record.ts";

export function summaryGroups(
  rows: readonly Record<string, unknown>[],
  input: PoolUsageSeriesInput,
  prices: OverviewPriceTable,
) {
  const series = new Map<string, SeriesGroup>();
  const compact = new Map<
    string,
    {
      provider: string | null;
      model?: string | null;
      countsOnly: boolean;
      buckets: UsageSummaryGroup["buckets"][number][];
    }
  >();
  for (const row of rows) {
    const key = JSON.parse(String(row.group_key)) as SeriesGroup["key"];
    const identity = JSON.stringify([key, row.counts_only === true]);
    const bucket = seriesBucket(row, input, prices);
    const estimate = "tokens" in bucket ? bucket.cost.apiEstimate : undefined;
    const previous = series.get(identity) ?? { key, buckets: [] };
    previous.buckets.push(bucket);
    series.set(identity, previous);
    const group = compact.get(identity) ?? {
      provider: key.provider ?? null,
      ...(key.model === undefined ? {} : { model: key.model }),
      countsOnly: row.counts_only === true,
      buckets: [],
    };
    group.buckets.push({
      at: bucket.at,
      end: timestamp(String(row.end_at)),
      partial: bucket.partial,
      requests: bucket.requests,
      failed: bucket.failed,
      limited: requestCount(row.limited),
      details:
        "tokens" in bucket && estimate
          ? {
              tokens: bucket.tokens,
              apiEstimate:
                key.model === undefined && estimate.excluded.unpriced > 0
                  ? {
                      ...estimate,
                      reason: "Some requests lack a usable current price or complete token counts.",
                    }
                  : estimate,
            }
          : null,
    });
    compact.set(identity, group);
  }
  return { series: [...series.values()], groups: [...compact.values()] };
}

/** Lab costs use the same official slice projection without returning serving accounts or people. */
export function summaryCostRows(
  rows: readonly Record<string, unknown>[],
  from: string,
): OfficialCostRow[] {
  return rows
    .filter((row) => row.counts_only !== true)
    .map((row) => {
      const key = JSON.parse(String(row.group_key)) as SeriesGroup["key"];
      return {
        person: null,
        account: null,
        app: null,
        requirement: null,
        provider: key.provider ?? null,
        model: key.model ?? null,
        day: from.slice(0, 10),
        requests: requestCount(row.requests),
        priced: requestCount(row.api_priced),
        missingPrices: requestCount(row.api_missing_prices),
        missingTokens: requestCount(row.api_missing_tokens),
        tokenCountEstimates: requestCount(row.api_token_count_estimates),
        cost: row.api_amount === null ? null : String(row.api_amount),
      };
    });
}
