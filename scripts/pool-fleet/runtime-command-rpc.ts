import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
  type RuntimeHandoffCommand,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { openPoolOperations, type PoolOperationsTarget } from "../pool-operations.ts";
import { providerObservationFailureHeader } from "../../src/pool/runtime-provider/observation.ts";
import { provisioningRefusal } from "./provisioning-refusal.ts";
import { BarrierRefusal } from "./refusal.ts";
import { poolOperationsAnswered } from "../../src/pool/operations-call.ts";
import {
  knownRuntimeFailureCode,
  runtimeResponseDiagnostic,
} from "../../src/pool/runtime-route-diagnostic.ts";

// A refusal body is a fixed code; anything larger or unknown is never copied into evidence.
const refusalBodyLimit = 2048;
// Past the text limit the body is only counted, up to what the Node bridge carries at most.
const refusalCountLimit = 1_048_576;
const providerCodes = new Set(["provider_observation_refused", "provider_fetch_failed"]);
const providerRefusal = "runtime-provider-observation-";

/**
 * What the platform says when the session proxy's service-binding call into the pool throws: the
 * proxy answers it as its own plain-text 500 (wrangler 4.153.0's ProxyServerWorker). Each text is
 * workerd 1.20261023.1's own, from the pinned binary; only the word ever reaches evidence.
 */
export const platformMessages = [
  { word: "connection_lost", text: "Network connection lost." },
  {
    word: "hung",
    text: "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response. Refer to: https://developers.cloudflare.com/workers/observability/errors/",
  },
  { word: "context_canceled", text: "The execution context responding to this call was canceled." },
  { word: "script_reset", text: "Script modified; context reset." },
  { word: "memory_limit", text: "Worker has exceeded memory limit." },
] as const;
// The same binary's text for any internal failure; its reference is Cloudflare's, never kept.
const internalError = /^internal error; reference = [0-9a-z]{1,64}$/u;

/** Whether this refusal is an answer without the pool's mark: no answer left the pool's code. */
export const unmarkedRefusal = (error: unknown) =>
  error instanceof BarrierRefusal &&
  error.delta?.changed.some(
    (change) =>
      change.path === "handoff.response.origin" && "new" in change && change.new === "unmarked",
  ) === true;

/** The Worker's closed cause when a provider-observe was refused with its failure header. */
export function providerObservationCause(error: unknown) {
  if (!(error instanceof BarrierRefusal) || !error.reason.startsWith(providerRefusal))
    return undefined;
  const cause = error.reason.slice(providerRefusal.length);
  return cause === "provider_observation_refused" || cause === "provider_fetch_failed"
    ? cause
    : undefined;
}

type Action<T> = T extends unknown ? Omit<T, "controllerCode" | "at" | "expiresAt"> : never;
export type RuntimeCommandAction = Action<RuntimeHandoffCommand>;
export type RuntimeCommandCall = (
  action: RuntimeCommandAction,
  mutation?: boolean,
  signal?: AbortSignal,
  dispatched?: (requestedAt: number) => void,
  received?: (receivedAt: number) => void,
) => Promise<unknown>;

/**
 * One send only. An unknown response must be recovered through the retained operation's read path.
 * `dispatched` receives the monotonic time just before the request is built for the already-open
 * bridge and `received` the time its 200 body was read, before the bridge closes. A caller bounding
 * a remote lease between the two never counts bridge setup or close against it. A command given as
 * a function is built once the bridge is open, so its timed proofs never count setup either.
 */
export async function sendRuntimeCommand(
  command: RuntimeHandoffCommand | (() => Promise<RuntimeHandoffCommand>),
  signingKey: string,
  target: PoolOperationsTarget,
  assertCurrent: (command: RuntimeHandoffCommand) => void,
  signal?: AbortSignal,
  dispatched?: (requestedAt: number) => void,
  received?: (receivedAt: number) => void,
  // A mutating command keeps 15 s. A read may wait longer: the Worker caps its own provider read at
  // 15 s, so a shorter client limit can give up before the Worker's named answer arrives.
  limitMs = 15_000,
) {
  const bridge = await openPoolOperations(target);
  // A timer rather than AbortSignal.timeout, so the limit is exactly the caller's.
  const limit = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const frozen = typeof command === "function" ? await command() : command;
    const envelope = await signEnvelope(signingKey, runtimeHandoffCommandPrefix, frozen);
    assertCurrent(frozen);
    dispatched?.(performance.now());
    timer = setTimeout(
      () => limit.abort(new DOMException("The command's time limit passed", "TimeoutError")),
      limitMs,
    );
    const response = await bridge.service.fetch(
      new Request(`http://pool-operations${runtimeHandoffPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope }),
        signal: signal ? AbortSignal.any([signal, limit.signal]) : limit.signal,
      }),
    );
    if (response.status !== 200) {
      const detail = await refusalDetail(response);
      const providerCause =
        frozen.action === "provider-observe" && response.status === 409
          ? response.headers.get(providerObservationFailureHeader)
          : null;
      const reason =
        providerCause === "provider_observation_refused" ||
        providerCause === "provider_fetch_failed"
          ? `${providerRefusal}${providerCause}`
          : "runtime-handoff-response-refused";
      const refusal = provisioningRefusal(reason, "handoff.response.status", 200, response.status);
      // Keep the server's closed refusal vocabulary, so a refused command says why in failure.json.
      const delta = refusal.delta ?? {
        fqn: "PoolRuntime",
        type: "Cloudflare.Container",
        changed: [],
      };
      throw new BarrierRefusal(refusal.reason, refusal.worker, {
        ...delta,
        changed: [
          ...delta.changed,
          { path: "handoff.command.action", old: null, new: frozen.action },
          // The status as a number, so a public line can say which answer it was.
          { path: "handoff.response.http", old: null, new: response.status },
          // Without the pool's mark no answer left the pool's handoff code: a proxy on the bridge, a
          // throw or platform failure in the pool's invocation before it, or a pool from before the mark.
          { path: "handoff.response.origin", old: null, new: detail.origin },
          { path: "handoff.response.step", old: null, new: detail.step },
          { path: "handoff.response.reason", old: null, new: detail.reason },
          { path: "handoff.response.code", old: null, new: detail.code },
          // An unmarked answer says who made it in closed words and numbers, never its text.
          ...(detail.unmarked
            ? [
                { path: "handoff.response.answeredBy", old: null, new: detail.unmarked.answeredBy },
                { path: "handoff.response.bytes", old: null, new: detail.unmarked.bytes },
                { path: "handoff.response.message", old: null, new: detail.unmarked.message },
                { path: "handoff.response.ray", old: null, new: detail.unmarked.ray },
              ]
            : []),
        ],
      });
    }
    const body: unknown = await response.json();
    received?.(performance.now());
    return body;
  } finally {
    clearTimeout(timer);
    await bridge.close();
  }
}

/** Reads at most a small refusal body, then keeps only values from the server's fixed vocabulary. */
async function refusalDetail(response: Response) {
  const headers = runtimeResponseDiagnostic(response);
  let code = "unclassified";
  const { text, bytes } = await boundedBody(response);
  if (text !== undefined) {
    try {
      const body: unknown = JSON.parse(text);
      const reason =
        body !== null && typeof body === "object" && "reason" in body ? body.reason : undefined;
      if (
        typeof reason === "string" &&
        (providerCodes.has(reason) || knownRuntimeFailureCode(reason))
      )
        code = reason;
    } catch {}
  }
  const marked = poolOperationsAnswered(response);
  return {
    origin: marked ? "pool" : "unmarked",
    step: headers?.runtimeStep ?? "unclassified",
    reason: headers?.runtimeReason ?? "unclassified",
    code,
    unmarked: marked
      ? undefined
      : {
          answeredBy: answeredBy(response, text, bytes),
          bytes,
          message: platformMessage(text),
          ray: response.headers.has("cf-ray") ? "yes" : "no",
        },
  };
}

/**
 * Who made an answer the pool never gave: the session proxy's plain-text 500 (its catch answers
 * `new Response(message, { status: 500 })`, typed as a string body is), an HTML error page from the
 * platform's edge, no body at all, or anything else.
 */
function answeredBy(response: Response, text: string | undefined, bytes: number) {
  if (bytes === 0) return "nothing";
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    type.startsWith("text/html") ||
    (text !== undefined && /^\s*<(?:!doctype html|html)\b/iu.test(text))
  )
    return "edge";
  if (response.status === 500 && type.startsWith("text/plain")) return "proxy";
  return "other";
}

const platformMessage = (text: string | undefined) => {
  const message = text?.trim();
  if (message === undefined) return "other";
  if (internalError.test(message)) return "internal_error";
  return platformMessages.find((known) => known.text === message)?.word ?? "other";
};

/** The body's text when it is small, and its length in bytes either way. */
async function boundedBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return { text: undefined, bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  // The refusal is evidence only; a stalled body must not hold the release.
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), 2_000);
  try {
    while (bytes <= refusalCountLimit) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes <= refusalBodyLimit) chunks.push(next.value);
    }
  } catch {
    return { text: undefined, bytes };
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return {
    text: bytes > refusalBodyLimit ? undefined : new TextDecoder().decode(Buffer.concat(chunks)),
    bytes,
  };
}
