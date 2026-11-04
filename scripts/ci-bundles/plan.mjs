import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../architecture/package.json", import.meta.url));
const { parse } = require("yaml");

// Successful hosted verification times from Check 41709146925, attempt 1.
const measuredSeconds = {
  "account-acquisition": 450, "compiler-diagnostics": 163,
  "contributed-accounts": 419, "host-managed-accounts": 671,
  "oauth-account-regressions": 242, "pool-account-recovery": 201,
  "production-ops": 506, "production-ops-migrations": 264,
  "production-ops-identity-physical": 127, "production-ops-identity-credentials": 168,
  "production-ops-identity-diagnostics": 110, "production-ops-identity-without-server": 164,
  "production-ops-identity-release": 195, "production-ops-identity-host": 170,
  "production-ops-identity-database": 195, "production-ops-identity-role": 171,
};

export const eligibleJobs = (workflow) => Object.keys(workflow.jobs).filter(
  (id) => Object.hasOwn(measuredSeconds, id) || id === "production-ops-identity",
);

export function partitionSuites(suites) {
  const slots = Array.from({ length: 6 }, (_, index) => ({ shard: Math.floor(index / 2) + 1, seconds: 0, suites: [] }));
  for (const suite of [...suites].sort((a, b) => measuredSeconds[b.key] - measuredSeconds[a.key] || a.key.localeCompare(b.key))) {
    assert.ok(Object.hasOwn(measuredSeconds, suite.key), `No measured schedule for ${suite.key}`);
    const slot = slots.reduce((best, current) => current.seconds < best.seconds ? current : best);
    slot.suites.push(suite);
    // Copy/evidence overhead is charged even for short verification commands.
    slot.seconds += measuredSeconds[suite.key] + 120;
  }
  return [1, 2, 3].map((shard) => slots.filter((slot) => slot.shard === shard).flatMap((slot) => slot.suites)
    .sort((a, b) => measuredSeconds[b.key] - measuredSeconds[a.key] || a.key.localeCompare(b.key)));
}

export function selectedJobs(text, workflow) {
  const ids = [...new Set(text.toLowerCase().split(",").filter(Boolean))];
  for (const id of ids) assert.ok(eligibleJobs(workflow).includes(id), `Unknown Boat job: ${id}`);
  return ids;
}

export function interpolate(value, context) {
  return String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    if (expression === "runner.temp") return context.temp;
    if (expression.startsWith("matrix.")) {
      const key = expression.slice(7);
      assert.ok(Object.hasOwn(context.matrix, key), `Missing matrix value: ${key}`);
      return context.matrix[key];
    }
    if (expression.startsWith("env.")) {
      const key = expression.slice(4);
      assert.ok(Object.hasOwn(context.env, key), `Missing workflow environment: ${key}`);
      return context.env[key];
    }
    if (["github.event.pull_request.base.sha || github.event.before",
      "github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before"].includes(expression)) {
      assert.match(context.baseSha, /^[a-f0-9]{40}$/);
      return context.baseSha;
    }
    throw new Error(`Unsupported bundle expression: ${expression}`);
  });
}

const sharedPreparation = (step) => step.run === "npm run prepare:upstream" ||
  (step["working-directory"] === ".upstream" &&
    ["bun run e2e:prepare", "bunx playwright install --with-deps chromium"].includes(step.run));

export function suitePlan(workflow, ids) {
  return ids.flatMap((id) => {
    const job = workflow.jobs[id];
    // Only Linux packaging moves; the Windows row stays on its original runner.
    const rows = id === "client-desktop" ? [{ os: "ubuntu-latest", platform: "linux" }]
      : job.strategy?.matrix?.include ?? [{}];
    return rows.map((matrix) => {
      const key = matrix.scope ? `${id}-${matrix.scope}` : id;
      const setup = job.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
      assert.ok(setup, `${id}: missing pinned Bun setup`);
      const bun = interpolate(setup.with["bun-version"], { env: workflow.env, matrix });
      assert.ok(["1.4.2", "1.4.4"].includes(bun), `${id}: unsupported Bun version ${bun}`);
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses,
          /^(actions\/(checkout|setup-node|upload-artifact)|oven-sh\/setup-bun)@/);
        if (step.run) assert.equal(step.if, undefined, `${id}: conditional run steps need explicit support`);
      }
      return {
        id, key, matrix, bun, timeoutMs: job["timeout-minutes"] * 60_000,
        env: { ...workflow.env, ...job.env },
        steps: job.steps.filter((step) => step.run && !sharedPreparation(step)),
        artifacts: job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
          .map((step) => step.with),
      };
    });
  });
}

export function readWorkflow(root) {
  const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  assert.ok(workflow?.jobs && workflow.env?.E2E_BUN_VERSION === "1.4.2");
  return workflow;
}
