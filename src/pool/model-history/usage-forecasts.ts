import type { UsageDay, UsageForecasts } from "../../../apps/pool/usage-forecast-contract.ts";
import type { PoolUsageSeriesResult, SeriesBucket, SeriesCounts } from "./series-contract.ts";
import { addUsageDays, usageDay, usageDayStart } from "../usage-calendar.ts";
import { usageForecast } from "../usage-forecast.ts";
import type { HomeCaptureCoverage } from "./capture-coverage.ts";

interface Day {
  requests: number;
  tokens: bigint;
  tokenKnown: number;
  tokenMissing: number;
  price: bigint;
  priced: number;
  unpriced: number;
  hidden: boolean;
}
const empty = (): Day => ({
  requests: 0,
  tokens: 0n,
  tokenKnown: 0,
  tokenMissing: 0,
  price: 0n,
  priced: 0,
  unpriced: 0,
  hidden: false,
});
const scale = 1_000_000_000_000n;
const fixed = (value: string | null) => {
  if (value === null || !/^\d+(?:\.\d{1,12})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(12, "0"));
};

function add(into: Day, bucket: SeriesBucket | SeriesCounts) {
  into.requests += bucket.requests;
  if (!("tokens" in bucket)) {
    into.hidden = true;
    into.tokenMissing += bucket.requests;
    into.unpriced += bucket.requests;
    return;
  }
  const tokens = bucket.tokens.total;
  if (tokens.sum !== null && /^\d+$/.test(tokens.sum)) into.tokens += BigInt(tokens.sum);
  else if (tokens.known > 0) into.hidden = true;
  into.tokenKnown += tokens.known;
  into.tokenMissing += tokens.missing;
  const metric = bucket.cost.apiEstimate;
  const amount = fixed(metric?.amount ?? null);
  if (metric?.status === "available" && amount !== null) {
    into.price += amount;
    into.priced += metric.pricedRequests;
    into.unpriced += metric.excluded.unpriced + metric.excluded.unknownKind;
  } else into.unpriced += bucket.requests;
}

/** Recorded daily history only. Counts-only data never acquires invented token or price values. */
export function seriesUsageForecasts(
  result: PoolUsageSeriesResult,
  capture?: HomeCaptureCoverage,
): UsageForecasts {
  const byProvider = new Map<string | null, Map<string, Day>>([[null, new Map()]]);
  const warnings: string[] = [];
  if (result.next !== null)
    return {
      calculatedAt: result.to,
      timezone: "Europe/Zurich",
      basis: "recorded-usage",
      series: [],
      warnings: [
        "This history exceeds one page. Forecasts are withheld until a complete range is available.",
      ],
    };
  if (
    result.coverage.sources.some(
      (source) => source.kind === "import" && source.backfillComplete !== true,
    )
  )
    warnings.push(
      "Imported history may still be arriving. Forecasts describe recorded usage and can change after import.",
    );
  const home = result.coverage.sources.find((source) => source.kind === "home");
  const incompleteHome =
    home !== undefined &&
    (home.backfillComplete !== true || capture === undefined || capture.incompleteHours === null);
  const missingDays = new Set(
    [...(capture?.incompleteHours ?? [])].map((hour) => usageDay(Date.parse(hour))),
  );
  if (incompleteHome)
    warnings.push("Home capture is incomplete. Uncaptured days cannot train a usage forecast.");
  else if (home && missingDays.size > 0)
    warnings.push(
      "Home has uncaptured requests. Affected days and current-period projections remain unknown.",
    );
  const today = usageDay(Date.parse(result.to));
  for (const group of result.groups) {
    const provider = group.key.provider ?? null;
    const map =
      provider === null ? undefined : (byProvider.get(provider) ?? new Map<string, Day>());
    if (map) byProvider.set(provider, map);
    for (const bucket of group.buckets) {
      const day = usageDay(Date.parse(bucket.at));
      if (usageDayStart(day) < Date.parse(result.from) || day > today) continue;
      for (const days of map ? [byProvider.get(null)!, map] : [byProvider.get(null)!]) {
        const value = days.get(day) ?? empty();
        add(value, bucket);
        days.set(day, value);
      }
    }
  }
  const series = [...byProvider].map(([provider, measured]) => {
    const first = [...measured.keys()].sort()[0];
    const metrics: Record<"requests" | "tokens" | "apiEstimate", UsageDay[]> = {
      requests: [],
      tokens: [],
      apiEstimate: [],
    };
    let tokenMissing = 0;
    let unpriced = 0;
    if (first && result.next === null)
      for (let day = first; day <= today; day = addUsageDays(day, 1)) {
        const value = measured.get(day) ?? empty();
        const captured = !incompleteHome && !missingDays.has(day);
        tokenMissing += value.tokenMissing;
        unpriced += value.unpriced;
        const cost = Number(value.price) / Number(scale);
        const tokens = Number(value.tokens);
        const row = { day, requests: value.requests };
        metrics.requests.push({ ...row, value: captured ? value.requests : null });
        metrics.tokens.push({
          ...row,
          value:
            !captured ||
            value.hidden ||
            !Number.isSafeInteger(tokens) ||
            (value.requests > 0 && value.tokenKnown === 0)
              ? null
              : tokens,
        });
        metrics.apiEstimate.push({
          ...row,
          value:
            !captured ||
            value.hidden ||
            !Number.isFinite(cost) ||
            cost > Number.MAX_SAFE_INTEGER ||
            (value.requests > 0 && value.priced === 0)
              ? null
              : cost,
        });
      }
    const calculate = (days: readonly UsageDay[], excludedRequests = 0) => {
      const forecast = usageForecast({ days, calculatedAt: result.to });
      // Back-tests cannot establish capture completeness while imports remain unconfirmed.
      return forecast.status === "available"
        ? {
            ...forecast,
            ...(excludedRequests > 0
              ? { coverage: { basis: "known-subset" as const, excludedRequests } }
              : {}),
            ...(warnings.length || excludedRequests > 0 ? { confidence: "Low" as const } : {}),
          }
        : forecast;
    };
    return {
      provider,
      requests: calculate(metrics.requests),
      tokens: calculate(metrics.tokens, tokenMissing),
      apiEstimate: calculate(metrics.apiEstimate, unpriced),
      excluded: { tokens: tokenMissing, apiEstimate: unpriced },
    };
  });
  return {
    calculatedAt: result.to,
    timezone: "Europe/Zurich",
    basis: "recorded-usage",
    warnings,
    series,
  };
}
