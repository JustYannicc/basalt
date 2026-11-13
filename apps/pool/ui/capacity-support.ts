import { planAllowanceWindows, type PlanAllowanceCatalog } from "apps";
import type { Account } from "../contract.ts";

export type LimitAccount = Pick<Account, "provider" | "plan" | "windows"> &
  Partial<Pick<Account, "freshness">>;

/** Home readings expire after 30 minutes; a quota reset does not renew the measurement. */
export function hasCurrentLimitReading(
  account: LimitAccount,
  seconds: number,
  at: number,
): boolean {
  return (
    account.freshness === "fresh" &&
    account.windows.some((window) => {
      const observed = Date.parse(window.observedAt ?? "");
      return (
        window.windowSeconds === seconds &&
        window.remainingRatio !== null &&
        Number.isFinite(window.remainingRatio) &&
        Number.isFinite(observed) &&
        observed <= at &&
        at - observed < 30 * 60_000
      );
    })
  );
}

const chartWindows = new Set([18_000, 604_800]);
const noCatalog: PlanAllowanceCatalog = { entries: [] };

/**
 * Plan support is separate from a current allowance measurement. Windows the account actually
 * reports always count, even where the catalog calls the plan unlimited; the catalog only adds
 * windows it currently knows. Without a catalog only reported windows count.
 */
export function supportedLimitWindows(
  account: LimitAccount,
  catalog: PlanAllowanceCatalog = noCatalog,
  now: number = Date.now(),
): readonly number[] {
  const reported = account.windows
    .map((window) => window.windowSeconds)
    .filter((seconds): seconds is number => seconds !== null && chartWindows.has(seconds));
  return planAllowanceWindows(
    catalog,
    account.provider,
    account.plan ?? null,
    reported,
    now,
  ).filter((seconds) => chartWindows.has(seconds));
}
