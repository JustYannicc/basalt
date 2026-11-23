import { runtimeReadStep, type RuntimeReadTrace } from "./runtime-read-trace.ts";
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

/** Start the remaining lease at request dispatch, so transport delay cannot extend it. */
export async function readRuntimeHealth(
  readiness: { fetch(input: string, init: RequestInit): Promise<Response> },
  managementKey: string,
  signal: AbortSignal,
  now = () => performance.now(),
  trace?: RuntimeReadTrace,
): Promise<PoolStatus> {
  const requestedAt = now();
  const { response, status } = await healthResponse(readiness, managementKey, signal, trace);
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
      ? { policyLeaseUntil: requestedAt + milliseconds }
      : {}),
    ...(database ? { database } : {}),
    ...("resume" in status && status.resume === "v1" ? { resume: "v1" as const } : {}),
    ...(ready ? { ready } : {}),
  };
}

/** A response cannot carry usable authority after the maximum lease window has elapsed. */
async function healthResponse(
  readiness: { fetch(input: string, init: RequestInit): Promise<Response> },
  managementKey: string,
  signal: AbortSignal,
  trace?: RuntimeReadTrace,
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
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Runtime health deadline exceeded", "TimeoutError")),
    policyHealthLeaseMs,
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
    const body: Promise<unknown> = runtimeReadStep(
      trace,
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
      // Inside the same deadline, and whatever the body does the refusal stays this refusal; the
      // catch below cancels whatever is left of it.
      const signals = await body.then(readySignals, () => undefined);
      throw withReadySignals(new PoolRuntimeUnhealthy(), signals);
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
