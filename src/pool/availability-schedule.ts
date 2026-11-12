import { capturePoolMonitor, startPoolMonitor } from "../telemetry/pool-monitor.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { awaitProbe, type ProbeResult } from "./availability.ts";
import { validProbeTarget } from "./availability-config.ts";
import type { PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";

export async function runAvailabilityProbe(
  env: SentryEnv & { POOL_AVAILABILITY_TARGET?: string },
  probe: (pool: string) => Promise<ProbeResult>,
  reliability?: (pool: string) => Promise<PoolReliabilitySlo>,
): Promise<void> {
  if (env.POOL_AVAILABILITY_TARGET === undefined || env.POOL_AVAILABILITY_TARGET === "") return;
  const receipt = await startPoolMonitor(env);
  const target = env.POOL_AVAILABILITY_TARGET;
  let result: ProbeResult;
  try {
    if (!validProbeTarget(target))
      result = { ok: false, failures: [{ guard: "configuration", reason: "invalid_target" }] };
    else {
      const signal = AbortSignal.timeout(25_000);
      const [availability, measured] = await Promise.all([
        awaitProbe(() => probe(target), signal).catch((): ProbeResult => ({
          ok: false,
          failures: [{ guard: "runtime", reason: "unavailable" }],
        })),
        reliability ? awaitProbe(() => reliability(target), signal).catch(() => null) : undefined,
      ]);
      result = { ...availability, failures: [...availability.failures] };
      if (measured) result.reliability = measured;
      if (measured?.state === "breached")
        result.failures.push({ guard: "request_reliability", reason: "below_target" });
      if (measured === null || measured?.state === "unavailable")
        result.failures.push({ guard: "request_reliability", reason: "collection_unavailable" });
    }
  } catch {
    result = { ok: false, failures: [{ guard: "runtime", reason: "unavailable" }] };
  }
  if (!result.ok) console.error("POOL_AVAILABILITY_FAILURE", result.failures);
  if (!(await capturePoolMonitor(env, receipt, result)))
    throw new Error("Pool availability alert delivery failed");
}
