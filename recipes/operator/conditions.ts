import type { Checkpoint, Observation } from "../common/types.ts";
const fact = (
  cursor: string,
  at: number,
  code: string,
  verdict: Observation["verdict"],
  failures = 0,
  successes = 0,
  since = at,
): Observation => ({ cursor, at, code, verdict, failures, successes, since });
export function availabilityObservation(
  at: number,
  status: "healthy" | "failed" | "unknown",
  previous: Checkpoint,
) {
  const failures = status === "failed" ? previous.observation.failures + 1 : 0;
  const successes = status === "healthy" ? previous.observation.successes + 1 : 0;
  return {
    ...fact(
      `availability:${at}`,
      at,
      status === "unknown" ? "availability-unknown" : "availability",
      failures >= 3 ? "action" : successes >= 3 ? "healthy" : "unknown",
      failures,
      successes,
    ),
    readComplete: status !== "unknown",
  };
}
export interface RuntimeFact {
  at: number;
  boot: string;
  startedAt: number;
  ready: boolean;
  unexpectedBoots: number[];
}
export function runtimeObservation(current: RuntimeFact, previous: Checkpoint) {
  const boots = [...new Set(current.unexpectedBoots)].filter(
    (at) => at <= current.at && at > current.at - 15 * 60000,
  );
  const lastBoot = Math.max(
    previous.observation.lastUnexpectedAt ?? 0,
    ...current.unexpectedBoots.filter((at) => at <= current.at),
  );
  const flapping = boots.length >= 3;
  const wasFlapping = previous.open && previous.observation.flapping === true;
  const pastBudget = !current.ready && current.at - current.startedAt > 180000;
  const successful = current.ready && (!wasFlapping || current.at - lastBoot >= 30 * 60000);
  const firstSuccess = previous.observation.successes > 0 ? previous.observation.since : current.at;
  const count = successful
    ? previous.observation.successes +
      (current.at - previous.observation.at >= 60000
        ? 1
        : previous.observation.successes === 0
          ? 1
          : 0)
    : 0;
  const healthy = successful && count >= 2 && current.at - firstSuccess >= 60000;
  return {
    ...fact(
      `${current.boot}:${current.at}`,
      current.at,
      flapping || (wasFlapping && !healthy)
        ? "pool-flapping"
        : pastBudget
          ? "pool-startup-failed"
          : "runtime-readiness",
      flapping || pastBudget ? "action" : healthy ? "healthy" : "unknown",
      0,
      count,
      successful ? firstSuccess : current.at,
    ),
    readComplete: true,
    lastUnexpectedAt: lastBoot,
    flapping: flapping || (wasFlapping && !healthy),
  };
}
export interface HttpBucket {
  start: number;
  requests: number;
  errors: number;
}
export function serviceErrorsObservation(at: number, buckets: HttpBucket[]) {
  const ordered = [...buckets].sort((a, b) => a.start - b.start).slice(-5);
  const valid =
    ordered.length === 5 &&
    ordered.every(
      (bucket, index) =>
        bucket.start % 60000 === 0 &&
        bucket.start + 60000 <= at &&
        bucket.start >= at - 7 * 60000 &&
        bucket.requests >= 20 &&
        bucket.errors >= 0 &&
        bucket.errors <= bucket.requests &&
        (index === 0 || bucket.start === ordered[index - 1]!.start + 60000),
    );
  const elevated =
    valid &&
    ordered.every((bucket) => bucket.errors >= 5 && bucket.errors / bucket.requests >= 0.05);
  const critical =
    elevated &&
    ordered.every((bucket) => bucket.errors >= 10 && bucket.errors / bucket.requests >= 0.2);
  const below =
    valid && ordered.every((bucket) => bucket.errors < 5 || bucket.errors / bucket.requests < 0.05);
  return {
    ...fact(
      ordered.map((bucket) => String(bucket.start)).join(":") || `http-unknown:${at}`,
      at,
      critical ? "service-errors-critical" : "service-errors",
      elevated ? "action" : below ? "healthy" : "unknown",
    ),
    readComplete: valid,
  };
}
export function errorSpikeObservation(
  at: number,
  events: number,
  priorHour: number | null,
  previous: Checkpoint,
) {
  const threshold = priorHour === null ? 20 : Math.max(10, (3 * priorHour) / 12);
  const openingRate = previous.open ? (previous.observation.openingRate ?? threshold) : threshold;
  const low = events < openingRate / 2;
  const since = low ? (previous.observation.successes > 0 ? previous.observation.since : at) : at;
  const successes = low ? previous.observation.successes + 1 : 0;
  return {
    ...fact(
      `error-count:${at}`,
      at,
      "error-event-spike",
      events >= threshold ? "action" : low && at - since >= 15 * 60000 ? "healthy" : "unknown",
      0,
      successes,
      since,
    ),
    readComplete: true,
    openingRate,
  };
}
