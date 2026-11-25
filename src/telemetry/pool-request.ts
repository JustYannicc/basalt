import { createMiddlewareLogger } from "evlog/toolkit";
import { initWorkersLogger } from "evlog/workers";
import type { SentryEnv } from "./sentry-target.ts";
import {
  exportSpans,
  methods,
  parseTraceparent,
  randomHex,
  type OtlpSpan,
  type TraceSend,
} from "./traces.ts";

/**
 * One wide event per pool request: where its time went between the Worker, the pool's Durable
 * Object, Home's dispatch and the provider. Every field is a closed label, a count, a duration or
 * an opaque reference. Paths, headers, bodies, model names and credentials never enter it.
 */

// The Worker has no stage binding; Sentry files unlabelled events under production as well.
initWorkersLogger({ env: { service: "basalt-pool", environment: "production" } });

const hops = [
  "worker",
  "replay",
  "queue",
  "admission",
  "dispatch",
  "firstByte",
  "unanswered",
  "stream",
] as const;
type Hop = (typeof hops)[number];
/** Home's dispatch stages, each under the field it is reported as. */
const homeFields: Readonly<Record<string, string>> = {
  authenticate: "homeAuthenticateMs",
  selection: "homeSelectionMs",
  admission: "homeAdmissionMs",
  reply_write: "homeReplyWriteMs",
  ping: "homePingMs",
  rpop: "homeRpopMs",
};
const outcomes = [
  "complete",
  "truncated",
  "client_closed",
  "provider_failed",
  "unavailable",
  "responded",
  "upgraded",
  "runtime_refused",
  "refused",
  "outcome_unknown",
  // Its runtime refused it before the container send; the Worker sends it again under this ID.
  "unsent",
  "controller_unavailable",
  "controller_failed",
  "controller_reset",
] as const;
export type PoolRequestOutcome = (typeof outcomes)[number];
const labelKeys = [
  "guard",
  "cause",
  "refusalReason",
  "runtimeStep",
  "runtimeReason",
  "runtimeRefused",
  "overloaded",
] as const;
const idKeys = ["responseRequestId"] as const;
/** The runtime that served the call: kind, slot, image input and boot, or `unplaced` in each. */
const runtimeKeys = ["runtime", "slot", "imageInput"] as const;
const bootKey = "boot";
export type PoolRequestLabels = Partial<
  Record<(typeof labelKeys)[number], string | boolean | undefined> &
    Record<
      (typeof idKeys)[number] | (typeof runtimeKeys)[number] | typeof bootKey,
      string | undefined
    >
>;
const label = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const runtimeWord = /^[A-Za-z0-9._:-]{1,128}$/;
const routeLabel = /^\/[A-Za-z0-9/:._-]{0,95}$/;
const kinds = ["model", "socket", "other"];
const count = (value: number | undefined) =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export interface HomeDispatchStage {
  stage: string;
  duration_ms: number;
  outcome: string;
}

export interface PoolRequestInput {
  requestId: string;
  method: string;
  /** A fixed route label, never a caller's path. */
  route: string;
  kind?: "model" | "socket" | "other" | undefined;
  port?: number | undefined;
  /** Model streams this Durable Object already held when the request arrived. */
  inFlight?: number | undefined;
  /** Wall clock when the Worker received the request and when it called the Durable Object. */
  receivedAt?: number | undefined;
  calledAt?: number | undefined;
  /** The first call, when `calledAt` is a second one after the object's instance was replaced. */
  firstCalledAt?: number | undefined;
  /** Wall clock when the Durable Object's handler started. Absent while the call never arrived. */
  arrivedAt?: number | undefined;
  /** This event's clock at that same moment. */
  started?: number | undefined;
  /** The caller's `traceparent`; only a well-formed one is continued. */
  traceparent: string | null;
  defer(work: Promise<unknown>): void;
}

export interface PoolRequestResult {
  outcome: PoolRequestOutcome;
  /** Absent when no response was produced. */
  status?: number | undefined;
  /** Present when the response body was observed to its end. */
  bytes?: number | undefined;
}

export interface PoolRequestEvent {
  /** Closed labels and identifiers; anything shaped like free text is dropped. */
  set(labels: PoolRequestLabels): void;
  /** Identity, membership and stream lease are settled. */
  admitted(): void;
  /** The request is handed to the runtime. */
  dispatched(): void;
  /** The runtime's response headers arrived. */
  firstByte(): void;
  home(stages: readonly HomeDispatchStage[]): void;
  /** Group by pool without recording which pool it is. */
  pool(pool: string | undefined): void;
  /** The first call emits the event; later calls are ignored. */
  end(result: PoolRequestResult): void;
}

const whole = (value: number) => Math.max(0, Math.round(value));

async function reference(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`basalt-pool-request:${value}`),
  );
  return Array.from(new Uint8Array(hash).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function poolRequestEvent(
  env: SentryEnv,
  input: PoolRequestInput,
  clock: () => number = () => performance.now(),
  wall: () => number = () => Date.now(),
  send?: TraceSend,
): PoolRequestEvent {
  const method = methods.has(input.method) ? input.method : "OTHER";
  const route = routeLabel.test(input.route) ? input.route : "/other";
  const requestId = uuid.test(input.requestId) ? input.requestId : crypto.randomUUID();
  const kind = input.kind !== undefined && kinds.includes(input.kind) ? input.kind : undefined;
  const port = count(input.port);
  const inFlight = count(input.inFlight);
  const parent = parseTraceparent(input.traceparent);
  const trace = {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
  };
  const sampled = parent === undefined || (Number.parseInt(parent.flags, 16) & 1) !== 0;
  const started = input.started ?? clock();
  const fields: Record<string, string | number | boolean> = {};
  const marks: { admitted?: number; dispatched?: number; firstByte?: number } = {};
  let pool: string | undefined;
  let ended = false;
  let exported: OtlpSpan[] = [];
  const { logger, finish } = createMiddlewareLogger({
    method,
    path: route,
    requestId,
    waitUntil: input.defer,
    // evlog writes the event to the Worker's log itself. Its Sentry drain follows redirects, which
    // this module's exporters refuse, so the diagnostic project receives the event as a trace.
    drain: () => exportSpans(env, exported, send),
  });

  const emit = async (result: PoolRequestResult, finished: number, finishedAt: number) => {
    const durations: Partial<Record<Hop, number>> = {};
    if (input.receivedAt !== undefined && input.calledAt !== undefined) {
      const firstCall = input.firstCalledAt ?? input.calledAt;
      durations.worker = whole(firstCall - input.receivedAt);
      // The failed call and the wait before the next one belong to neither the Worker nor the queue.
      if (input.firstCalledAt !== undefined) durations.replay = whole(input.calledAt - firstCall);
      // A call that failed without an answer waited for the Durable Object, unless the object's own
      // code threw, its instance ended mid-call or the caller left: then the Worker cannot tell the
      // wait from the work.
      if (
        input.arrivedAt === undefined &&
        (result.outcome === "controller_failed" ||
          result.outcome === "controller_reset" ||
          result.outcome === "client_closed")
      )
        durations.unanswered = whole(finishedAt - input.calledAt);
      else durations.queue = whole((input.arrivedAt ?? finishedAt) - input.calledAt);
    }
    if (input.arrivedAt !== undefined || input.calledAt === undefined) {
      // Only an observed body has a stream to time; otherwise the event ends with the headers.
      const last = result.bytes === undefined ? (marks.firstByte ?? finished) : finished;
      durations.admission = whole((marks.admitted ?? last) - started);
      // Routing can answer without handing the request to a runtime; that wait is still dispatch.
      if (marks.admitted !== undefined)
        durations.dispatch = whole((marks.dispatched ?? last) - marks.admitted);
      if (marks.dispatched !== undefined && marks.firstByte !== undefined)
        durations.firstByte = whole(marks.firstByte - marks.dispatched);
      // Handed to the runtime and never answered: not a first byte.
      if (marks.dispatched !== undefined && marks.firstByte === undefined)
        durations.unanswered = whole(last - marks.dispatched);
      if (marks.firstByte !== undefined && result.bytes !== undefined)
        durations.stream = whole(finished - marks.firstByte);
    }
    const totalMs = hops.reduce((total, hop) => total + (durations[hop] ?? 0), 0);
    const labels: Record<string, string | number | boolean> = {
      ...(kind === undefined ? {} : { kind }),
      ...(port === undefined ? {} : { port }),
      ...(inFlight === undefined ? {} : { inFlight }),
      ...fields,
      outcome: outcomes.includes(result.outcome) ? result.outcome : "unavailable",
      ...(result.bytes === undefined ? {} : { bytes: result.bytes }),
      ...(pool === undefined ? {} : { poolRef: await reference(pool) }),
    };
    const timings: Record<string, number> = { totalMs };
    for (const hop of hops) if (durations[hop] !== undefined) timings[`${hop}Ms`] = durations[hop];
    const failed = result.status === undefined || result.status >= 500;
    if (sampled) {
      const nano = (milliseconds: number) => BigInt(Math.round(milliseconds)) * 1_000_000n;
      const startedAt = input.receivedAt ?? input.arrivedAt ?? finishedAt - totalMs;
      exported = [
        {
          ...trace,
          name: `pool ${method} ${route}`,
          kind: 2,
          startUnixNano: nano(startedAt),
          endUnixNano: nano(startedAt + totalMs),
          attributes: {
            "http.request.method": method,
            "http.route": route,
            ...(result.status === undefined ? {} : { "http.response.status_code": result.status }),
            "pool.requestId": requestId,
            ...Object.fromEntries(
              Object.entries({ ...labels, ...timings }).map(([key, value]) => [
                `pool.${key}`,
                typeof value === "boolean" ? String(value) : value,
              ]),
            ),
          },
          ...(failed ? { failed: true } : {}),
        },
      ];
      let offset = startedAt;
      for (const hop of hops) {
        const duration = durations[hop];
        if (duration === undefined) continue;
        // A hop that took no measurable time adds a span without adding an answer.
        if (duration >= 1)
          exported.push({
            traceId: trace.traceId,
            spanId: randomHex(8),
            parentSpanId: trace.spanId,
            name: `pool.${hop}`,
            kind: 1,
            startUnixNano: nano(offset),
            endUnixNano: nano(offset + duration),
            attributes: {},
          });
        offset += duration;
      }
    }
    // Flat scalars: a log query and a span attribute can each sum a number, not a nested object.
    logger.set({ traceId: trace.traceId, spanId: trace.spanId, ...labels, ...timings });
    await finish(result.status === undefined ? {} : { status: result.status });
  };

  return {
    set(labels) {
      if (ended) return;
      for (const key of labelKeys) {
        const value = labels[key];
        if (typeof value === "boolean" || (typeof value === "string" && label.test(value)))
          fields[key] = value;
      }
      for (const key of idKeys) {
        const value = labels[key];
        if (typeof value === "string" && uuid.test(value)) fields[key] = value.toLowerCase();
      }
      for (const key of runtimeKeys) {
        const value = labels[key];
        if (typeof value === "string" && runtimeWord.test(value)) fields[key] = value;
      }
      // A runtime's boot is the UUID it made at start; anything else is not one.
      const boot = labels[bootKey];
      if (boot === "unplaced") fields[bootKey] = boot;
      else if (typeof boot === "string" && uuid.test(boot)) fields[bootKey] = boot.toLowerCase();
    },
    admitted() {
      marks.admitted ??= clock();
    },
    dispatched() {
      marks.dispatched ??= clock();
    },
    firstByte() {
      marks.firstByte ??= clock();
    },
    home(stages) {
      if (ended) return;
      const faults: string[] = [];
      for (const { stage, duration_ms, outcome } of stages) {
        const field = Object.hasOwn(homeFields, stage) ? homeFields[stage] : undefined;
        if (!field || !Number.isSafeInteger(duration_ms) || duration_ms < 0) continue;
        fields[field] = duration_ms;
        if (outcome !== "ok" && label.test(outcome)) faults.push(`${stage}:${outcome}`);
      }
      if (faults.length) fields.homeFaults = faults.join(",");
    },
    pool(value) {
      pool ??= value;
    },
    end(result) {
      if (ended) return;
      ended = true;
      // Telemetry never fails or delays the request it describes.
      input.defer(
        emit(result, clock(), wall()).catch(() => console.error("POOL_REQUEST_EVENT_FAILED")),
      );
    },
  };
}

/** A request is never refused because it could not be observed. */
export function startPoolRequestEvent(
  env: SentryEnv,
  input: () => PoolRequestInput,
): PoolRequestEvent | undefined {
  try {
    return poolRequestEvent(env, input());
  } catch {
    console.error("POOL_REQUEST_EVENT_UNAVAILABLE");
    return undefined;
  }
}
