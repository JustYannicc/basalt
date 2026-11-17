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
import {
  knownRuntimeFailureCode,
  runtimeResponseDiagnostic,
} from "../../src/pool/runtime-route-diagnostic.ts";

// A refusal body is a fixed code; anything larger or unknown is never copied into evidence.
const refusalBodyLimit = 2048;
const providerCodes = new Set(["provider_observation_refused", "provider_fetch_failed"]);

type Action<T> = T extends unknown ? Omit<T, "controllerCode" | "at" | "expiresAt"> : never;
export type RuntimeCommandAction = Action<RuntimeHandoffCommand>;
export type RuntimeCommandCall = (
  action: RuntimeCommandAction,
  mutation?: boolean,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * One send only. An unknown response must be recovered through the retained operation's read path.
 * `dispatched` receives the monotonic time the request left over the already-open bridge, so a
 * caller bounding a remote lease never counts bridge setup against it.
 */
export async function sendRuntimeCommand(
  command: RuntimeHandoffCommand,
  signingKey: string,
  target: PoolOperationsTarget,
  assertCurrent: () => void,
  signal?: AbortSignal,
  dispatched?: (requestedAt: number) => void,
) {
  const envelope = await signEnvelope(signingKey, runtimeHandoffCommandPrefix, command);
  const bridge = await openPoolOperations(target);
  try {
    assertCurrent();
    const request = new Request(`http://pool-operations${runtimeHandoffPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    dispatched?.(performance.now());
    const response = await bridge.service.fetch(request);
    if (response.status !== 200) {
      const detail = await refusalDetail(response);
      const providerCause =
        command.action === "provider-observe" && response.status === 409
          ? response.headers.get(providerObservationFailureHeader)
          : null;
      const reason =
        providerCause === "provider_observation_refused" ||
        providerCause === "provider_fetch_failed"
          ? `runtime-provider-observation-${providerCause}`
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
          { path: "handoff.command.action", old: null, new: command.action },
          { path: "handoff.response.step", old: null, new: detail.step },
          { path: "handoff.response.reason", old: null, new: detail.reason },
          { path: "handoff.response.code", old: null, new: detail.code },
        ],
      });
    }
    return (await response.json()) as unknown;
  } finally {
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
