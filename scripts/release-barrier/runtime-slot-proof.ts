import { Schema } from "effect";
import {
  AdmissionProof,
  StartupWitness,
  decodeAdmissionProof,
  runtimeAttestationFormat,
  type ProviderApplicationProof,
  type ProviderRuntimeProof,
  type SelectionProof,
} from "../../src/pool/runtime-slots/admission-proof.ts";
import { configurationDigest } from "../../src/pool/runtime-slots/configuration.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { canonical, digest } from "./manifest.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import {
  assertRuntimeBridgeKey,
  assertRuntimeProofEnable,
  decodeRuntimeHandoffManifest,
  runtimeHandoffDigest,
  type RuntimeHandoffManifest,
} from "./runtime-slot-manifest.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

export interface RuntimeProofObservations {
  provider: typeof ProviderApplicationProof.Type | typeof ProviderRuntimeProof.Type;
  selection: SelectionProof;
  witness?: unknown;
  unattestedBootId?: string;
}

/** The production reader owns provider GETs and the private runtime witness read; the controller writes neither. */
export async function signRuntimeAdmission(
  input: RuntimeHandoffManifest,
  kind: "start" | "attested" | "unattested-active",
  observations: RuntimeProofObservations,
  enable: ProvisioningEnable | undefined,
  signingKey: string,
  now = Date.now,
) {
  const manifest = structuredClone(decodeRuntimeHandoffManifest(input));
  const at = now();
  assertRuntimeProofEnable(manifest, enable, at);
  assertRuntimeBridgeKey(manifest, signingKey);
  const manifestDigest = runtimeHandoffDigest(manifest);
  sameProvisioningValue(
    "handoff.configuration.imageInput",
    manifest.target.imageInput,
    manifest.configuration.imageInput,
  );
  sameProvisioningValue(
    "handoff.configuration.fingerprint",
    manifest.configurationFingerprint,
    await configurationDigest(manifest.configuration),
  );
  const provider = observations.provider;
  sameProvisioningValue(
    "handoff.provider.expected",
    {
      ...manifest.provider,
      applicationId: manifest.target.applicationId,
      applicationVersion: manifest.target.applicationVersion,
      imageDigest: manifest.target.imageDigest,
    },
    {
      accountId: provider.accountId,
      namespaceId: provider.namespaceId,
      applicationConfigDigest: provider.applicationConfigDigest,
      applicationId: provider.applicationId,
      applicationVersion: provider.applicationVersion,
      imageDigest: provider.imageDigest,
    },
  );
  sameProvisioningValue("handoff.selection", manifest.selection, observations.selection);
  sameProvisioningValue(
    "handoff.disposition",
    kind === "unattested-active" ? "preserve-unattested" : "runtime-handoff",
    manifest.disposition,
  );
  let witness: typeof StartupWitness.Type | undefined;
  if (kind === "attested") {
    witness = Schema.decodeUnknownSync(StartupWitness, { onExcessProperty: "error" })(
      observations.witness,
    );
    sameProvisioningValue(
      "handoff.witness.join",
      {
        operationId: manifest.operationId,
        manifestDigest,
        target: manifest.target,
        configurationFingerprint: manifest.configurationFingerprint,
      },
      {
        operationId: witness.operationId,
        manifestDigest: witness.manifestDigest,
        target: witness.target,
        configurationFingerprint: witness.configurationFingerprint,
      },
    );
    if (!witness.bootId)
      throw provisioningRefusal(
        "runtime-start-witness-incomplete",
        "handoff.witness.bootId",
        "authenticated-ready-boot",
        null,
      );
  } else if (observations.witness !== undefined)
    throw provisioningRefusal("runtime-proof-kind-mismatch", "handoff.witness", null, "present");
  const proof = decodeAdmissionProof(
    {
      format: runtimeAttestationFormat,
      kind,
      operationId: manifest.operationId,
      manifestDigest,
      controllerCode: manifest.controllerCode,
      target: manifest.target,
      configurationFingerprint: manifest.configurationFingerprint,
      selection: manifest.selection,
      provider,
      at,
      expiresAt: Math.min(at + 60_000, enable!.expiresAt),
      ...(kind === "attested" ? { launch: witness!.launch, bootId: witness!.bootId } : {}),
      ...(kind === "unattested-active" ? { bootId: observations.unattestedBootId } : {}),
    },
    at,
  );
  sameProvisioningValue("handoff.frozenManifest", manifestDigest, runtimeHandoffDigest(input));
  assertRuntimeProofEnable(manifest, enable, now());
  const envelope = await signEnvelope(
    signingKey,
    runtimeAttestationFormat,
    Schema.decodeUnknownSync(AdmissionProof, { onExcessProperty: "error" })(proof),
  );
  decodeAdmissionProof(proof, now());
  return { proof, envelope, digest: digest(canonical(proof)) };
}
