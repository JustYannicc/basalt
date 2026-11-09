import { capturePoolMonitor, startPoolMonitor } from "../telemetry/pool-monitor.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { awaitProbe, type ProbeResult } from "./availability.ts";
import { validProbeTarget } from "./availability-config.ts";

export async function runAvailabilityProbe(
  env: SentryEnv & { POOL_AVAILABILITY_TARGET?: string },
  probe: (pool: string) => Promise<ProbeResult>,
): Promise<void> {
  if (env.POOL_AVAILABILITY_TARGET === undefined || env.POOL_AVAILABILITY_TARGET === "") return;
  const receipt = await startPoolMonitor(env);
  const target = env.POOL_AVAILABILITY_TARGET;
  let result: ProbeResult;
  try {
    result = validProbeTarget(target)
      ? await awaitProbe(() => probe(target), AbortSignal.timeout(25_000))
      : { ok: false, failures: [{ guard: "configuration", reason: "invalid_target" }] };
  } catch {
    result = { ok: false, failures: [{ guard: "runtime", reason: "unavailable" }] };
  }
  if (!result.ok) console.error("POOL_AVAILABILITY_FAILURE", result.failures);
  if (!(await capturePoolMonitor(env, receipt, result)))
    throw new Error("Pool availability alert delivery failed");
}
