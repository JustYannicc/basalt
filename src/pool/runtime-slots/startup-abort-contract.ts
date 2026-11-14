import { Schema } from "effect";
import { SlotIdentity, SlotTarget } from "./contract.ts";
import { StartupWitness, ProviderApplicationProof } from "./admission-proof.ts";

export const StartupStopIntent = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u)),
  target: SlotTarget,
  startupOperationId: Schema.NonEmptyString,
  witness: Schema.NullOr(StartupWitness),
});
export type StartupStopIntent = typeof StartupStopIntent.Type;
export const StartupAbortIntent = Schema.Struct({
  ...StartupStopIntent.fields,
  expectedEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  active: SlotIdentity,
});
export type StartupAbortIntent = typeof StartupAbortIntent.Type;
export const StartupAbortReceipt = Schema.Struct({
  intent: StartupAbortIntent,
  status: Schema.Literals(["pending", "aborted"]),
  sent: Schema.Boolean,
});
export type StartupAbortReceipt = typeof StartupAbortReceipt.Type;
export const StartupStopRecord = Schema.Struct({
  intent: StartupStopIntent,
  provider: ProviderApplicationProof,
  status: Schema.Literals(["pending", "aborted"]),
  destroySent: Schema.Boolean,
});
export type StartupStopRecord = typeof StartupStopRecord.Type;
export const startupStopKey = (target: SlotTarget) =>
  `runtime-slots-v1:startup-stop:${target.slotId}`;
export const startupAbortKey = (operationId: string) =>
  `runtime-slots-v1:startup-abort:${operationId}`;

export function sameStartupWitness(
  expected: StartupWitness | null,
  actual: StartupWitness | undefined,
) {
  if (expected === null) return actual === undefined;
  if (!actual || (expected.bootId && expected.bootId !== actual.bootId)) return false;
  return (
    JSON.stringify(Schema.decodeUnknownSync(StartupWitness)({ ...expected, bootId: undefined })) ===
    JSON.stringify(Schema.decodeUnknownSync(StartupWitness)({ ...actual, bootId: undefined }))
  );
}
