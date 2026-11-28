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
import { summaryHeatmapTo, summaryHourly, summaryHourlyFigures } from "./summary-hourly.ts";
import { summaryIncidents } from "./summary-incidents.ts";
import { summaryKnownDays } from "./summary-known-days.ts";
import {
  maxSummaryRollupGroups,
  rollupSupportedPrices,
  rollupSelection,
  summaryModeTargets,
} from "./summary-rollup-query.ts";
import { rollupFigures } from "./summary-rollup-figures.ts";
import type { HistoryReadStep } from "./read-failure.ts";

/** One statement: the read's timeout, no JIT, and whether each rollup's tables exist yet. */
export const summarySessionSettings = `SELECT set_config('statement_timeout','5s',true),
  set_config('jit','off',true),to_regclass('basalt_model_usage_ready') IS NOT NULL AS rollup_tables,
  to_regclass('basalt_model_usage_people_ready') IS NOT NULL AS people_tables`;

type Prices = (
  targets: readonly { provider: string; model: string }[],
) => Promise<OverviewPriceTable>;

/** Three missed capture runs: a capture further behind than this is behind, not merely lagging. */
export const summaryCaptureLagMs = 15 * 60_000;

/** A bounded manager summary owns one snapshot; legacy overview and series pagination are not called. */
export async function poolUsageSummary(
  db: HistoryDatabase,
  raw: unknown,
  currentPrices?: Prices,
  now = Date.now(),
  /** Labels the statements that follow, so a failure names its step rather than an ordinal. */
  mark: (step: HistoryReadStep) => void = () => {},
  windowRows = maxSummaryWindowRows,
  rollupGroups = maxSummaryRollupGroups,
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
    const settings = (await db.query(summarySessionSettings)).rows[0];
    let selection = await summarySelection(pool, readFrom, input.to, authority);
    // A pool whose rollup is ready reads it; every range boundary cuts its groups.
    const boundaries = [readFrom, input.from, input.to, previous.from, previous.to, heatmapFrom];
    const targetQuery = summaryModeTargets(
      selection,
      windowRows,
      boundaries,
      settings?.rollup_tables === true,
      rollupGroups,
      settings?.people_tables === true,
    );
    mark("targets");
    const first = (await db.query(targetQuery.text, targetQuery.values)).rows;
    if (first.some((row) => row.window_rows !== null)) throw new HistoryTooLarge();
    const targets = first.filter((row) => row.kind === "target");
    const rollup = first.find((row) => row.kind === "rollup");
    const rolled = rollup !== undefined;
    const target = rollup?.provider === "v16" ? "v16" : "v15";
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
    // A pair with a price tier the rollup's bands cannot separate counts as missing a price.
    if (rolled) prices = rollupSupportedPrices(prices);
    selection = await summarySelection(pool, readFrom, input.to, authority, prices);
    const source = rolled ? rollupSelection(selection, boundaries, target) : selection;
    const heatmapTo = summaryHeatmapTo(input.to);
    // A rolled summary reads its window's groups once, for coverage, daily and hourly together.
    // The hourly window starts at input.from or heatmapFrom, both cuts inside readFrom's window.
    let figures: Awaited<ReturnType<typeof rollupFigures>> | undefined;
    if (rolled) {
      mark("figures");
      figures = await rollupFigures(db, source, {
        from: input.from,
        previousFrom: previous.from,
        heatmapFrom,
        heatmapTo,
        models: input.by === "model",
      });
    }
    mark("coverage");
    const observed = await summaryCoverage(db, source, authority, figures?.coverage);
    let rows = figures?.daily;
    if (rows === undefined) {
      const dailyQuery = summaryDailyQuery(source, input.from, previous.from, input.by === "model");
      mark("daily");
      rows = (await db.query(dailyQuery.text, dailyQuery.values)).rows;
    }
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
    // The capture ingests on every model-history pass, about every five minutes, so its newest
    // minutes are normally not captured yet. The check runs to the later of the capture's recorded
    // position and three missed runs ago, and never past the window or now: a usage row in that
    // normal lag is not captured yet, never missing, while one older than it with no request is
    // missing, so a capture that has fallen behind reads partial. A window that ended before that
    // is checked whole, as before. Without a recorded position the check runs to now, as before.
    // Every bound is normalised by timestamp(), so the comparisons are exact.
    const capturedThrough = observed.coverage.capturedThrough;
    const settled = timestamp(new Date(now - summaryCaptureLagMs).toISOString());
    const end = [input.to, incidentTo].sort().at(-1)!;
    const checkedThrough =
      capturedThrough === null ? end : [end, [capturedThrough, settled].sort().at(-1)!].sort()[0]!;
    const captureTo = [readFrom, checkedThrough].sort().at(-1)!;
    // Only an hour or a day the check has passed whole can be complete; the rest are not yet.
    const capturedMs = Date.parse(captureTo);
    // Both of its statements, the stored hours' comparison and the rows it leaves, are this step. A
    // pool read from v16 is ready on it, so its stored counts can stand in for the per-row check,
    // and its per-row check of the tail and cut hours runs to the same captureTo.
    mark("capture");
    const capture = await homeCaptureCoverage(
      db,
      String(selection.values[0]),
      selection.homeSource,
      readFrom,
      captureTo,
      rolled && target === "v16",
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
    const historyCoverage = summaryKnownDays(
      readFrom,
      input.to,
      observed.coverage,
      capture,
      captureTo,
    );
    let hourly: ReturnType<typeof summaryHourlyFigures>;
    if (figures) hourly = summaryHourlyFigures(figures.hourly, heatmapFrom, heatmapTo);
    else {
      const hourlySelection = await summarySelection(
        pool,
        [input.from, heatmapFrom].sort()[0]!,
        input.to,
        authority,
      );
      mark("hourly");
      hourly = await summaryHourly(db, hourlySelection, input.from, heatmapFrom, input.to);
    }
    const missingHours = capture.incompleteHours;
    // Whether every Home usage row has its request, which is not whether each request's account is
    // saved in the pool: an unmapped account is counted as unmapped in the coverage and in the
    // account views, and never makes a captured hour unproven.
    const nativeComplete =
      missingHours !== null &&
      observed.coverage.sources.find((source) => source.kind === "home")?.backfillComplete === true;
    const completeHours: string[] = [];
    if (nativeComplete && hourly.nativeAvailable && missingHours !== null)
      for (
        let at = Math.ceil(Date.parse(input.from) / 3_600_000) * 3_600_000;
        at + 3_600_000 <= Math.min(Date.parse(input.to), capturedMs);
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
        ![...missingHours].some((at) => Date.parse(at) + 3_600_000 > incidentFrom) &&
        capturedMs >= Date.parse(incidentTo),
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
