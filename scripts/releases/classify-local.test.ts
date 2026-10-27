// Basalt's own files are clear only through the reviewed list of paths no deployment reads, or a
// precise rule. Deploy workflows, deploy-time scripts and the stack generator are always judged.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifySnapshots } from "./classify.ts";
import { pins, sha } from "./fixtures.test-helpers.ts";
import { benignRuntimeFiles, deployModule, nonDeployPaths, type LocalContents } from "./local-impact.ts";
import { reviewedHelpers } from "./stack-impact.ts";

function classifyLocal(paths: string[], localContents?: LocalContents) {
  const report = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: pins(), candidatePins: pins(),
    localChangedPaths: paths, ...(localContents ? { localContents } : {}),
  });
  return {
    database: report.evidence.database.state,
    workflow: report.evidence.workflow.state,
  };
}

test("deploy-time scripts are unknown for both areas", () => {
  for (const path of [
    // Runs CREATE ROLE, GRANT, CREATE DATABASE and REVOKE against production on every deploy.
    "scripts/ensure-pool-database.ts",
    // Chooses which carried patches are applied before the build.
    "scripts/prepare-upstream.ts",
    "scripts/pool-app-bundle.ts",
    "scripts/deploy.ts",
    "scripts/alchemy.ts",
    "scripts/build.ts",
    "scripts/worker-build.ts",
    "scripts/smoke.ts",
    // The deploy-safety gate, the release gate and the main-release candidate run inside the deploy.
    "scripts/deploy-safety/release-runner.ts",
    "scripts/deploy-safety/release.ts",
    "scripts/deploy-safety/planetscale-safety.ts",
    "scripts/releases/classify.ts",
    "scripts/release-merge/main-candidate.ts",
    // `scripts/environment.ts` imports it on the production path.
    "scripts/release-preview/keys.ts",
    // Writes the deploy secrets.
    "scripts/release-credentials/export.ts",
    // A file nobody has reviewed yet.
    "scripts/new-deploy-step.ts",
  ]) assert.deepEqual(classifyLocal([path]), { database: "unknown", workflow: "unknown" }, path);
});

test("reviewed non-deploy files are clear", () => {
  assert.deepEqual(classifyLocal([
    "scripts/releases/update.ts",
    "scripts/releases/receipts/node.json",
    "scripts/releases/patches.json",
    "scripts/architecture/deployment.ts",
    "scripts/release-merge/gate.ts",
    "scripts/deploy-safety/README.md",
    "scripts/deploy-safety/planetscale-safety.test.ts",
    "scripts/upstream-tests/app-outbound-user-agent.test.ts",
    "scripts/check-connectors.ts",
    "src/pool/providers.json",
    "docs/cutover.md",
    "architecture/model/basalt.c4",
  ]), { database: "unchanged", workflow: "unchanged" });
});

test("workflows that deploy production or hold its deploy secrets are unknown; others are clear", () => {
  for (const path of ["deploy", "release-main", "release-manual", "release-rollback", "release-credentials", "release-preview", "release-cleanup", "pool-acceptance"])
    assert.deepEqual(classifyLocal([`.github/workflows/${path}.yml`]), { database: "unknown", workflow: "unknown" }, path);
  for (const path of ["ci", "app-lint", "release-merge", "releases"])
    assert.deepEqual(classifyLocal([`.github/workflows/${path}.yml`]), { database: "unchanged", workflow: "unchanged" }, path);
});

test("no module a deploy entry point imports is on the reviewed list", () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  // What the deploy workflows and `npm run deploy`/`build`/`prepare:upstream` run.
  const entries = [
    "alchemy.run.ts", "scripts/deploy.ts", "scripts/build.ts", "scripts/prepare-upstream.ts", "scripts/smoke.ts",
    "scripts/environment.ts", "scripts/deploy-safety/release.ts",
    "scripts/release-merge/main-candidate.ts", "scripts/release-merge/manual-candidate.ts",
  ];
  const reached = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (reached.has(file) || file.startsWith(".upstream/") || !existsSync(join(root, file))) continue;
    reached.add(file);
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g))
      queue.push(normalize(relative(root, join(root, dirname(file), match[1]!))));
  }
  assert.ok(reached.size > 30, "the walk found the deploy's modules");
  for (const file of reached) {
    assert.ok(!nonDeployPaths.some(([rule]) => rule.test(file)), `${file} runs at deploy but is on the reviewed list`);
    assert.ok(!benignRuntimeFiles.some(([rule]) => rule.test(file)), `${file} runs at deploy but is a reviewed runtime file`);
    if (/^(?:src|apps\/pool|containers\/pool)\//.test(file))
      assert.ok(deployModule.test(file) || reviewedHelpers.has(file), `${file} runs at deploy but is judged as ordinary runtime code`);
  }
});

test("runtime source is judged for Workflows by its changed lines", () => {
  const edit = (path: string, before: string, after: string) =>
    classifyLocal([path], { [path]: { base: `export const x = 1;\n${before}\n`, candidate: `export const x = 1;\n${after}\n` } });
  // A container or Workflow class the stack declares.
  assert.equal(edit("src/pool/deployment.ts", "  className: \"PoolContainer\",", "  className: \"GatewayContainer\",").workflow, "unknown");
  assert.equal(edit("src/pool/controller.ts", "", "export class Drain extends WorkflowEntrypoint {}").workflow, "changed");
  assert.equal(edit("src/router.ts", "", "  WORKFLOWS: Cloudflare.Workflow(\"Drain\"),").workflow, "changed");
  // Ordinary runtime code still leaves the database unknown, as before.
  assert.deepEqual(edit("src/router.ts", "const a = 1;", "const a = 2;"), { database: "unknown", workflow: "unchanged" });
  // Without its contents, a runtime file cannot be judged.
  assert.equal(classifyLocal(["src/router.ts"]).workflow, "unknown");
});
