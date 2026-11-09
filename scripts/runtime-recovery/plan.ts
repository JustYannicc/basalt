import { Schema } from "effect";
import { canonical, hash } from "../production-ops/artifact.ts";

const uuid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/));
const hex = (length: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${length}}$`)));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
export const RecoveryPlan = Schema.Struct({
  version: Schema.Literal(1),
  operationId: uuid,
  accountId: hex(32),
  worker: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  deploymentId: uuid,
  workerVersion: uuid,
  release: hex(40),
  applicationId: uuid,
  applicationVersion: positive,
  imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  resources: Schema.Struct({
    instanceType: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/))),
    vcpu: Schema.Number.check(Schema.isGreaterThan(0)),
    memoryMiB: positive,
    diskMiB: positive,
    maxInstances: positive,
  }),
  instanceId: hex(64),
  imageHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16,64}$/)),
  bootId: uuid,
});
export type RecoveryPlan = typeof RecoveryPlan.Type;
export const decodeRecoveryPlan = Schema.decodeUnknownSync(RecoveryPlan, {
  onExcessProperty: "error",
});
export const recoveryPlanDigest = (plan: RecoveryPlan) => hash(`${canonical(plan)}\n`);

export interface PinDrift {
  resource: string;
  property: string;
  expected: string;
  observed: string;
}
export class RecoveryWorkflowRefusal extends Error {
  readonly reason: string;
  readonly drift: readonly PinDrift[];
  constructor(reason: string, drift: readonly PinDrift[] = []) {
    super(`Runtime recovery refused: ${reason}`);
    this.reason = reason;
    this.drift = drift;
  }
}

export function reviewedPlan(text: string, digest: string) {
  if (Buffer.byteLength(text) > 16_384 || !/^[a-f0-9]{64}$/.test(digest))
    throw new RecoveryWorkflowRefusal("invalid-plan-input");
  let plan: RecoveryPlan;
  try {
    plan = decodeRecoveryPlan(JSON.parse(text));
  } catch {
    throw new RecoveryWorkflowRefusal("invalid-plan-input");
  }
  if (recoveryPlanDigest(plan) !== digest)
    throw new RecoveryWorkflowRefusal("plan-digest-mismatch");
  return plan;
}
