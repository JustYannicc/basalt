import { Schema } from "effect";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import type { RuntimeDistance } from "../runtime-distance.ts";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Counter = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const SlotTarget = Schema.Struct({
  format: Schema.Literal("pool-runtime-slot-v1"),
  controllerId: Identifier,
  slotId: Identifier,
  applicationId: Identifier,
  applicationVersion: Identifier,
  instanceId: Identifier,
  imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  imageInput: Identifier,
  homePeerOrdinal: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 128 })),
  ),
});
export type SlotTarget = typeof SlotTarget.Type;
export const SlotIdentity = Schema.Struct({ ...SlotTarget.fields, bootId: Identifier });
export type SlotIdentity = typeof SlotIdentity.Type;
export const ControllerCode = Schema.Struct({
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  workerInput: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type ControllerCode = typeof ControllerCode.Type;
export const SlotRecord = Schema.Struct({
  target: SlotTarget,
  identity: Schema.optional(SlotIdentity),
  fenced: Schema.Boolean,
  /** When the slot was last fenced, for the operator. Slots fenced before it was kept have none. */
  fencedAt: Schema.optional(Schema.Number),
  /**
   * How the last unfence ended the fence: with a passing proof, or by handing a slot that couldn't
   * prove itself back to recovery, after which it serves only once `proven`.
   */
  unfenced: Schema.optional(
    Schema.Struct({
      by: Schema.Literals(["proof", "recovery"]),
      at: Schema.Number,
      proven: Schema.Boolean,
    }),
  ),
  retirement: Schema.optional(
    Schema.Struct({
      operationId: Identifier,
      status: Schema.Literals(["started", "retired"]),
    }),
  ),
});
export type SlotRecord = typeof SlotRecord.Type;
/** Handed back to recovery by an unfence: it serves nothing until current policies reach its boot. */
export const awaitsProof = (slot: SlotRecord | undefined) => slot?.unfenced?.proven === false;
export const SlotSelection = Schema.Struct({
  epoch: Counter,
  active: SlotRecord,
  candidate: Schema.optional(SlotRecord),
  draining: Schema.optional(SlotRecord),
});
export type SlotSelection = typeof SlotSelection.Type;
const PolicyRevision = Schema.Struct({
  pool: Identifier,
  organization: Identifier,
  revision: Counter,
});
export const PromotionIntent = Schema.Struct({
  operationId: Identifier,
  controllerCode: ControllerCode,
  expectedEpoch: Counter,
  previous: SlotIdentity,
  candidate: SlotIdentity,
  policyDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type PromotionIntent = typeof PromotionIntent.Type;
const slotRefusals = [
  "identity",
  "selection",
  "policy",
  "unhealthy",
  "draining",
  "uncertain",
] as const;
export const PromotionRefusal = Schema.Literals([...slotRefusals, "timeout", "unclassified"]);
export type PromotionRefusal = typeof PromotionRefusal.Type;
export const PromotionReceipt = Schema.Struct({
  format: Schema.Literal("pool-promotion-receipt-v1"),
  intent: PromotionIntent,
  status: Schema.Literals(["started", "promoted", "refused"]),
  reason: Schema.optional(PromotionRefusal),
  at: Schema.Number,
  epoch: Counter,
  policies: Schema.Array(PolicyRevision),
});
export type PromotionReceipt = typeof PromotionReceipt.Type;
export const RetirementReceipt = Schema.Struct({
  operationId: Identifier,
  target: SlotTarget,
  identity: Schema.optional(SlotIdentity),
  status: Schema.Literals(["started", "retired"]),
  at: Schema.Number,
});
export type RetirementReceipt = typeof RetirementReceipt.Type;

export interface SlotHealth {
  identity: SlotIdentity;
  // Uses the controller's monotonic clock, like RuntimeProtection.
  policyLeaseUntil: number;
  database?: RuntimeDistance;
}
export interface SlotDriver {
  start(target: SlotTarget, signal: AbortSignal): Promise<SlotHealth>;
  observe(target: SlotTarget, signal: AbortSignal): Promise<SlotHealth>;
  health(identity: SlotIdentity, signal: AbortSignal): Promise<SlotHealth>;
  // Success means exact signed revision enforcement on this boot, including monotonic revision vetoes.
  install(
    identity: SlotIdentity,
    policy: NativeMembershipPolicy,
    signal: AbortSignal,
  ): Promise<void>;
  fetch(identity: SlotIdentity, request: Request, port: 8317 | 8327): Promise<Response>;
  drain(identity: SlotIdentity, signal: AbortSignal): Promise<{ active: number; known: boolean }>;
  retire(target: SlotTarget, identity: SlotIdentity, signal: AbortSignal): Promise<void>;
  retirement(identity: SlotIdentity, signal: AbortSignal): Promise<RuntimeRetirementObservation>;
}
export interface SlotSnapshot {
  selection?: SlotSelection;
  policies: readonly NativeMembershipPolicy[];
  denials: readonly NativeMembershipPolicy[];
  digest: string;
}
export const RuntimeRetirementObservation = Schema.Struct({
  identity: SlotIdentity,
  retired: Schema.Boolean,
  running: Schema.Boolean,
  retireNotStarted: Schema.optional(Schema.Literal(true)),
  provider: Schema.optional(
    Schema.Struct({
      accountId: Identifier,
      namespaceId: Identifier,
      applicationConfigDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    }),
  ),
});
export type RuntimeRetirementObservation = typeof RuntimeRetirementObservation.Type;
export class SlotRefused extends Error {
  readonly reason: (typeof slotRefusals)[number];
  constructor(reason: SlotRefused["reason"]) {
    super(`Pool runtime slot refused: ${reason}`);
    this.reason = reason;
  }
}
export const sameTarget = (left: SlotTarget, right: SlotTarget) =>
  JSON.stringify(Schema.decodeUnknownSync(SlotTarget)(left)) ===
  JSON.stringify(Schema.decodeUnknownSync(SlotTarget)(right));
export const sameIdentity = (left: SlotIdentity | undefined, right: SlotIdentity) =>
  left !== undefined && sameTarget(left, right) && left.bootId === right.bootId;
export const slotKey = (target: SlotTarget) =>
  JSON.stringify([target.applicationId, target.instanceId]);
export const executionKey = (identity: SlotIdentity) =>
  JSON.stringify(Schema.decodeUnknownSync(SlotIdentity)(identity));
export const sameControllerCode = (left: ControllerCode, right: ControllerCode) =>
  left.candidate === right.candidate && left.workerInput === right.workerInput;
export const sameIntent = (left: PromotionIntent, right: PromotionIntent) =>
  left.operationId === right.operationId &&
  sameControllerCode(left.controllerCode, right.controllerCode) &&
  left.expectedEpoch === right.expectedEpoch &&
  left.policyDigest === right.policyDigest &&
  sameIdentity(left.previous, right.previous) &&
  sameIdentity(left.candidate, right.candidate);
