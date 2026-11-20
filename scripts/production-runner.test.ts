import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))(
  "yaml",
) as { parse: (text: string) => unknown };
const workflows = new URL("../.github/workflows/", import.meta.url);
const releaseRunner = "${{ vars.BASALT_RELEASE_RUNNER || 'ubuntu-latest' }}";

interface Job {
  readonly "runs-on"?: unknown;
  readonly environment?: string | { readonly name?: string };
  readonly steps?: ReadonlyArray<{ readonly uses?: string }>;
}

const environmentOf = (job: Job) =>
  typeof job.environment === "string" ? job.environment : job.environment?.name;

// CI can hold every hosted runner for an hour; a release, rollback, restart or observe run must
// not wait behind it. Every job of a workflow that acts in the production environment takes the
// release runner (hosted while the variable is unset) and installs tools with the repository's
// pinned installers, which also run there.
test("production operations take the release runner, never the queue CI fills", () => {
  const checked: string[] = [];
  for (const file of readdirSync(workflows)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()) {
    const workflow = parse(readFileSync(new URL(file, workflows), "utf8")) as {
      jobs?: Record<string, Job>;
    };
    const jobs = Object.entries(workflow.jobs ?? {});
    if (!jobs.some(([, job]) => environmentOf(job) === "production-release")) continue;
    for (const [id, job] of jobs) {
      assert.equal(job["runs-on"], releaseRunner, `${file} job ${id}`);
      for (const step of job.steps ?? [])
        assert.doesNotMatch(
          step.uses ?? "",
          /^(?:actions\/setup-node|oven-sh\/setup-bun)@/u,
          `${file} job ${id}`,
        );
    }
    checked.push(file);
  }
  for (const operation of ["pool-crash-operator.yml", "pool-runtime-recovery.yml"])
    assert.ok(checked.includes(operation), `${operation} is no longer recognised as production`);
});
