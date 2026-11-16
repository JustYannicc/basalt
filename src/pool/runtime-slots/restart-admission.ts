import { SlotRefused, sameIdentity } from "./contract.ts";
import type { RestartAuthorization } from "./admission-proof.ts";
import type { RuntimeWitnessStore } from "./witness-store.ts";
import type { ControllerState } from "./runtime-state.ts";

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
    if (!ctx.container!.running) await store.put(proof.target, { ...record, authorization: proof });
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
  await store.put(proof.target, { authorization: proof, sealed: record.sealed });
}
