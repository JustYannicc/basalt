import type { PoolReliability, PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";
import { closedFailures } from "../telemetry/pool-monitor.ts";
import type { ProbeResult } from "./availability.ts";
import { percentageFailureWindows } from "./reliability-notifications.ts";

type Window = "current" | "hour" | "day";

const count = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const instant = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ? value : null;
const closed = <T extends string>(value: string | undefined, words: readonly T[]) =>
  words.find((word) => word === value) ?? null;
const states = ["ok", "breached", "no_traffic", "unavailable"] as const;
const objectiveReasons = [
  "history_inactive",
  "capture_stale",
  "capture_lagging",
  "classification_pending",
  "terminal_collection_pending",
  "terminal_collection_unavailable",
] as const;

/**
 * A window's counts as the objective decided them: real and proof traffic, failures by status and
 * those no account was named for, and unknown outcomes by cause. Only checked words and counts.
 */
function counts(window: PoolReliability) {
  const side = (value: PoolReliability["real"]) => ({
    requests: count(value.requests),
    failed: count(value.failed),
    unassigned: count(value.unassignedFailures),
    failures: value.failures.map(({ status, count: failures, unassigned }) => ({
      status:
        status !== null && Number.isInteger(status) && status >= 100 && status <= 599
          ? status
          : null,
      count: count(failures),
      unassigned: count(unassigned),
    })),
  });
  const unknown = window.unknown;
  return {
    from: instant(window.from),
    to: instant(window.to),
    classification: closed(window.classification, ["ready", "pending"] as const),
    real: side(window.real),
    proof: side(window.proof),
    ...(unknown
      ? {
          unknown: {
            requests: count(unknown.requests),
            pending: count(unknown.pending),
            unavailable: count(unknown.unavailable),
            unmatched: count(unknown.unmatched),
            uncounted: count(unknown.uncounted),
            couldFail: count(unknown.couldFail),
          },
        }
      : {}),
  };
}

/** The windows a reliability state was decided on, by the same rules that raise it. */
function decidedOn(reason: string, slo: PoolReliabilitySlo | undefined): Window[] {
  if (!slo) return [];
  if (reason === "below_target") return percentageFailureWindows(slo);
  if (reason === "failing_now") return ["current"];
  if (reason === "collection_unavailable") return ["hour", "day"];
  // A stuck history tick is decided on the history's own state, not on a traffic window.
  return [];
}

/**
 * The probe's verdict as one log line of its own, for any run that is not all fine. It is written
 * before anything is sent to Sentry, so a refused alert never hides what the probe concluded. It
 * holds every failure, where Sentry takes eight, and a stuck state that could not be read this
 * minute. Only closed words, counts, timestamps and the pool's own 16-hex history id appear.
 */
export function probeVerdict(result: ProbeResult, unread: readonly string[] = []) {
  const failures = closedFailures(result.failures);
  const availability = failures.filter((failure) => failure.guard !== "request_reliability");
  const reliability = failures.filter((failure) => failure.guard === "request_reliability");
  const unreadStates = unread.flatMap((reason) =>
    reason === "usage_rollup_stuck" || reason === "capture_hours_stuck" ? [reason] : [],
  );
  const failing = !result.ok || availability.length > 0;
  if (!failing && reliability.length === 0 && unreadStates.length === 0) return undefined;
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
    reliability:
      reliability.length || unreadStates.length
        ? {
            verdicts: [
              ...reliability.map((failure) => ({
                state: failure.reason,
                windows: decidedOn(failure.reason, slo),
                ...(failure.pool ? { pool: failure.pool } : {}),
              })),
              // Its state could not be read, so the episode it may be in is carried, not ended.
              ...unreadStates.map((state) => ({ state, windows: [], unread: true })),
            ],
            objective: slo
              ? {
                  target: 99,
                  state: closed(slo.state, states),
                  reason: closed(slo.reason, objectiveReasons),
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
