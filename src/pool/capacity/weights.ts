/** Capacity policy is separate from plan price, credential mechanism and account health. */
export interface CapacityWeight {
  readonly multiplier: number;
  readonly source: "reference-plan" | "published-session-multiplier" | "unknown-plan";
  readonly known: boolean;
  readonly unit: { readonly id: string; readonly label: string };
  readonly revision: string;
}

export const capacityWeightRevision = "2026-10-30";
// Anthropic states these multiples per five-hour session, not for weekly allowance.
// https://support.anthropic.com/en/articles/11049741-what-is-the-max-plan
const claudeSessionMultiples = new Map([["max 5x", 5], ["max 20x", 20]]);

/** A missing plan is a flagged 1x contribution, never a known candidate-account weight. */
export function capacityWeight(provider: string, plan: string | null, windowSeconds: number): CapacityWeight {
  const name = plan?.trim().toLowerCase();
  const claude = provider === "claude" || provider === "anthropic";
  const codex = provider === "codex" || provider === "openai";
  const unit = claude ? { id: "claude-pro-equivalent", label: "Pro-eq" }
    : codex ? { id: "chatgpt-plus-equivalent", label: "Plus-eq" }
      : { id: `${provider}-account-equivalent`, label: "account-eq" };
  const reference = claude && name === "pro" || codex && name === "plus";
  const multiple = claude && windowSeconds === 18_000 && name !== undefined
    ? claudeSessionMultiples.get(name) : undefined;
  return {
    multiplier: multiple ?? 1,
    source: reference ? "reference-plan" : multiple === undefined ? "unknown-plan" : "published-session-multiplier",
    known: reference || multiple !== undefined,
    unit,
    revision: capacityWeightRevision,
  };
}
