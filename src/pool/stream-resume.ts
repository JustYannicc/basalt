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
 * The splice itself lives in `stream-splice.ts`, which the router loads too.
 */
export * from "./stream-splice.ts";
import {
  requestIdPattern,
  streamResumableHeader,
  streamResumeEligibleHeader,
  streamResumeFromHeader,
  streamResumeBootHeader,
  streamResumeHeader,
  streamResumePath,
  streamResumeStateHeader,
  streamResumeTargetHeader,
  streamResumeUpstreamHeader,
  streamResumeVersion,
  resumeLayerPort,
  streamBootHeader,
  streamResumeAttempts,
  streamResumeCuts,
  streamResumeWindowMs,
} from "./stream-splice.ts";
/** A body kept for a refused connect's resend stays inside the entry's own bounds for a held copy. */
const spareBytes = 4 * 1024 * 1024;
const spareBudgetBytes = 32 * 1024 * 1024;
/**
 * How long a kept copy can still be re-sent. A refused connect comes at the layer's connect, and an
 * unreachable node within the layer's 5 s dial limit, before it reads a body byte. Past this a copy
 * only costs memory, so it is dropped and its share given back.
 */
export const spareWindowMs = 20_000;
// Each share also carries its own deadline: a request the platform cancels never runs its timers,
// and its bytes must not stay counted for the life of the isolate.
const spares = new Map<object, { bytes: number; until: number }>();
function spareHeld(now: number) {
  let total = 0;
  for (const [key, share] of spares) {
    if (share.until <= now) spares.delete(key);
    else total += share.bytes;
  }
  return total;
}

export type StreamResumeTarget = { kind: "primary" } | { kind: "runtime"; identity: SlotIdentity };

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
  const copy = request.clone();
  const key = {};
  const until = now + spareWindowMs;
  let state: "kept" | "taken" | "dropped" = "kept";
  const release = () => {
    clearTimeout(timer);
    spares.delete(key);
  };
  const timer = setTimeout(() => {
    if (state !== "kept") return;
    state = "dropped";
    release();
    void copy.body?.cancel().catch(() => {});
  }, spareWindowMs);
  spares.set(key, { bytes: size, until });
  return {
    copy,
    /** The copy to re-send, once and only inside its window; a taken copy is never cut. */
    take() {
      if (state !== "kept" || Date.now() >= until) return undefined;
      state = "taken";
      return copy;
    },
    release,
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
      const copy = layerConnectRefused(error) ? spare?.take() : undefined;
      if (copy) return await toNode(copy);
      rememberRuntimeFailure("resume_layer", error);
      throw error;
    }
    const upstream = answer.status === 502 ? answer.headers.get(streamResumeUpstreamHeader) : null;
    if (upstream !== "unreachable" && upstream !== "failed") return answer;
    void answer.body?.cancel().catch(() => {});
    // The layer couldn't reach the node, so the node saw nothing: its port answers as today.
    const copy = upstream === "unreachable" ? spare?.take() : undefined;
    if (copy) return await toNode(copy);
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
    if (!resent) void spare?.copy.body?.cancel().catch(() => {});
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
