/** Capacity policy is separate from plan price, credential mechanism and account health. */
export interface CapacityWeight {
  readonly multiplier: number;
  readonly source:
    | "reference-plan"
    | "published-session-multiplier"
    | "published-weekly-multiplier"
    | "plan-multiplier"
    | "unknown-plan";
  readonly known: boolean;
  readonly unit: { readonly id: string; readonly label: string };
  readonly revision: string;
}

export const capacityWeightRevision = "2026-10-30";
const claudeWeeklyWeightRevision = "2026-11-09";
const claudeSessionMultiples = new Map([
  ["max 5x", 5],
  ["max 20x", 20],
]);
// Max 20x follows the pool's 20x plan policy; Max 5x and Ultra retain published weekly limits.
// https://support.claude.com/en/articles/11049741-what-is-the-max-plan
// https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan
const claudeWeeklyMultiples = new Map([
  ["max 5x", 5],
  ["max 20x", 20],
  ["ultra", 10],
]);

/** A missing plan is a flagged 1x contribution, never a known candidate-account weight. */
export function capacityWeight(
  provider: string,
  plan: string | null,
  windowSeconds: number,
): CapacityWeight {
  const name = plan?.trim().toLowerCase();
  const claude = provider === "claude" || provider === "anthropic";
  const codex = provider === "codex" || provider === "openai";
  const unit = claude
    ? { id: "claude-pro-equivalent", label: "Pro-eq" }
    : codex
      ? { id: "chatgpt-plus-equivalent", label: "Plus-eq" }
      : { id: `${provider}-account-equivalent`, label: "account-eq" };
  const reference = (claude && name === "pro") || (codex && name === "plus");
  const multiples =
    windowSeconds === 18_000
      ? claudeSessionMultiples
      : windowSeconds === 604_800
        ? claudeWeeklyMultiples
        : undefined;
  const multiple = claude && name !== undefined ? multiples?.get(name) : undefined;
  const planPolicy = claude && name === "max 20x" && windowSeconds === 604_800;
  return {
    multiplier: multiple ?? 1,
    source: planPolicy
      ? "plan-multiplier"
      : reference
        ? "reference-plan"
        : multiple === undefined
          ? "unknown-plan"
          : windowSeconds === 604_800
            ? "published-weekly-multiplier"
            : "published-session-multiplier",
    known: reference || multiple !== undefined,
    unit,
    revision: planPolicy
      ? "2026-11-09-max20x-20"
      : claude && windowSeconds === 604_800 && multiple !== undefined
        ? claudeWeeklyWeightRevision
        : capacityWeightRevision,
  };
}
