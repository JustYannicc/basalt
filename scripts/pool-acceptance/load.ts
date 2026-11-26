import type { ModelCredential, PoolAcceptanceClient } from "./client.ts";
import {
  sendAttempt,
  sendCall,
  servedClean,
  type CallContext,
  type CallRecord,
  type Clock,
} from "./load-call.ts";
import {
  barClasses,
  judge,
  loadClasses,
  ttfbMs,
  verdictOf,
  type JudgedCall,
  type LoadVerdict,
} from "./load-classes.ts";
import { delayBarMs, kindRotation, workerStartMs, type LoadShape } from "./load-shape.ts";

export interface LoadInput {
  readonly client: PoolAcceptanceClient;
  readonly credential: ModelCredential;
  readonly shape: LoadShape;
  /** The restart phase's kill time once it is known; given at all, a kill is armed. */
  readonly kill?: () => number | undefined;
  /** How long to wait for a kill time still unknown when the last call ends. */
  readonly killWaitMs?: number;
  readonly clock?: Clock;
}

export interface LoadRun {
  readonly calls: readonly JudgedCall[];
  readonly killAt: number | undefined;
  readonly verdict: LoadVerdict;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  wall: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/**
 * Workers send back to back from their ramp step until the duration or the call budget ends. The
 * first call that is not a pass stops every worker from starting another; calls in flight finish
 * and are recorded. A call in flight at the kill time is then sent once more, for its own class.
 */
export async function runLoad(input: LoadInput): Promise<LoadRun> {
  const { shape } = input;
  const clock = input.clock ?? systemClock;
  const context: CallContext = {
    client: input.client,
    credential: input.credential,
    clock,
    maxAttempts: shape.maxAttempts,
    attemptTimeoutMs: shape.attemptTimeoutMs,
  };
  const kinds = new Map(shape.mix.map((kind) => [kind.name, kind]));
  const next = kindRotation(shape.mix);
  const started = clock.now();
  const end = started + shape.durationMs;
  // Aborted by the first non-pass or the last call of the budget: no worker starts another.
  const halt = new AbortController();
  const records: CallRecord[] = [];
  let sent = 0;
  let firstFailure: number | undefined;
  const worker = async (index: number) => {
    const start = Math.min(started + workerStartMs(shape, index), end);
    await clock.sleep(start - clock.now(), halt.signal);
    while (!halt.signal.aborted && clock.now() < end) {
      const kind = next();
      const call = ++sent;
      if (call === shape.calls) halt.abort();
      const record = await sendCall(context, kind, call, index);
      records.push(record);
      // Whether a call passes never depends on the kill time, so the first non-pass stops the run.
      if (barClasses(record, kind).length && firstFailure === undefined) {
        firstFailure = record.call;
        halt.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: shape.concurrency }, (_, index) => worker(index)));

  let killAt = input.kill?.();
  const killDeadline = clock.now() + (input.killWaitMs ?? 0);
  while (input.kill && killAt === undefined && clock.now() < killDeadline) {
    await clock.sleep(500);
    killAt = input.kill();
  }
  const calls = records
    .sort((a, b) => a.call - b.call)
    .map((record) => judge(record, kinds.get(record.kind)!, killAt));
  await Promise.all(
    calls
      .filter((call) => call.inFlight && !call.pass)
      .map(async (call) => {
        const kind = kinds.get(call.kind)!;
        const resend = await sendAttempt(context, kind, call.traceId, call.attempts.length + 1);
        call.inFlight!.resend = {
          ...resend,
          passed:
            servedClean(resend) &&
            resend.boot !== undefined &&
            ttfbMs(resend) <= kind.ttfbProfileMs + delayBarMs,
        };
      }),
  );
  return {
    calls,
    killAt,
    verdict: verdictOf(calls, firstFailure, { armed: input.kill !== undefined, at: killAt }),
  };
}

const percentile = (sorted: readonly number[], share: number) =>
  sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!)
    : 0;

/** The run's public lines: counts and the shape. No boot, request id, trace id, host or account. */
export function summaryLines(run: LoadRun, shape: LoadShape): string[] {
  const { verdict } = run;
  const lines = [
    `load status=${verdict.passed ? "passed" : "failed"} calls=${verdict.calls} passes=${verdict.passes} attempts=${verdict.attempts}`,
    `load classes ${loadClasses.map((name) => `${name}=${verdict.counts[name]}`).join(" ")}`,
  ];
  const failure = run.calls.find((call) => call.call === verdict.firstFailure);
  if (failure) {
    const last = failure.attempts.at(-1)!;
    const reason = last.verdict?.reason
      ? ` reason=${last.verdict.reason.replaceAll(" ", "_")}`
      : "";
    lines.push(
      `load stopped_by call=${failure.call} kind=${failure.kind} classes=${failure.classes.join(",")} attempts=${failure.attempts.length} status=${last.status ?? "none"} end=${last.end}${reason}`,
    );
  }
  const first = run.calls
    .filter((call) => call.pass)
    .map((call) => ttfbMs(call.attempts[0]!))
    .sort((a, b) => a - b);
  lines.push(
    `load first_byte_ms passes p50=${percentile(first, 0.5)} p95=${percentile(first, 0.95)} max=${percentile(first, 1)}`,
    `load boots distinct=${verdict.boots.length} answers=${verdict.boots.join(",") || "0"}`,
    // The pool strips its placement header, so a caller sees the boot and not the runtime.
    "load runtime=not_visible_to_callers join_on=requestId,traceId",
  );
  if (verdict.restart) {
    const { kill, inFlight, resendPassed, passed } = verdict.restart;
    lines.push(
      `load restart kill=${kill} in_flight=${inFlight} in_flight_cut=${verdict.counts.in_flight_cut} resend_passed=${resendPassed} verdict=${passed ? "passed" : "not_passed"}`,
    );
  }
  const ramp = shape.ramp
    ? `${shape.ramp.from}+${shape.ramp.step}/${shape.ramp.intervalMs / 1_000}s`
    : "none";
  lines.push(
    `load shape concurrency=${shape.concurrency} duration_s=${shape.durationMs / 1_000} ramp=${ramp} calls=${shape.calls ?? "unbounded"} mix=${shape.mix.map((kind) => `${kind.name}:${kind.weight}`).join(",")}`,
  );
  return lines;
}
