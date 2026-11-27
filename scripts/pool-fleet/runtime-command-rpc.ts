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
const providerCodes = new Set(["provider_observation_refused", "provider_fetch_failed"]);
const providerRefusal = "runtime-provider-observation-";

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
          // Without the pool's mark, a proxy on the bridge built this answer, not the pool.
          { path: "handoff.response.origin", old: null, new: detail.origin },
          { path: "handoff.response.step", old: null, new: detail.step },
          { path: "handoff.response.reason", old: null, new: detail.reason },
          { path: "handoff.response.code", old: null, new: detail.code },
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
  const text = await boundedText(response);
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
  return {
    origin: poolOperationsAnswered(response) ? "pool" : "unmarked",
    step: headers?.runtimeStep ?? "unclassified",
    reason: headers?.runtimeReason ?? "unclassified",
    code,
  };
}

async function boundedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  // The refusal is evidence only; a stalled body must not hold the release.
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), 2_000);
  try {
    while (size <= refusalBodyLimit) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  if (size > refusalBodyLimit) return undefined;
  return new TextDecoder().decode(Buffer.concat(chunks));
}
