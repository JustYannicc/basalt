import { Schema } from "effect";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { openEnvelope } from "./token.ts";
import {
  RuntimeCrashAuthorization,
  crashAuditKey,
  currentCrashCommand,
} from "./runtime-crash-contract.ts";
import {
  SlotRefused,
  sameControllerCode,
  type ControllerCode,
  type SlotIdentity,
} from "./runtime-slots/contract.ts";
import { runtimeInput } from "./runtime-slots/input.ts";
import type { ControllerState } from "./runtime-slots/runtime-state.ts";

/** Audit persistence precedes the signal. An uncertain signal is never dispatched again. */
export async function crashOwnedRuntime(
  ctx: ControllerState,
  secret: string,
  code: ControllerCode,
  envelope: string,
  health: (identity: SlotIdentity) => Promise<unknown>,
) {
  const opened = await openEnvelope(secret, deploymentReadinessPrefix, envelope);
  const authorization = runtimeInput(() =>
    Schema.decodeUnknownSync(RuntimeCrashAuthorization, { onExcessProperty: "error" })(opened),
  );
  const command = currentCrashCommand(authorization.command);
  const valid = () => {
    currentCrashCommand(command);
    const now = Date.now();
    if (
      !sameControllerCode(command.controllerCode, code) ||
      command.identity.instanceId !== ctx.id.toString() ||
      command.identity.controllerId !== authorization.sibling.controllerId ||
      command.identity.instanceId === authorization.sibling.instanceId ||
      authorization.checkedAt > now ||
      authorization.expiresAt <= now ||
      authorization.expiresAt > authorization.checkedAt + 1_000 ||
      authorization.expiresAt > command.expiresAt ||
      !ctx.container?.running ||
      !ctx.container.signal
    )
      throw new SlotRefused("identity");
  };
  valid();
  await health(command.identity);
  const key = crashAuditKey(command.nonce);
  const armed = {
    command,
    sibling: authorization.sibling,
    at: Date.now(),
    status: "armed" as const,
  };
  await ctx.storage.transaction(async (transaction) => {
    if (await transaction.get(key)) throw new SlotRefused("selection");
    valid();
    await transaction.put(key, armed);
  });
  // The runtime can restart while audit persistence is pending.
  await health(command.identity);
  valid();
  ctx.container!.signal!(9);
  const receipt = { ...armed, signalledAt: Date.now(), status: "signalled" as const };
  await ctx.storage.put(key, receipt);
  return receipt;
}
