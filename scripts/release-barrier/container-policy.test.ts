import assert from "node:assert/strict";
import { test } from "node:test";
import { BarrierRefusal } from "./manifest.ts";
import { refusalTable } from "./refusal-report.ts";
import { Effect } from "effect";
import { assertImageOnlyPublication, stageContainer } from "./container.ts";
import { containerProps, containerPublication } from "./test/container-fixture.ts";
import {
  decodeApplication,
  decodeContainerRollout,
  waitForContainerVersion,
} from "./container-cloudflare.ts";

test("only an immutable image change preserves the existing EU/basic/one-instance application", async () => {
  const proof = containerPublication();
  const result = await Effect.runPromise(
    stageContainer(proof.publication, containerProps(), containerProps(), proof.previous, () =>
      Effect.succeed(proof.metadata),
    ),
  );
  assert.deepEqual(result.frozen, proof.frozen);
  assert.deepEqual(result.frozen.configuration, proof.publication.proposed.configuration);
});

for (const change of [
  "resources",
  "environment",
  "placement",
  "namespace",
  "version",
  "mutable-image",
  "declaration",
] as const)
  test(`container ${change} changes refuse before image admission`, () => {
    const proof = containerPublication();
    const news = containerProps();
    if (change === "resources")
      proof.publication.proposed.configuration.instanceType = "standard-1";
    if (change === "environment")
      Object.assign(proof.publication.proposed.configuration, {
        environmentVariables: [{ name: "UNREVIEWED", value: "secret" }],
      });
    if (change === "placement")
      Object.assign(proof.publication.proposed.constraints!, { jurisdiction: "global" });
    if (change === "namespace") proof.publication.previous.durableObjects!.namespaceId = "foreign";
    if (change === "version") proof.publication.previous.version = 99;
    if (change === "mutable-image")
      proof.publication.proposed.configuration.image =
        "registry.cloudflare.com/fixture/pool:latest";
    if (change === "declaration") news.maxInstances = 2;
    const cached = containerPublication().previous;
    assert.throws(() =>
      assertImageOnlyPublication(proof.publication, news, containerProps(), cached),
    );
  });

for (const metadata of [
  { platform: "linux/arm64" },
  { capabilityLabel: "0" },
  { configDigest: "missing" },
  { digest: `sha256:${"9".repeat(64)}` },
])
  test(`image metadata ${JSON.stringify(metadata)} cannot pass admission`, async () => {
    const proof = containerPublication();
    await assert.rejects(
      Effect.runPromise(
        stageContainer(proof.publication, containerProps(), containerProps(), proof.previous, () =>
          Effect.succeed({ ...proof.metadata, ...metadata }),
        ),
      ),
      /invalid-container-image-metadata/,
    );
  });

test("raw control-plane settings reject unknown fields before the SDK can drop them", () => {
  const app = {
    id: "pool-app",
    name: "pool",
    account_id: "fixture",
    version: 1,
    created_at: "2026-01-01T00:00:00Z",
    scheduling_policy: "default",
    instances: 1,
    max_instances: 1,
    configuration: { image: containerPublication().previous.configuration.image },
  };
  assert.equal(decodeApplication(app).applicationId, "pool-app");
  assert.throws(
    () => decodeApplication({ ...app, unrecognized_setting: true }),
    /unsupported-container-observation/,
  );
  assert.throws(
    () =>
      decodeApplication({
        ...app,
        configuration: { ...app.configuration, unrecognized_setting: true },
      }),
    /unsupported-container-observation/,
  );
});

test("documented application health and rollout metadata do not hide unsupported settings", () => {
  const app = {
    id: "pool-app",
    name: "pool",
    account_id: "fixture",
    version: 1,
    created_at: "2026-01-01T00:00:00Z",
    scheduling_policy: "default",
    instances: 1,
    max_instances: 1,
    configuration: { image: containerPublication().previous.configuration.image },
    active_rollout_id: "recorded-rollout",
    health: { summary: "healthy" },
  };
  assert.equal(decodeApplication(app).activeRolloutId, "recorded-rollout");
  for (const field of ["authorized_keys", "wrangler_ssh", "future_setting"])
    assert.throws(
      () => decodeApplication({ ...app, configuration: { ...app.configuration, [field]: [] } }),
      /unsupported-container-observation/,
    );
  assert.throws(
    () => decodeApplication({ ...app, rollout_active_grace_period: 10 }),
    /unsupported-container-observation/,
  );
});

test("rollout receipt binds the documented target version rather than the SDK's Application type", () => {
  assert.deepEqual(
    decodeContainerRollout({
      id: "rollout",
      current_version: 1,
      target_version: 2,
      status: "completed",
    }),
    { id: "rollout", currentVersion: 1, targetVersion: 2 },
  );
  for (const response of [
    { id: "rollout", version: 2 },
    { id: "rollout", current_version: 2, target_version: 2 },
  ])
    assert.throws(() => decodeContainerRollout(response), /container-rollout-unconfirmed/);
});

test("native attributes use only the observed target version, and foreign rollout state refuses", async () => {
  const proof = containerPublication();
  const target = { ...proof.frozen.baseline, configuration: proof.frozen.configuration };
  const rollout = { id: "rollout", currentVersion: 1, targetVersion: 2 };
  const adopted = { ...proof.proposed, version: 2 };
  assert.equal(
    (
      await Effect.runPromise(
        waitForContainerVersion(target, rollout, () => Effect.succeed(adopted)),
      )
    ).version,
    2,
  );
  for (const current of [
    { ...adopted, version: 99 },
    { ...adopted, activeRolloutId: "foreign-rollout" },
    { ...adopted, configuration: proof.previous.configuration },
    { ...adopted, maxInstances: 2 },
  ])
    await assert.rejects(
      Effect.runPromise(waitForContainerVersion(target, rollout, () => Effect.succeed(current))),
      /container-(version|rollout|configuration)-drift/,
    );
});

test("container declaration refusals name every changed property and hide private values", () => {
  const proof = containerPublication();
  const news = { ...containerProps(), maxInstances: 2, env: { ACCESS_TOKEN: "private-value" } };
  assert.throws(
    () => assertImageOnlyPublication(proof.publication, news, containerProps(), proof.previous),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      const table = refusalTable(error);
      assert.match(table, /maxInstances.*1 → 2/);
      assert.match(table, /env.ACCESS_TOKEN/);
      assert.ok(!table.includes("private-value"));
      return true;
    },
  );
});
