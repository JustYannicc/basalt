import assert from "node:assert/strict";
import { test } from "node:test";
import { probeNeeded, releasePreflightNeeded } from "./probe-paths.ts";

test("a change to a stack resource, its settings or a storage declaration runs the full-plan probe", () => {
  for (const path of [
    "alchemy.run.ts",
    "release-declarations.json",
    "brand.ts",
    "scripts/environment.ts",
    "scripts/ensure-pool-database.ts",
    "scripts/pool-database-provisioning.ts",
    "src/browser-check.ts",
    "src/telemetry/deployment.ts",
    "src/pool/database-settings.ts",
    "src/pool/deployment.ts",
    "src/pool/database.ts",
    "src/pool/worker-database.ts",
    "src/pool/database-budget.ts",
  ])
    assert.equal(probeNeeded(["docs/releases.md", path]), true, path);
});

test("release machinery, carried upstream code and release workflows still run it", () => {
  for (const path of [
    "scripts/release-barrier/plan-stack.ts",
    "scripts/release-phases/deploy.ts",
    "patches/0003-eu-durable-objects.patch",
    "upstream.json",
    ".github/workflows/ci.yml",
    ".github/workflows/release-manual.yml",
  ])
    assert.equal(probeNeeded([path]), true, path);
});

test("site copy, docs, the architecture mapping and nested look-alikes don't", () => {
  assert.equal(
    probeNeeded([
      "src/site/content.ts",
      "docs/releases.md",
      "architecture/model/infrastructure.c4",
      "src/pool/accounts-view.ts",
      "src/pool/database-settings.test.ts",
      "src/brand.ts",
      "scripts/environment.test.ts",
      "apps/pool/alchemy.run.ts",
      "scripts/preview/stack/alchemy.database.ts",
      "",
    ]),
    false,
  );
});

test("release and pool runtime changes select the preflight", () => {
  for (const path of [
    "scripts/release-barrier/runtime-release-client.ts",
    "scripts/release-phases/deploy.ts",
    "scripts/release-merge/main-candidate.ts",
    "scripts/deploy.ts",
    "scripts/deploy-safety/release.ts",
    ".github/workflows/release-main.yml",
    ".github/workflows/release-manual.yml",
    ".github/workflows/deploy.yml",
    "src/pool/runtime-slots/contract.ts",
    "src/pool/runtime-fleet/configuration.ts",
    "src/pool/runtime-recovery.ts",
    "src/pool/deployment-readiness.ts",
    "src/pool/runtime.worker.ts",
    "src/pool/runtime-do.worker.ts",
    "src/pool/worker.ts",
    "scripts/pool-operations-node-worker.mjs",
    ".github/workflows/release-rollback.yml",
  ])
    assert.equal(releasePreflightNeeded([path]), true, path);
  for (const path of ["src/pool/inventory.ts", "README.md", "apps/pool/ui/index.ts"])
    assert.equal(releasePreflightNeeded([path]), false, path);
  assert.equal(probeNeeded(["scripts/release-barrier/release-preflight.ts"]), true);
});
