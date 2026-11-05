import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Schema } from "effect";
import { legacyScenarios, scenarios, TestPlan } from "../../.upstream/e2e/test-plan.ts";
import { readDeclarations } from "./declarations.ts";
import { upstreamInputFiles } from "./inputs.ts";

const root = process.cwd();
const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
const declarations = readDeclarations(root);
const prepared = new Map(Object.entries(scenarios));
const inventory = JSON.parse(readFileSync("scripts/ci/inherited-tests.json", "utf8")) as {
  pin: string;
  files: Record<string, string>;
  manualTargets: Record<string, unknown>;
};
const pin = JSON.parse(readFileSync("upstream.json", "utf8")).commit;
assert.equal(inventory.pin, pin, "Refresh the inherited inventory when the upstream pin changes");
assert.deepEqual(
  upstreamInputFiles(root),
  execFileSync("git", ["-C", ".upstream", "ls-tree", "-r", "--name-only", "-z", pin], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean),
  "Frozen upstream input inventory differs from the pinned source",
);
const original = execFileSync("git", ["-C", ".upstream", "show", pin + ":e2e/test-plan.ts"], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
const inheritedKeys = new Set(
  [...original.matchAll(/^  ([A-Za-z][A-Za-z0-9]*): \{/gm)].map((match) => match[1]),
);
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const known = new Map<string, string>();
const files = readdirSync(".upstream/e2e/tests", { recursive: true, encoding: "utf8" }).filter(
  (file) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file),
);
for (const [file, entry] of Object.entries(declarations.files)) {
  assert.ok(files.includes(file), "Declaration has no test file: " + file);
  for (const [key, value] of Object.entries(entry.scenarios)) {
    assert.ok(!known.has(key), "Duplicate scenario key: " + key);
    known.set(key, file);
    const decoded = Schema.decodeUnknownSync(TestPlan)(value);
    assert.deepEqual(
      prepared.get(key),
      decoded,
      "Prepared plan does not contain declaration: " + key,
    );
    if (legacyScenarios[key])
      assert.deepEqual(
        legacyScenarios[key],
        decoded,
        "Central plan drifted from its per-file declaration: " + key,
      );
  }
  for (const key of entry.inherited) {
    assert.ok(inheritedKeys.has(key), "A Basalt scenario cannot claim upstream ownership: " + key);
    assert.equal(
      legacyScenarios[key]?.file,
      file,
      "Inherited scenario belongs to another file: " + key,
    );
  }
  for (const config of entry.config) {
    assert.ok(
      workflow.jobs[config.job]?.steps.some((step: { run?: string }) =>
        step.run?.includes("e2e/" + config.config),
      ),
      "Declared config is not run by its job: " + config.config,
    );
    assert.ok(
      readFileSync(join(".upstream/e2e", config.config), "utf8").includes("e2e/tests/" + file),
      "Config does not include test: " + file,
    );
    for (const title of config.titles)
      assert.ok(
        readFileSync(join(".upstream/e2e/tests", file), "utf8").includes(title),
        "Declared config scenario is absent: " + title,
      );
  }
}
for (const [key, plan] of Object.entries(legacyScenarios)) {
  if (!inheritedKeys.has(key))
    assert.equal(
      known.get(key),
      plan.file,
      "Basalt scenario has no per-file plan or CI job: " + key,
    );
}
for (const file of files) {
  if (declarations.files[file]) continue;
  const expected = inventory.files[file];
  assert.ok(expected, "Unmapped test file: " + file);
  const source = readFileSync(join(".upstream/e2e/tests", file));
  const actual = createHash("sha1")
    .update("blob " + source.length + "\0")
    .update(source)
    .digest("hex");
  assert.equal(actual, expected, "Changed inherited test needs a declaration: " + file);
}
for (const file of Object.keys(inventory.files))
  assert.ok(files.includes(file), "Stale inherited test inventory: " + file);
for (const [id, group] of Object.entries(declarations.groups)) {
  const assigned = Object.values(declarations.files).some((entry) =>
    Object.values(entry.runs).some((runs) => runs.includes(id)),
  );
  assert.ok(assigned, "Empty declared test group: " + id);
  const job = workflow.jobs[group.job];
  assert.ok(job, "Declared e2e group has no workflow job: " + id);
  if (group.command)
    assert.ok(
      job.steps.some((step: { run?: string }) => step.run?.includes(group.command!)),
      "Proof runner is absent from job: " + id,
    );
  else if (!group.matrix)
    assert.ok(
      job.steps.some((step: { run?: string }) => step.run?.includes("e2e-pattern.ts " + id)),
      "Group is not selected by job: " + id,
    );
}
const report = {
  pin,
  files: files.length,
  declaredFiles: Object.keys(declarations.files).length,
  inheritedFiles: Object.keys(inventory.files).length,
  declaredScenarios: known.size,
  groups: Object.keys(declarations.groups).length,
  manualTargets: declarations.manualTargets,
};
mkdirSync(".generated/ci", { recursive: true });
writeFileSync(".generated/ci/coverage.json", JSON.stringify(report, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY && Object.keys(declarations.manualTargets).length)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    "Explicit inherited manual targets:\n\n" +
      Object.entries(declarations.manualTargets)
        .map(([key, value]) => "- " + key + " / " + value.target + ": " + value.reason + "\n")
        .join(""),
  );
console.log(JSON.stringify(report));
