import { Schema } from "effect";
import { ControllerCode, SlotIdentity, SlotTarget } from "./contract.ts";
import { launchGeneration, launchOperationId } from "../launch-contract.ts";

export const runtimeAttestationFormat = "pool-runtime-attestation-v1";
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Counter = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Milliseconds = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const PolicyRevision = Schema.Struct({
  pool: Identifier,
  organization: Identifier,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  retired: Schema.Boolean,
});
export const SelectionProof = Schema.Struct({
  expectedEpoch: Counter,
  active: Schema.NullOr(SlotIdentity),
  policyDigest: Hash,
  revisions: Schema.Array(PolicyRevision),
});
export type SelectionProof = typeof SelectionProof.Type;

/** Application readback precedes first start; it cannot invent an observed instance. */
export const ProviderApplicationProof = Schema.Struct({
  accountId: Identifier,
  namespaceId: Identifier,
  applicationId: Identifier,
  applicationVersion: Identifier,
  imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  applicationConfigDigest: Hash,
  observationDigest: Hash,
  observedAt: Milliseconds,
});
export const ProviderRuntimeProof = Schema.Struct({
  ...ProviderApplicationProof.fields,
  instanceId: Identifier,
});
export const LaunchWitness = Schema.Struct({
  operationId: launchOperationId,
  generation: launchGeneration,
  tokenHash: Hash,
});
export type LaunchWitness = typeof LaunchWitness.Type;
const releaseFields = {
  format: Schema.Literal(runtimeAttestationFormat),
  operationId: Identifier,
  manifestDigest: Hash,
  controllerCode: ControllerCode,
  target: SlotTarget,
  configurationFingerprint: Hash,
  selection: SelectionProof,
  at: Milliseconds,
  expiresAt: Milliseconds,
};

/** One inactive start is authorized before its boot exists. This is not completed attestation. */
export const StartAuthorization = Schema.Struct({
  ...releaseFields,
  kind: Schema.Literal("start"),
  provider: ProviderApplicationProof,
});
export type StartAuthorization = typeof StartAuthorization.Type;
export const InitialStartAuthorization = Schema.Struct({
  ...StartAuthorization.fields,
  kind: Schema.Literal("initial-start"),
});
export const LaunchAuthorization = Schema.Union([StartAuthorization, InitialStartAuthorization]);
export type LaunchAuthorization = typeof LaunchAuthorization.Type;

/** Preserves the existing running boot without representing its startup settings as measured. */
export const UnattestedActive = Schema.Struct({
  ...releaseFields,
  kind: Schema.Literal("unattested-active"),
  provider: ProviderRuntimeProof,
  bootId: Identifier,
});
export type UnattestedActive = typeof UnattestedActive.Type;

/** Release joins fresh provider observations to the runtime's actual trusted-start callback. */
export const RuntimeAttestation = Schema.Struct({
  ...releaseFields,
  kind: Schema.Literal("attested"),
  provider: ProviderRuntimeProof,
  launch: LaunchWitness,
  bootId: Identifier,
});
export type RuntimeAttestation = typeof RuntimeAttestation.Type;
export const InitialRuntimeAttestation = Schema.Struct({
  ...RuntimeAttestation.fields,
  kind: Schema.Literal("initial-attested"),
});
export const VerifiedRuntimeAttestation = Schema.Union([
  RuntimeAttestation,
  InitialRuntimeAttestation,
]);
export const AdmissionProof = Schema.Union([
  StartAuthorization,
  InitialStartAuthorization,
  UnattestedActive,
  RuntimeAttestation,
  InitialRuntimeAttestation,
]);
export type AdmissionProof = typeof AdmissionProof.Type;
export const isLaunchAuthorization = (proof: AdmissionProof): proof is LaunchAuthorization =>
  proof.kind === "start" || proof.kind === "initial-start";
export const isRuntimeAttestation = (
  proof: AdmissionProof,
): proof is typeof VerifiedRuntimeAttestation.Type =>
  proof.kind === "attested" || proof.kind === "initial-attested";

export const StartupWitness = Schema.Struct({
  operationId: Identifier,
  manifestDigest: Hash,
  target: SlotTarget,
  configurationFingerprint: Hash,
  launch: LaunchWitness,
  bootId: Schema.optional(Identifier),
});
export type StartupWitness = typeof StartupWitness.Type;

export function launchWitnessKey(slot: string) {
  Schema.decodeUnknownSync(Identifier)(slot);
  return `runtime-slots-v1:launch-witness:${slot}`;
}

export function decodeAdmissionProof(value: unknown, now = Date.now()): AdmissionProof {
  const proof = Schema.decodeUnknownSync(AdmissionProof, { onExcessProperty: "error" })(value);
  if (
    proof.at > now + 5_000 ||
    proof.expiresAt <= now ||
    proof.expiresAt <= proof.at ||
    proof.expiresAt > proof.at + 60_000
  )
    throw new Error("Runtime attestation validity refused");
  if (proof.provider.observedAt > now + 5_000 || proof.provider.observedAt < now - 30_000)
    throw new Error("Runtime provider observation expired");
  const { target, provider, selection } = proof;
  if (
    provider.applicationId !== target.applicationId ||
    provider.applicationVersion !== target.applicationVersion ||
    provider.imageDigest !== target.imageDigest ||
    (!isLaunchAuthorization(proof) && proof.provider.instanceId !== target.instanceId)
  )
    throw new Error("Runtime provider identity differs");
  if ((selection.expectedEpoch === 0) !== (selection.active === null))
    throw new Error("Runtime selection epoch differs");
  if (proof.kind === "unattested-active" && selection.active !== null)
    throw new Error("Runtime bootstrap already selected");
  const initial = proof.kind === "initial-start" || proof.kind === "initial-attested";
  if (initial && target.homePeerOrdinal === undefined)
    throw new Error("Initial Home identity is missing");
  if (initial && (selection.active !== null || selection.expectedEpoch !== 0))
    throw new Error("Initial runtime already selected");
  if (!initial && proof.kind !== "unattested-active" && selection.active === null)
    throw new Error("Runtime candidate requires an active selection");
  if (
    selection.active &&
    (selection.active.controllerId !== target.controllerId ||
      selection.active.applicationId === target.applicationId ||
      selection.active.instanceId === target.instanceId)
  )
    throw new Error("Runtime candidate overlaps active");
  if (
    selection.active?.homePeerOrdinal !== undefined &&
    (target.homePeerOrdinal === undefined ||
      target.homePeerOrdinal === selection.active.homePeerOrdinal)
  )
    throw new Error("Runtime candidate overlaps Home identity");
  const keys = selection.revisions.map((row) => row.pool);
  if (
    new Set(keys).size !== keys.length ||
    JSON.stringify([...keys].sort((left, right) => left.localeCompare(right))) !==
      JSON.stringify(keys)
  )
    throw new Error("Runtime policy revisions are not canonical");
  return proof;
}
