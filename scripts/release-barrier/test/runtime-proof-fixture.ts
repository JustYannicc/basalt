import { Schema } from "effect";
import { SlotTarget } from "../../../src/pool/runtime-slots/contract.ts";
import { runtimeConfiguration } from "../../../src/pool/runtime-slots/configuration.ts";
import { decodeApplication } from "../container-observation.ts";
import {
  freezeRuntimeHandoff,
  runtimeBridgeKeyDigest,
  runtimeHandoffDigest,
} from "../runtime-slot-manifest.ts";
import { runtimeApplicationConfigDigest } from "../runtime-slot-provider-proof.ts";

export async function runtimeProofFixture() {
  const now = 10_000;
  const raw = {
    id: "candidate-application",
    name: "synthetic-runtime",
    account_id: "1".repeat(32),
    version: 1,
    created_at: "2026-11-09T00:00:00Z",
    instances: 0,
    max_instances: 1,
    scheduling_policy: "default",
    constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
    durable_objects: { namespace_id: "candidate-namespace" },
    configuration: {
      image: `registry.cloudflare.com/${"1".repeat(32)}/synthetic@sha256:${"a".repeat(64)}`,
      instance_type: "basic",
      environment_variables: [{ name: "SYNTHETIC", value: "private-fixture-value" }],
      observability: { logs: { enabled: true } },
    },
  };
  const target = Schema.decodeUnknownSync(SlotTarget)({
    format: "pool-runtime-slot-v1",
    controllerId: "2".repeat(64),
    slotId: "candidate",
    applicationId: raw.id,
    applicationVersion: "1",
    instanceId: "3".repeat(64),
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "4".repeat(16),
  });
  const selection = {
    expectedEpoch: 1,
    active: {
      ...target,
      slotId: "legacy",
      applicationId: "legacy-application",
      instanceId: "5".repeat(64),
      bootId: "11111111-1111-1111-1111-111111111111",
    },
    policyDigest: "6".repeat(64),
    revisions: [
      { pool: "synthetic-pool", organization: "synthetic-org", revision: 1, retired: false },
    ],
  };
  const manifest = await freezeRuntimeHandoff({
    disposition: "runtime-handoff",
    candidate: "7".repeat(40),
    stack: "synthetic",
    stage: "production",
    operationId: "release-operation",
    bridgeKey: {
      baselineDigest: runtimeBridgeKeyDigest("d".repeat(64)),
      candidateDigest: runtimeBridgeKeyDigest("d".repeat(64)),
    },
    controller: { accountId: raw.account_id, scriptName: "synthetic-poolworker" },
    controllerCode: { candidate: "7".repeat(40), workerInput: "8".repeat(64) },
    target,
    provider: {
      accountId: raw.account_id,
      namespaceId: "candidate-namespace",
      applicationConfigDigest: runtimeApplicationConfigDigest(decodeApplication(raw)),
    },
    configuration: runtimeConfiguration({
      POOL_DATABASE_URL: "postgres://synthetic.invalid/test",
      POOL_MANAGEMENT_KEY: "synthetic-management",
      POOL_APP_SIGNING_KEY: "e".repeat(64),
      POOL_IMAGE_HASH: target.imageInput,
    }),
    selection,
  });
  const manifestDigest = runtimeHandoffDigest(manifest);
  const enable = {
    coordinatorGo: "synthetic-only",
    writerLease: "synthetic-exclusive-release",
    manifest: manifestDigest,
    expiresAt: now + 60_000,
  };
  const provider = {
    ...manifest.provider,
    applicationId: target.applicationId,
    applicationVersion: target.applicationVersion,
    imageDigest: target.imageDigest,
    observationDigest: "b".repeat(64),
    observedAt: now,
  };
  const witness = {
    operationId: manifest.operationId,
    manifestDigest,
    target: manifest.target,
    configurationFingerprint: manifest.configurationFingerprint,
    launch: {
      operationId: "22222222-2222-2222-2222-222222222222",
      generation: 2,
      tokenHash: "c".repeat(64),
    },
    bootId: "33333333-3333-3333-3333-333333333333",
  };
  return { now, raw, manifest, enable, provider, witness, signingKey: "d".repeat(64) };
}
