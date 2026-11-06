import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { heavyJobs } from "./ci/areas.ts";
import { readDeclarations } from "./ci/declarations.ts";
import { gateErrors } from "./ci/gate.ts";
import { selectPaths } from "./ci/affected.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

test("declared matrices use the bounded browser setup within their existing deadlines", () => {
  for (const id of ["declared-self-host", "declared-local", "declared-cloud"]) {
    const job = workflow.jobs[id];
    assert.equal(job["timeout-minutes"], 10, id);
    assert.equal(job.needs, "select", id);
    assert.deepEqual(
      job.steps.slice(3, 7),
      [
        { run: "npm run prepare:upstream" },
        {
          name: "Build isolated test assets",
          "working-directory": ".upstream",
          run: "bun run e2e:prepare",
        },
        { name: "Install the scenarios' browser engine", uses: "./.github/actions/setup-browser" },
        {
          name: "Run this file's declared scenarios",
          run: 'bun scripts/ci/run-declared.ts "${{ matrix.group }}" "${{ matrix.file }}"',
        },
      ],
      id,
    );
  }
});

test("HITL partitions retain every target scenario exactly once behind required jobs", () => {
  const declarations = readDeclarations();
  const counts = new Map<string, number>();
  for (const [id, group] of Object.entries(declarations.groups)) {
    if (!id.startsWith("human-in-the-loop:")) continue;
    const expectedJob = group.target === "cloud" ? "human-in-the-loop-cloud" : "human-in-the-loop";
    assert.equal(group.job, expectedJob, id);
    const job = workflow.jobs[group.job];
    assert.equal(job["timeout-minutes"], 15, group.job);
    assert.equal(job.needs, "select");
    assert.ok(heavyJobs.includes(group.job));
    assert.ok(workflow.jobs.check.needs.includes(group.job));
    assert.equal(
      job.steps.filter((step: { run?: string }) => step.run?.includes("e2e-pattern.ts " + id))
        .length,
      1,
      id,
    );
    for (const entry of Object.values(declarations.files)) {
      for (const [key, runs] of Object.entries(entry.runs)) {
        if (runs.includes(id)) {
          const pair = group.target + ":" + key;
          counts.set(pair, (counts.get(pair) ?? 0) + 1);
        }
      }
    }
  }
  assert.equal(counts.size, 42);
  assert.ok([...counts.values()].every((count) => count === 1));
  for (const path of [
    ".upstream/e2e/tests/first-entry-reveal.spec.ts",
    ".upstream/e2e/tests/hidden-section-reads.spec.ts",
    ".upstream/packages/ui/src/implementation/dashboard/review-lazy.tsx",
  ])
    assert.ok(selectPaths([path]).jobs.includes("human-in-the-loop-cloud"), path);
  const needs = Object.fromEntries(heavyJobs.map((id) => [id, { result: "success" }]));
  needs["human-in-the-loop-cloud"] = { result: "failure" };
  assert.ok(
    gateErrors(needs, heavyJobs, [], true).some((error) =>
      error.startsWith("human-in-the-loop-cloud:"),
    ),
  );
});

test("account usage has its own required budget without changing its approved proof", () => {
  const id = "account-acquisition:account-usage-rows-and-cells";
  const declarations = readDeclarations();
  assert.equal(declarations.groups[id]!.job, "account-usage");
  const job = workflow.jobs["account-usage"];
  assert.equal(job["timeout-minutes"], 20);
  assert.equal(workflow.jobs["account-acquisition"]["timeout-minutes"], 20);
  assert.ok(heavyJobs.includes("account-usage"));
  assert.ok(workflow.jobs.check.needs.includes("account-usage"));
  assert.ok(
    !workflow.jobs["account-acquisition"].steps.some((step: { run?: string }) =>
      step.run?.includes("e2e-pattern.ts " + id),
    ),
  );
  assert.equal(
    job.steps.filter((step: { run?: string }) => step.run?.includes("e2e-pattern.ts " + id)).length,
    1,
  );
  const conformance = JSON.parse(
    readFileSync(new URL("../e2e/conformance/compact-rows-r3.json", import.meta.url), "utf8"),
  );
  const proofs = conformance.requirements
    .flatMap(
      (requirement: { proofs?: { scenario: string; job: string }[] }) => requirement.proofs ?? [],
    )
    .filter((proof: { scenario: string }) => proof.scenario === "accountCompactRows");
  assert.equal(proofs.length, 2);
  assert.ok(proofs.every((proof: { job: string }) => proof.job === "account-usage"));
});
