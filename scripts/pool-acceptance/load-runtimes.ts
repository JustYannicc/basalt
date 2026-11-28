// Which runtime served each call, as the load can see it: the pool's X-Signalbox-Pool-Boot header
// carries the serving runtime's boot id, one per runtime start. That id names one runtime, so it
// never leaves the run: every record the load writes names the runtime by the order it first
// answered, and the verdict counts calls per runtime per phase, numbers only.
import type { CallRecord } from "./load-call.ts";
import type { InFlight } from "./load-classes.ts";
import type { LoadShape } from "./load-shape.ts";

/** Each boot the run saw, numbered by the order the run first wrote it, from 1. */
export class RuntimeOrdinals {
  private readonly seen = new Map<string, number>();
  of(boot: string) {
    let ordinal = this.seen.get(boot);
    if (ordinal === undefined) {
      ordinal = this.seen.size + 1;
      this.seen.set(boot, ordinal);
    }
    return ordinal;
  }
  /** The call as the load writes it: each attempt's boot replaced by its runtime's ordinal. */
  record<T extends Pick<CallRecord, "attempts"> & { readonly inFlight?: InFlight }>(call: T): T {
    const named = <A extends { readonly boot?: string }>(attempt: A): A =>
      attempt.boot === undefined
        ? attempt
        : { ...attempt, boot: `runtime-${this.of(attempt.boot)}` };
    // A kill's resend is a send too, and its boot leaves no more than any other's.
    const resend = call.inFlight?.resend;
    return {
      ...call,
      attempts: call.attempts.map(named),
      ...(call.inFlight && resend ? { inFlight: { ...call.inFlight, resend: named(resend) } } : {}),
    };
  }
}

export interface PhaseCount {
  readonly phase: string;
  readonly calls: number;
  readonly runtimes: number;
  /** Answers per runtime in the phase, largest first. */
  readonly answers: readonly number[];
}

/**
 * The run's phases, by when a call started: each ramp interval while workers are still being
 * added, then the hold once all run (a shape without a ramp is one steady phase), each split at an
 * armed kill. A call's answers count for the runtimes that gave them.
 */
export function phaseCounts(
  calls: readonly CallRecord[],
  shape: LoadShape,
  killAt: number | undefined,
): PhaseCount[] {
  if (!calls.length) return [];
  // A loop, not a spread: a run may hold a million calls, past any argument list.
  let start = Infinity;
  for (const call of calls) start = Math.min(start, call.startedAt);
  const ramp = shape.ramp;
  const steps = ramp ? Math.ceil((shape.concurrency - ramp.from) / ramp.step) : 0;
  const phaseOf = (call: CallRecord) => {
    const at = call.startedAt - start;
    const base = ramp
      ? at < steps * ramp.intervalMs
        ? `ramp_${Math.floor(at / ramp.intervalMs) + 1}`
        : "held"
      : "steady";
    return killAt === undefined
      ? base
      : `${base}_${call.startedAt <= killAt ? "before" : "after"}_kill`;
  };
  const phases = new Map<string, { calls: number; served: Map<string, number> }>();
  for (const call of [...calls].sort((a, b) => a.startedAt - b.startedAt)) {
    const name = phaseOf(call);
    const phase = phases.get(name) ?? { calls: 0, served: new Map<string, number>() };
    phase.calls++;
    for (const attempt of call.attempts)
      if (attempt.boot !== undefined)
        phase.served.set(attempt.boot, (phase.served.get(attempt.boot) ?? 0) + 1);
    phases.set(name, phase);
  }
  return [...phases].map(([phase, { calls: count, served }]) => ({
    phase,
    calls: count,
    runtimes: served.size,
    answers: [...served.values()].sort((a, b) => b - a),
  }));
}

/** The phases as the summary's lines. */
export const phaseLines = (phases: readonly PhaseCount[]) =>
  phases.map(
    ({ phase, calls, runtimes, answers }) =>
      `load phase=${phase} calls=${calls} runtimes=${runtimes} answers=${answers.join(",") || "0"}`,
  );
