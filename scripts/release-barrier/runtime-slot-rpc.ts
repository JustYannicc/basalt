import { Schema } from "effect";
import {
  decodeRuntimeHandoffCommand,
  type RuntimeHandoffCommand,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { StartupWitness } from "../../src/pool/runtime-slots/admission-proof.ts";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { sendRuntimeCommand } from "./runtime-command-rpc.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import {
  assertRuntimeBridgeKey,
  assertRuntimeProofEnable,
  type RuntimeHandoffManifest,
} from "./runtime-slot-manifest.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

export async function runtimeHandoffRequest(
  manifest: RuntimeHandoffManifest,
  enable: ProvisioningEnable | undefined,
  signingKey: string,
  command: RuntimeHandoffCommand,
  target: PoolOperationsTarget,
  now = Date.now,
) {
  assertRuntimeProofEnable(manifest, enable, now());
  assertRuntimeBridgeKey(manifest, signingKey);
  const frozen = decodeRuntimeHandoffCommand(command, now());
  if (frozen.expiresAt > enable!.expiresAt)
    throw provisioningRefusal(
      "runtime-handoff-enable-expired",
      "handoff.command.expiresAt",
      enable!.expiresAt,
      frozen.expiresAt,
    );
  sameProvisioningValue(
    "handoff.command.controller",
    manifest.controllerCode,
    frozen.controllerCode,
  );
  sameProvisioningValue("handoff.command.destination", manifest.controller, {
    accountId: target.accountId,
    scriptName: target.worker,
  });
  return sendRuntimeCommand(frozen, signingKey, target, () => {
    assertRuntimeProofEnable(manifest, enable, now());
  });
}

const witnessResponse = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      kind: Schema.Literal("witness"),
      controllerCode: ControllerCode,
      witness: StartupWitness,
    }),
  }),
  { onExcessProperty: "error" },
);
export async function readRuntimeStartupWitness(
  manifest: RuntimeHandoffManifest,
  enable: ProvisioningEnable | undefined,
  signingKey: string,
  target: PoolOperationsTarget,
  now = Date.now,
) {
  const at = now();
  const response = witnessResponse(
    await runtimeHandoffRequest(
      manifest,
      enable,
      signingKey,
      {
        action: "witness",
        target: manifest.target,
        controllerCode: manifest.controllerCode,
        at,
        expiresAt: Math.min(at + 60_000, enable?.expiresAt ?? at),
      },
      target,
      now,
    ),
  ).result;
  sameProvisioningValue(
    "handoff.response.controllerCode",
    manifest.controllerCode,
    response.controllerCode,
  );
  return response.witness;
}
