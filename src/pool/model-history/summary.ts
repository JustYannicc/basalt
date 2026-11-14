import type { OverviewPriceTable } from "../../../apps/pool/overview-contract.ts";
import type { PoolUsageSummaryResult } from "../../../apps/pool/usage-overview-contract.ts";
import type { PoolUsageSeriesInput, PoolUsageSeriesResult } from "./series-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import { historyObject, timestamp } from "./record.ts";
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
  summaryDailyQuery,
  summaryPriceTargets,
  summarySelection,
} from "./summary-query.ts";
import { summaryCoverage } from "./summary-coverage.ts";
import { summaryGroups, summaryCostRows } from "./summary-values.ts";
import { summaryHourly } from "./summary-hourly.ts";
import { summaryIncidents } from "./summary-incidents.ts";
import { summaryKnownDays } from "./summary-known-days.ts";

type Prices = (
  targets: readonly { provider: string; model: string }[],
) => Promise<OverviewPriceTable>;

/** A bounded manager summary owns one snapshot; legacy overview and series pagination are not called. */
export async function poolUsageSummary(
  db: HistoryDatabase,
  raw: unknown,
  currentPrices?: Prices,
  now = Date.now(),
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
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    let selection = await summarySelection(pool, readFrom, input.to, authority);
    const targetQuery = summaryPriceTargets(selection);
    const targets = (await db.query(targetQuery.text, targetQuery.values)).rows;
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
    const observed = await summaryCoverage(db, selection, authority);
    const dailyQuery = summaryDailyQuery(
      selection,
      input.from,
      previous.from,
      input.by === "model",
    );
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
    const hourly = await summaryHourly(db, hourlySelection, input.from, heatmapFrom, input.to);
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
    const incidents = await summaryIncidents(
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
      incidents,
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
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
