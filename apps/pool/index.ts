import { defineApp, boolean, number, object, query, type QueryContext, router } from "apps";
import { type PoolView, type UsageSummary } from "./contract.ts";
import { providerAccountView } from "./provider-account-view.ts";
import { requirements } from "./requirements.ts";
import { control, type Result } from "./control.ts";
import { importUsage } from "./import-actions.ts";
export { importUsage } from "./import-actions.ts";
export type { Result } from "./control.ts";
import {
  refreshUsage,
  pauseAccount,
  resumeAccount,
  clearCooldown,
  resetCredits,
  resetAttempt,
  useReset,
} from "./account-actions.ts";
import { publicHistory } from "./history-query.ts";
export { publicHistory } from "./history-query.ts";
import type { Computer, PoolChoice } from "./ui/computer-types.ts";

type Context = QueryContext<typeof requirements>;

export const view = query(
  {
    description:
      "This pool's accounts with their limit windows, reading freshness and banked resets, and its supported providers. Set fresh to await revalidation instead of returning the retained view.",
    input: object({ fresh: boolean().optional() }),
  },
  async (ctx: Context, { fresh }): Promise<Result<PoolView>> => {
    const result = await control<PoolView>(ctx, fresh ? "/pool?fresh=true" : "/pool");
    return result.ok ? { ok: true, value: await providerAccountView(ctx, result.value) } : result;
  },
);

export const usage = query(
  {
    description:
      "Tokens and API-equivalent cost through this pool for the last `days` days (1 to 30, default 30), per model, per UTC day and per serving account. The pool's owner gets the whole pool, each member's totals and cap by tools-service user id, with no account-sizing verdict. Seasonal account advice is available through capacity after four completed weeks and its evidence checks. Anyone else gets only their own usage on this pool and their own weekly cap with when it resets.",
    input: object({ days: number().optional() }),
  },
  async (ctx: Context, { days }) =>
    control<UsageSummary>(
      ctx,
      `/usage/summary?days=${Math.min(30, Math.max(1, Math.round(days ?? 30)))}`,
    ),
);

export const capacity = query(
  {
    description:
      "Measured capacity and seasonal projections for pool managers (1 to 90 days, default 30). Forecasts need two completed weeks, sizing advice four. Banked resets are never spent by a forecast.",
    input: object({ days: number().optional(), to: number().optional() }),
  },
  async (ctx: Context, { days, to }) =>
    control<import("./capacity-contract.ts").PoolCapacityHistory>(
      ctx,
      `/usage/capacity?days=${Math.min(90, Math.max(1, Math.round(days ?? 30)))}${to === undefined ? "" : `&to=${encodeURIComponent(to)}`}`,
    ),
);

export interface ComputerContext {
  readonly href: string;
  readonly computers: Computer[];
  readonly pools?: PoolChoice[];
  readonly undoPrompt: string;
  /** Native app settings for a caller who can manage this pool. */
  readonly shareHref?: string;
  /** The host owns the pool's single saved-account list for every authorized caller. */
  readonly accountsHref?: string;
}

export const computerContext = query(
  {
    description:
      "Your computers in every pool you use, the pools you can pick for each, and a short-lived setup `href`. If you can manage this pool, `shareHref` opens native app Settings for sharing, per-person usage and caps.",
    input: object({}),
  },
  async (ctx: Context) => control<ComputerContext>(ctx, "/setup-context"),
);

export default defineApp(requirements, {
  tools: router({
    importUsage,
    view,
    usage,
    capacity,
    publicHistory,
    computerContext,
    refreshUsage,
    pauseAccount,
    resumeAccount,
    clearCooldown,
    resetCredits,
    resetAttempt,
    useReset,
  }),
});
