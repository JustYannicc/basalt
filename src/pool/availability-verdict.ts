import {
  reliabilityNotificationMinimumRequests,
  type PoolReliability,
  type PoolReliabilitySlo,
} from "../../apps/pool/reliability-contract.ts";
import { closedFailures } from "../telemetry/pool-monitor.ts";
import type { ProbeResult } from "./availability.ts";
import { windowVerdict } from "./model-history/reliability-unknown.ts";

type Window = "current" | "hour" | "day";

const count = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** A window's counts as the objective decided them: real and proof traffic, failures by status. */
function counts(window: PoolReliability) {
  const side = (value: PoolReliability["real"]) => ({
    requests: count(value.requests),
    failed: count(value.failed),
    failures: value.failures.map(({ status, count: failures }) => ({
      status:
        status !== null && Number.isInteger(status) && status >= 100 && status <= 599
          ? status
          : null,
      count: count(failures),
    })),
  });
  return {
    from: window.from,
    to: window.to,
    classification: window.classification,
    real: side(window.real),
    proof: side(window.proof),
    ...(window.unknown
      ? {
          unknown: {
            requests: count(window.unknown.requests),
            uncounted: count(window.unknown.uncounted),
            couldFail: count(window.unknown.couldFail),
          },
        }
      : {}),
  };
}

/** The windows a reliability state was decided on, by the same rules that raise it. */
function decidedOn(reason: string, slo: PoolReliabilitySlo | undefined): Window[] {
  if (!slo) return [];
  if (reason === "failing_now") return ["current"];
  if (reason === "below_target")
    return (["hour", "day"] as const).filter(
      (name) =>
        slo[name].classification === "ready" &&
        slo[name].real.requests >= reliabilityNotificationMinimumRequests &&
        windowVerdict(slo[name]) === "breached",
    );
  if (reason === "collection_unavailable") return ["hour", "day"];
  // A stuck history tick is decided on the history's own state, not on a traffic window.
  return [];
}

/**
 * The probe's verdict as one log line of its own, for any run that is not all fine. It is written
 * before anything is sent to Sentry, so a refused alert never hides what the probe concluded. Only
 * closed words, counts and the pool's own 16-hex history id appear.
 */
export function probeVerdict(result: ProbeResult) {
  const failures = closedFailures(result.failures);
  const availability = failures.filter((failure) => failure.guard !== "request_reliability");
  const reliability = failures.filter((failure) => failure.guard === "request_reliability");
  const failing = !result.ok || availability.length > 0;
  if (!failing && reliability.length === 0) return undefined;
  const slo = result.reliability;
  const windows = new Set(reliability.flatMap((failure) => decidedOn(failure.reason, slo)));
  return {
    availability: failing
      ? {
          state: "failing" as const,
          failures: availability.map(
            (failure) =>
              `${failure.guard}:${failure.reason}${failure.backend_status ? `:HTTP${failure.backend_status}` : ""}`,
          ),
        }
      : null,
    reliability: reliability.length
      ? {
          verdicts: reliability.map((failure) => ({
            state: failure.reason,
            windows: decidedOn(failure.reason, slo),
            ...(failure.pool ? { pool: failure.pool } : {}),
          })),
          objective: slo
            ? {
                target: slo.target,
                state: slo.state,
                ...(slo.reason ? { reason: slo.reason } : {}),
                windows: Object.fromEntries(
                  [...windows].flatMap((name) => {
                    const window = name === "current" ? slo.current : slo[name];
                    return window ? [[name, counts(window)]] : [];
                  }),
                ),
              }
            : null,
        }
      : null,
  };
}
