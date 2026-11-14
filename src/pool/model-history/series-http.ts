import type { HomeClient } from "../control.ts";
import { sessionSuccess } from "./session-success.ts";
import { controlBasePath } from "../../../apps/pool/contract.ts";
import { fail, failureResponse, json, object, readBody } from "../json.ts";
import { openEnvelope } from "../token.ts";
import { digest } from "../backend-users.ts";
import { withHistoryDatabase } from "./database.ts";
import { HistoryInputError, historyObject } from "./record.ts";
import { seriesAuthority } from "./series-input.ts";
import { poolUsageSeries } from "./series.ts";
import {
  overviewTargets,
  personalOverviewTargets,
  poolPersonalOverview,
  poolUsageOverview,
} from "./overview.ts";
import type {
  OverviewApiPrice,
  OverviewPriceIssue,
  OverviewPriceTable,
  PoolOverviewSignedInput,
  PoolPersonalOverviewSignedInput,
} from "../../../apps/pool/overview-contract.ts";
import { lastSuccessAt } from "./last-success.ts";
import { poolUsageSummary } from "./summary.ts";
import { summaryInput } from "./summary-input.ts";
import { HistoryDeadline } from "./series-deadline.ts";
import { historyPhase, historySeriesDiagnostics } from "./series-diagnostics.ts";

export const poolUsageSeriesPath = `${controlBasePath}/usage/series`;
export const lastSuccessAtPath = `${controlBasePath}/usage/last-success`;
export const poolOverviewPath = `${controlBasePath}/usage/overview`;
export const poolPersonalOverviewPath = `${controlBasePath}/usage/personal-overview`;
export const poolUsageSummaryPath = `${controlBasePath}/usage/summary`;

/** Native host policy authorizes this exact signed read while holding its organization lock. */
export async function handleUsageSeries(
  request: Request,
  access: {
    home?: HomeClient;
    signingKey: string;
    previousSigningKey?: string;
    connectionString: string | undefined;
    accountLabels?: (pool: string) => Promise<Readonly<Record<string, string>>>;
    currentPrices?: (
      targets: readonly { provider: string; model: string }[],
    ) => Promise<OverviewPriceTable>;
  },
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const diagnostics = path === poolUsageSeriesPath ? historySeriesDiagnostics() : undefined;
  const deadline = diagnostics ? new HistoryDeadline(5_000, request.signal) : undefined;
  const bounded = <T>(work: () => Promise<T>) => (deadline ? deadline.run(work) : work());
  try {
    if (request.method !== "POST")
      return fail(404, "not_found", "This pool endpoint does not exist.");
    const bytes = await bounded(() => readBody(request, 2_097_152));
    if (bytes === undefined)
      return fail(413, "invalid_query", "The usage assertion exceeds its limit.");
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const action =
      path === poolUsageSummaryPath
        ? "poolUsageSummary"
        : path === poolUsageSeriesPath
          ? "poolUsageSeries"
          : path === poolOverviewPath
            ? "poolOverview"
            : path === poolPersonalOverviewPath
              ? "poolPersonalOverview"
              : "lastSuccessAt";
    // This DO validates the signed host assertion. Membership is read by the host.
    const payload = await historyPhase(diagnostics, "signed_envelope_validation", () =>
      bounded(async () => {
        const payload =
          object(body) && typeof body.envelope === "string"
            ? await openEnvelope(
                access.signingKey,
                "sbs1",
                body.envelope,
                access.previousSigningKey,
              )
            : undefined;
        if (
          !object(payload) ||
          payload.action !== action ||
          typeof payload.expiresAt !== "number" ||
          payload.expiresAt <= Date.now() ||
          payload.expiresAt > Date.now() + 30_000
        )
          return fail(401, "unauthorized", "A valid host usage assertion is required.");
        return payload;
      }),
    );
    const input = historyObject(payload.input);
    if (
      typeof payload.pool !== "string" ||
      !payload.pool ||
      input.pool !== payload.pool ||
      typeof payload.user !== "string" ||
      !payload.user ||
      typeof payload.organization !== "string" ||
      !payload.organization
    )
      throw new HistoryInputError();
    if (action === "poolPersonalOverview") {
      const allowed = new Set(["action", "pool", "user", "organization", "expiresAt", "input"]);
      const personalInputFields = new Set(["pool", "person", "from", "to", "days", "offerings"]);
      if (Object.keys(payload).some((key) => !allowed.has(key)))
        return fail(401, "unauthorized", "A caller-bound personal usage assertion is required.");
      if (Object.keys(input).some((key) => !personalInputFields.has(key)))
        throw new HistoryInputError();
      if (
        typeof input.person !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.person) ||
        input.person !== (await digest(payload.user))
      )
        return fail(401, "unauthorized", "A caller-bound personal usage assertion is required.");
    }
    if (action === "poolUsageSeries" || action === "lastSuccessAt") {
      const authority = seriesAuthority(payload.authority);
      const pool = payload.pool;
      const currentPrices = access.currentPrices;
      const labels =
        action === "poolUsageSeries" && Array.isArray(input.by) && input.by.includes("account")
          ? await historyPhase(diagnostics, "account_labels", () =>
              bounded(async () => access.accountLabels?.(pool)),
            )
          : undefined;
      const result =
        action === "poolUsageSeries"
          ? await historyPhase(diagnostics, "series_read", () =>
              bounded(() =>
                withHistoryDatabase(
                  access.connectionString,
                  (db) =>
                    poolUsageSeries(
                      db,
                      input,
                      authority,
                      "owned",
                      currentPrices
                        ? (targets) =>
                            historyPhase(diagnostics, "price_callback", () =>
                              bounded(() => currentPrices(targets)),
                            )
                        : undefined,
                      labels,
                    ),
                  {
                    totalTimeoutMs: 5_000,
                    timeoutFailure: "history",
                    signal: deadline?.signal,
                    diagnostics,
                  },
                ),
              ),
            )
          : input.session !== undefined && access.home !== undefined
            ? await sessionSuccess(access.home, input, authority, {
                pool: payload.pool,
                user: payload.user,
              })
            : await withHistoryDatabase(access.connectionString, (db) =>
                lastSuccessAt(db, input, authority),
              );
      return json(result);
    }
    if (action === "poolUsageSummary") {
      seriesAuthority(input.authority);
      summaryInput(input);
      return json(
        await withHistoryDatabase(access.connectionString, (db) =>
          poolUsageSummary(db, input, access.currentPrices),
        ),
      );
    }
    const result =
      action === "poolOverview"
        ? await withHistoryDatabase(access.connectionString, async (db) => {
            const overview = input as unknown as PoolOverviewSignedInput;
            await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
            try {
              await db.query("SET LOCAL statement_timeout = '5s'");
              const priceTargets = await overviewTargets(db, overview);
              let prices: readonly OverviewApiPrice[] = [];
              let priceIssues: readonly OverviewPriceIssue[] = [];
              let pricesUnavailableReason = priceTargets.unavailableReason;
              if (!pricesUnavailableReason && access.currentPrices) {
                try {
                  ({ prices, issues: priceIssues } = await access.currentPrices(
                    priceTargets.targets,
                  ));
                } catch {
                  pricesUnavailableReason = "Current API price data could not be read.";
                }
              } else if (!pricesUnavailableReason)
                pricesUnavailableReason = "Current API price data is unavailable.";
              const result = await poolUsageOverview(
                db,
                {
                  ...overview,
                  prices,
                  priceIssues,
                  ...(pricesUnavailableReason ? { pricesUnavailableReason } : {}),
                },
                "caller",
              );
              await db.query("COMMIT");
              return result;
            } catch (error) {
              await db.query("ROLLBACK").catch(() => {});
              throw error;
            }
          })
        : await withHistoryDatabase(access.connectionString, async (db) => {
            const overview = input as unknown as PoolPersonalOverviewSignedInput;
            await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
            try {
              await db.query("SET LOCAL statement_timeout = '5s'");
              const priceTargets = await personalOverviewTargets(db, overview);
              let prices: readonly OverviewApiPrice[] = [];
              let priceIssues: readonly OverviewPriceIssue[] = [];
              let pricesUnavailableReason = priceTargets.unavailableReason;
              if (!pricesUnavailableReason && access.currentPrices) {
                try {
                  ({ prices, issues: priceIssues } = await access.currentPrices(
                    priceTargets.targets,
                  ));
                } catch {
                  pricesUnavailableReason = "Current API price data could not be read.";
                }
              } else if (!pricesUnavailableReason)
                pricesUnavailableReason = "Current API price data is unavailable.";
              const result = await poolPersonalOverview(
                db,
                overview,
                prices,
                pricesUnavailableReason,
                "caller",
                priceIssues,
              );
              await db.query("COMMIT");
              return result;
            } catch (error) {
              await db.query("ROLLBACK").catch(() => {});
              throw error;
            }
          });
    return json(result);
  } catch (error) {
    if (error instanceof HistoryInputError || error instanceof SyntaxError)
      return json(
        {
          error: "invalid_query",
          message: "Provide valid usage bounds, dimensions and a cursor for this read.",
        },
        400,
      );
    return failureResponse(error);
  } finally {
    deadline?.dispose();
  }
}
