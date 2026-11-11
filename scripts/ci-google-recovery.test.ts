import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { selectPaths } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";
import { gateErrors, fastJobs, conditionalJobs } from "./ci/gate.ts";
import { patternForGroup, readDeclarations } from "./ci/declarations.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const ids = ["google-account-recovery", "google-account-diagnostics"];
const [recovery, diagnostics] = ids.map((id) => workflow.jobs[id]);

test("Google recovery and diagnostics retain every original command, environment and deadline", () => {
  const commands = [recovery, diagnostics].flatMap((job) =>
    job.steps
      .filter(
        (step: { run?: string }) =>
          step.run?.includes("prove-provider-adoption.ts") || step.run?.includes("e2e:cloud"),
      )
      .map(
        (step: {
          run: string;
          env: Record<string, string>;
          "working-directory"?: string;
          "timeout-minutes": number;
        }) => ({
          run: step.run,
          env: step.env,
          minutes: step["timeout-minutes"],
          cwd: step["working-directory"] ?? null,
        }),
      ),
  );
  assert.deepEqual(commands, [
    {
      run: 'BASALT_ADOPTION_PROOF_PATTERN="$(node scripts/ci/e2e-pattern.ts google-account-recovery:google-recovery-through-signed-cloud-operations)"\nexport BASALT_ADOPTION_PROOF_PATTERN\nnode scripts/production-ops/prove-provider-adoption.ts\n',
      env: {
        BASALT_E2E_PRODUCTION_OPS: "1",
        BASALT_E2E_PREBOOT_BINDING: "alternate",
        BASALT_ADOPTION_PROOF_WORKERS: "1",
      },
      minutes: 6,
      cwd: null,
    },
    {
      run: 'bun run e2e:cloud --test-name "$(node ../scripts/ci/e2e-pattern.ts google-account-diagnostics:configured-client-diagnostics)" --workers 1',
      env: {
        BASALT_E2E_PRODUCTION_OPS: "1",
        BASALT_E2E_GOOGLE_CLIENT_DIAGNOSTICS: "configured",
      },
      minutes: 3,
      cwd: ".upstream",
    },
    {
      run: 'bun run e2e:cloud --test-name "$(node ../scripts/ci/e2e-pattern.ts google-account-diagnostics:unconfigured-client-diagnostics)" --workers 1',
      env: {
        BASALT_E2E_PRODUCTION_OPS: "1",
        BASALT_E2E_GOOGLE_CLIENT_DIAGNOSTICS: "unconfigured",
      },
      minutes: 3,
      cwd: ".upstream",
    },
  ]);
  const plans = Object.values(readDeclarations().files).flatMap((file) =>
    Object.entries(file.scenarios),
  );
  const selected = (group: string) =>
    plans
      .filter(([, plan]) => {
        const target = plan.targets.cloud;
        assert.ok(target !== null && typeof target === "object" && "status" in target);
        return target.status === "scheduled" && new RegExp(patternForGroup(group)).test(plan.title);
      })
      .map(([key]) => key)
      .sort();
  assert.deepEqual(
    selected("google-account-recovery:google-recovery-through-signed-cloud-operations"),
    [
      "atlassianIdentityMigration",
      "googleDuplicateBindingRace",
      "googleDuplicateBindings",
      "googleIdentityBinding",
      "googleIdentityMigration",
    ],
  );
  assert.deepEqual(selected("google-account-diagnostics:configured-client-diagnostics"), [
    "googleClientDiagnostics",
  ]);
  assert.deepEqual(selected("google-account-diagnostics:unconfigured-client-diagnostics"), [
    "googleClientUnavailable",
  ]);
});

test("both Google halves retain browser setup, ten-minute budgets and independent evidence", () => {
  assert.deepEqual(recovery.steps.slice(0, 6), diagnostics.steps.slice(0, 6));
  for (const [index, job] of [recovery, diagnostics].entries()) {
    assert.equal(job.needs, "select");
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(job["timeout-minutes"], 10);
    assert.equal(job.if, `contains(fromJSON(needs.select.outputs.jobs), '${ids[index]}')`);
    assert.equal(job.steps[3].uses, "./.github/actions/setup-browser");
    assert.deepEqual(job.steps[3].with, { "prepare-upstream": "true" });
    assert.equal(job.steps[3]["timeout-minutes"], 5);
    assert.equal(job.steps[4].run, "bun run e2e:prepare");
    assert.equal(job.steps[4]["timeout-minutes"], 2);
    assert.equal(job.steps[5].run, "node ../scripts/check-e2e-browser.mjs");
    assert.equal(job.steps[5]["timeout-minutes"], 1);
    assert.deepEqual(job.steps.at(-2), recovery.steps.at(-2));
    assert.equal(job.steps.at(-2).if, "always()");
    assert.equal(job.steps.at(-1).if, "always()");
    assert.equal(job.steps.at(-1)["timeout-minutes"], 1);
    assert.equal(job.steps.at(-1).with.name, `${ids[index]}-e2e`);
    assert.equal(job.steps.at(-1).with.path, recovery.steps.at(-1).with.path);
  }
});

test("account selection and the full aggregate require both Google halves", () => {
  const selected = selectPaths([".upstream/e2e/tests/google-account-recovery.spec.ts"]).jobs;
  for (const id of ids) {
    assert.ok(selected.includes(id));
    assert.ok(workflow.jobs.check.needs.includes(id));
    const needs = Object.fromEntries(
      [...fastJobs, ...heavyJobs, ...conditionalJobs].map((job) => [
        job,
        {
          result: conditionalJobs.includes(job) && job !== "workerd-assets" ? "skipped" : "success",
        },
      ]),
    );
    assert.deepEqual(gateErrors(needs, heavyJobs, [], true), []);
    needs[id] = { result: "skipped" };
    assert.ok(gateErrors(needs, heavyJobs, [], true).some((error) => error.startsWith(id + ":")));
  }
});
