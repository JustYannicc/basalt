import { Schema } from "effect";
import { SlotIdentity } from "./runtime-slots/contract.ts";
import { rememberRuntimeFailure, retainEndpointRequestId } from "./runtime-route-diagnostic.ts";

/**
 * Resumable model streams, contract v1 (issue #1642): the container's front layer keeps a call's
 * raw answer for a while, and when the controller instance ends mid-body the entry re-attaches
 * through the new instance and splices the rest in. Without the front layer nothing here acts.
 */
export const streamResumableHeader = "X-Basalt-Resumable";
export const streamResumeHeader = "X-Basalt-Resume";
export const streamResumeVersion = "v1";
export const streamResumeTargetHeader = "X-Basalt-Resume-Target";
export const streamResumeFromHeader = "X-Basalt-Resume-From";
export const streamResumeBootHeader = "X-Basalt-Resume-Boot";
export const streamResumeStateHeader = "X-Basalt-Resume-State";
export const streamBootHeader = "X-Signalbox-Pool-Boot";
export const streamResumePath = "/__basalt/resume/v1/";
/**
 * Set by the controller on a finite model call it would let the front layer keep. The hop that
 * owns the container turns it into the layer's mark only while the container advertises the layer.
 */
export const streamResumeEligibleHeader = "X-Basalt-Resume-Eligible";
/** The front layer's own port; marked calls and resume reads only (the layer's own, proposed by B). */
export const resumeLayerPort = 8316;
/** Attempts per cut; each waits the replay delay first, as the reset replay does. */
export const streamResumeAttempts = 3;
/** A cut's attempts end this long after it; a new instance answers within seconds. */
export const streamResumeWindowMs = 20_000;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const internalHeaders = [streamResumeHeader, streamResumeTargetHeader, streamResumeStateHeader];

export type StreamResumeTarget = { kind: "primary" } | { kind: "runtime"; identity: SlotIdentity };
export interface StreamResumeInput {
  requestId: string;
  from: number;
  target: string;
  boot: string;
}

const encodedIdentity = Schema.fromJsonString(SlotIdentity);

/** The runtime that served a call, as the opaque value the entry hands back on a resume. */
export function encodeResumeTarget(target: StreamResumeTarget) {
  if (target.kind === "primary") return "primary";
  return `runtime:${btoa(JSON.stringify(target.identity)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function decodeResumeTarget(value: unknown): StreamResumeTarget | undefined {
  if (value === "primary") return { kind: "primary" };
  if (typeof value !== "string" || value.length > 4_096) return undefined;
  const encoded = /^runtime:([A-Za-z0-9_-]+)$/.exec(value)?.[1];
  if (!encoded) return undefined;
  let json: string;
  try {
    json = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return undefined;
  }
  const identity = Schema.decodeUnknownOption(encodedIdentity)(json);
  return identity._tag === "Some" ? { kind: "runtime", identity: identity.value } : undefined;
}

/** A resume request from the entry, or nothing when any field is out of its closed form. */
export function decodeResumeInput(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Partial<Record<keyof StreamResumeInput, unknown>>;
  const target = decodeResumeTarget(input.target);
  if (
    typeof input.requestId !== "string" ||
    !requestIdPattern.test(input.requestId) ||
    typeof input.from !== "number" ||
    !Number.isSafeInteger(input.from) ||
    input.from < 0 ||
    typeof input.boot !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(input.boot) ||
    !target
  )
    return undefined;
  return { requestId: input.requestId, from: input.from, boot: input.boot, target };
}

/** The front layer's read for the rest of an answer, from the offset the entry delivered. */
export function resumeRequest(input: { requestId: string; from: number; boot: string }) {
  return new Request(`http://pool${streamResumePath}${input.requestId}`, {
    method: "GET",
    headers: {
      [streamResumeFromHeader]: String(input.from),
      [streamResumeBootHeader]: input.boot,
    },
  });
}

/**
 * Where a request goes on a container, given that container's latest readiness. With the layer's
 * advert, an eligible call is marked and sent to the layer, and a resume read goes to the layer.
 * Without it the call goes to the node's port unmarked, exactly as before, and a resume is "gone".
 * The marks never come from a caller: they are removed here first.
 */
export function resumeRoute<Port extends number>(
  request: Request,
  port: Port,
  status: { resume?: "v1" } | undefined,
): { request: Request; port: Port | typeof resumeLayerPort } | "gone" {
  const advertised = status?.resume === streamResumeVersion;
  if (new URL(request.url).pathname.startsWith(streamResumePath))
    return advertised ? { request, port: resumeLayerPort } : "gone";
  const eligible = request.headers.get(streamResumeEligibleHeader) === "1";
  if (
    !eligible &&
    !request.headers.has(streamResumeEligibleHeader) &&
    !request.headers.has(streamResumableHeader)
  )
    return { request, port };
  const headers = new Headers(request.headers);
  headers.delete(streamResumeEligibleHeader);
  headers.delete(streamResumableHeader);
  const marked = eligible && advertised && port === 8317;
  if (marked) headers.set(streamResumableHeader, "1");
  return { request: new Request(request, { headers }), port: marked ? resumeLayerPort : port };
}

/** The platform refused the connection, so the layer accepted nothing of the call. */
export function layerConnectRefused(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && current.code === "ECONNREFUSED") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Sends a routed request to the front layer's port. A layer that died since the readiness read
 * costs resumability only: a refused connect sends the call on to the node unmarked, as it would
 * have gone without the advert, and any other failure is recorded as the layer's, so neither the
 * fleet's quarantine nor a runtime recovery acts on it. A resume read the layer can't take is gone.
 */
export async function toLayer(
  request: Request,
  send: (request: Request, port: 8317 | typeof resumeLayerPort) => Promise<Response>,
): Promise<Response> {
  if (new URL(request.url).pathname.startsWith(streamResumePath))
    return send(request, resumeLayerPort).catch(() => resumeGone());
  const spare = request.clone();
  try {
    const answer = await send(request, resumeLayerPort);
    void spare.body?.cancel().catch(() => {});
    return answer;
  } catch (error) {
    if (!layerConnectRefused(error)) {
      void spare.body?.cancel().catch(() => {});
      rememberRuntimeFailure("resume_layer", error);
      throw error;
    }
    const headers = new Headers(spare.headers);
    headers.delete(streamResumableHeader);
    return send(new Request(spare, { headers }), 8317);
  }
}

/** The explicit "gone": the entry ends the stream with today's retry terminal. */
export function resumeGone(state: "gone" | "failed" = "gone") {
  return new Response(null, { status: 410, headers: { [streamResumeStateHeader]: state } });
}

/** Marks an answer with the runtime that served it, only when that runtime can resume it. */
export function stampResumeTarget(response: Response, target: StreamResumeTarget) {
  if (response.headers.get(streamResumeHeader) !== streamResumeVersion) return response;
  const headers = new Headers(response.headers);
  headers.set(streamResumeTargetHeader, encodeResumeTarget(target));
  const stamped = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  // The runtime's request id travels with the answer, as it would without the stamp.
  retainEndpointRequestId(response, stamped);
  return stamped;
}

interface SpliceDeps {
  /** Resolved per attempt, as a fresh stub. */
  resume(input: StreamResumeInput): Promise<Response>;
  /** The platform's "this instance is no longer active" error, the only cut a resume can heal. */
  ended(error: unknown): boolean;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  now(): number;
  delayMs: number;
  signal: AbortSignal;
}

/**
 * The entry side of a resumable answer. It counts the raw bytes it delivered, and when the
 * controller instance ends mid-body it re-attaches from that offset and splices the rest in. When
 * no resume works it ends with the original error, so the caller's stream ends exactly as today.
 * An answer the front layer did not mark is returned untouched.
 */
export function resumableAnswer(response: Response, deps: SpliceDeps): Response {
  const requestId = response.headers.get("X-Request-Id") ?? "";
  const target = response.headers.get(streamResumeTargetHeader) ?? "";
  const boot = response.headers.get(streamBootHeader) ?? "";
  if (
    !response.ok ||
    !response.body ||
    response.headers.get(streamResumeHeader) !== streamResumeVersion ||
    !requestIdPattern.test(requestId) ||
    !decodeResumeTarget(target) ||
    !boot
  )
    return response;
  let reader = response.body.getReader();
  let delivered = 0;
  const reattach = async () => {
    const cutAt = deps.now();
    for (let attempt = 1; attempt <= streamResumeAttempts; attempt++) {
      if (deps.now() - cutAt + deps.delayMs > streamResumeWindowMs) break;
      await deps.wait(deps.delayMs, deps.signal);
      let answer: Response;
      try {
        answer = await deps.resume({ requestId, from: delivered, target, boot });
      } catch (error) {
        // The new instance may not be up yet; any other refusal means it cannot resume.
        if (deps.ended(error) && !deps.signal.aborted) continue;
        return { outcome: "failed" as const, attempt };
      }
      if (
        answer.status === 200 &&
        answer.body &&
        answer.headers.get(streamResumeHeader) === streamResumeVersion &&
        answer.headers.get(streamResumeFromHeader) === String(delivered)
      )
        return { outcome: "resumed" as const, attempt, reader: answer.body.getReader() };
      void answer.body?.cancel().catch(() => {});
      return { outcome: answer.status === 410 ? ("gone" as const) : ("failed" as const), attempt };
    }
    return { outcome: "failed" as const, attempt: streamResumeAttempts };
  };
  const headers = new Headers(response.headers);
  for (const name of internalHeaders) headers.delete(name);
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try {
            part = await reader.read();
          } catch (error) {
            if (!deps.ended(error) || deps.signal.aborted) throw error;
            const result = await reattach();
            console.info("POOL_STREAM_RESUME", {
              requestId,
              outcome: result.outcome,
              attempts: result.attempt,
              from: delivered,
            });
            // No resume: the original error ends the stream, so today's retry terminal follows.
            if (result.outcome !== "resumed") throw error;
            reader = result.reader;
            continue;
          }
          if (part.done) return controller.close();
          delivered += part.value.byteLength;
          return controller.enqueue(part.value);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}
