import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  AdmissionProof,
  RuntimeAttestation,
  decodeAdmissionProof,
  launchWitnessKey,
  runtimeAttestationFormat,
} from "./runtime-slots/admission-proof.ts";

function proof() {
  const now = Date.now();
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "controller",
    slotId: "candidate",
    applicationId: "candidate-app",
    applicationVersion: "3",
    instanceId: "candidate-instance",
    imageInput: "candidate-input",
    imageDigest: `sha256:${"b".repeat(64)}`,
  };
  return {
    format: runtimeAttestationFormat,
    kind: "attested",
    operationId: "fixture-release-operation",
    manifestDigest: "d".repeat(64),
    controllerCode: { candidate: "a".repeat(40), workerInput: "e".repeat(64) },
    target,
    configurationFingerprint: "f".repeat(64),
    bootId: "candidate-boot",
    provider: {
      accountId: "fixture-account",
      namespaceId: "fixture-namespace",
      applicationId: target.applicationId,
      applicationVersion: target.applicationVersion,
      instanceId: target.instanceId,
      imageDigest: target.imageDigest,
      applicationConfigDigest: "1".repeat(64),
      observationDigest: "2".repeat(64),
      observedAt: now,
    },
    launch: { operationId: crypto.randomUUID(), generation: 1, tokenHash: "3".repeat(64) },
    selection: {
      expectedEpoch: 1,
      active: {
        ...target,
        applicationId: "old-app",
        slotId: "old",
        instanceId: "old-instance",
        bootId: "old-boot",
      },
      policyDigest: "4".repeat(64),
      revisions: [{ pool: "pool", organization: "organization", revision: 1, retired: false }],
    },
    at: now,
    expiresAt: now + 60_000,
  };
}

test("the shared codec keeps launch and release operations distinct and binds exact provider identity", () => {
  const value = proof();
  const decoded = decodeAdmissionProof(value);
  assert.equal(decoded.operationId, value.operationId);
  assert.equal(decoded.kind, "attested");
  assert.ok("launch" in decoded && decoded.launch.operationId === value.launch.operationId);
  assert.equal(launchWitnessKey("candidate"), "runtime-slots-v1:launch-witness:candidate");
  for (const field of ["applicationId", "applicationVersion", "instanceId", "imageDigest"] as const)
    assert.throws(() =>
      decodeAdmissionProof({ ...value, provider: { ...value.provider, [field]: "different" } }),
    );
});

test("unattested-active is explicit bootstrap preservation and cannot decode as completed attestation", () => {
  const value = proof();
  const { launch: _launch, ...withoutLaunch } = value;
  const bootstrap = {
    ...withoutLaunch,
    kind: "unattested-active",
    selection: { ...value.selection, active: null, expectedEpoch: 0 },
  };
  assert.equal(decodeAdmissionProof(bootstrap).kind, "unattested-active");
  assert.throws(() => Schema.decodeUnknownSync(RuntimeAttestation)(bootstrap));
  assert.throws(() => decodeAdmissionProof({ ...bootstrap, selection: value.selection }));
});

test("stale, overlapping, noncanonical and unallocated proofs refuse", () => {
  const value = proof();
  assert.throws(() => decodeAdmissionProof({ ...value, expiresAt: value.at - 1 }));
  assert.throws(() =>
    decodeAdmissionProof({
      ...value,
      provider: { ...value.provider, observedAt: Date.now() - 31_000 },
    }),
  );
  assert.throws(() =>
    decodeAdmissionProof({
      ...value,
      selection: { ...value.selection, active: { ...value.target, bootId: "boot" } },
    }),
  );
  assert.throws(() =>
    decodeAdmissionProof({
      ...value,
      selection: {
        ...value.selection,
        revisions: [...value.selection.revisions, ...value.selection.revisions],
      },
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(AdmissionProof)({ ...value, format: "unallocated" }),
  );
  assert.throws(() => decodeAdmissionProof({ ...value, rawStartupSecret: "fixture-secret" }));
});
