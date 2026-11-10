import { Schema } from "effect";
import { openEnvelope } from "./token.ts";
import { AutomaticSample } from "./automatic-recovery.ts";

export const runtimeRecoveryPath = "/runtime-recovery";
export const runtimeRecoveryPrefix = "sbpr1";
export const recoveryOperationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fields = {
  version: Schema.Literal(1),
  operationId: Schema.String,
  instanceId: Schema.String,
  imageHash: Schema.String,
  at: Schema.Number,
  expiresAt: Schema.Number,
};
const reviewed = { ...fields, release: Schema.String, bootId: Schema.String };
const SignedRecovery = Schema.Union([
  Schema.Struct({ ...fields, action: Schema.Literal("restart") }),
  Schema.Struct({ ...reviewed, action: Schema.Literal("restart-reviewed") }),
  Schema.Struct({
    ...reviewed,
    action: Schema.Literal("restart-automatic"),
    pool: Schema.String,
    selection: Schema.String,
    samples: Schema.Array(AutomaticSample),
  }),
]);
export type RecoveryApproval = typeof SignedRecovery.Type;
export type AutomaticApproval = Extract<RecoveryApproval, { action: "restart-automatic" }>;
export interface RecoveryDrift {
  property: "release" | "instanceId" | "imageHash" | "bootId";
  expected: string;
  observed: string;
}
export class RecoveryRefused extends Error {
  readonly status: number;
  readonly drift?: RecoveryDrift[];
  constructor(status: number, drift?: RecoveryDrift[]) {
    super("Pool runtime recovery refused");
    this.status = status;
    this.drift = drift;
  }
}

export async function decodeRecoveryApproval(secret: string, envelope: string, now = Date.now()) {
  const decoded = await openEnvelope(secret, runtimeRecoveryPrefix, envelope);
  if (decoded === undefined) throw new RecoveryRefused(401);
  const approval = Schema.decodeUnknownSync(SignedRecovery)(decoded);
  if (
    !recoveryOperationId.test(approval.operationId) ||
    !/^[a-f0-9]{64}$/.test(approval.instanceId) ||
    !approval.imageHash ||
    approval.imageHash.length > 256 ||
    !Number.isSafeInteger(approval.at) ||
    !Number.isSafeInteger(approval.expiresAt) ||
    approval.at > now + 5_000 ||
    approval.expiresAt <= now ||
    approval.expiresAt <= approval.at ||
    approval.expiresAt > approval.at + 60_000
  )
    throw new RecoveryRefused(401);
  if (
    approval.action !== "restart" &&
    (!/^[a-f0-9]{40}$/.test(approval.release) ||
      !recoveryOperationId.test(approval.bootId) ||
      !/^[a-f0-9]{16,64}$/.test(approval.imageHash))
  )
    throw new RecoveryRefused(401);
  return approval;
}
