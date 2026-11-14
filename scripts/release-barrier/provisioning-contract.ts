import { Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import { RuntimeCreateDeclaration, type RuntimeResourceName } from "./runtime-create-schema.ts";
import { decodeProvisioningInput, provisioningRefusal } from "./provisioning-refusal.ts";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const RuntimeProvisioningManifest = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  disposition: Schema.Literal("provision-only"),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  stack: Schema.NonEmptyString,
  stage: Schema.Literal("production"),
  operationId: Schema.NonEmptyString,
  declaration: RuntimeCreateDeclaration,
  namespaceBaselineDigest: hash,
  namespaceRequestDigest: hash,
  applicationTemplateDigest: hash,
  active: Schema.Struct({
    applicationId: Schema.NonEmptyString,
    namespaceId: Schema.NonEmptyString,
    version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    configurationDigest: hash,
    bootId: Schema.NonEmptyString,
    selectionEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
});
export type RuntimeProvisioningManifest = typeof RuntimeProvisioningManifest.Type;
export const decodeProvisioningManifest = decodeProvisioningInput(
  RuntimeProvisioningManifest,
  "provisioning.manifest",
);
export const provisioningManifestDigest = (value: RuntimeProvisioningManifest) =>
  digest(canonical(decodeProvisioningManifest(value)));

export interface ProvisioningEnable {
  coordinatorGo?: string;
  releaseWriter?: { candidate: string; lease: string };
  manifest: string;
  writerLease: string;
  expiresAt: number;
}

export function provisioningAuthority(enable: ProvisioningEnable | undefined, candidate: string) {
  return (
    !!enable?.coordinatorGo ||
    !!(
      enable?.writerLease &&
      enable.releaseWriter?.candidate === candidate &&
      enable.releaseWriter.lease === enable.writerLease
    )
  );
}

/** No ordinary release entrypoint constructs this authority; enabling requires a separate reviewed GO. */
export function assertProvisioningEnable(
  manifest: RuntimeProvisioningManifest,
  enable: ProvisioningEnable | undefined,
  now: number,
) {
  if (
    !provisioningAuthority(enable, manifest.candidate) ||
    !enable?.writerLease ||
    enable.manifest !== provisioningManifestDigest(manifest) ||
    !Number.isSafeInteger(enable.expiresAt) ||
    !Number.isSafeInteger(now) ||
    enable.expiresAt <= now
  )
    throw provisioningRefusal(
      "runtime-provisioning-not-enabled",
      "enable.manifest",
      provisioningManifestDigest(manifest),
      enable?.manifest ?? null,
    );
}

export interface RuntimeProvisioningReceipt {
  schemaVersion: 3;
  candidate: string;
  manifest: string;
  resource: RuntimeResourceName;
  disposition: "idle";
  namespaceId: string;
  applicationId: string;
  applicationVersion: number;
  applicationObservationDigest: string;
  nativeAfterDigest: string;
  activeUnchangedDigest: string;
}
