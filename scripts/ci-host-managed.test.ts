import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { selectPaths } from "./ci/affected.ts";
import { gateErrors, fastJobs, bundleJobs } from "./ci/gate.ts";
import { heavyJobs } from "./ci/areas.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const ids = ["host-managed-accounts", "host-managed-accounts-pool"];
const [accounts, pool] = ids.map((id) => workflow.jobs[id]);

// Preserve the unsplit suite's selectors, including cases unavailable on this target.
const originalBehavior = [
  "host-managed accounts are hidden",
  "host-provisioned accounts keep working",
  "account radio linking cannot replace",
  "agent connection creation and updates",
  "Executor app card shows",
  "Executor installation shows",
  "Executor installs each",
  "A member's unlinked managed Executor key",
  "a configured product name and logo",
  "failed executor upgrades report a safe SQLSTATE",
  "^Reviewed catalog OAuth clients",
  "^Catalog OAuth grants",
  "^Hosted operator-client partial consent retains",
  "^account rows show retained usage and health",
  "^Apps check a shared account their own way and report its identity$",
  "^app-acquired account checks publish bounded status",
  "^pool seed upgrades add canonical native slots",
  "^native pool account links mirror current tokens only after hosted authorization",
  "^native pool settings keep",
  "^native sharing keeps existing",
  "^invitation roles cannot grant",
  "^organization admins who manage an app",
  "^An account check and agents' discovery report an app whose tools do not load",
  "^an open account row shows newly retained usage",
  "^the signed usage publish request refreshes native usage reports",
  "^Pool creation preserves retained pools",
  "^catalog instances keep every service family reachable",
  "^app model bindings delegate one pool",
  "^app model requests preserve refusals",
  "^native pool usage (renders|preserves)",
  "^Catalog OAuth deferrals",
];

function alternatives(pattern: string) {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (const [index, char] of [...pattern].entries()) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "|" && depth === 0) {
      result.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  return [...result, pattern.slice(start)];
}

const scenarioCommands = (job: { steps: { run?: string }[] }) =>
  job.steps.flatMap((step) => (step.run?.includes("--test-name") ? [step.run] : []));

test("account and pool jobs retain the entire unsplit behavior suite once", () => {
  const behavior = [accounts, pool].flatMap((job) => {
    const command = scenarioCommands(job).find(
      (run: string) =>
        run.includes("host-managed accounts are hidden") || run.includes("^pool seed upgrades"),
    );
    assert.ok(command);
    const match = command.match(/--test-name "(.+)" --workers 1/);
    assert.ok(match);
    return alternatives(match[1]!);
  });
  assert.deepEqual([...behavior].sort(), [...originalBehavior].sort());
  const remaining = [accounts, pool]
    .flatMap(scenarioCommands)
    .filter(
      (run) =>
        !run.includes("host-managed accounts are hidden") && !run.includes("^pool seed upgrades"),
    );
  assert.deepEqual(remaining, [
    'bun run e2e:self-host --test-name "^app query traces record ordered request phase durations$" --workers 1',
    'bun run e2e:self-host --test-name "^Service installs reuse one team app|^Quick-add MCP apps retain package names|^MCP quick add confirms public" --workers 1',
    "bun run e2e:self-host --test-name 'while the account is read' --workers 1",
    'bun run e2e:self-host --test-name "^poolUsageSeries is manager-only and preserves one bounded decimal usage read$" --workers 1',
  ]);
  assert.equal(
    accounts.steps.filter(
      (step: { run?: string }) =>
        step.run === "node --test scripts/pool-ui-tests/accounts-ready.test.mjs",
    ).length,
    1,
  );
});

test("both halves prepare independently, retain evidence and keep the 20-minute limit", () => {
  assert.deepEqual(accounts.steps.slice(0, 6), pool.steps.slice(0, 6));
  for (const [index, job] of [accounts, pool].entries()) {
    assert.equal(job.needs, "select");
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(job["timeout-minutes"], 20);
    assert.equal(job.if, `contains(fromJSON(needs.select.outputs.hosted_jobs), '${ids[index]}')`);
    assert.deepEqual(job.steps.at(-2), accounts.steps.at(-2));
    assert.equal(job.steps.at(-2).if, "always()");
    assert.equal(job.steps.at(-1).if, "always()");
    assert.equal(job.steps.at(-1).with.name, `${ids[index]}-self-host-e2e`);
  }
});

test("affected selection and aggregate require both account halves", () => {
  const selected = selectPaths([".upstream/e2e/tests/listed-account-actions.spec.ts"]).jobs;
  for (const id of ids) {
    assert.ok(selected.includes(id));
    assert.ok(workflow.jobs.check.needs.includes(id));
    const needs = Object.fromEntries(
      [...fastJobs, ...heavyJobs, ...bundleJobs].map((job) => [
        job,
        { result: bundleJobs.includes(job) ? "skipped" : "success" },
      ]),
    );
    assert.deepEqual(gateErrors(needs, heavyJobs, [], true), []);
    needs[id] = { result: "skipped" };
    assert.ok(gateErrors(needs, heavyJobs, [], true).some((error) => error.startsWith(id + ":")));
  }
});
