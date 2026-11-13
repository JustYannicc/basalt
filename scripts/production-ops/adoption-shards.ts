const files = new Set(["provider-adoption.spec.ts", "provider-adoption-locks.spec.ts"]);

export function adoptionProofSelection(
  plans: Readonly<Record<string, { readonly file: string; readonly title: string }>>,
  pattern: string,
  shard?: string,
) {
  if (shard !== undefined && shard !== "1/2" && shard !== "2/2")
    throw new Error("Provider adoption shard must be 1/2 or 2/2");
  const selected = new RegExp(pattern);
  if (shard === undefined)
    return {
      ids: Object.entries(plans)
        .filter(([, plan]) => selected.test(plan.title))
        .map(([id]) => id),
      pattern,
    };
  const positions = new Map<string, number>();
  const cases = Object.entries(plans)
    .filter(([, plan]) => files.has(plan.file) && selected.test(plan.title))
    .sort(([left], [right]) => left.localeCompare(right))
    .filter(([, plan]) => {
      const position = positions.get(plan.file) ?? 0;
      positions.set(plan.file, position + 1);
      return shard === undefined || position % 2 === (shard === "1/2" ? 0 : 1);
    });
  if (cases.length === 0) throw new Error("No provider adoption scenarios matched this shard");
  return {
    ids: cases.map(([id]) => id),
    pattern:
      "^(?:" +
      cases.map(([, plan]) => plan.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
      ")$",
  };
}
