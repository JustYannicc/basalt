import { runtimeReadStep, type RuntimeReadTrace } from "./runtime-read-trace.ts";
import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";

export const policyHealthLeaseMs = 1_500;
export const policyHealthRefreshMs = 500;
export const policyHealthProbeMs = 250;
export const policyHealthHeader = "X-Signalbox-Policy-Lease-Ms";
export const launchGenerationHeader = "X-Signalbox-Launch-Generation";
export const launchTokenHashHeader = "X-Signalbox-Launch-Token-Sha256";

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
    if (!received.ok) throw new PoolRuntimeUnhealthy();
    const status: unknown = await runtimeReadStep(
      trace,
      "health_body",
      () =>
        Promise.race([
          (async () => {
            reader = received.body?.getReader();
            const decoder = new TextDecoder();
            let text = "";
            try {
              while (reader) {
                const part = await reader.read();
                bounded.throwIfAborted();
                if (part.done) break;
                text += decoder.decode(part.value, { stream: true });
              }
              bounded.throwIfAborted();
              return JSON.parse(text + decoder.decode());
            } finally {
              reader?.releaseLock();
              reader = undefined;
            }
          })(),
          aborted,
        ]),
      8318,
    );
    return { response: received, status };
  } catch (error) {
    cancel();
    throw error;
  } finally {
    clearTimeout(timer);
    bounded.removeEventListener("abort", onAbort);
  }
}
