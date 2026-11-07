import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { stageContainer } from "./container.ts";
import { assertImageOnlyPublication, containerSnapshot, sameContainerState } from "./container.ts";
import { decodeApplication } from "./container-cloudflare.ts";
import { BarrierRefusal } from "./manifest.ts";
import { containerProps, containerPublication } from "./test/container-fixture.ts";

function recordedBaseline() {
  const proof = containerPublication();
  const cached = structuredClone(proof.previous);
  cached.version = 25;
  cached.configuration = {
    ...cached.configuration,
    environmentVariables: [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: "fixture" }],
    observability: { logs: { enabled: true } },
  };
  const live = structuredClone(cached);
  live.version = 26;
  live.configuration = {
    image: cached.configuration.image,
    vcpu: 0.25,
    memory: "1GiB",
    memoryMib: 1024,
    disk: { size: "4GB", size_mb: 4000 },
    environmentVariables: structuredClone(cached.configuration.environmentVariables),
    observability: structuredClone(cached.configuration.observability),
    command: [],
    entrypoint: [],
    network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
  };
  Object.assign(live.configuration, { runtime: "firecracker" });
  const proposed = {
    ...proof.proposed,
    version: 26,
    configuration: { ...cached.configuration, image: proof.proposed.configuration.image },
  };
  const publication = {
    ...proof.publication,
    previous: live,
    proposed,
    rolloutRequest: {
      ...proof.publication.rolloutRequest,
      targetConfiguration: proposed.configuration,
    },
  };
  return { proof, cached, live, publication };
}

test("the recorded pre-rollout v25 baseline converges to its exact expanded v26 readback before staging a newer image", async () => {
  const { proof, cached, publication } = recordedBaseline();
  const staged = await Effect.runPromise(
    stageContainer(publication, containerProps(), containerProps(), cached, () =>
      Effect.succeed(proof.metadata),
    ),
  );
  assert.equal(staged.frozen.baseline.version, 26);
  assert.equal(staged.frozen.baselineInputHash, cached.hash?.image);
  assert.equal(staged.frozen.imageDigest, proof.metadata.digest);
  assert.notEqual(staged.frozen.imageDigest, cached.hash?.digest);
  assert.equal(staged.normalization?.recordedVersion, 25);
  assert.equal(staged.normalization?.observedVersion, 26);
  assert.equal(staged.normalization?.disposition, "observed-baseline");
  assert.equal(staged.normalization?.changed.length, 13);
});

test("same-version baseline expansion is also observed without promoting the new input hash", async () => {
  const { proof, cached, publication } = recordedBaseline();
  publication.previous.version = cached.version;
  const staged = await Effect.runPromise(
    stageContainer(publication, containerProps(), containerProps(), cached, () =>
      Effect.succeed(proof.metadata),
    ),
  );
  assert.equal(staged.frozen.baseline.version, 25);
  assert.equal(staged.normalization?.observedVersion, 25);
  assert.equal(staged.frozen.baselineInputHash, "a".repeat(16));
  assert.equal(staged.frozen.inputHash, "b".repeat(16));
});

for (const field of [
  "image",
  "recorded-image",
  "hash",
  "recorded-hash",
  "environment",
  "resources",
  "disk",
  "network",
  "command",
  "entrypoint",
  "runtime",
  "namespace",
  "placement",
  "capacity",
  "identity",
  "version",
  "rollout",
] as const)
  test(`baseline convergence refuses foreign ${field} with changed paths`, () => {
    const { cached, publication } = recordedBaseline();
    const previous = publication.previous;
    if (field === "image") previous.configuration.image = publication.proposed.configuration.image;
    if (field === "recorded-image")
      cached.configuration.image = publication.proposed.configuration.image;
    if (field === "hash") previous.hash!.image = "c".repeat(16);
    if (field === "recorded-hash") cached.hash!.digest = `sha256:${"9".repeat(64)}`;
    if (field === "environment")
      previous.configuration.environmentVariables![0]!.value = "private-foreign-value";
    if (field === "resources") previous.configuration.vcpu = 0.5;
    if (field === "disk") previous.configuration.disk = { size: "4GB", size_mb: 4001 };
    if (field === "network")
      previous.configuration.network = { assign_ipv4: "none", assign_ipv6: "none", mode: "public" };
    if (field === "command") previous.configuration.command = ["foreign"];
    if (field === "entrypoint") previous.configuration.entrypoint = ["foreign"];
    if (field === "runtime") Object.assign(previous.configuration, { runtime: "foreign" });
    if (field === "namespace") previous.durableObjects!.namespaceId = "foreign";
    if (field === "placement") Object.assign(previous.constraints!, { jurisdiction: "global" });
    if (field === "capacity") previous.maxInstances = 2;
    if (field === "identity") previous.applicationId = "foreign";
    if (field === "version") previous.version = 27;
    if (field === "rollout") Object.assign(previous, { activeRolloutId: "foreign" });
    assert.throws(
      () => assertImageOnlyPublication(publication, containerProps(), containerProps(), cached),
      (error) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.ok(error.delta?.changed.length);
        assert.ok(!JSON.stringify(error.delta).includes("private-foreign-value"));
        return true;
      },
    );
  });

test("baseline normalization never relaxes the later frozen version guard", () => {
  const { live } = recordedBaseline();
  assert.equal(sameContainerState(live, containerSnapshot(live)), true);
  assert.equal(sameContainerState({ ...live, version: 27 }, containerSnapshot(live)), false);
});

test("raw readback admits only the known runtime default and preserves every effective setting", () => {
  const { live } = recordedBaseline();
  const raw = {
    id: live.applicationId,
    name: live.applicationName,
    account_id: live.accountId,
    version: live.version,
    created_at: live.createdAt,
    instances: live.instances,
    updated_at: "2026-01-01T00:00:01Z",
    network: { bandwidth_limit_mbps: 250 },
    max_instances: live.maxInstances,
    scheduling_policy: live.schedulingPolicy,
    constraints: live.constraints,
    durable_objects: { namespace_id: live.durableObjects!.namespaceId },
    configuration: {
      ...live.configuration,
      memory_mib: live.configuration.memoryMib,
      environment_variables: live.configuration.environmentVariables,
    },
  };
  delete raw.configuration.memoryMib;
  delete raw.configuration.environmentVariables;
  assert.equal(sameContainerState(decodeApplication(raw), containerSnapshot(live)), true);
  for (const extra of [{ runtime: "foreign" }, { unrecognized_setting: true }])
    assert.throws(
      () => decodeApplication({ ...raw, configuration: { ...raw.configuration, ...extra } }),
      /unsupported-container-observation/,
    );
  for (const network of [
    { bandwidth_limit_mbps: 251 },
    { bandwidth_limit_mbps: 250, future_setting: true },
  ])
    assert.throws(
      () => decodeApplication({ ...raw, network }),
      /unsupported-container-observation/,
    );
});
