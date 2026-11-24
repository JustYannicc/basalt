import type { PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";
import { reportingCadence } from "./reporting.ts";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
interface Recorded {
  pool: string;
  computedAt: number;
  slo: PoolReliabilitySlo;
}
const key = "pool-reliability-slo-v1";
// History arrives with the five-minute capture. A slow or late capture gets one extra minute before
// the check-in computes the figure itself.
export const reliabilityFreshMs = reportingCadence + 60_000;

/** Each capture computes the figure once; the windows end at that capture. */
export async function recordReliability(
  storage: Storage,
  pool: string,
  compute: (now: number) => Promise<PoolReliabilitySlo>,
  now = Date.now(),
): Promise<PoolReliabilitySlo> {
  const slo = await compute(now);
  await storage.put(key, { pool, computedAt: now, slo } satisfies Recorded);
  return slo;
}

/** The minute check-in reuses the capture's figure while it is fresh, and otherwise computes one. */
export async function capturedReliability(
  storage: Storage,
  pool: string,
  compute: (now: number) => Promise<PoolReliabilitySlo>,
  now = Date.now(),
): Promise<PoolReliabilitySlo> {
  const recorded = await storage.get<Recorded>(key);
  if (
    recorded?.pool === pool &&
    recorded.computedAt <= now &&
    now - recorded.computedAt < reliabilityFreshMs
  )
    return recorded.slo;
  return recordReliability(storage, pool, compute, now);
}
