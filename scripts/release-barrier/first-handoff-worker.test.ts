import assert from "node:assert/strict";
import { test } from "node:test";
import { firstHandoffVersionRequest } from "./first-handoff-worker.ts";
import { firstHandoffFixture } from "./test/first-handoff-fixture.ts";
import { decodeHandoffWorker } from "./first-handoff-contract.ts";

test("handoff code installation cannot advance the legacy image or settings before adoption", async () => {
  const { manifest } = await firstHandoffFixture();
  const request = firstHandoffVersionRequest(manifest, "preserve");
  assert.deepEqual(
    request.bindings,
    manifest.baseline.version.bindings!.map((binding) => ({
      type: "inherit",
      name: binding.name,
      versionId: manifest.baseline.version.id,
    })),
  );
  assert.equal(request.deploy, false);
  assert.deepEqual(request.modules, manifest.modules);
  assert.deepEqual(request.exports, manifest.baseline.version.exports);
  assert.deepEqual(request.containers, manifest.baseline.version.containers);
});

test("a foreign runtime namespace refuses before the first code upload", async () => {
  const { manifest } = await firstHandoffFixture();
  const changed = {
    ...manifest,
    baseline: decodeHandoffWorker({
      ...manifest.baseline,
      version: {
        ...manifest.baseline.version,
        bindings: manifest.baseline.version.bindings!.map((binding) =>
          binding.name === "PoolRuntime"
            ? { ...binding, namespaceId: "foreign-namespace" }
            : binding,
        ),
      },
    }),
  };
  assert.throws(() => firstHandoffVersionRequest(changed, "preserve"), {
    reason: "first-handoff-namespace-mismatch",
  });
});

test("candidate settings advance explicitly while every other binding keeps the frozen baseline", async () => {
  const { manifest } = await firstHandoffFixture();
  const request = firstHandoffVersionRequest(manifest, "advance");
  assert.deepEqual(
    request.bindings!.find((binding) => binding.name === "POOL_IMAGE_HASH"),
    { name: "POOL_IMAGE_HASH", type: "plain_text", text: manifest.candidate.target.imageInput },
  );
  assert.deepEqual(
    request.bindings!.find((binding) => binding.name === "POOL_MANAGEMENT_KEY"),
    {
      name: "POOL_MANAGEMENT_KEY",
      type: "secret_text",
      text: manifest.candidate.configuration.managementKey,
    },
  );
  assert.deepEqual(
    request.bindings!.find((binding) => binding.name === "KEEP"),
    { name: "KEEP", type: "inherit", versionId: manifest.baseline.version.id },
  );
});
