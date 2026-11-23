import { capturePoolMonitor, reliabilityKey, startPoolMonitor } from "../telemetry/pool-monitor.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { awaitProbe, type ProbeResult } from "./availability.ts";
import { availabilityCron, validProbeTarget } from "./availability-config.ts";
import type { PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";
import {
  notifyCollectionUnavailable,
  notifyPercentageFailure,
} from "./reliability-notifications.ts";
import {
  reliabilityFailure,
  reliabilitySessionFailed,
} from "./model-history/reliability-read-failure.ts";
import { episodeAfter, episodeReport, type AvailabilityEpisode } from "./availability-episode.ts";

/** The pool's memory of the episode it reported, read and written within the run's own bounds. */
export interface EpisodeMemory {
  read(): Promise<AvailabilityEpisode | undefined>;
  write(episode: AvailabilityEpisode): Promise<void>;
}
const episodeBudgetMs = 5_000;

/** What makes one check's failures the same as the next one's: guard and reason, not their detail. */
function signatures(result: ProbeResult): Omit<AvailabilityEpisode, "pool"> {
  const availability = result.failures.filter((failure) => failure.guard !== "request_reliability");
  const failed = !result.ok || availability.length > 0;
  return {
    availability: failed
      ? availability
          .map((failure) => `${failure.guard}:${failure.reason}`)
          .sort()
          .join(" ") || "runtime:unknown"
      : null,
    reliability: [
      ...new Set(
        result.failures
          .filter((failure) => failure.guard === "request_reliability")
          .map(reliabilityKey),
      ),
    ].sort(),
  };
}

export async function runAvailabilityProbe(
  env: SentryEnv & { POOL_AVAILABILITY_TARGET?: string },
  probe: (pool: string) => Promise<ProbeResult>,
  reliability?: (pool: string) => Promise<PoolReliabilitySlo>,
  release?: string,
  /** Which failures were already reported; without it every failing run is reported. */
  episodes?: EpisodeMemory,
  /** The history pools whose usage rollup is stuck: a history problem, never an outage. */
  usageRollupStuck?: () => Promise<readonly string[]>,
): Promise<void> {
  if (env.POOL_AVAILABILITY_TARGET === undefined || env.POOL_AVAILABILITY_TARGET === "") return;
  const receipt = await startPoolMonitor(env, availabilityCron);
  const target = env.POOL_AVAILABILITY_TARGET;
  let result: ProbeResult;
  let rollupUnread = false;
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
        reliability
          ? awaitProbe(() => reliability(target), signal).catch((error: unknown) => {
              // The read's own session already logged its statement and session failures.
              const logged =
                !signal.aborted &&
                error instanceof Error &&
                error.message === reliabilitySessionFailed;
              if (!logged)
                console.error("POOL_REQUEST_RELIABILITY_READ_FAILED", {
                  step: "session",
                  ...(signal.aborted ? { failure: "probe_budget" } : reliabilityFailure(error)),
                });
              return null;
            })
          : undefined,
      ]);
      result = { ...availability, failures: [...availability.failures] };
      if (measured) result.reliability = measured;
      if (measured && notifyPercentageFailure(measured))
        result.failures.push({ guard: "request_reliability", reason: "below_target" });
      if (measured?.current?.classification === "ready" && measured.current.real.failed)
        result.failures.push({ guard: "request_reliability", reason: "failing_now" });
      if (measured === null || (measured && notifyCollectionUnavailable(measured)))
        result.failures.push({ guard: "request_reliability", reason: "collection_unavailable" });
      const stuck = usageRollupStuck
        ? await awaitProbe(usageRollupStuck, signal).catch(() => "unread" as const)
        : [];
      if (stuck === "unread") rollupUnread = true;
      // On the reliability side, so the check-in stays ok while the pool serves. Only the pool's
      // own 16-hex history id travels, so each stuck pool is its own episode.
      else
        for (const pool of stuck)
          if (/^[0-9a-f]{16}$/.test(pool))
            result.failures.push({
              guard: "request_reliability",
              reason: "usage_rollup_stuck",
              pool,
            });
    }
  } catch {
    result = { ok: false, failures: [{ guard: "runtime", reason: "unavailable" }] };
  }
  if (!result.ok) console.error("POOL_AVAILABILITY_FAILURE", result.failures);
  let next = { pool: target, ...signatures(result) };
  const reported = episodes
    ? await awaitProbe(() => episodes.read(), AbortSignal.timeout(episodeBudgetMs)).catch(
        () => "unreachable" as const,
      )
    : undefined;
  if (reported === "unreachable") console.error("POOL_AVAILABILITY_EPISODE_UNREACHABLE");
  // A stuck rollup whose state could not be read this minute stays in its episode, rather than
  // ending it and reporting it again a minute later.
  if (rollupUnread && reported && reported !== "unreachable" && reported.pool === next.pool)
    next = {
      ...next,
      reliability: [
        ...new Set([
          ...next.reliability,
          ...reported.reliability.filter((key) => key.startsWith("usage_rollup_stuck:")),
        ]),
      ].sort(),
    };
  const report = episodes ? episodeReport(reported, next, Date.now()) : undefined;
  const { delivered, eventsDelivered } = await capturePoolMonitor(env, receipt, {
    ...result,
    release,
    ...(report ? { report } : {}),
  });
  // Recorded after sending, so a start whose events Sentry refused is tried again next minute.
  if (episodes && report && reported !== "unreachable")
    await awaitProbe(
      () => episodes.write(episodeAfter(reported, next, report, eventsDelivered)),
      AbortSignal.timeout(episodeBudgetMs),
    ).catch(() => console.error("POOL_AVAILABILITY_EPISODE_UNRECORDED"));
  if (!delivered) throw new Error("Pool availability alert delivery failed");
}
