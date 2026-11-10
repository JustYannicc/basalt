import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { openEnvelope } from "../../src/pool/token.ts";
import {
  RuntimeAttestation,
  runtimeAttestationFormat,
} from "../../src/pool/runtime-slots/admission-proof.ts";
import { signRuntimeAdmission } from "./runtime-slot-proof.ts";
import { runtimeHandoffDigest } from "./runtime-slot-manifest.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";

test("start signing binds the observed provider app without inventing an instance or completed boot", async () => {
  const f = await runtimeProofFixture();
  const result = await signRuntimeAdmission(
    f.manifest,
    "start",
    { provider: f.provider, selection: f.manifest.selection },
    f.enable,
    f.signingKey,
    () => f.now,
  );
  assert.deepEqual(
    await openEnvelope(f.signingKey, runtimeAttestationFormat, result.envelope),
    result.proof,
  );
  assert.equal(result.proof.kind, "start");
  assert.equal("instanceId" in result.proof.provider, false);
  assert.equal("bootId" in result.proof, false);
  assert.equal(await openEnvelope(f.signingKey, "sbpdr1", result.envelope), undefined);
});

test("completed proof joins fresh provider instance to the retained startup witness and distinct launch operation", async () => {
  const f = await runtimeProofFixture();
  const result = await signRuntimeAdmission(
    f.manifest,
    "attested",
    {
      provider: { ...f.provider, instanceId: f.manifest.target.instanceId },
      selection: f.manifest.selection,
      witness: f.witness,
    },
    f.enable,
    f.signingKey,
    () => f.now,
  );
  const proof = Schema.decodeUnknownSync(RuntimeAttestation)(result.proof);
  assert.equal(proof.operationId, "release-operation");
  assert.equal(proof.launch.operationId, f.witness.launch.operationId);
  assert.notEqual(proof.launch.operationId, proof.operationId);
  assert.equal(proof.launch.tokenHash, f.witness.launch.tokenHash);
  assert.equal(proof.bootId, f.witness.bootId);
  assert.equal(proof.manifestDigest, runtimeHandoffDigest(f.manifest));
});

test("different witness operation, manifest, target, configuration and incomplete boot refuse signing", async () => {
  const f = await runtimeProofFixture();
  for (const witness of [
    { ...f.witness, operationId: "another-release" },
    { ...f.witness, manifestDigest: "e".repeat(64) },
    { ...f.witness, target: { ...f.witness.target, applicationId: "other-application" } },
    { ...f.witness, configurationFingerprint: "f".repeat(64) },
    { ...f.witness, bootId: undefined },
  ])
    await assert.rejects(
      signRuntimeAdmission(
        f.manifest,
        "attested",
        {
          provider: { ...f.provider, instanceId: f.manifest.target.instanceId },
          selection: f.manifest.selection,
          witness,
        },
        f.enable,
        f.signingKey,
        () => f.now,
      ),
    );
});

test("stale provider observations, identity drift, selection drift and missing enable refuse", async () => {
  const f = await runtimeProofFixture();
  for (const provider of [
    { ...f.provider, observedAt: f.now - 30_001 },
    { ...f.provider, observedAt: f.now + 5_001 },
    { ...f.provider, applicationVersion: "2" },
    { ...f.provider, namespaceId: "other-namespace" },
    { ...f.provider, applicationConfigDigest: "e".repeat(64) },
  ])
    await assert.rejects(
      signRuntimeAdmission(
        f.manifest,
        "start",
        { provider, selection: f.manifest.selection },
        f.enable,
        f.signingKey,
        () => f.now,
      ),
    );
  await assert.rejects(
    signRuntimeAdmission(
      f.manifest,
      "start",
      { provider: f.provider, selection: { ...f.manifest.selection, expectedEpoch: 2 } },
      f.enable,
      f.signingKey,
      () => f.now,
    ),
    /provisioning-input-drift/,
  );
  await assert.rejects(
    signRuntimeAdmission(
      f.manifest,
      "start",
      { provider: f.provider, selection: f.manifest.selection },
      undefined,
      f.signingKey,
      () => f.now,
    ),
    /runtime-handoff-not-enabled/,
  );
});

test("legacy preservation remains unattested and cannot decode as completed readiness", async () => {
  const f = await runtimeProofFixture();
  const manifest = {
    ...f.manifest,
    disposition: "preserve-unattested" as const,
    selection: { ...f.manifest.selection, expectedEpoch: 0, active: null },
  };
  const enable = { ...f.enable, manifest: runtimeHandoffDigest(manifest) };
  const result = await signRuntimeAdmission(
    manifest,
    "unattested-active",
    {
      provider: { ...f.provider, instanceId: manifest.target.instanceId },
      selection: manifest.selection,
      unattestedBootId: "legacy-unattested-boot",
    },
    enable,
    f.signingKey,
    () => f.now,
  );
  assert.equal(result.proof.kind, "unattested-active");
  assert.equal("launch" in result.proof, false);
  assert.throws(() => Schema.decodeUnknownSync(RuntimeAttestation)(result.proof));
  await assert.rejects(
    signRuntimeAdmission(
      manifest,
      "attested",
      {
        provider: { ...f.provider, instanceId: manifest.target.instanceId },
        selection: manifest.selection,
        witness: f.witness,
      },
      enable,
      f.signingKey,
      () => f.now,
    ),
    /provisioning-input-drift/,
  );
});

test("a bridge-key rotation refuses while per-slot management and app-signing settings remain independent", async () => {
  const f = await runtimeProofFixture();
  const changed = {
    ...f.manifest,
    bridgeKey: { ...f.manifest.bridgeKey, candidateDigest: "f".repeat(64) },
  };
  const enable = { ...f.enable, manifest: runtimeHandoffDigest(changed) };
  await assert.rejects(
    signRuntimeAdmission(
      changed,
      "start",
      { provider: f.provider, selection: f.manifest.selection },
      enable,
      f.signingKey,
      () => f.now,
    ),
    /provisioning-input-drift/,
  );
  await assert.rejects(
    signRuntimeAdmission(
      f.manifest,
      "start",
      { provider: f.provider, selection: f.manifest.selection },
      f.enable,
      "e".repeat(64),
      () => f.now,
    ),
    /provisioning-input-drift/,
  );
  assert.notEqual(f.manifest.configuration.signingKey, f.signingKey);
  assert.notEqual(f.manifest.configuration.managementKey, f.signingKey);
  assert.equal(
    (
      await signRuntimeAdmission(
        f.manifest,
        "start",
        { provider: f.provider, selection: f.manifest.selection },
        f.enable,
        f.signingKey,
        () => f.now,
      )
    ).proof.kind,
    "start",
  );
});

test("invalid private runtime configuration names its property without printing secret values", async () => {
  const f = await runtimeProofFixture();
  const privateValue = "synthetic-private-value-must-not-reach-diagnostics";
  const invalid = {
    ...f.manifest,
    configuration: { ...f.manifest.configuration, unexpectedSecret: privateValue },
  };
  await assert.rejects(
    signRuntimeAdmission(
      invalid,
      "start",
      { provider: f.provider, selection: f.manifest.selection },
      f.enable,
      f.signingKey,
      () => f.now,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /runtime-private-input-invalid/);
      assert.equal(String(error).includes(privateValue), false);
      assert.equal(JSON.stringify(error).includes(privateValue), false);
      assert.match(JSON.stringify(error), /configuration/);
      return true;
    },
  );
});
