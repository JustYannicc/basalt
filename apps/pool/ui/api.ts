import { json, type Schema } from "apps";
import type { importUsage } from "../import-actions.ts";
import type { UsageImportPage, UsageImportResult } from "../import-contract.ts";
import { ChangeReadRetry, createAppClient, mutationReference, queryReference } from "apps/client";
import type {
  capacity,
  ComputerContext,
  computerContext,
  publicHistory,
  Result,
  usage,
  view,
} from "../index.ts";
import { readWhileActive } from "./active-read.ts";
import { productName } from "../deployment.ts";
import type { PoolView, UsageSummary } from "../contract.ts";

const client = createAppClient();
// The server shapes each result as the contract describes; the page reads it as that.
const result = <T>() => json() as unknown as Schema<Result<T>, boolean>;

function read<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((error) => {
    if (error instanceof ChangeReadRetry) throw error;
    return {
      ok: false,
      error: "backend_unavailable",
      message: `${productName} couldn't reach your pool. Try again.`,
    };
  });
}

export const pool = {
  publicHistory: (input: import("../history-contract.ts").PublicHistoryQuery) =>
    read(
      readWhileActive(client, (signal) =>
        client.query(
          queryReference<typeof publicHistory>("publicHistory"),
          input,
          result<import("../history-contract.ts").PublicHistoryPage>(),
          { signal },
        ),
      ),
    ),
  importUsage: (input: UsageImportPage) =>
    read(
      client.mutate(
        mutationReference<typeof importUsage>("importUsage"),
        input,
        result<UsageImportResult>(),
      ),
    ),
  capacity: (days: 7 | 30 | 90, to?: number, signal?: AbortSignal) =>
    read(
      client.query(
        queryReference<typeof capacity>("capacity"),
        { days, ...(to === undefined ? {} : { to }) },
        result<import("../capacity-contract.ts").PoolCapacityHistory>(),
        signal === undefined ? undefined : { signal },
      ),
    ),
  overviewUsage: async (
    input: import("../overview-contract.ts").PoolOverviewInput,
  ): Promise<Result<import("../overview-contract.ts").PoolOverviewResult>> => {
    try {
      const context = JSON.parse(document.getElementById("executor-context")?.textContent ?? "{}");
      const response = await fetch("/_executor/api/pool-usage/overview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: context.version ?? context.deployment, input }),
      });
      if (!response.ok)
        return {
          ok: false,
          error: response.status === 403 ? "unauthorized" : "backend_unavailable",
          message:
            response.status === 403
              ? "Pool usage is available to managers only."
              : "Overview could not be read. Reload and try again.",
        };
      return { ok: true, value: await response.json() };
    } catch {
      return {
        ok: false,
        error: "backend_unavailable",
        message: "Overview could not be read. Try again.",
      };
    }
  },
  personalOverview: async (
    input: import("../overview-contract.ts").PoolOverviewInput,
  ): Promise<Result<import("../overview-contract.ts").PoolPersonalOverviewResult>> => {
    try {
      const context = JSON.parse(document.getElementById("executor-context")?.textContent ?? "{}");
      const response = await fetch("/_executor/api/pool-usage/personal-overview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: context.version ?? context.deployment, input }),
      });
      if (!response.ok)
        return {
          ok: false,
          error: response.status === 403 ? "unauthorized" : "backend_unavailable",
          message:
            response.status === 403
              ? "Your usage isn't available for this pool."
              : "Your usage could not be read. Reload and try again.",
        };
      return { ok: true, value: await response.json() };
    } catch {
      return {
        ok: false,
        error: "backend_unavailable",
        message: "Your usage could not be read. Try again.",
      };
    }
  },
  series: async (
    input: Omit<import("../usage-series-contract.ts").PoolUsageSeriesInput, "pool">,
  ): Promise<Result<import("../usage-series-contract.ts").PoolUsageSeriesResult>> => {
    try {
      return await readWhileActive(client, async (signal) => {
        const context = JSON.parse(
          document.getElementById("executor-context")?.textContent ?? "{}",
        );
        const response = await fetch("/_executor/api/pool-usage/series", {
          signal,
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: context.version ?? context.deployment, input }),
        });
        if (!response.ok)
          return {
            ok: false,
            error: "unauthorized",
            message:
              response.status === 403
                ? "Pool usage is available to managers only."
                : "Usage could not be read. Reload and try again.",
          };
        return { ok: true, value: await response.json() };
      });
    } catch (error) {
      if (error instanceof ChangeReadRetry) throw error;
      return {
        ok: false,
        error: "backend_unavailable",
        message: "Usage could not be read. Try again.",
      };
    }
  },
  computerContext: () =>
    read(
      client.query(
        queryReference<typeof computerContext>("computerContext"),
        {},
        result<ComputerContext>(),
      ),
    ),
  /** `fresh` waits for a live read; otherwise the pool may answer at once from its retained view. */
  view: (options: { readonly fresh?: boolean } = {}) =>
    read(
      client.query(
        queryReference<typeof view>("view"),
        options.fresh ? { fresh: true } : {},
        result<PoolView>(),
      ),
    ),
  usage: () =>
    read(client.query(queryReference<typeof usage>("usage"), { days: 30 }, result<UsageSummary>())),
  /** Refreshes on an interval only while someone sees the page, including behind the host's other tabs. */
  poll: client.poll,
  /** Committed-revision feed; pool data reads again only when it reports a change. */
  changes: client.changes,
};

export type PoolApi = typeof pool;
