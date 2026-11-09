import { Schema } from "effect";
import type { PoolStatus } from "./lifecycle.ts";

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u));
export const launchOperationId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
);
export const launchGeneration = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export const LaunchTarget = Schema.Struct({
  controllerId: digest,
  instanceId: digest,
  applicationId: identifier,
  versionId: identifier,
  imageHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16,64}$/u)),
  imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  releaseEpoch: digest,
});
export type LaunchTarget = typeof LaunchTarget.Type;
export const LaunchRecord = Schema.Struct({
  target: LaunchTarget,
  generation: launchGeneration,
  operationId: launchOperationId,
  token: digest,
  bootId: Schema.optional(launchOperationId),
});
export type LaunchRecord = typeof LaunchRecord.Type;
export interface LaunchExpectation {
  target: LaunchTarget;
  generation: number;
  operationId: string;
}
export interface LaunchHooks {
  prepare(expected?: LaunchExpectation, intent?: "restart"): Promise<LaunchRecord>;
  verify(status: PoolStatus): Promise<void>;
}

export function sameLaunchTarget(left: LaunchTarget, right: LaunchTarget) {
  return (Object.keys(LaunchTarget.fields) as (keyof LaunchTarget)[]).every(
    (key) => left[key] === right[key],
  );
}

export class LaunchRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Stopped recovery refused: ${reason}`);
    this.reason = reason;
  }
}
