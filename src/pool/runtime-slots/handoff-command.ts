import { Schema, Tuple } from "effect";
import { ControllerCode, PromotionIntent, SlotIdentity, SlotTarget } from "./contract.ts";
import { deploymentReadinessPrefix } from "../deployment-readiness.ts";
import { FleetConfiguration } from "../runtime-fleet/configuration.ts";

export const runtimeHandoffPath = "/runtime-handoff";
export const runtimeHandoffCommandPrefix = deploymentReadinessPrefix;
const OperationId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u));
const Proof = Schema.String.check(Schema.isMinLength(1));
const Milliseconds = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const fields = { controllerCode: ControllerCode, at: Milliseconds, expiresAt: Milliseconds };

/** The existing bridge authenticates a closed command; the inner proof has its separate allocated kind. */
export const RuntimeFleetOperationPayload = Schema.Union([
  Schema.Struct({
    controllerCode: ControllerCode,
    action: Schema.Literal("fleet-configure"),
    operationId: OperationId,
    configuration: FleetConfiguration,
  }),
  Schema.Struct({
    controllerCode: ControllerCode,
    action: Schema.Literal("fleet-inspect"),
    operationId: Schema.optional(OperationId),
  }),
  Schema.Struct({
    controllerCode: ControllerCode,
    action: Schema.Literal("fleet-disable"),
    operationId: OperationId,
    expectedDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  Schema.Struct({
    controllerCode: ControllerCode,
    action: Schema.Literal("fleet-replace"),
    operationId: OperationId,
    identity: SlotIdentity,
  }),
]);
export type RuntimeFleetOperationPayload = typeof RuntimeFleetOperationPayload.Type;
export const RuntimeFleetCommand = RuntimeFleetOperationPayload.mapMembers(
  Tuple.map(Schema.fieldsAssign({ at: Milliseconds, expiresAt: Milliseconds })),
);
export type RuntimeFleetCommand = typeof RuntimeFleetCommand.Type;

export const RuntimeHandoffCommand = Schema.Union([
  ...RuntimeFleetCommand.members,
  Schema.Struct({ ...fields, action: Schema.Literals(["inspect", "observe"]) }),
  Schema.Struct({
    ...fields,
    action: Schema.Literals(["receipt", "retirement", "drain", "discard"]),
    operationId: OperationId,
  }),
  Schema.Struct({ ...fields, action: Schema.Literal("witness"), target: SlotTarget }),
  Schema.Struct({ ...fields, action: Schema.Literals(["adopt", "stage"]), proof: Proof }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("promote"),
    intent: PromotionIntent,
    proof: Proof,
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literals(["fence", "unfence"]),
    identity: SlotIdentity,
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("peer-bootstrap"),
    operationId: OperationId,
    identity: SlotIdentity,
    configurationFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    sourceSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
]);
export type RuntimeHandoffCommand = typeof RuntimeHandoffCommand.Type;

export function decodeRuntimeHandoffCommand(value: unknown, now = Date.now()) {
  const command = Schema.decodeUnknownSync(RuntimeHandoffCommand, { onExcessProperty: "error" })(
    value,
  );
  if (
    command.at > now + 5_000 ||
    command.expiresAt <= now ||
    command.expiresAt <= command.at ||
    command.expiresAt > command.at + 60_000
  )
    throw new Error("Runtime handoff command expired");
  return command;
}
