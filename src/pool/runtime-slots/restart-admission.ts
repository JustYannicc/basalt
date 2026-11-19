import { SlotRefused, sameIdentity } from "./contract.ts";
import type { RestartAuthorization } from "./admission-proof.ts";
import type { RuntimeWitnessStore } from "./witness-store.ts";
import type { ControllerState } from "./runtime-state.ts";
import { runtimeStopTiming } from "./forced-stop.ts";

/**
 * Whether the container is still stopped after a confirmation wait. One `running: false` read is not
 * proof of an exit: on 19 Nov 2026 it read false for under a second while the old container lived,
 * a restart was admitted over it, and the record it replaced left the pool refusing for hours.
 */
export async function confirmedStopped(ctx: ControllerState) {
  if (ctx.container!.running) return false;
  await runtimeStopTiming.confirmExit();
  return !ctx.container!.running;
}

/** A fresh restart grant preserves sealed settings and replaces only a proved stopped boot. */
export async function admitRuntimeRestart(
  ctx: ControllerState,
  store: RuntimeWitnessStore,
  proof: RestartAuthorization,
) {
  const { record } = await store.read(proof.target);
  const previous = record.authorization;
  if (previous.kind === "restart" && previous.operationId === proof.operationId) {
    if (
      !sameIdentity(previous.previous, proof.previous) ||
      previous.manifestDigest !== proof.manifestDigest ||
      previous.configurationFingerprint !== proof.configurationFingerprint ||
      previous.provider.accountId !== proof.provider.accountId ||
      previous.provider.namespaceId !== proof.provider.namespaceId ||
      previous.provider.applicationConfigDigest !== proof.provider.applicationConfigDigest
    )
      throw new SlotRefused("identity");
    if (await confirmedStopped(ctx))
      await store.put(proof.target, { ...record, authorization: proof });
    return;
  }
  if (
    !sameIdentity(record.identity, proof.previous) ||
    ctx.container!.running ||
    previous.configurationFingerprint !== proof.configurationFingerprint ||
    previous.provider.accountId !== proof.provider.accountId ||
    previous.provider.namespaceId !== proof.provider.namespaceId ||
    previous.provider.applicationConfigDigest !== proof.provider.applicationConfigDigest
  )
    throw new SlotRefused("identity");
  if (!(await confirmedStopped(ctx))) throw new SlotRefused("uncertain");
  await store.put(proof.target, { authorization: proof, sealed: record.sealed });
}
