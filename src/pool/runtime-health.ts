import { runtimeReadStep, type RuntimeReadSteps } from "./runtime-read-trace.ts";
import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";
import { readinessDistance } from "./runtime-distance.ts";
import { readySignals, withReadySignals } from "./runtime-ready-signals.ts";

export const policyHealthLeaseMs = 1_500;
export const policyHealthRefreshMs = 500;
export const policyHealthProbeMs = 250;
export const policyHealthHeader = "X-Signalbox-Policy-Lease-Ms";
export const launchGenerationHeader = "X-Signalbox-Launch-Generation";
export const launchTokenHashHeader = "X-Signalbox-Launch-Token-Sha256";
/** A refusal's body is read only for its signals; a larger one is dropped unparsed. */
export const refusalBodyBytes = 16 * 1024;
/** How long a refusal waits for its body's signals: a refusal still arrives when it did without them. */
export const refusalBodyMs = 250;

type Readiness = { fetch(input: string, init: RequestInit): Promise<Response> };

/** Start the remaining lease at request dispatch, so transport delay cannot extend it. */
export async function readRuntimeHealth(
  readiness: Readiness,
  managementKey: string,
  signal: AbortSignal,
  now = () => performance.now(),
  trace?: RuntimeReadSteps,
): Promise<PoolStatus> {
  const requestedAt = now();
  const answer = await healthResponse(readiness, managementKey, signal, policyHealthLeaseMs, trace);
  return poolStatus(answer, requestedAt);
}

/**
 * The same read with no lease window, bounded only by `signal`: whether the container answers
 * ready, however late. A 200 says its services and policy lease were live when it answered, but a
 * lease that ran out on the way back admits no call, so this is never authority to send one.
 */
export async function readRuntimeLiveness(
  readiness: Readiness,
  managementKey: string,
  signal: AbortSignal,
): Promise<PoolStatus> {
  const requestedAt = performance.now();
  return poolStatus(await healthResponse(readiness, managementKey, signal, undefined), requestedAt);
}

function poolStatus(
  { response, status }: Awaited<ReturnType<typeof healthResponse>>,
  requestedAt: number,
): PoolStatus {
  if (
    typeof status !== "object" ||
    status === null ||
    !("boot_id" in status) ||
    !("started_at" in status) ||
    typeof status.boot_id !== "string" ||
    typeof status.started_at !== "string"
  )
    throw new PoolRuntimeUnhealthy();
  const remaining = response.headers.get(policyHealthHeader);
  const milliseconds = remaining !== null && /^[1-9]\d*$/.test(remaining) ? Number(remaining) : 0;
  const generation = response.headers.get(launchGenerationHeader);
  const tokenHash = response.headers.get(launchTokenHashHeader);
  const database = readinessDistance(status);
  const ready = readySignals(status);
  const refreshing = refreshInFlight(status);
  return {
    boot_id: status.boot_id,
    started_at: status.started_at,
    ...(generation &&
    /^[1-9]\d*$/.test(generation) &&
    Number.isSafeInteger(Number(generation)) &&
    tokenHash &&
    /^[a-f0-9]{64}$/.test(tokenHash)
      ? { launch: { generation: Number(generation), tokenHash } }
      : {}),
    ...(milliseconds > 0 && milliseconds <= policyHealthLeaseMs
      ? { policyLeaseUntil: requestedAt + milliseconds, policyLeaseMs: milliseconds }
      : {}),
    ...(database ? { database } : {}),
    ...("resume" in status && status.resume === "v1" ? { resume: "v1" as const } : {}),
    ...(ready ? { ready } : {}),
    ...(refreshing !== undefined ? { refreshInFlight: refreshing } : {}),
  };
}

/**
 * Home's own count of refreshes in flight, which a container reports only while its reading is
 * fresh and the root's image never does. Only a non-negative integer counts; anything else is
 * unknown.
 */
export function refreshInFlight(body: unknown) {
  if (typeof body !== "object" || body === null || !("refresh_in_flight" in body)) return undefined;
  const count = body.refresh_in_flight;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}
// Keeps the refusal's identity, as its ready signals do, so existing refusal handling is unchanged.
const refusedRefresh = new WeakMap<object, number>();
/** The refresh count a refused readiness answer reported, if it reported one. */
export function refusalRefreshInFlight(error: unknown) {
  return typeof error === "object" && error !== null ? refusedRefresh.get(error) : undefined;
}

/**
 * `limitMs`: a read for authority gives up at the maximum lease window, since a response after it
 * can carry none; a liveness read passes none and waits as long as its caller does.
 */
async function healthResponse(
  readiness: Readiness,
  managementKey: string,
  signal: AbortSignal,
  limitMs: number | undefined,
  trace?: RuntimeReadSteps,
) {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const bounded = AbortSignal.any([signal, deadline.signal]);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    const pending = reader ? reader.cancel() : response?.body?.cancel();
    void pending?.catch(() => {});
  };
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      cancel();
      reject(bounded.reason);
    };
    bounded.addEventListener("abort", onAbort, { once: true });
  });
  const timer =
    limitMs === undefined
      ? undefined
      : setTimeout(
          () =>
            deadline.abort(new DOMException("Runtime health deadline exceeded", "TimeoutError")),
          limitMs,
        );
  try {
    response = await runtimeReadStep(
      trace,
      "health_headers",
      () =>
        Promise.race([
          readiness
            .fetch("http://pool/ready", {
              signal: bounded,
              headers: { Authorization: `Bearer ${managementKey}` },
            })
            .catch((error: unknown) => {
              if (bounded.aborted) throw error;
              throw new ReadinessReadFailure("transport", error);
            })
            .then((value) => {
              response = value;
              if (bounded.aborted) {
                cancel();
                bounded.throwIfAborted();
              }
              return value;
            }),
          aborted,
        ]),
      8318,
    );
    const received = response;
    // Only a refusal's body, read just for the signals it may carry, is capped.
    const limit = received.ok ? undefined : refusalBodyBytes;
    // A refusal's body is read only for its signals, so it is no phase of the read.
    const body: Promise<unknown> = runtimeReadStep(
      received.ok ? trace : undefined,
      "health_body",
      () =>
        Promise.race([
          (async () => {
            reader = received.body?.getReader();
            const decoder = new TextDecoder();
            let text = "";
            let bytes = 0;
            try {
              while (reader) {
                const part = await reader.read().catch((error: unknown) => {
                  if (bounded.aborted) throw error;
                  throw new ReadinessReadFailure("transport", error);
                });
                bounded.throwIfAborted();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (limit !== undefined && bytes > limit)
                  throw new ReadinessReadFailure("body", new RangeError("Body over its limit"));
                text += decoder.decode(part.value, { stream: true });
              }
              bounded.throwIfAborted();
              try {
                return JSON.parse(text + decoder.decode());
              } catch (error) {
                if (error instanceof SyntaxError) throw new ReadinessReadFailure("body", error);
                throw error;
              }
            } finally {
              reader?.releaseLock();
              reader = undefined;
            }
          })(),
          aborted,
        ]),
      8318,
    );
    if (!received.ok) {
      // Whatever the body does the refusal stays this refusal, and it waits at most refusalBodyMs
      // for the signals; the catch below cancels whatever is left of the body.
      let late: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        body.then(
          (value) => ({ signals: readySignals(value), refreshing: refreshInFlight(value) }),
          () => undefined,
        ),
        new Promise<undefined>((resolve) => {
          late = setTimeout(resolve, refusalBodyMs, undefined);
        }),
      ]);
      clearTimeout(late);
      const refusal = withReadySignals(new PoolRuntimeUnhealthy(), read?.signals);
      if (read?.refreshing !== undefined) refusedRefresh.set(refusal, read.refreshing);
      throw refusal;
    }
    const status = await body;
    return { response: received, status };
  } catch (error) {
    cancel();
    throw error;
  } finally {
    clearTimeout(timer);
    bounded.removeEventListener("abort", onAbort);
  }
}

/** The readiness port failed in transport or answered an unparsable body; never a code defect. */
export class ReadinessReadFailure extends Error {
  readonly kind: "transport" | "body";
  constructor(kind: ReadinessReadFailure["kind"], cause: unknown) {
    super(`Runtime readiness read failed: ${kind}`, { cause });
    this.kind = kind;
  }
}
