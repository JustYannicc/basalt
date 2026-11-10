import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { heavyJobs } from "./ci/areas.ts";
import { fastJobs } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const gate = fileURLToPath(new URL("./ci/gate.ts", import.meta.url));

const runGate = (
  needs: Record<string, { result: string }>,
  selected: readonly string[],
  full: boolean,
  baseline: boolean,
) =>
  spawnSync(process.execPath, [gate], {
    encoding: "utf8",
    env: {
      ...process.env,
      CI_NEEDS: JSON.stringify(needs),
      CI_JOBS: JSON.stringify(selected),
      CI_BOAT_JOBS: "[]",
      CI_FULL_SUITE: String(full),
      CI_BASELINE_PROBE: String(baseline),
    },
  });

test("the real workflow dependencies reach the aggregate CLI in fast and full lanes", () => {
  const step = workflow.jobs.check.steps.find(
    (step: { run?: string }) => step.run === "node scripts/ci/gate.ts",
  );
  assert.equal(step.env.CI_NEEDS, "${{ toJSON(needs) }}");
  assert.equal(workflow.jobs.check.if, "always()");
  assert.deepEqual(workflow.jobs["upstream-image"].needs, ["select", "workerd-assets"]);
  assert.equal(
    workflow.jobs["workerd-assets"].if,
    "contains(fromJSON(needs.select.outputs.jobs), 'upstream-image')",
  );
  for (const full of [false, true]) {
    const selected = full ? heavyJobs : [];
    for (const baseline of [false, true]) {
      const needs = Object.fromEntries(
        workflow.jobs.check.needs.map((job: string) => [
          job,
          {
            result:
              fastJobs.includes(job) ||
              selected.includes(job) ||
              (job === "baseline-probe" && baseline) ||
              (job === "workerd-assets" && selected.includes("upstream-image"))
                ? "success"
                : "skipped",
          },
        ]),
      );
      const valid = runGate(needs, selected, full, baseline);
      assert.equal(valid.status, 0, valid.stderr);
      for (const result of full
        ? ["failure", "cancelled", "skipped"]
        : ["success", "failure", "cancelled"]) {
        const refused = runGate(
          { ...needs, "workerd-assets": { result } },
          selected,
          full,
          baseline,
        );
        assert.notEqual(refused.status, 0);
        assert.match(
          refused.stderr,
          new RegExp(`workerd-assets: expected ${full ? "success" : "skipped"}, got ${result}`),
        );
      }
      const missing = { ...needs };
      delete missing["workerd-assets"];
      const refused = runGate(missing, selected, full, baseline);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Aggregate gate dependencies differ/);
      assert.match(refused.stderr, /workerd-assets: expected (?:success|skipped), got missing/);
    }
  }
});
