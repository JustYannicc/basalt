import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { baselineInventory, baselineRoles } from "./baseline-probe.ts";
import { gateErrors, fastJobs } from "../ci/gate.ts";

const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

const scripts = baselineRoles.map((role) => ({
  id: `basalt-${role.toLowerCase()}-production-fixture`,
}));

test("selected baseline probe must pass the aggregate Check and unselected probes must skip", () => {
  const needs = Object.fromEntries(
    workflow.jobs.check.needs.map((job: string) => [
      job,
      { result: fastJobs.includes(job) ? "success" : "skipped" },
    ]),
  );
  needs["baseline-probe"] = { result: "success" };
  assert.deepEqual(gateErrors(needs, [], [], false, true), []);
  for (const result of ["failure", "cancelled", "skipped"])
    assert.ok(
      gateErrors({ ...needs, "baseline-probe": { result } }, [], [], false, true).some((error) =>
        error.startsWith("baseline-probe:"),
      ),
    );
  needs["baseline-probe"] = { result: "skipped" };
  assert.deepEqual(gateErrors(needs, [], [], false, false), []);
});

test("baseline inventory covers all live roles and refuses missing, duplicate and unexpected Workers", () => {
  assert.deepEqual(
    baselineInventory([...scripts, { id: "unrelated-worker" }]).map((worker) => worker.role),
    baselineRoles,
  );
  assert.ok(baselineInventory(scripts).some((worker) => worker.role === "AppOutbound"));
  assert.throws(
    () => baselineInventory(scripts.filter((script) => !script.id.includes("publicsite"))),
    /PublicSite/,
  );
  assert.throws(() => baselineInventory([...scripts, scripts[0]!]), /Api/);
  assert.throws(
    () => baselineInventory([...scripts, { id: "basalt-future-worker-production-fixture" }]),
    /unexpected/,
  );
});

test("live probe runs only on internal PRs and precedes automatic and manual release work", () => {
  const workflow = (name: string) =>
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
  const ci = workflow("ci");
  const job = ci.slice(ci.indexOf("\n  baseline-probe:"), ci.indexOf("\n  cpa-pipeline:"));
  assert.match(job, /github\.event_name == 'pull_request'/);
  assert.match(job, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(job, /needs\.select\.outputs\.baseline_probe == 'true'/);
  assert.doesNotMatch(job, /environment:|pull_request_target/);
  assert.match(job, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(job, /bun-version: \$\{\{ env\.E2E_BUN_VERSION \}\}/);
  assert.match(ci, /E2E_BUN_VERSION: 1\.4\.2/);
  for (const name of ["release-main", "release-manual"]) {
    const text = workflow(name);
    const probe = text.indexOf("baseline-probe-entry.ts");
    assert.ok(probe > 0 && probe < text.indexOf("release.ts backup-only"), name);
  }
  for (const name of ["ci", "deploy", "release-main", "release-manual"]) {
    assert.match(
      workflow(name),
      /BASALT_RELEASE_ATTEMPT="\$\(node -e '[^\n]+randomUUID\(\)[^\n]+'\)" \\\n\s+bun scripts\/release-barrier\/baseline-probe-entry\.ts/,
    );
  }
  const deploy = workflow("deploy");
  assert.ok(deploy.indexOf("baseline-probe-entry.ts") < deploy.indexOf("release.ts deploy "));
});
