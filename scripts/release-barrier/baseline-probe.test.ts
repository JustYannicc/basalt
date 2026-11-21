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
  tags: ["alchemy:stack:basalt", "alchemy:stage:production", `alchemy:id:${role}`],
}));

test("selected baseline probe must pass the aggregate Check and unselected probes must skip", () => {
  const needs = Object.fromEntries(
    workflow.jobs.check.needs
      .filter((job: string) => job !== "reuse")
      .map((job: string) => [job, { result: fastJobs.includes(job) ? "success" : "skipped" }]),
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
  const truncated = scripts.map((script) =>
    script.tags.includes("alchemy:id:ArtifactsCredentials")
      ? { ...script, id: `basalt-artifactscredentials-pr${"a".repeat(24)}` }
      : script,
  );
  assert.equal(
    baselineInventory(truncated).find((worker) => worker.role === "ArtifactsCredentials")!
      .scriptName,
    `basalt-artifactscredentials-pr${"a".repeat(24)}`,
  );
  for (const tag of ["alchemy:id:Other", "alchemy:stage:preview", "alchemy:stack:Other"])
    assert.throws(
      () =>
        baselineInventory([
          { ...scripts[0]!, tags: [...scripts[0]!.tags, tag] },
          ...scripts.slice(1),
        ]),
      /Api/,
    );
  assert.throws(
    () => baselineInventory(scripts.filter((script) => !script.id.includes("publicsite"))),
    /PublicSite/,
  );
  assert.throws(() => baselineInventory([...scripts, scripts[0]!]), /Api/);
  assert.throws(
    () =>
      baselineInventory([
        ...scripts,
        {
          id: "basalt-future-worker-production-fixture",
          tags: ["alchemy:stack:basalt", "alchemy:stage:production", "alchemy:id:Future"],
        },
      ]),
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

test("a stage's inventory is exactly its own Workers, and production never takes a rehearsal's", () => {
  const stage = (stack: string, name: string) =>
    baselineRoles.map((role) => ({
      id: `basalt-${role.toLowerCase()}-${name}`,
      tags: [`alchemy:stack:${stack}`, `alchemy:stage:${name}`, `alchemy:id:${role}`],
    }));
  const rehearsal = stage("basalt-rehearsal", "test-rehearsal-1");
  const other = stage("basalt-rehearsal", "test-rehearsal-2");
  const target = { stack: "basalt-rehearsal", stage: "test-rehearsal-1" };
  const names = (workers: { scriptName: string }[]) => workers.map((worker) => worker.scriptName);
  assert.deepEqual(
    names(baselineInventory([...scripts, ...rehearsal, ...other])),
    scripts.map((script) => script.id),
  );
  assert.deepEqual(
    names(baselineInventory([...scripts, ...rehearsal, ...other], target)),
    rehearsal.map((script) => script.id),
  );
  // A rehearsal stage may lack roles its declaration leaves out, never taking another stage's.
  const partial = rehearsal.filter((script) => !script.tags.includes("alchemy:id:PublicSite"));
  assert.deepEqual(
    names(baselineInventory([...scripts, ...partial, ...other], target)),
    partial.map((script) => script.id),
  );
  for (const inventory of [scripts, other, stage("basalt", "test-rehearsal-1")])
    assert.deepEqual(baselineInventory(inventory, target), []);
  // Production refuses every missing role; it never takes a rehearsal's Workers.
  for (const inventory of [rehearsal, stage("basalt-rehearsal", "production")])
    assert.throws(
      () => baselineInventory(inventory),
      (error: { refusals?: { reason: string }[]; workers?: unknown[] }) =>
        error.workers?.length === 0 &&
        error.refusals?.length === baselineRoles.length &&
        error.refusals.every(({ reason }) => reason.startsWith("missing-worker")),
    );
});

test("production still requires all 20 roles: a missing apex site or app pages is refused there", () => {
  const without = (list: typeof scripts) =>
    list.filter(
      (script) =>
        !["alchemy:id:PublicSite", "alchemy:id:AppPages"].some((tag) => script.tags.includes(tag)),
    );
  for (const target of [undefined, { stack: "basalt", stage: "production" }])
    assert.throws(
      () => baselineInventory(without(scripts), target),
      (error: { refusals?: { role: string; reason: string }[] }) =>
        JSON.stringify(
          error.refusals?.map(({ role, reason }) => [role, reason.split(";")[0]]).sort(),
        ) ===
        JSON.stringify([
          ["AppPages", "missing-worker"],
          ["PublicSite", "missing-worker"],
        ]),
    );
  // The partial match follows only the release stage named by the trusted environment.
  const rehearsal = without(scripts).map((script) => ({
    id: script.id.replace("production-fixture", "test-rehearsal-1"),
    tags: script.tags.map((tag) =>
      tag
        .replace("alchemy:stack:basalt", "alchemy:stack:basalt-rehearsal")
        .replace("alchemy:stage:production", "alchemy:stage:test-rehearsal-1"),
    ),
  }));
  assert.equal(
    baselineInventory(rehearsal, { stack: "basalt-rehearsal", stage: "test-rehearsal-1" }).length,
    baselineRoles.length - 2,
  );
  assert.throws(() =>
    baselineInventory(rehearsal, { stack: "basalt-rehearsal", stage: "production" }),
  );
});
