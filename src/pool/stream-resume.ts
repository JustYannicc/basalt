import { Schema } from "effect";
import { SlotIdentity } from "./runtime-slots/contract.ts";
import {
  refuseRuntime,
  rememberRuntimeFailure,
  retainEndpointRequestId,
} from "./runtime-route-diagnostic.ts";

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
/** The layer's answer when it could not reach the node: no request byte reached the node. */
export const streamResumeUpstreamHeader = "X-Basalt-Resume-Upstream";
export const streamResumePath = "/__basalt/resume/v1/";
/**
 * Set by the controller on a finite model call it would let the front layer keep. The hop that
 * owns the container turns it into the layer's mark only while the container advertises the layer.
 */
export const streamResumeEligibleHeader = "X-Basalt-Resume-Eligible";
/** The front layer's own port; marked calls and resume reads only. */
export const resumeLayerPort = 8316;
/** Attempts per cut; each waits the replay delay first, as the reset replay does. */
export const streamResumeAttempts = 3;
/** A cut's attempts end this long after it; a new instance answers within seconds. */
export const streamResumeWindowMs = 20_000;
/** Cuts one answer is resumed from, each only after the delivered offset moved. */
export const streamResumeCuts = 5;
/** A body kept for a refused connect's resend stays inside the entry's own bounds for a held copy. */
const spareBytes = 4 * 1024 * 1024;
const spareBudgetBytes = 32 * 1024 * 1024;
// Each share carries its own deadline, as the entry's held copy does: a send that never settles
// never reaches its release, and its bytes must not stay counted for the life of the isolate.
const spares = new Map<object, { bytes: number; until: number }>();
function spareHeld(now: number) {
  let total = 0;
  for (const [key, share] of spares) {
    if (share.until <= now) spares.delete(key);
    else total += share.bytes;
  }
  return total;
}
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
  return new Request(new URL(`${streamResumePath}${input.requestId}`, "http://pool"), {
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

/**
 * The platform refused the connection, so the layer accepted nothing of the call. A container
 * port with nothing listening fails with this message and no code (the platform's containers
 * library matches the same text); a plain socket refusal carries ECONNREFUSED.
 */
export function layerConnectRefused(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && current.code === "ECONNREFUSED") return true;
    if (
      current instanceof Error &&
      current.message.toLowerCase().includes("the container is not listening")
    )
      return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** A copy of a call's body for a resend, when its size is known and inside the bounds. */
function spareOf(request: Request) {
  const size = request.body ? Number(request.headers.get("Content-Length") ?? Number.NaN) : 0;
  if (!Number.isSafeInteger(size) || size < 0 || size > spareBytes) return undefined;
  const now = Date.now();
  if (spareHeld(now) + size > spareBudgetBytes) return undefined;
  const key = {};
  // A refused connect or an unreachable node answers at the connect, well inside the window; past
  // it the share is no longer counted, so the copy is never sent either.
  const until = now + streamResumeWindowMs;
  spares.set(key, { bytes: size, until });
  return {
    request: request.clone(),
    usable: () => Date.now() < until,
    release: () => spares.delete(key),
  };
}

/** A resume read: gone when the layer can't take it or sends no headers within the window. */
async function resumeRead(
  request: Request,
  send: (request: Request, port: typeof resumeLayerPort) => Promise<Response>,
) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), streamResumeWindowMs);
  try {
    return await send(new Request(request, { signal: deadline.signal }), resumeLayerPort);
  } catch {
    return resumeGone();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a routed request to the front layer's port. A layer that died since the readiness read
 * costs resumability only: a refused connect sends the call on to the node unmarked, as it would
 * have gone without the advert, and any other failure is recorded as the layer's, so neither the
 * fleet's quarantine nor a runtime recovery acts on it. A stopped container is the runtime's
 * failure, as on the node's port. A body too large to keep, or of unknown size, is never re-sent.
 */
export async function toLayer(
  request: Request,
  send: (request: Request, port: 8317 | typeof resumeLayerPort) => Promise<Response>,
  running: () => boolean = () => true,
): Promise<Response> {
  if (new URL(request.url).pathname.startsWith(streamResumePath)) return resumeRead(request, send);
  const spare = spareOf(request);
  let resent = false;
  const toNode = (copy: Request) => {
    resent = true;
    const headers = new Headers(copy.headers);
    headers.delete(streamResumableHeader);
    return send(new Request(copy, { headers }), 8317);
  };
  try {
    let answer: Response;
    try {
      answer = await send(request, resumeLayerPort);
    } catch (error) {
      if (!running()) throw error;
      if (spare?.usable() && layerConnectRefused(error)) return await toNode(spare.request);
      rememberRuntimeFailure("resume_layer", error);
      throw error;
    }
    const upstream = answer.status === 502 ? answer.headers.get(streamResumeUpstreamHeader) : null;
    if (upstream !== "unreachable" && upstream !== "failed") return answer;
    void answer.body?.cancel().catch(() => {});
    // The layer couldn't reach the node, so the node saw nothing: its port answers as today.
    if (upstream === "unreachable" && spare?.usable()) return await toNode(spare.request);
    // The node failed, or can't be reached and the call can't be re-sent: the node's own failure,
    // as on its port, and never sent twice, since the node may have started it.
    refuseRuntime(
      "port_dispatch",
      new Error(
        upstream === "failed" ? "Pool node failed before answering" : "Pool node unreachable",
      ),
    );
  } finally {
    spare?.release();
    if (!resent) void spare?.request.body?.cancel().catch(() => {});
  }
}

/** The explicit "gone": the entry ends the stream with today's retry terminal. */
export function resumeGone(state: "gone" | "failed" = "gone") {
  return new Response(null, { status: 410, headers: { [streamResumeStateHeader]: state } });
}

/** Marks an answer with the runtime that served it, only when that runtime can resume it. */
export function stampResumeTarget(response: Response, target: StreamResumeTarget) {
  if (!response.ok || response.headers.get(streamResumeHeader) !== streamResumeVersion)
    return response;
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
  if (!internalHeaders.some((name) => response.headers.has(name))) return response;
  const requestId = response.headers.get("X-Request-Id") ?? "";
  const target = response.headers.get(streamResumeTargetHeader) ?? "";
  const boot = response.headers.get(streamBootHeader) ?? "";
  const headers = new Headers(response.headers);
  for (const name of internalHeaders) headers.delete(name);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (
    !response.ok ||
    !response.body ||
    response.headers.get(streamResumeHeader) !== streamResumeVersion ||
    !requestIdPattern.test(requestId) ||
    !decodeResumeTarget(target) ||
    !boot
  )
    // Not resumable after all: the same answer, with nothing internal left in it.
    return new Response(response.body, init);
  let reader = response.body.getReader();
  let delivered = 0;
  let cuts = 0;
  let resumedAt = -1;
  let cancelled = false;
  const reattach = async () => {
    const cutAt = deps.now();
    for (let attempt = 1; attempt <= streamResumeAttempts; attempt++) {
      if (deps.now() - cutAt + deps.delayMs > streamResumeWindowMs) break;
      await deps.wait(deps.delayMs, deps.signal);
      let answer: Response | undefined;
      try {
        answer = await withinWindow(
          deps.resume({ requestId, from: delivered, target, boot }),
          streamResumeWindowMs - (deps.now() - cutAt),
        );
      } catch (error) {
        // The new instance may not be up yet; any other refusal means it cannot resume.
        if (deps.ended(error) && !deps.signal.aborted) continue;
        return { outcome: "failed" as const, attempt };
      }
      if (!answer) return { outcome: "failed" as const, attempt };
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
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try {
            part = await reader.read();
          } catch (error) {
            if (!deps.ended(error) || deps.signal.aborted || cancelled) throw error;
            // A cut with no byte delivered since the last resume, or one too many, is not resumed.
            if (++cuts > streamResumeCuts || delivered === resumedAt) throw error;
            const result = await reattach();
            console.info("POOL_STREAM_RESUME", {
              requestId,
              outcome: result.outcome,
              attempts: result.attempt,
              from: delivered,
            });
            // No resume: the original error ends the stream, so today's retry terminal follows.
            if (result.outcome !== "resumed") throw error;
            // The client left while the resume was asked for: the resumed part is not kept open.
            if (cancelled || deps.signal.aborted) {
              void result.reader.cancel().catch(() => {});
              throw error;
            }
            reader = result.reader;
            resumedAt = delivered;
            continue;
          }
          if (part.done) return controller.close();
          delivered += part.value.byteLength;
          return controller.enqueue(part.value);
        }
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason);
      },
    }),
    init,
  );
}

/** The answer if it comes within the window, or nothing; a later one is cancelled when it comes. */
async function withinWindow(answer: Promise<Response>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, milliseconds), undefined);
  });
  try {
    const first = await Promise.race([answer, late]);
    if (!first) void answer.then((value) => value.body?.cancel()).catch(() => {});
    return first;
  } finally {
    clearTimeout(timer);
  }
}
