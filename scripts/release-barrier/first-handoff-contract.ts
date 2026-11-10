import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
import { SlotIdentity } from "../../src/pool/runtime-slots/contract.ts";
import { configurationDigest } from "../../src/pool/runtime-slots/configuration.ts";
import { canonical, digest } from "./manifest.ts";
import { type ProvisioningEnable } from "./provisioning-contract.ts";
import { RuntimeHandoffManifest, runtimeHandoffDigest } from "./runtime-slot-manifest.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

const synchronous = <A>(schema: Schema.Schema<A>) => Schema.make<Schema.Codec<A>>(schema.ast);
export const HandoffWorkerSnapshot = Schema.Struct({
  accountId: Schema.NonEmptyString,
  scriptName: Schema.NonEmptyString,
  deploymentId: Schema.NonEmptyString,
  version: synchronous(Schema.toType(Workers.GetBetaWorkerVersionResponse)),
});
export type HandoffWorkerSnapshot = typeof HandoffWorkerSnapshot.Type;
export const decodeHandoffWorker = decodeProvisioningInput(
  HandoffWorkerSnapshot,
  "firstHandoff.Worker",
);

/** This private manifest reuses release format 3; it does not grant live activation authority. */
export const FirstHandoffManifest = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  disposition: Schema.Literal("first-handoff"),
  baseline: HandoffWorkerSnapshot,
  mainModule: Schema.NonEmptyString,
  modules: synchronous(Schema.toType(Workers.BetaWorkersVersionsCreateRequestModulesList)),
  legacy: RuntimeHandoffManifest,
  legacyBootId: SlotIdentity.fields.bootId,
  candidate: RuntimeHandoffManifest,
  promotionOperationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u)),
  drainOperationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u)),
});
export type FirstHandoffManifest = typeof FirstHandoffManifest.Type;
const decode = decodeProvisioningInput(FirstHandoffManifest, "firstHandoff.manifest");
export const firstHandoffDigest = (value: FirstHandoffManifest) => digest(canonical(decode(value)));

export function freezeFirstHandoff(value: FirstHandoffManifest) {
  const manifest = structuredClone(decode(value));
  const { legacy, candidate, baseline } = manifest;
  sameProvisioningValue(
    "firstHandoff.legacy.disposition",
    "preserve-unattested",
    legacy.disposition,
  );
  sameProvisioningValue(
    "firstHandoff.candidate.disposition",
    "runtime-handoff",
    candidate.disposition,
  );
  for (const field of [
    "candidate",
    "stack",
    "stage",
    "controllerCode",
    "controller",
    "bridgeKey",
  ] as const)
    sameProvisioningValue(`firstHandoff.${field}`, legacy[field], candidate[field]);
  sameProvisioningValue("firstHandoff.controller", legacy.controller, {
    accountId: baseline.accountId,
    scriptName: baseline.scriptName,
  });
  sameProvisioningValue(
    "firstHandoff.initialSelection",
    { expectedEpoch: 0, active: null },
    {
      expectedEpoch: legacy.selection.expectedEpoch,
      active: legacy.selection.active,
    },
  );
  sameProvisioningValue(
    "firstHandoff.candidateSelection",
    {
      ...legacy.selection,
      expectedEpoch: 1,
      active: { ...legacy.target, bootId: manifest.legacyBootId },
    },
    candidate.selection,
  );
  if (
    legacy.target.controllerId !== candidate.target.controllerId ||
    legacy.target.applicationId === candidate.target.applicationId ||
    legacy.target.instanceId === candidate.target.instanceId ||
    legacy.target.slotId === candidate.target.slotId ||
    !baseline.version.id ||
    !manifest.modules.length ||
    !manifest.modules.some((part) => part.name === manifest.mainModule)
  )
    throw provisioningRefusal(
      "first-handoff-targets-invalid",
      "firstHandoff.targets",
      "distinct-slots-and-complete-code",
      "invalid",
    );
  return manifest;
}

export async function assertFirstHandoffConfiguration(manifest: FirstHandoffManifest) {
  for (const role of ["legacy", "candidate"] as const) {
    const runtime = manifest[role];
    sameProvisioningValue(
      `firstHandoff.${role}.imageInput`,
      runtime.target.imageInput,
      runtime.configuration.imageInput,
    );
    sameProvisioningValue(
      `firstHandoff.${role}.configurationFingerprint`,
      runtime.configurationFingerprint,
      await configurationDigest(runtime.configuration),
    );
    sameProvisioningValue(
      `firstHandoff.${role}.bridgeKey`,
      runtime.bridgeKey.baselineDigest,
      runtime.bridgeKey.candidateDigest,
    );
  }
}

export function assertFirstHandoffEnable(
  manifest: FirstHandoffManifest,
  enable: ProvisioningEnable | undefined,
  now: number,
) {
  if (
    !enable?.coordinatorGo ||
    !enable.writerLease ||
    enable.manifest !== firstHandoffDigest(manifest) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    enable.expiresAt <= now
  )
    throw provisioningRefusal(
      "first-handoff-not-enabled",
      "firstHandoff.enable",
      firstHandoffDigest(manifest),
      enable?.manifest ?? null,
    );
}

/** The outer exact-manifest grant binds both already-frozen inner authorizations. */
export function firstHandoffRuntimeEnable(
  manifest: FirstHandoffManifest,
  role: "legacy" | "candidate",
  enable: ProvisioningEnable,
  now: number,
) {
  assertFirstHandoffEnable(manifest, enable, now);
  return { ...enable, manifest: runtimeHandoffDigest(manifest[role]) };
}
