import type { ComputerStorage } from "./computer-registry.ts";

export const reportingCadence = 5 * 60_000;

/** Claim before I/O so eviction and failed reads cannot restart five-second report polling. */
export async function reportWhenDue(
  storage: ComputerStorage,
  name: string,
  work: () => Promise<unknown>,
  now = Date.now(),
): Promise<void> {
  const key = `pool-reporting-v1:${name}`;
  const due = await storage.get<number>(key);
  if (due !== undefined && due > now && due <= now + reportingCadence) return;
  await storage.put(key, now + reportingCadence);
  await work();
}
