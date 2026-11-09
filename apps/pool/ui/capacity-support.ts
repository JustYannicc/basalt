import type { Account } from "../contract.ts";

export type LimitAccount = Pick<Account, "provider" | "plan" | "windows"> &
  Partial<Pick<Account, "freshness">>;

const claudePlans = new Set(["pro", "max", "max 5x", "max 20x", "ultra"]);
const codexPlans = new Set([
  "plus",
  "pro",
  "pro 5x",
  "pro 20x",
  "pro (max)",
  "pro (mid)",
  "promax",
  "prolite",
]);

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

/** Plan support is separate from a current allowance measurement. Unknown plans need evidence. */
export function supportedLimitWindows(account: LimitAccount): readonly number[] {
  const plan = account.plan?.trim().toLowerCase();
  const known =
    plan !== undefined &&
    ((account.provider === "claude" && claudePlans.has(plan)) ||
      (account.provider === "codex" && codexPlans.has(plan)));
  return known
    ? [604_800, 18_000]
    : [
        ...new Set(
          account.windows
            .map((window) => window.windowSeconds)
            .filter((seconds): seconds is number => seconds === 18_000 || seconds === 604_800),
        ),
      ];
}
