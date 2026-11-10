import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readDeclarations } from "./ci/declarations.ts";
import { selectPaths } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";
import { conditionalJobs, fastJobs, gateErrors } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const transport = "host-managed-accounts-cloud";
const actions = "host-managed-accounts-cloud-actions";
const groups = {
  "isolated-cold-listing-telemetry": { job: transport, count: 1 },
  "the-private-oauth-transport-and-hosted-placement": { job: transport, count: 19 },
  "account-policy-and-import": { job: actions, count: 12 },
  "listed-account-actions": { job: actions, count: 12 },
};

test("all 44 Cloud account scenarios keep one owner and their original isolated command", () => {
  const declarations = readDeclarations();
  const all = new Set<string>();
  for (const [name, { job, count }] of Object.entries(groups)) {
    const id = `${transport}:${name}`;
    assert.deepEqual(declarations.groups[id], {
      job,
      target: "cloud",
      mode: "managed",
      matrix: false,
      command: undefined,
    });
    const selected = Object.values(declarations.files).flatMap((file) =>
      Object.entries(file.runs)
        .filter(([, runs]) => runs.includes(id))
        .map(([key]) => key),
    );
    assert.equal(selected.length, count, id);
    for (const key of selected) {
      assert.ok(!all.has(key), `Cloud scenario scheduled twice: ${key}`);
      all.add(key);
    }
    const commands = Object.entries(workflow.jobs).flatMap(([owner, value]) =>
      (value as { steps: { run?: string }[] }).steps
        .filter((step) => step.run?.includes(`e2e-pattern.ts ${id})`))
        .map((step) => ({ owner, command: step.run!.replace(/\s+/g, " ").trim() })),
    );
    assert.deepEqual(commands, [
      {
        owner: job,
        command: `bun run e2e:cloud --test-name "$(node ../scripts/ci/e2e-pattern.ts ${id})" --workers 1`,
      },
    ]);
  }
  assert.equal(all.size, 44);
});

test("both jobs prepare separately and retain evidence inside unchanged deadlines", () => {
  for (const id of [transport, actions]) {
    const job = workflow.jobs[id];
    assert.equal(job.needs, "select");
    assert.equal(job.if, `contains(fromJSON(needs.select.outputs.jobs), '${id}')`);
    assert.equal(job["timeout-minutes"], 20);
    assert.deepEqual(job.steps.slice(0, 6), workflow.jobs[transport].steps.slice(0, 6));
    assert.equal(
      job.steps.filter((step: { run?: string }) => step.run?.includes("e2e-pattern.ts")).length,
      2,
    );
    assert.deepEqual(job.steps.at(-2), workflow.jobs[transport].steps.at(-2));
    assert.equal(job.steps.at(-2).if, "always()");
    assert.equal(job.steps.at(-1).if, "always()");
    assert.equal(job.steps.at(-1).with.name, `${id}-e2e`);
  }
});

test("source selection and the aggregate cannot skip either Cloud account job", () => {
  const declarations = readDeclarations();
  for (const file of [
    "cold-listing-telemetry.spec.ts",
    "cloud-mcp-session-routing.spec.ts",
    "account-identity-policy.spec.ts",
    "listed-account-actions.spec.ts",
  ]) {
    const plan = declarations.files[file]!;
    const selected = selectPaths([`.upstream/e2e/tests/${file}`]).jobs;
    for (const runs of Object.values(plan.runs))
      for (const run of runs) {
        if (run.startsWith(transport + ":"))
          assert.ok(selected.includes(declarations.groups[run]!.job), file);
      }
  }
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...conditionalJobs].map((job) => [
      job,
      {
        result: conditionalJobs.includes(job) && job !== "workerd-assets" ? "skipped" : "success",
      },
    ]),
  );
  assert.deepEqual(gateErrors(needs, heavyJobs, [], true), []);
  for (const id of [transport, actions]) {
    assert.ok(workflow.jobs.check.needs.includes(id));
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.ok(
        gateErrors({ ...needs, [id]: { result } }, heavyJobs, [], true).some((error) =>
          error.startsWith(id + ":"),
        ),
      );
    }
  }
});
