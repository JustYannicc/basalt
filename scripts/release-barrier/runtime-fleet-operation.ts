import { Schema } from "effect";
import {
  RuntimeFleetOperationPayload,
  decodeRuntimeHandoffCommand,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { canonical, digest } from "./manifest.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";
import { runtimeBridgeKeyDigest } from "./runtime-slot-manifest.ts";
import { sendRuntimeCommand } from "./runtime-command-rpc.ts";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const RuntimeFleetOperation = Schema.Struct({
  format: Schema.Literal("pool-runtime-fleet-operation-v1"),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  controller: Schema.Struct({
    accountId: Schema.NonEmptyString,
    scriptName: Schema.NonEmptyString,
  }),
  bridgeKeyDigest: hash,
  command: RuntimeFleetOperationPayload,
});
export type RuntimeFleetOperation = typeof RuntimeFleetOperation.Type;
export const decodeRuntimeFleetOperation = decodeProvisioningInput(
  RuntimeFleetOperation,
  "fleet.operation",
);
export const runtimeFleetOperationDigest = (value: RuntimeFleetOperation) =>
  digest(canonical(decodeRuntimeFleetOperation(value)));

function assertOperation(value: RuntimeFleetOperation) {
  sameProvisioningValue(
    "fleet.operation.candidate",
    value.candidate,
    value.command.controllerCode.candidate,
  );
  if (value.command.action === "fleet-configure") {
    sameProvisioningValue(
      "fleet.operation.controller",
      value.command.controllerCode,
      value.command.configuration.controllerCode,
    );
    for (const application of value.command.configuration.applications)
      sameProvisioningValue(
        "fleet.operation.account",
        value.controller.accountId,
        application.accountId,
      );
  }
}
export function freezeRuntimeFleetOperation(input: Omit<RuntimeFleetOperation, "format">) {
  const operation = decodeRuntimeFleetOperation({
    ...input,
    format: "pool-runtime-fleet-operation-v1",
  });
  assertOperation(operation);
  return operation;
}
function assertDestination(
  operation: RuntimeFleetOperation,
  signingKey: string,
  target: PoolOperationsTarget,
) {
  assertOperation(operation);
  sameProvisioningValue(
    "fleet.operation.signer",
    operation.bridgeKeyDigest,
    runtimeBridgeKeyDigest(signingKey),
  );
  sameProvisioningValue("fleet.operation.destination", operation.controller, {
    accountId: target.accountId,
    scriptName: target.worker,
  });
}
function assertEnabled(
  operation: RuntimeFleetOperation,
  enable: ProvisioningEnable | undefined,
  now: number,
) {
  const manifest = runtimeFleetOperationDigest(operation);
  if (
    !enable?.coordinatorGo ||
    !enable.writerLease ||
    enable.manifest !== manifest ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    enable.expiresAt <= now
  )
    throw provisioningRefusal(
      "runtime-fleet-not-enabled",
      "fleet.operation.enable",
      manifest,
      enable?.manifest ?? null,
    );
}
export function validateRuntimeFleetRequest(
  input: RuntimeFleetOperation,
  enable: ProvisioningEnable | undefined,
  signingKey: string,
  target: PoolOperationsTarget,
  now = Date.now,
) {
  const operation = decodeRuntimeFleetOperation(input);
  assertDestination(operation, signingKey, target);
  assertEnabled(operation, enable, now());
  return operation;
}
export async function runtimeFleetRequest(
  input: RuntimeFleetOperation,
  enable: ProvisioningEnable | undefined,
  signingKey: string,
  target: PoolOperationsTarget,
  now = Date.now,
) {
  const operation = validateRuntimeFleetRequest(input, enable, signingKey, target, now);
  const at = now();
  const command = decodeRuntimeHandoffCommand(
    { ...operation.command, at, expiresAt: Math.min(at + 60_000, enable!.expiresAt) },
    at,
  );
  return sendRuntimeCommand(command, signingKey, target, () => {
    assertEnabled(operation, enable, now());
    decodeRuntimeHandoffCommand(command, now());
  });
}

/** Readback remains available after a lost acknowledgment or expired writer lease, without reissuing the write. */
export async function inspectRuntimeFleetOperation(
  input: RuntimeFleetOperation,
  signingKey: string,
  target: PoolOperationsTarget,
  now = Date.now,
) {
  const operation = decodeRuntimeFleetOperation(input);
  assertDestination(operation, signingKey, target);
  const at = now();
  const command = decodeRuntimeHandoffCommand(
    {
      action: "fleet-inspect",
      operationId: operation.command.operationId,
      controllerCode: operation.command.controllerCode,
      at,
      expiresAt: at + 60_000,
    },
    at,
  );
  return sendRuntimeCommand(command, signingKey, target, () => {
    decodeRuntimeHandoffCommand(command, now());
  });
}
