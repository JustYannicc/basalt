import type { Account } from "../contract.ts";

export type LimitAccount = Pick<Account, "provider" | "plan" | "windows">;

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
