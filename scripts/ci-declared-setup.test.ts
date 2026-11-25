import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { heavyJobs } from "./ci/areas.ts";
import { readDeclarations } from "./ci/declarations.ts";
import { gateErrors } from "./ci/gate.ts";
import { selectPaths } from "./ci/affected.ts";
import { declaredMatrices, fileDeadlineMinutes } from "./ci/shards.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

test("declared shards pay setup once, then run their planned files within the planned deadline", () => {
  const matrices = declaredMatrices();
  for (const id of ["declared-self-host", "declared-local", "declared-cloud"]) {
    const job = workflow.jobs[id];
    assert.equal(job["timeout-minutes"], "${{ matrix.timeout }}", id);
    assert.equal(job.name, "${{ matrix.shard }}", id);
    assert.equal(job.strategy["fail-fast"], false, id);
    assert.ok([job.needs].flat().includes("select"), id);
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
          name: "Run this shard's declared files, each in its own process",
          // Names the shard's retry record; the job id comes from GITHUB_JOB.
          env: { BASALT_E2E_SHARD: "${{ matrix.shard }}" },
          run: 'bun scripts/ci/run-declared.ts "${{ matrix.runs }}"',
        },
      ],
      id,
    );
    const [upload, retries, ...others] = job.steps.filter((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.deepEqual(others, [], id);
    assert.equal(upload.with.name, "${{ matrix.shard }}", id);
    assert.ok(
      upload.with.path.split("\n").includes("${{ runner.temp }}/basalt-e2e-evidence/retries.json"),
      id,
    );
    // The check job downloads only these, by the pattern its download step uses.
    assert.equal(retries.if, "always()", id);
    // A failed upload leaves the count incomplete; it must never fail the shard.
    assert.equal(retries["continue-on-error"], true, id);
    // One per run attempt, so a rerun cannot replace what the first attempt retried.
    assert.equal(
      retries.with.name,
      "e2e-retries-${{ matrix.shard }}-${{ github.run_attempt }}",
      id,
    );
    assert.equal(retries.with.path, "${{ runner.temp }}/basalt-e2e-evidence/retries.json", id);
    const download = workflow.jobs.check.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    assert.equal(download.with.pattern, "e2e-retries-*", id);
    const shards = matrices[id]!.include;
    assert.ok(shards.length > 0, id);
    // A shard's budget covers setup, its planned files and one file running to its own deadline
    // on both its attempts.
    for (const shard of shards) {
      assert.ok(shard.shard.startsWith(id + "-"), shard.shard);
      assert.ok(shard.timeout > 10 + 2 * fileDeadlineMinutes && shard.timeout <= 40, shard.shard);
    }
  }
  const shards = Object.values(matrices).flatMap((matrix) => matrix.include);
  assert.ok(shards.length <= 24, String(shards.length));
});

test("sign-in jobs prepare the runtime before bounded browser setup and run independently", () => {
  for (const id of ["clerk-sign-in", "workos-sign-in", "gitlab-sign-in", "planetscale-sign-in"]) {
    const job = workflow.jobs[id];
    assert.ok([job.needs].flat().includes("select"), id);
    assert.equal(job.strategy, undefined, id);
    assert.equal(job["timeout-minutes"], id === "planetscale-sign-in" ? 20 : 10, id);
    assert.deepEqual(
      job.steps.slice(3, 6),
      [
        { run: "npm run prepare:upstream" },
        { run: "bun run --cwd .upstream e2e:prepare" },
        { uses: "./.github/actions/setup-browser", "timeout-minutes": 5 },
      ],
      id,
    );
    assert.ok(
      !job.steps.some((step: { run?: string }) => step.run?.includes("playwright install")),
      id,
    );
  }
});

test("HITL partitions retain every target scenario exactly once behind required jobs", () => {
  const declarations = readDeclarations();
  const counts = new Map<string, number>();
  for (const [id, group] of Object.entries(declarations.groups)) {
    if (!id.startsWith("human-in-the-loop:")) continue;
    const expectedJob =
      id === "human-in-the-loop:navigation-and-retained-accounts"
        ? "human-in-the-loop-navigation"
        : group.target === "cloud"
          ? "human-in-the-loop-cloud"
          : "human-in-the-loop";
    assert.equal(group.job, expectedJob, id);
    const job = workflow.jobs[group.job];
    assert.equal(
      job["timeout-minutes"],
      group.job === "human-in-the-loop-cloud" ? 25 : 15,
      group.job,
    );
    assert.ok([job.needs].flat().includes("select"), group.job);
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
  assert.equal(counts.size, 65);
  assert.ok([...counts.values()].every((count) => count === 1));
  for (const target of ["self-host", "cloud"])
    for (const scenario of [
      "hitlIntentPrefetchDesktop",
      "hitlIntentPrefetchPhone",
      "hitlIntentScopeDesktop",
      "hitlIntentScopePhone",
      "hitlInventoryDocumentLifetime",
      "settingsIntentPrefetchDesktop",
      "settingsIntentPrefetchPhone",
      "settingsIntentPrefetchMember",
      "settingsLoading",
      "hostedAppAccountsFirstEntryDesktop",
      "hostedAppAccountsFirstEntryPhone",
    ])
      assert.equal(counts.get(`${target}:${scenario}`), 1, `${target}:${scenario}`);
  for (const path of [
    ".upstream/e2e/tests/first-entry-reveal.spec.ts",
    ".upstream/e2e/tests/hidden-section-reads.spec.ts",
    ".upstream/e2e/tests/hitl-intent-prefetch.spec.ts",
    ".upstream/e2e/tests/hitl-intent-scope.spec.ts",
    ".upstream/e2e/support/hitl-touch-intent.ts",
    ".upstream/e2e/tests/settings-intent-prefetch.spec.ts",
    ".upstream/e2e/tests/settings-loading.spec.ts",
    ".upstream/e2e/tests/app-accounts-tab.spec.ts",
    ".upstream/e2e/support/settings-touch-intent.ts",
    ".upstream/packages/ui/src/implementation/dashboard/review-lazy.tsx",
  ])
    assert.ok(selectPaths([path]).jobs.includes("human-in-the-loop-cloud"), path);
  const needs = Object.fromEntries(heavyJobs.map((id) => [id, { result: "success" }]));
  for (const id of [
    "human-in-the-loop",
    "human-in-the-loop-navigation",
    "human-in-the-loop-cloud",
  ]) {
    assert.ok(selectPaths([".upstream/packages/sdk/src/workflows.ts"]).jobs.includes(id), id);
    const failed = { ...needs, [id]: { result: "failure" } };
    assert.ok(
      gateErrors(failed, heavyJobs, [], "full").some((error) => error.startsWith(id + ":")),
      id,
    );
  }
  needs["human-in-the-loop-cloud"] = { result: "failure" };
  assert.ok(
    gateErrors(needs, heavyJobs, [], "full").some((error) =>
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
  assert.equal(workflow.jobs["account-acquisition"]["timeout-minutes"], 30);
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

test("account acquisition's self-host proof runs in two required jobs with the same setup", () => {
  const declarations = readDeclarations();
  for (const [id, job, timeout] of [
    [
      "account-acquisition:reusable-acquisition-and-retained-account-compatibility",
      "account-acquisition",
      30,
    ],
    [
      "account-observations:driver-readings-health-and-observation-compatibility",
      "account-observations",
      25,
    ],
  ] as const) {
    assert.equal(declarations.groups[id]!.job, job, id);
    const definition = workflow.jobs[job];
    assert.equal(definition["timeout-minutes"], timeout, job);
    assert.equal(definition.needs, "select", job);
    assert.ok(heavyJobs.includes(job), job);
    assert.ok(workflow.jobs.check.needs.includes(job), job);
    assert.deepEqual(
      definition.steps
        .filter((step: { run?: string }) => step.run?.includes("e2e-pattern.ts " + id))
        .map((step: { run: string }) => step.run),
      [
        `bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts ${id})" --workers 1`,
      ],
      id,
    );
  }
  const [acquisition, observations] = ["account-acquisition", "account-observations"].map(
    (id) => workflow.jobs[id].steps,
  );
  assert.deepEqual(observations.slice(0, 6), acquisition.slice(0, 6));
  assert.deepEqual(observations.slice(-2, -1), acquisition.slice(-2, -1));
  assert.equal(observations.at(-1).with.name, "account-observations-e2e");
  assert.ok(
    acquisition.some(
      (step: { run?: string }) =>
        step.run ===
        'bun run e2e:local --test-name "$(node ../scripts/ci/e2e-pattern.ts account-acquisition:local-account-lifetime-and-observation-provenance)" --workers 1',
    ),
  );
});
