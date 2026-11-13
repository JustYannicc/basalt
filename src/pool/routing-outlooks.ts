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
  const next: Record<string, CapacityAttentionState> = Object.fromEntries(
    Object.entries(previous).map(([id, state]) => [
      id,
      { ...state, qualifiedSince: null, lastQualifiedAt: null },
    ]),
  );
  if (
    new Set(inputs.map((input) => JSON.stringify([input.provider, input.modelFamily]))).size !==
    inputs.length
  )
    throw new Error("Duplicate routing outlook cohort");
  const outlooks = inputs.map((input) => {
    const id = JSON.stringify([input.provider, input.modelFamily]);
    const result = capacityAttention(input, previous[id] ?? null, now);
    if (result.state) next[id] = result.state;
    else delete next[id];
    return { ...input, attention: result.attention };
  });
  if (Object.keys(next).length > 128) throw new Error("Routing attention episode limit exceeded");
  await storage.put(key, next);
  return outlooks;
}
