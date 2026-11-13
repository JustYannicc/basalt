import type { CapacityOutlook } from "../../apps/pool/routing-contract.ts";
import {
  capacityAttention,
  type CapacityAttentionState,
  type CapacityOutlookInput,
} from "./routing-attention.ts";
import type { UsageStorage } from "./usage-storage.ts";

/** The forecast producer owns replay results. This adapter only persists attention episodes. */
export async function routingOutlooks(
  storage: UsageStorage,
  pool: string,
  inputs: readonly CapacityOutlookInput[],
  now: number,
): Promise<readonly CapacityOutlook[]> {
  if (inputs.length > 12) throw new Error("Routing outlook cohort limit exceeded");
  const key = `routing-attention:${pool}`;
  const previous = (await storage.get<Record<string, CapacityAttentionState>>(key)) ?? {};
  const next: Record<string, CapacityAttentionState> = {};
  const outlooks = inputs.map((input) => {
    const id = JSON.stringify([input.provider, input.modelFamily]);
    const result = capacityAttention(input, previous[id] ?? null, now);
    if (result.state) next[id] = result.state;
    return { ...input, attention: result.attention };
  });
  await storage.put(key, next);
  return outlooks;
}
