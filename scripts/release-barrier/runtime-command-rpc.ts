import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
  type RuntimeHandoffCommand,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { openPoolOperations, type PoolOperationsTarget } from "../pool-operations.ts";
import { providerObservationFailureHeader } from "../../src/pool/runtime-provider/observation.ts";
import { provisioningRefusal } from "./provisioning-refusal.ts";

type Action<T> = T extends unknown ? Omit<T, "controllerCode" | "at" | "expiresAt"> : never;
export type RuntimeCommandAction = Action<RuntimeHandoffCommand>;
export type RuntimeCommandCall = (
  action: RuntimeCommandAction,
  mutation?: boolean,
  signal?: AbortSignal,
) => Promise<unknown>;

/** One send only. An unknown response must be recovered through the retained operation's read path. */
export async function sendRuntimeCommand(
  command: RuntimeHandoffCommand,
  signingKey: string,
  target: PoolOperationsTarget,
  assertCurrent: () => void,
  signal?: AbortSignal,
) {
  const envelope = await signEnvelope(signingKey, runtimeHandoffCommandPrefix, command);
  const bridge = await openPoolOperations(target);
  try {
    assertCurrent();
    const response = await bridge.service.fetch(
      new Request(`http://pool-operations${runtimeHandoffPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      }),
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      const providerCause =
        command.action === "provider-observe" && response.status === 409
          ? response.headers.get(providerObservationFailureHeader)
          : null;
      const reason =
        providerCause === "provider_observation_refused" ||
        providerCause === "provider_fetch_failed"
          ? `runtime-provider-observation-${providerCause}`
          : "runtime-handoff-response-refused";
      throw provisioningRefusal(reason, "handoff.response.status", 200, response.status);
    }
    return (await response.json()) as unknown;
  } finally {
    await bridge.close();
  }
}
