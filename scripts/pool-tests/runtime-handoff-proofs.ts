import assert from "node:assert/strict";
import { Schema } from "effect";
import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { RuntimeSlotStorage } from "../../src/pool/runtime-slots/storage.ts";
import {
  VerifiedRuntimeAttestation,
  decodeAdmissionProof,
  runtimeAttestationFormat,
  type LaunchAuthorization,
} from "../../src/pool/runtime-slots/admission-proof.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import type { handoffRuntime } from "./runtime-handoff-fixture.ts";
import type { RuntimeSqlite } from "./runtime-handoff-storage.ts";
import { runtimeProviderFixture } from "./runtime-provider-fixture.ts";

export const runtimeFixtureCode = {
  candidate: productionOpsRelease,
  workerInput: poolWorkerRevision,
};
export async function selectionProof(storage: RuntimeSqlite) {
  const snapshot = await new RuntimeSlotStorage(storage).inspect();
  return {
    expectedEpoch: snapshot.selection?.epoch ?? 0,
    active: snapshot.selection?.active.identity ?? null,
    policyDigest: snapshot.digest,
    revisions: [
      ...snapshot.policies.map(({ pool, organization, revision }) => ({
        pool,
        organization,
        revision,
        retired: false,
      })),
      ...snapshot.denials.map(({ pool, organization, revision }) => ({
        pool,
        organization,
        revision,
        retired: true,
      })),
    ].sort((left, right) => left.pool.localeCompare(right.pool)),
  };
}
export async function runtimeGrant(
  runtime: Awaited<ReturnType<typeof handoffRuntime>>,
  controller: RuntimeSqlite,
  kind: "start" | "initial-start" | "unattested-active",
  provider?: { accountId: string; namespaceId: string; applicationConfigDigest: string },
) {
  const now = Date.now();
  const observation = provider ?? (await runtimeProviderFixture(runtime.target));
  const proof = decodeAdmissionProof({
    format: runtimeAttestationFormat,
    kind,
    operationId: crypto.randomUUID(),
    manifestDigest: "e".repeat(64),
    controllerCode: runtimeFixtureCode,
    target: runtime.target,
    configurationFingerprint: await runtime.digest(),
    selection: await selectionProof(controller),
    provider: {
      accountId: observation.accountId,
      namespaceId: observation.namespaceId,
      applicationConfigDigest: observation.applicationConfigDigest,
      applicationId: runtime.target.applicationId,
      applicationVersion: runtime.target.applicationVersion,
      imageDigest: runtime.target.imageDigest,
      observationDigest: "b".repeat(64),
      observedAt: now,
      ...(kind === "unattested-active" ? { instanceId: runtime.target.instanceId } : {}),
    },
    ...(kind === "unattested-active" ? { bootId: runtime.identity().bootId } : {}),
    at: now,
    expiresAt: now + 60_000,
  });
  return {
    proof,
    envelope: await signEnvelope(runtime.env.POOL_DEPLOYMENT_KEY!, runtimeAttestationFormat, proof),
  };
}
export async function joinedRuntimeProof(
  runtime: Awaited<ReturnType<typeof handoffRuntime>>,
  controller: RuntimeSqlite,
  authorization: LaunchAuthorization,
) {
  const observed = await runtime.endpoint.witness(runtime.target);
  assert.equal(observed.kind, "witness");
  assert.ok("witness" in observed && observed.witness?.bootId);
  const now = Date.now();
  const proof = Schema.decodeUnknownSync(VerifiedRuntimeAttestation)({
    ...authorization,
    kind: authorization.kind === "initial-start" ? "initial-attested" : "attested",
    bootId: observed.witness.bootId,
    launch: observed.witness.launch,
    selection: await selectionProof(controller),
    provider: {
      ...authorization.provider,
      instanceId: runtime.target.instanceId,
      observationDigest: "c".repeat(64),
      observedAt: now,
    },
    at: now,
    expiresAt: now + 60_000,
  });
  return {
    proof,
    envelope: await signEnvelope(runtime.env.POOL_DEPLOYMENT_KEY!, runtimeAttestationFormat, proof),
  };
}
