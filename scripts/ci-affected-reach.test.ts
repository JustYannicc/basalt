import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { carryTargets, selectPaths } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";
import { declaredJobs } from "./ci/box-router.ts";
import { fastConfigs, readDeclarations } from "./ci/declarations.ts";
import { configsReached } from "./ci/e2e-workflow.ts";
import { readWorkflow } from "./ci/job-inputs.ts";

// Inputs the import graph cannot see on its own: product files inside the unprepared upstream,
// reads by computed path, package manifests and fast-only e2e configs. ci.test.ts covers the
// e2e test corrections preparation applies by name.
const root = fileURLToPath(new URL("../", import.meta.url));
const select = (paths: string[]) => selectPaths(paths, root);
const carry = (path: string) => carryTargets(readFileSync(join(root, path), "utf8"));
const includes = (paths: string[], jobs: string[]) => {
  const selected = select(paths).jobs;
  for (const job of jobs) assert.ok(selected.includes(job), paths.join(" ") + " " + job);
};
const everything = (paths: string[]) => {
  const selected = select(paths);
  assert.deepEqual(selected.jobs, heavyJobs, paths.join(" "));
  assert.equal(selected.declaredFiles, null, paths.join(" "));
};

test("an upstream product file selects every heavy job, whichever plans name it", () => {
  // Nothing graphs imports inside `.upstream`, so a plan naming a shell, root or frame file
  // says which specs read it, not that no other spec does.
  for (const path of [
    ".upstream/packages/dashboard-start/src/implementation/shell.tsx",
    ".upstream/apps/hosted/cloud/web/src/main.tsx",
    ".upstream/apps/hosted/cloud/web/src/implementation/routes/__root.tsx",
    ".upstream/apps/hosted/self-host/web/src/implementation/routes/__root.tsx",
    ".upstream/apps/local/web/src/implementation/routes/__root.tsx",
    ".upstream/apps/hosted/web/src/implementation/components/entry.tsx",
    ".upstream/apps/hosted/web/src/implementation/pages/login-frame.tsx",
    ".upstream/packages/ui/src/implementation/dashboard/shell.tsx",
  ])
    everything([path]);
  // The dashboard analytics carry reaches every Cloud page, not only its own spec.
  everything(carry("patches/0150-dashboard-browser-analytics.patch"));
  // An e2e spec's plan still decides its jobs.
  assert.notDeepEqual(select([".upstream/e2e/tests/product-analytics.spec.ts"]).jobs, heavyJobs);
});

test("a catalog source a contract fixture reads by computed path reaches its contract job", () => {
  for (const path of ["src/catalog/cloudflare.json", "src/catalog/cloudflare.published.json"])
    includes([path], ["upstream-contracts"]);
});

test("a package's manifest and lockfile reach every job its files reach", () => {
  for (const path of ["src/setup/package.json", "src/setup/bun.lock"])
    includes([path], ["slack-health", "gitlab-connectors", "production-build"]);
  for (const path of ["src/tunnel/package.json", "src/tunnel/bun.lock"])
    includes([path], ["pool-runtime", "client-native-product"]);
});

test("the declared shard planner and its durations select every declared shard", () => {
  // Each declared job's shards, timeouts and per-file deadline come from these.
  for (const path of ["scripts/ci/shards.ts", "scripts/ci/declared-durations.json"]) {
    const selected = select([path]);
    for (const job of declaredJobs) assert.ok(selected.jobs.includes(job), path + " " + job);
    assert.equal(selected.declaredFiles, null, path);
  }
});

test("the Home peer sources the pool Worker bundles select its build", () => {
  // scripts/pool-peer-program.ts bundles them; the pool Worker build fails on a stale bundle.
  for (const path of [
    "containers/pool/home_peer.py",
    "containers/pool/home_peer_wire.py",
    "containers/pool/home_peer_bootstrap.py",
  ])
    includes([path], ["pool-runtime", "production-build"]);
});

test("a change that reaches a fast-declared spec runs its config in the lane", () => {
  // These specs' plans name only the fast job, whose step runs their configs.
  const declarations = readDeclarations(root);
  const configs = (path: string) => fastConfigs(select(carry(path)).declaredFiles, declarations);
  assert.deepEqual(configs("patches/0187-cloud-app-listener-native-http.patch"), [
    "cloud-app-listener.config.ts",
  ]);
  assert.deepEqual(configs("patches/0268-emulator-fixture-ipv4.patch"), [
    "emulator-failures.config.ts",
  ]);
  assert.deepEqual(fastConfigs(select(["docs/pools.md"]).declaredFiles, declarations), []);
  // The step that runs them runs in a lane Check whenever selection names one.
  const steps = readWorkflow(root).jobs.fast!.steps!;
  for (const config of fastConfigs(null, declarations)) {
    const step = steps.find((step) => step.run?.includes(`--config e2e/${config}`));
    assert.equal(step?.if, configsReached, config);
  }
});
