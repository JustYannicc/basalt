import { servedClean, type Attempt, type CallRecord } from "./load-call.ts";
import { delayBarMs, type LoadKind } from "./load-shape.ts";

/**
 * What the zero bar counts. failed: the last send was not a 200 with a terminal event and exact
 * content. retried: more than one send, even if the last passed. delayed: a send's first byte came
 * more than 30 s past its profile's. missing_boot: an answer without the pool's boot header.
 * in_flight_cut: in flight at the kill time and not clean, in place of those four.
 */
export type LoadClass = "failed" | "retried" | "delayed" | "missing_boot" | "in_flight_cut";
export const loadClasses: readonly LoadClass[] = [
  "failed",
  "retried",
  "delayed",
  "missing_boot",
  "in_flight_cut",
];

/** Time to first byte: of the body, else of the answer's headers, else of the whole wait. */
export const ttfbMs = (attempt: Attempt) =>
  attempt.firstByteMs ?? attempt.headersMs ?? attempt.totalMs;

/** The bar's classes for one call on its own. No class at all is the only pass. */
export function barClasses(call: CallRecord, kind: LoadKind): LoadClass[] {
  const classes: LoadClass[] = [];
  if (!servedClean(call.attempts.at(-1)!)) classes.push("failed");
  if (call.attempts.length > 1) classes.push("retried");
  if (call.attempts.some((attempt) => ttfbMs(attempt) > kind.ttfbProfileMs + delayBarMs))
    classes.push("delayed");
  if (call.attempts.some((attempt) => attempt.status !== undefined && attempt.boot === undefined))
    classes.push("missing_boot");
  return classes;
}

export type InFlightEnding = "ok" | "verdict" | Exclude<Attempt["end"], "complete">;

export interface InFlight {
  /** How the send in flight at the kill ended, or the first one sent after it from a retry's wait. */
  readonly ending: InFlightEnding;
  readonly endedMsAfterKill: number;
  readonly retryable: boolean;
  /** What the bar alone would have counted; in flight, the call counts as one in-flight cut. */
  readonly bar: readonly LoadClass[];
  /** The same call sent once more. Recorded only here: it never makes the call a pass. */
  resend?: Attempt & { readonly passed: boolean };
}

export interface JudgedCall extends CallRecord {
  readonly classes: readonly LoadClass[];
  readonly pass: boolean;
  readonly inFlight?: InFlight;
}

export const inFlightAt = (call: CallRecord, killAt: number | undefined) =>
  killAt !== undefined && call.startedAt <= killAt && killAt < call.endedAt;

/** A call against the bar; a kill time only moves a call that was in flight into its own class. */
export function judge(call: CallRecord, kind: LoadKind, killAt: number | undefined): JudgedCall {
  const bar = barClasses(call, kind);
  const pass = bar.length === 0;
  if (!inFlightAt(call, killAt)) return { ...call, classes: bar, pass };
  const hit = call.attempts.find((attempt) => attempt.endedAt > killAt!)!;
  const ending: InFlightEnding =
    hit.end !== "complete" ? hit.end : servedClean(hit) ? "ok" : "verdict";
  return {
    ...call,
    classes: pass ? [] : ["in_flight_cut"],
    pass,
    inFlight: { ending, endedMsAfterKill: hit.endedAt - killAt!, retryable: hit.retryable, bar },
  };
}

export type KillSeen = "seen" | "unseen" | "outside_run";

export interface LoadVerdict {
  readonly passed: boolean;
  readonly calls: number;
  readonly passes: number;
  readonly attempts: number;
  readonly counts: Readonly<Record<LoadClass, number>>;
  /** The call whose end stopped the run: the first non-pass to finish. */
  readonly firstFailure: number | undefined;
  /** Answers per distinct boot, largest first; the boots themselves stay in the artifact. */
  readonly boots: readonly number[];
  readonly restart:
    | {
        readonly kill: KillSeen;
        readonly inFlight: number;
        readonly resendPassed: number;
        /** Until Yannic decides otherwise, only zero in-flight cuts pass the restart phase. */
        readonly passed: boolean;
      }
    | undefined;
}

export function verdictOf(
  calls: readonly JudgedCall[],
  firstFailure: number | undefined,
  kill: { armed: boolean; at: number | undefined },
): LoadVerdict {
  const counts = Object.fromEntries(loadClasses.map((name) => [name, 0])) as Record<
    LoadClass,
    number
  >;
  for (const call of calls) for (const name of call.classes) counts[name] += 1;
  const served = new Map<string, number>();
  for (const call of calls)
    for (const attempt of call.attempts)
      if (attempt.boot) served.set(attempt.boot, (served.get(attempt.boot) ?? 0) + 1);
  const passes = calls.filter((call) => call.pass).length;
  let restart: LoadVerdict["restart"];
  if (kill.armed) {
    const first = Math.min(...calls.map((call) => call.startedAt));
    const last = Math.max(...calls.map((call) => call.endedAt));
    const seen: KillSeen =
      kill.at === undefined
        ? "unseen"
        : calls.length && kill.at >= first && kill.at <= last
          ? "seen"
          : "outside_run";
    restart = {
      kill: seen,
      inFlight: calls.filter((call) => call.inFlight).length,
      resendPassed: calls.filter((call) => call.inFlight?.resend?.passed).length,
      passed: seen === "seen" && counts.in_flight_cut === 0,
    };
  }
  return {
    passed: calls.length > 0 && passes === calls.length && (restart?.passed ?? true),
    calls: calls.length,
    passes,
    attempts: calls.reduce((sum, call) => sum + call.attempts.length, 0),
    counts,
    firstFailure,
    boots: [...served.values()].sort((a, b) => b - a),
    restart,
  };
}
