import { Schema } from "effect";
import { ControllerCode, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import {
  RuntimeConfiguration,
  configurationDigest,
} from "../../src/pool/runtime-slots/configuration.ts";
import { SelectionProof } from "../../src/pool/runtime-slots/admission-proof.ts";
import { canonical, digest } from "./manifest.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const RuntimeHandoffManifest = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  disposition: Schema.Literals(["runtime-handoff", "preserve-unattested"]),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  stack: Schema.NonEmptyString,
  stage: Schema.Literal("production"),
  operationId: Schema.NonEmptyString,
  controllerCode: ControllerCode,
  controller: Schema.Struct({
    accountId: Schema.NonEmptyString,
    scriptName: Schema.NonEmptyString,
  }),
  bridgeKey: Schema.Struct({ baselineDigest: hash, candidateDigest: hash }),
  target: SlotTarget,
  provider: Schema.Struct({
    accountId: Schema.NonEmptyString,
    namespaceId: Schema.NonEmptyString,
    applicationConfigDigest: hash,
  }),
  configuration: RuntimeConfiguration,
  configurationFingerprint: hash,
  selection: SelectionProof,
});
export type RuntimeHandoffManifest = typeof RuntimeHandoffManifest.Type;
export const decodeRuntimeHandoffManifest = decodeProvisioningInput(
  RuntimeHandoffManifest,
  "handoff.manifest",
);
export const runtimeHandoffDigest = (manifest: RuntimeHandoffManifest) =>
  digest(canonical(decodeRuntimeHandoffManifest(manifest)));

export async function freezeRuntimeHandoff(
  input: Omit<RuntimeHandoffManifest, "schemaVersion" | "configurationFingerprint">,
) {
  const configuration = decodeProvisioningInput(
    RuntimeConfiguration,
    "handoff.configuration",
  )(input.configuration);
  const manifest = decodeRuntimeHandoffManifest({
    ...input,
    configuration,
    schemaVersion: 3,
    configurationFingerprint: await configurationDigest(configuration),
  });
  sameProvisioningValue(
    "handoff.bridgeKey.continuity",
    manifest.bridgeKey.baselineDigest,
    manifest.bridgeKey.candidateDigest,
  );
  return manifest;
}

export function runtimeBridgeKeyDigest(value: string) {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw provisioningRefusal(
      "runtime-bridge-key-unavailable",
      "handoff.bridgeKey",
      "32-byte-key",
      "unavailable",
    );
  return digest(Buffer.from(value, "hex"));
}
export function assertRuntimeBridgeKey(manifest: RuntimeHandoffManifest, value: string) {
  sameProvisioningValue(
    "handoff.bridgeKey.signer",
    manifest.bridgeKey.baselineDigest,
    runtimeBridgeKeyDigest(value),
  );
}

export function assertRuntimeProofEnable(
  manifest: RuntimeHandoffManifest,
  enable: ProvisioningEnable | undefined,
  now: number,
) {
  sameProvisioningValue(
    "handoff.bridgeKey.continuity",
    manifest.bridgeKey.baselineDigest,
    manifest.bridgeKey.candidateDigest,
  );
  sameProvisioningValue(
    "handoff.controller.account",
    manifest.provider.accountId,
    manifest.controller.accountId,
  );
  if (
    !enable?.coordinatorGo ||
    !enable.writerLease ||
    enable.manifest !== runtimeHandoffDigest(manifest) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    enable.expiresAt <= now ||
    manifest.controllerCode.candidate !== manifest.candidate
  )
    throw provisioningRefusal(
      "runtime-handoff-not-enabled",
      "handoff.enable",
      runtimeHandoffDigest(manifest),
      enable?.manifest ?? null,
    );
}
