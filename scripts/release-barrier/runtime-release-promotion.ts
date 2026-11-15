import { Schema } from "effect";
import {
  ControllerCode,
  PromotionReceipt,
  SlotIdentity,
  SlotTarget,
  sameIdentity,
} from "../../src/pool/runtime-slots/contract.ts";
import type { SelectionProof } from "../../src/pool/runtime-slots/admission-proof.ts";
import type { RuntimeCommandCall } from "./runtime-command-rpc.ts";
import { BarrierRefusal } from "./refusal.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import { RuntimeHandoffManifest } from "./runtime-slot-manifest.ts";

export const ReleasePromotionAttempt = Schema.Struct({
  operationId: Schema.NonEmptyString,
  candidate: Schema.optional(SlotIdentity),
  pool: Schema.NonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  probeSent: Schema.optional(Schema.Boolean),
  promotionSent: Schema.optional(Schema.Boolean),
  startup: RuntimeHandoffManifest,
});
export type ReleasePromotionAttempt = typeof ReleasePromotionAttempt.Type;
export interface ReleasePromotionJournal {
  read(): Promise<ReleasePromotionAttempt | undefined>;
  write(attempt: ReleasePromotionAttempt): Promise<void>;
}
const Probe = Schema.Struct({
  status: Schema.Literals(["started", "accepted", "failed"]),
  cleanup: Schema.Boolean,
  ticket: Schema.Struct({
    controllerCode: ControllerCode,
    candidate: SlotIdentity,
    previous: SlotIdentity,
    pool: Schema.String,
    expectedEpoch: Schema.Number,
    policyDigest: Schema.String,
    expiresAt: Schema.Number,
  }),
});
const result = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ result: schema }))(value).result;
const promotionId = (attempt: ReleasePromotionAttempt) =>
  attempt.generation === 0
    ? attempt.operationId
    : `${attempt.operationId}-attempt-${attempt.generation}`;

export async function retainReleaseStartup(input: {
  manifest: RuntimeHandoffManifest;
  pool: string;
  journal: ReleasePromotionJournal;
  call: RuntimeCommandCall;
}) {
  let attempt = await input.journal.read();
  if (attempt && attempt.operationId !== input.manifest.operationId) {
    const prior = result(
      Schema.NullOr(PromotionReceipt),
      await input.call({ action: "receipt", operationId: promotionId(attempt) }),
    );
    if (prior?.status !== "promoted")
      throw new BarrierRefusal("runtime-release-prior-promotion-unsettled", "PoolWorker");
    attempt = undefined;
  }
  if (!attempt) {
    attempt = {
      operationId: input.manifest.operationId,
      pool: input.pool,
      generation: 0,
      startup: input.manifest,
    };
    await input.journal.write(attempt);
  }
  sameProvisioningValue(
    "runtime-release.startup",
    { ...input.manifest, selection: attempt.startup.selection },
    attempt.startup,
  );
  sameProvisioningValue("runtime-release.promotion-attempt-pool", input.pool, attempt.pool);
  return attempt.startup;
}

/** A fresh attempt follows only a settled refusal or probe. Unknown sends remain inspection-only. */
export async function releasePromotionGate(input: {
  operationId: string;
  candidate: SlotIdentity;
  pool: string;
  selection: SelectionProof;
  code: ControllerCode;
  journal: ReleasePromotionJournal;
  call: RuntimeCommandCall;
}) {
  const readPromotion = async (operationId: string) =>
    result(Schema.NullOr(PromotionReceipt), await input.call({ action: "receipt", operationId }));
  let attempt = await input.journal.read();
  if (attempt && attempt.operationId !== input.operationId) {
    if ((await readPromotion(promotionId(attempt)))?.status !== "promoted")
      throw new BarrierRefusal("runtime-release-prior-promotion-unsettled", "PoolWorker");
    attempt = undefined;
  }
  if (!attempt) throw new BarrierRefusal("runtime-release-startup-not-retained", "PoolWorker");
  sameProvisioningValue(
    "runtime-release.promotion-attempt-target",
    attempt.startup.target,
    Schema.decodeUnknownSync(SlotTarget)(input.candidate),
  );
  if (!attempt.candidate) {
    attempt = { ...attempt, candidate: input.candidate };
    await input.journal.write(attempt);
  }
  sameProvisioningValue(
    "runtime-release.promotion-attempt-candidate",
    input.candidate,
    attempt.candidate,
  );
  sameProvisioningValue("runtime-release.promotion-attempt-pool", input.pool, attempt.pool);
  let operationId = promotionId(attempt);
  let probeOperationId = `probe-${operationId}`;
  const promotion = await readPromotion(operationId);
  if (promotion && promotion.status !== "refused")
    throw new BarrierRefusal("runtime-release-promotion-inspect-only", "PoolWorker");
  if (!promotion && attempt.promotionSent)
    throw new BarrierRefusal("runtime-release-promotion-inspect-only", "PoolWorker");
  let gate = result(
    Schema.NullOr(Probe),
    await input.call({ action: "candidate-probe-inspect", operationId: probeOperationId }),
  );
  const current = (probe: typeof Probe.Type) =>
    probe.status === "accepted" &&
    probe.ticket.expiresAt > Date.now() &&
    sameIdentity(probe.ticket.candidate, input.candidate) &&
    input.selection.active !== null &&
    sameIdentity(probe.ticket.previous, input.selection.active) &&
    probe.ticket.expectedEpoch === input.selection.expectedEpoch &&
    probe.ticket.policyDigest === input.selection.policyDigest &&
    probe.ticket.pool === input.pool &&
    JSON.stringify(probe.ticket.controllerCode) === JSON.stringify(input.code);
  if (gate && (gate.status === "started" || gate.cleanup))
    throw new BarrierRefusal("runtime-release-public-probe-inspect-only", "PoolWorker");
  if (!gate && attempt.probeSent)
    throw new BarrierRefusal("runtime-release-public-probe-inspect-only", "PoolWorker");
  if (promotion || (gate && !current(gate))) {
    if (!gate) throw new BarrierRefusal("runtime-release-promotion-probe-missing", "PoolWorker");
    attempt = {
      ...attempt,
      generation: attempt.generation + 1,
      probeSent: false,
      promotionSent: false,
    };
    // The outer encrypted journal owns the new identities before a key mint, public GET or promotion send.
    await input.journal.write(attempt);
    operationId = promotionId(attempt);
    probeOperationId = `probe-${operationId}`;
    if (await readPromotion(operationId))
      throw new BarrierRefusal("runtime-release-promotion-attempt-collision", "PoolWorker");
    gate = result(
      Schema.NullOr(Probe),
      await input.call({ action: "candidate-probe-inspect", operationId: probeOperationId }),
    );
    if (gate) throw new BarrierRefusal("runtime-release-probe-attempt-collision", "PoolWorker");
  }
  if (!gate) {
    attempt = { ...attempt, probeSent: true };
    await input.journal.write(attempt);
    gate = result(
      Probe,
      await input.call(
        { action: "candidate-probe", operationId: probeOperationId, pool: input.pool },
        true,
      ),
    );
  }
  if (!current(gate))
    throw new BarrierRefusal("runtime-release-public-probe-not-current", "PoolWorker");
  return {
    operationId,
    gate,
    beforePromotion: async () => {
      attempt = { ...attempt!, promotionSent: true };
      await input.journal.write(attempt);
    },
  };
}
