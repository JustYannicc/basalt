import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requiredPreviewDeploySecrets } from "../environment.ts";
import type { LifecycleServices } from "./lifecycle.ts";
import { deployPreview, planPreview } from "./lifecycle.ts";
import { manifestPath } from "../release-preview/checkpoint.ts";
import { readPreviewManifest } from "./manifest.ts";

const originalBrand = `export const brand = {
  host: "app.production.example.invalid",
  zone: "production.example.invalid",
} as const;
`;

function environment(): NodeJS.ProcessEnv {
  const source = Object.fromEntries(requiredPreviewDeploySecrets.map((name) => [name, "fixture"])) as NodeJS.ProcessEnv;
  Object.assign(source, {
    GITHUB_ACTIONS: "true",
    PREVIEW_MANIFEST_CHECKPOINTED: "1",
    TEST_STAGE_DOMAIN: "preview.example.invalid",
    PREVIEW_STATE_KEY: "17".repeat(32),
    PREVIEW_SMOKE_EMAIL: "preview-pr-17@example.invalid",
    PREVIEW_SMOKE_PASSWORD: "fixture-preview-password-that-is-long-enough",
  });
  return source;
}

function services(root: string, observations: string[], failDeploy = false): LifecycleServices {
  return {
    stateReader: () => ({ read: async () => ({ basalt: [], "basalt-preview-database": [] }) }),
    captureProviders: async () => ({ complete: true, containers: [], domains: [] }),
    build: async (buildRoot) => {
      const source = await readFile(join(buildRoot, "brand.ts"), "utf8");
      observations.push("build:" + source);
    },
    deploy: async (identity, _environment, seedFile) => {
      const source = await readFile(join(root, "brand.ts"), "utf8");
      observations.push("deploy:" + source);
      if (failDeploy) throw new Error("fixture deployment failed");
      await writeFile(seedFile, `${JSON.stringify({
        version: 1,
        stage: identity.stage,
        origin: identity.origin,
        userId: "preview-user-17",
        organization: { id: "organization-17", slug: "preview-smoke-17" },
        poolAppId: "pool-app-17",
      })}\n`, { flag: "wx", mode: 0o600 });
    },
    destroyStack: async () => {},
    deleteArtifacts: async () => {},
    verifyProviders: async () => {},
  };
}

test("the preview host stays materialized through build and both deploy stacks, then restores", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-lifecycle-"));
  const source = environment();
  const observations: string[] = [];
  try {
    await writeFile(join(root, "brand.ts"), originalBrand, { mode: 0o600 });
    await planPreview(root, 17, source);
    await deployPreview(root, 17, source, services(root, observations));
    assert.equal(observations.length, 2);
    for (const observation of observations) {
      assert.match(observation, /host: "app\.pr-17\.preview\.example\.invalid"/);
      assert.match(observation, /zone: "preview\.example\.invalid"/);
    }
    assert.equal(await readFile(join(root, "brand.ts"), "utf8"), originalBrand);
    const manifest = await readPreviewManifest(manifestPath(root, 17), 17);
    assert.equal(manifest.phase, "seeded");
    assert.equal(manifest.organizationId, "organization-17");
    assert.equal(manifest.poolAppId, "pool-app-17");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed deploy restores the tracked brand source", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-lifecycle-fail-"));
  const source = environment();
  try {
    await writeFile(join(root, "brand.ts"), originalBrand, { mode: 0o600 });
    await planPreview(root, 17, source);
    await assert.rejects(deployPreview(root, 17, source, services(root, [], true)), /fixture deployment failed/);
    assert.equal(await readFile(join(root, "brand.ts"), "utf8"), originalBrand);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
