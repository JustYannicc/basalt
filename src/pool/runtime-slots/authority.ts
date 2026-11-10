import {
  decodeAdmissionProof,
  runtimeAttestationFormat,
  type AdmissionProof,
} from "./admission-proof.ts";
import {
  SlotRefused,
  sameControllerCode,
  sameIdentity,
  sameTarget,
  type ControllerCode,
  type PromotionIntent,
} from "./contract.ts";
import { currentPolicies, slotClock } from "./proof.ts";
import type { RuntimeSlotStorage } from "./storage.ts";
import { openEnvelope } from "../token.ts";

/** Release signatures bind current controller state; they cannot substitute for runtime proof. */
export class RuntimeSlotAuthority {
  private storage: RuntimeSlotStorage;
  private code: ControllerCode;
  private controllerId: string;
  private secret: string;
  constructor(
    storage: RuntimeSlotStorage,
    code: ControllerCode,
    controllerId: string,
    secret: string,
  ) {
    this.storage = storage;
    this.code = code;
    this.controllerId = controllerId;
    this.secret = secret;
  }
  async read(envelope: string) {
    const proof = decodeAdmissionProof(
      await openEnvelope(this.secret, runtimeAttestationFormat, envelope),
    );
    if (
      !sameControllerCode(proof.controllerCode, this.code) ||
      proof.target.controllerId !== this.controllerId
    )
      throw new SlotRefused("identity");
    return proof;
  }
  async selection(proof: AdmissionProof) {
    const snapshot = await this.storage.inspect(),
      selection = snapshot.selection,
      expected = proof.selection;
    if (
      (selection?.epoch ?? 0) !== expected.expectedEpoch ||
      (expected.active === null
        ? selection !== undefined
        : !sameIdentity(selection?.active.identity, expected.active)) ||
      snapshot.digest !== expected.policyDigest
    )
      throw new SlotRefused("selection");
    const revisions = [
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
    ].sort((left, right) => left.pool.localeCompare(right.pool));
    if (JSON.stringify(revisions) !== JSON.stringify(expected.revisions))
      throw new SlotRefused("policy");
    currentPolicies(snapshot, slotClock);
  }
  async promotion(intent: PromotionIntent, envelope: string) {
    const proof = await this.read(envelope);
    if (
      proof.kind !== "attested" ||
      !sameTarget(proof.target, intent.candidate) ||
      proof.bootId !== intent.candidate.bootId ||
      !sameIdentity(proof.selection.active ?? undefined, intent.previous) ||
      proof.selection.expectedEpoch !== intent.expectedEpoch ||
      proof.selection.policyDigest !== intent.policyDigest ||
      !sameControllerCode(proof.controllerCode, intent.controllerCode)
    )
      throw new SlotRefused("identity");
    await this.selection(proof);
    return proof;
  }
  fresh(proof: AdmissionProof) {
    try {
      decodeAdmissionProof(proof);
    } catch {
      throw new SlotRefused("identity");
    }
  }
}
