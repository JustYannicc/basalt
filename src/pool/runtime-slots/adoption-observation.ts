import { Schema } from "effect";
import { UnattestedActive, type SelectionProof } from "./admission-proof.ts";
import { decodeUnattestedAdoptionResponse } from "./adoption-readback.ts";
import {
  ControllerCode,
  SlotIdentity,
  SlotRefused,
  sameControllerCode,
  sameTarget,
  type SlotTarget,
  type SlotSnapshot,
} from "./contract.ts";
import { currentPolicies, healthy, type SlotClock } from "./proof.ts";
import type { RuntimeSlotStorage } from "./storage.ts";
import type { BoundSlotDriver } from "./transport.ts";

const retainedWitness = Schema.decodeUnknownSync(
  Schema.Struct({
    kind: UnattestedActive.fields.kind,
    controllerCode: ControllerCode,
    identity: SlotIdentity,
    authorization: UnattestedActive,
  }),
  { onExcessProperty: "error" },
);
interface Dependencies {
  controllerCode: typeof ControllerCode.Type;
  driver: Pick<BoundSlotDriver, "health">;
  storage: RuntimeSlotStorage;
  clock: SlotClock;
}
function selectionProof(snapshot: SlotSnapshot): SelectionProof {
  return {
    expectedEpoch: snapshot.selection?.epoch ?? 0,
    active: snapshot.selection?.active.identity ?? null,
    policyDigest: snapshot.digest,
    revisions: [
      ...snapshot.policies.map(({ pool, organization, revision }) => ({
        pool,
        organization,
        revision,
        retired: false,
      })),
      ...snapshot.denials.map(({ pool, organization, revision }) => ({
        pool,
        organization,
        revision,
        retired: true,
      })),
    ].sort((left, right) => left.pool.localeCompare(right.pool)),
  };
}

/** Joins a decrypted retained capsule to the current selection and freshly observed boot, without mutation. */
export async function observeUnattestedAdoption(
  deps: Dependencies,
  target: SlotTarget,
  raw: unknown,
  expected?: UnattestedActive,
) {
  const retained = retainedWitness(raw);
  if (
    !sameControllerCode(retained.controllerCode, deps.controllerCode) ||
    !sameTarget(retained.identity, target)
  )
    throw new SlotRefused("identity");
  const validate = (snapshot: SlotSnapshot) => {
    const selection = snapshot.selection,
      active = selection?.active;
    if (
      !selection ||
      !active ||
      active.fenced ||
      active.retirement ||
      selection.candidate ||
      selection.draining ||
      !sameTarget(active.target, target)
    )
      throw new SlotRefused("selection");
    currentPolicies(snapshot, deps.clock);
    const response = {
      result: {
        kind: retained.kind,
        controllerCode: retained.controllerCode,
        operationId: retained.authorization.operationId,
        manifestDigest: retained.authorization.manifestDigest,
        identity: retained.identity,
        configurationFingerprint: retained.authorization.configurationFingerprint,
        selection: selectionProof(snapshot),
      },
    };
    const result = decodeUnattestedAdoptionResponse(response, retained.authorization);
    if (expected) decodeUnattestedAdoptionResponse(response, expected);
    return result;
  };
  const before = await deps.storage.inspect();
  validate(before);
  const health = healthy(
    await deps.driver.health(retained.identity, AbortSignal.timeout(2_000)),
    retained.identity,
    deps.clock,
  );
  const after = await deps.storage.inspect();
  const result = validate(after);
  if (
    before.digest !== after.digest ||
    JSON.stringify(before.selection) !== JSON.stringify(after.selection)
  )
    throw new SlotRefused("selection");
  currentPolicies(before, deps.clock);
  healthy(health, retained.identity, deps.clock);
  return result;
}
