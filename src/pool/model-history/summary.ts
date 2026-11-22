import type { OverviewPriceTable } from "../../../apps/pool/overview-contract.ts";
import type { PoolUsageSummaryResult } from "../../../apps/pool/usage-overview-contract.ts";
import type { PoolUsageSeriesInput, PoolUsageSeriesResult } from "./series-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import { historyObject, timestamp } from "./record.ts";
import { HistoryTooLarge } from "./series-deadline.ts";
import { authorizeSeries, seriesAuthority } from "./series-input.ts";
import { homeAccountMappingProven } from "./series-mapping.ts";
import { homeCaptureCoverage } from "./capture-coverage.ts";
import { officialCostSlices } from "./official-cost.ts";
import { seriesUsageForecasts } from "./usage-forecasts.ts";
import { summaryInput } from "./summary-input.ts";
import {
  maxSummaryBytes,
  maxSummaryCostRows,
  maxSummaryModelRows,
  maxSummaryProviderRows,
  maxSummaryWindowRows,
  summaryDailyQuery,
  summarySelection,
} from "./summary-query.ts";
import { summaryCoverage } from "./summary-coverage.ts";
import { summaryGroups, summaryCostRows } from "./summary-values.ts";
import { summaryHourly } from "./summary-hourly.ts";
import { summaryIncidents } from "./summary-incidents.ts";
import { summaryKnownDays } from "./summary-known-days.ts";
import {
  rollupCoverageQuery,
  rollupDailyQuery,
  rollupPricesSupported,
  rollupSelection,
  summaryModeTargets,
} from "./summary-rollup-query.ts";
import type { HistoryReadStep } from "./read-failure.ts";

export const summarySessionSettings =
  "SELECT set_config('statement_timeout','5s',true),set_config('jit','off',true)";

type Prices = (
  targets: readonly { provider: string; model: string }[],
) => Promise<OverviewPriceTable>;

/** A bounded manager summary owns one snapshot; legacy overview and series pagination are not called. */
export async function poolUsageSummary(
  db: HistoryDatabase,
  raw: unknown,
  currentPrices?: Prices,
  now = Date.now(),
  /** Labels the statements that follow, so a failure names its step rather than an ordinal. */
  mark: (step: HistoryReadStep) => void = () => {},
  windowRows = maxSummaryWindowRows,
): Promise<PoolUsageSummaryResult> {
  const parsed = summaryInput(raw);
  const value = historyObject(raw);
  const policy = historyObject(value.authority);
  const authority = seriesAuthority(
    policy,
    policy.mappingProven === true && homeAccountMappingProven,
  );
  authorizeSeries({}, authority);
  const { input, pool, readFrom, previous, heatmapFrom } = parsed;
  mark("begin");
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    // JIT compiling these wide plans costs seconds and buys nothing on bounded reads.
    await db.query(summarySessionSettings);
    let selection = await summarySelection(pool, readFrom, input.to, authority);
    // A pool whose rollup is ready reads it; every range boundary cuts its groups.
    const boundaries = [readFrom, input.from, input.to, previous.from, previous.to, heatmapFrom];
    const targetQuery = summaryModeTargets(selection, windowRows, boundaries);
    mark("targets");
    const first = (await db.query(targetQuery.text, targetQuery.values)).rows;
    if (first.some((row) => row.window_rows !== null)) throw new HistoryTooLarge();
    const targets = first.filter((row) => row.kind === "target");
    let rolled = first.some((row) => row.kind === "rollup");
    const priceUnavailableReason =
      targets.length > 100
        ? "More than 100 provider/model pairs need prices; money estimates are unavailable."
        : undefined;
    let prices: OverviewPriceTable = { prices: [], issues: [] };
    if (targets.length <= 100 && currentPrices)
      try {
        prices = await currentPrices(
          targets.map((row) => ({ provider: String(row.provider), model: String(row.model) })),
        );
      } catch {
        prices = { prices: [], issues: [] };
      }
    selection = await summarySelection(pool, readFrom, input.to, authority, prices);
    // A price tier the rollup's bands cannot separate is priced exactly only from raw rows.
    if (rolled && !rollupPricesSupported(String(selection.values[6]))) rolled = false;
    const source = rolled ? rollupSelection(selection, boundaries) : selection;
    mark("coverage");
    const observed = await summaryCoverage(
      db,
      source,
      authority,
      rolled ? rollupCoverageQuery : undefined,
    );
    const dailyQuery = (rolled ? rollupDailyQuery : summaryDailyQuery)(
      source,
      input.from,
      previous.from,
      input.by === "model",
    );
    mark("daily");
    const rows = (await db.query(dailyQuery.text, dailyQuery.values)).rows;
    const historyRows = rows.filter((row) => row.scope === "history");
    const providerRows = rows.filter((row) => row.scope === "current");
    const previousRows = rows.filter((row) => row.scope === "previous");
    const modelRows = rows.filter((row) => row.scope === "model");
    const costRows = rows.filter((row) => row.scope === "cost");
    if (
      [historyRows, providerRows, previousRows].some((rows) => rows.length > maxSummaryProviderRows)
    )
      throw new Error("Daily provider summary exceeds its bounded response");
    const seriesInput: PoolUsageSeriesInput = {
      pool,
      from: readFrom,
      to: input.to,
      bucket: "day",
      by: ["provider"],
      timezone: "Europe/Zurich",
    };
    const history = summaryGroups(historyRows, seriesInput, prices, priceUnavailableReason);
    const daily = summaryGroups(
      providerRows,
      { ...seriesInput, from: input.from },
      prices,
      priceUnavailableReason,
    );
    const previousDaily = summaryGroups(
      previousRows,
      { ...seriesInput, ...previous },
      prices,
      priceUnavailableReason,
    );
    const incidentTo = timestamp(new Date(now).toISOString());
    const captureTo = [input.to, incidentTo].sort().at(-1)!;
    mark("capture");
    const capture = await homeCaptureCoverage(
      db,
      String(selection.values[0]),
      selection.homeSource,
      readFrom,
      captureTo,
    );
    const series: PoolUsageSeriesResult = {
      from: readFrom,
      to: input.to,
      bucket: "day",
      timezone: "Europe/Zurich",
      asOf: observed.asOf,
      coverage: observed.coverage,
      groups: history.series,
      next: null,
    };
    const historyCoverage = summaryKnownDays(readFrom, input.to, observed.coverage, capture);
    const hourlySelection = await summarySelection(
      pool,
      [input.from, heatmapFrom].sort()[0]!,
      input.to,
      authority,
    );
    mark("hourly");
    const hourly = await summaryHourly(
      db,
      rolled ? rollupSelection(hourlySelection, boundaries) : hourlySelection,
      input.from,
      heatmapFrom,
      input.to,
      rolled,
    );
    const missingHours = capture.incompleteHours;
    const nativeComplete =
      observed.nativeMappingProven &&
      missingHours !== null &&
      observed.coverage.sources.find((source) => source.kind === "home")?.backfillComplete === true;
    const completeHours: string[] = [];
    if (nativeComplete && hourly.nativeAvailable && missingHours !== null)
      for (
        let at = Math.ceil(Date.parse(input.from) / 3_600_000) * 3_600_000;
        at + 3_600_000 <= Date.parse(input.to);
        at += 3_600_000
      ) {
        const key = new Date(at).toISOString();
        if (!missingHours.has(key.slice(0, 19) + "Z")) completeHours.push(key);
      }
    const complete = new Set(completeHours.map((at) => Date.parse(at)));
    const incidentFrom = now - 3_600_000;
    mark("incidents");
    const reliability = await summaryIncidents(
      db,
      pool,
      incidentTo,
      nativeComplete &&
        missingHours !== null &&
        ![...missingHours].some((at) => Date.parse(at) + 3_600_000 > incidentFrom),
      observed.terminalReady,
    );
    const forecasts = seriesUsageForecasts(series, capture, historyCoverage.known);
    let result: PoolUsageSummaryResult = {
      from: input.from,
      to: input.to,
      timezone: "Europe/Zurich",
      previous,
      readFrom,
      asOf: observed.asOf,
      retainedFirstAt: observed.retainedFirstAt,
      coverage: observed.coverage,
      historyCoverage: {
        from: readFrom,
        to: input.to,
        knownDays: [...historyCoverage.known],
        gapDays: historyCoverage.gaps,
      },
      daily: daily.groups,
      previousDaily: previousDaily.groups,
      models:
        input.by !== "model"
          ? null
          : modelRows.length > maxSummaryModelRows
            ? {
                status: "unavailable",
                groups: [],
                reason: "The model chart exceeds its bounded response. Use a shorter range.",
              }
            : {
                status: "available",
                groups: summaryGroups(
                  modelRows,
                  { ...seriesInput, from: input.from, by: ["provider", "model"] },
                  prices,
                  priceUnavailableReason,
                ).groups,
              },
      forecasts: priceUnavailableReason
        ? { ...forecasts, warnings: [...forecasts.warnings, priceUnavailableReason] }
        : forecasts,
      usageSlices:
        costRows.length > maxSummaryCostRows
          ? []
          : officialCostSlices(
              summaryCostRows(costRows, input.from),
              prices.prices,
              [],
              prices.issues,
              priceUnavailableReason,
            ),
      ...(costRows.length > maxSummaryCostRows
        ? {
            usageSlicesUnavailableReason:
              "The cost breakdown exceeds its bounded response. Use a shorter range.",
          }
        : {}),
      heatmap: hourly.heatmap,
      ...reliability,
      homeCapture: {
        status:
          !nativeComplete || !hourly.nativeAvailable
            ? "unavailable"
            : missingHours!.size > 0
              ? "partial"
              : "available",
        ...(!hourly.nativeAvailable
          ? {
              reason:
                "The native request history exceeds its bounded response. Use a shorter range.",
            }
          : {}),
        capturedAt: capture.capturedAt,
        completeHours,
      },
      requestsByHour: hourly.native.map((point) => ({
        ...point,
        coverage: complete.has(Date.parse(point.at)) ? 1 : null,
      })),
      partial:
        priceUnavailableReason !== undefined ||
        hourly.partial ||
        costRows.length > maxSummaryCostRows ||
        modelRows.length > maxSummaryModelRows ||
        !nativeComplete ||
        (missingHours?.size ?? 0) > 0,
    };
    if (
      new TextEncoder().encode(JSON.stringify(result)).byteLength > maxSummaryBytes &&
      result.models !== null
    )
      result = {
        ...result,
        partial: true,
        models: {
          status: "unavailable",
          groups: [],
          reason: "The model chart exceeds its bounded response. Use a shorter range.",
        },
      };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxSummaryBytes)
      throw new Error("Usage summary exceeds its bounded response");
    mark("commit");
    await db.query("COMMIT");
    return result;
  } catch (error) {
    mark("rollback");
    // A broken session cannot let the rollback replace the cause.
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
