import { randomBytes } from "node:crypto";
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
  contentWaitMs,
  delayed,
  judge,
  loadClasses,
  loadOutcomes,
  ioLagLimitMs,
  verdictOf,
  type JudgedCall,
  type LoadClass,
  type LoadVerdict,
} from "./load-classes.ts";
import { kindRotation, workerStartMs, type LoadShape } from "./load-shape.ts";

import { startIoProbe } from "./load-io-probe.ts";
import { byMarker, driverMissing, witnessed, type MockSend, type Witness } from "./load-witness.ts";

/** A call as it ended, judged by the bar alone; a kill time can still move it to its own class. */
export type EndedCall = CallRecord & {
  readonly classes: readonly LoadClass[];
  readonly pass: boolean;
};

export interface LoadInput {
  readonly client: PoolAcceptanceClient;
  readonly credential: ModelCredential;
  readonly shape: LoadShape;
  /** The restart phase's kill time once it is known; given at all, a kill is armed. */
  readonly kill?: () => number | undefined;
  /** How long to wait for a kill time still unknown when the last call ends. */
  readonly killWaitMs?: number;
  /** Each call as soon as it ends, so a run that is stopped from outside keeps what it sent. */
  readonly ended?: (call: EndedCall) => void;
  /** Aborted from outside (a signal): no call starts after it, and the run cannot pass. */
  readonly stop?: AbortSignal;
  readonly clock?: Clock;
  /** The mock's own record of its sends. Without one, or unread, no call is in time. */
  readonly witness?: Witness;
}

export interface LoadRun {
  readonly calls: readonly JudgedCall[];
  readonly killAt: number | undefined;
  readonly verdict: LoadVerdict;
  /** What the mock recorded of this run's sends, when it was read. */
  readonly sends?: readonly MockSend[];
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

// Only the kind of error reaches a record or a public line, never its message.
export const errorKind = (error: unknown) =>
  error instanceof Error ? error.constructor.name || "Error" : "unknown";
/** The name a stop gives, such as `SIGTERM`; nothing else of its reason. */
export const stopKind = (signal: AbortSignal) =>
  typeof signal.reason === "string" && /^[A-Z]{3,16}$/u.test(signal.reason)
    ? signal.reason
    : "stopped";

/**
 * Workers send back to back from their ramp step until the duration or the call budget ends. The
 * first call that is not a pass, or a worker that throws, stops every worker from starting another;
 * calls in flight finish and are recorded. A call in flight at the kill time is then sent once more,
 * for its own class.
 */
export async function runLoad(input: LoadInput): Promise<LoadRun> {
  const { shape } = input;
  const clock = input.clock ?? systemClock;
  const run = randomBytes(8).toString("hex");
  const context: CallContext = {
    run,
    client: input.client,
    credential: input.credential,
    clock,
    maxAttempts: shape.maxAttempts,
    attemptTimeoutMs: shape.attemptTimeoutMs,
  };
  const kinds = new Map(shape.mix.map((kind) => [kind.name, kind]));
  const next = kindRotation(shape.mix);
  // How long an answer could have waited on the driver's own loop, measured for the whole run: a
  // wait there delays every clock read a timing depends on. The run starts once the probe answers.
  const probe = await startIoProbe();
  const started = clock.now();
  const end = started + shape.durationMs;
  // Aborted by the first non-pass, a worker's error or the budget's last call: no worker starts another.
  const halt = new AbortController();
  const records: CallRecord[] = [];
  let sent = 0;
  let firstFailure: number | undefined;
  let error: string | undefined;
  const stopped = () => {
    error ??= stopKind(input.stop!);
    halt.abort();
  };
  if (input.stop?.aborted) stopped();
  else input.stop?.addEventListener("abort", stopped, { once: true });
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
      const classes = barClasses(record, kind);
      input.ended?.({ ...record, classes, pass: classes.length === 0 });
      if (classes.length && firstFailure === undefined) {
        firstFailure = record.call;
        halt.abort();
      }
    }
  };
  await Promise.all(
    Array.from({ length: shape.concurrency }, (_, index) =>
      worker(index).catch((thrown: unknown) => {
        error ??= errorKind(thrown);
        halt.abort();
      }),
    ),
  );

  let killAt = input.kill?.();
  const killDeadline = clock.now() + (input.killWaitMs ?? 0);
  // A stopped run reports at once: it waits for no marker and sends nothing more.
  const signalled = () => input.stop?.aborted === true;
  while (input.kill && killAt === undefined && !signalled() && clock.now() < killDeadline) {
    await clock.sleep(500);
    killAt = input.kill();
  }
  const judged = records
    .sort((a, b) => a.call - b.call)
    .map((record) => judge(record, kinds.get(record.kind)!, killAt));
  await Promise.all(
    judged
      .filter((call) => call.inFlight && !call.pass && !signalled())
      .map(async (call) => {
        const kind = kinds.get(call.kind)!;
        try {
          const resend = await sendAttempt(context, kind, call.traceId, call.attempts.length + 1);
          call.inFlight!.resend = {
            ...resend,
            passed: servedClean(resend) && resend.boot !== undefined && !delayed(resend, kind),
          };
        } catch (thrown) {
          error ??= errorKind(thrown);
        }
      }),
  );
  const ioLagMaxMs = await probe.stop();
  // Read once every send has ended, outside the probe's measure: the mock records an answer as its
  // body ends, which is before the driver read that end.
  const sends = await input.witness?.read(run).catch(() => undefined);
  const marked = sends && byMarker(sends);
  const calls = judged.map((call) =>
    witnessed(call, kinds.get(call.kind)!, run, marked, loadClasses),
  );
  input.stop?.removeEventListener("abort", stopped);
  if (signalled()) error ??= stopKind(input.stop!);
  return {
    calls,
    killAt,
    sends,
    verdict: verdictOf(
      calls,
      firstFailure,
      { armed: input.kill !== undefined, at: killAt },
      error,
      ioLagMaxMs,
      {
        read: sends !== undefined,
        sends: sends?.length ?? 0,
        driverMissing: marked ? driverMissing(run, calls, marked) : 0,
      },
    ),
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
    `load classes ${loadOutcomes.map((name) => `${name}=${verdict.counts[name]}`).join(" ")}`,
    verdict.witness.read
      ? `load witness=read sends=${verdict.witness.sends}`
      : "load witness=unread",
  ];
  if (verdict.error) lines.push(`load error=${verdict.error}`);
  const lag = verdict.ioLagMaxMs;
  lines.push(
    `load io_lag_max_ms=${lag ?? "unmeasured"} limit_ms=${ioLagLimitMs}${lag === undefined || lag >= ioLagLimitMs ? " timings_not_trusted" : ""}`,
  );
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
    .map((call) => contentWaitMs(call.attempts[0]!))
    .sort((a, b) => a - b);
  lines.push(
    `load first_content_ms passes p50=${percentile(first, 0.5)} p95=${percentile(first, 0.95)} max=${percentile(first, 1)}`,
    `load boots distinct=${verdict.boots.length} answers=${verdict.boots.join(",") || "0"}`,
    // The pool strips its placement header, so a caller sees the boot and not the runtime.
    "load runtime=not_visible_to_callers join_on=requestId,traceId",
  );
  if (verdict.restart) {
    const { kill, inFlight, resendPassed, newBoots, goneBoots, passed } = verdict.restart;
    lines.push(
      `load restart kill=${kill} in_flight=${inFlight} in_flight_cut=${verdict.counts.in_flight_cut} resend_passed=${resendPassed} new_boots=${newBoots} gone_boots=${goneBoots} verdict=${passed ? "passed" : "not_passed"}`,
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
