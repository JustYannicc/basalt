import { servedClean, type Attempt, type CallRecord } from "./load-call.ts";
import { delayBarMs, type LoadKind } from "./load-shape.ts";

/**
 * What the zero bar counts. failed: the last send was not a 200 with a terminal event and exact
 * content. retried: more than one send, even if the last passed. delayed: a send's first content,
 * or a wait between its frames after that, came more than 30 s past its profile's time to first
 * token. missing_boot: an answer without the pool's boot header.
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

/**
 * How long a send waited for its answer: its first content, else the headers of an answer that
 * never brought any (which fails on its own), else the whole wait for no answer at all.
 */
export const contentWaitMs = (attempt: Attempt) =>
  attempt.firstContentMs ?? attempt.headersMs ?? attempt.totalMs;

/** A send whose first content or a later stall came more than the bar past its profile. */
export const delayed = (attempt: Attempt, kind: LoadKind) =>
  Math.max(contentWaitMs(attempt), attempt.stallMs ?? 0) > kind.ttfbProfileMs + delayBarMs;

/** The bar's classes for one call on its own. No class at all is the only pass. */
export function barClasses(call: CallRecord, kind: LoadKind): LoadClass[] {
  const classes: LoadClass[] = [];
  if (!servedClean(call.attempts.at(-1)!)) classes.push("failed");
  if (call.attempts.length > 1) classes.push("retried");
  if (call.attempts.some((attempt) => delayed(attempt, kind))) classes.push("delayed");
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

export interface Restart {
  readonly kill: KillSeen;
  readonly inFlight: number;
  readonly resendPassed: number;
  /** Boots first answering after the kill: a runtime that started. */
  readonly newBoots: number;
  /**
   * Boots of the sends in flight at the kill (else of every send before it) that no send after the
   * kill answered from: a runtime that went away.
   */
  readonly goneBoots: number;
  /**
   * Until Yannic decides otherwise, only zero in-flight cuts pass; and only a kill the answers
   * show, by a boot that went and a boot that came, is a restart at all.
   */
  readonly passed: boolean;
}

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
  readonly restart: Restart | undefined;
  /** The kind of error that ended the run early, when one did. */
  readonly error: string | undefined;
}

// Loops, not spreads: a long run holds more calls than a call's arguments may.
function restartOf(
  calls: readonly JudgedCall[],
  killAt: number | undefined,
  cuts: number,
): Restart {
  let first = Infinity;
  let last = -Infinity;
  const before = new Set<string>();
  const after = new Set<string>();
  const held = new Set<string>();
  for (const call of calls) {
    first = Math.min(first, call.startedAt);
    last = Math.max(last, call.endedAt);
    for (const attempt of call.attempts) {
      if (!attempt.boot || killAt === undefined) continue;
      (attempt.startedAt > killAt ? after : before).add(attempt.boot);
      if (attempt.startedAt <= killAt && killAt < attempt.endedAt) held.add(attempt.boot);
    }
  }
  const kill: KillSeen =
    killAt === undefined ? "unseen" : killAt >= first && killAt <= last ? "seen" : "outside_run";
  let newBoots = 0;
  for (const boot of after) if (!before.has(boot)) newBoots += 1;
  let goneBoots = 0;
  for (const boot of held.size ? held : before) if (!after.has(boot)) goneBoots += 1;
  let inFlight = 0;
  let resendPassed = 0;
  for (const call of calls) {
    if (call.inFlight) inFlight += 1;
    if (call.inFlight?.resend?.passed) resendPassed += 1;
  }
  return {
    kill,
    inFlight,
    resendPassed,
    newBoots,
    goneBoots,
    passed: kill === "seen" && cuts === 0 && newBoots > 0 && goneBoots > 0,
  };
}

export function verdictOf(
  calls: readonly JudgedCall[],
  firstFailure: number | undefined,
  kill: { armed: boolean; at: number | undefined },
  error?: string,
): LoadVerdict {
  const counts = Object.fromEntries(loadClasses.map((name) => [name, 0])) as Record<
    LoadClass,
    number
  >;
  const served = new Map<string, number>();
  let passes = 0;
  let attempts = 0;
  for (const call of calls) {
    for (const name of call.classes) counts[name] += 1;
    if (call.pass) passes += 1;
    attempts += call.attempts.length;
    for (const attempt of call.attempts)
      if (attempt.boot) served.set(attempt.boot, (served.get(attempt.boot) ?? 0) + 1);
  }
  const restart = kill.armed ? restartOf(calls, kill.at, counts.in_flight_cut) : undefined;
  return {
    passed:
      error === undefined &&
      calls.length > 0 &&
      passes === calls.length &&
      (restart?.passed ?? true),
    calls: calls.length,
    passes,
    attempts,
    counts,
    firstFailure,
    boots: [...served.values()].sort((a, b) => b - a),
    restart,
    error,
  };
}
