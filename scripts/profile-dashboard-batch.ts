import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const runs = join(upstream, ".local/e2e");
const output = join(process.env.RUNNER_TEMP ?? tmpdir(), "dashboard-batch-profile");
const patch = join(root, "patches/0035-dashboard-batch-authentication.patch");
const scenario = "A dashboard batch checks its session and each membership once";

interface Profile {
  reads: number;
  samples: number;
  p50Ms: number;
  p90Ms: number;
  firstChecks: { sessions: number; organizations: number; memberships: number; removals: number };
  lastChecks: { sessions: number; organizations: number; memberships: number; removals: number };
}

const apply = (reverse: boolean) => {
  const result = spawnSync("git", [
    "apply", ...(reverse ? ["--reverse"] : []),
    "--include=apps/hosted/server/src/implementation/*", patch,
  ], { cwd: upstream, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Could not switch the dashboard batch implementation");
};

const directories = () => {
  try { return readdirSync(runs); } catch { return []; }
};
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);

const measure = (label: "before" | "after") => {
  const previous = new Set(directories());
  const result = spawnSync("bun", [
    "run", "e2e:self-host", "--test-name", scenario, "--workers", "1",
  ], { cwd: upstream, stdio: "inherit" });
  if (result.error) throw result.error;
  const created = directories().filter(directory => !previous.has(directory));
  if (created.length !== 1) throw new Error(`Expected one ${label} E2E run`);
  const report = files(join(runs, created[0]!, "self-host", "report"));
  const profiles = report.filter(file => file.endsWith("/batch-profile.json"));
  const results = report.filter(file => file.endsWith("/diagnostics/results.json"));
  for (const file of report.filter(file => file.endsWith("/batch-trace-counts.json")))
    copyFileSync(file, join(output, `${label}-trace-counts.json`));
  if (profiles.length !== 1 || results.length !== 1) throw new Error(`Missing ${label} E2E evidence`);
  const profile: Profile = JSON.parse(readFileSync(profiles[0]!, "utf8"));
  const tests: { testResults: { assertionResults: {
    title: string; status: string; failureMessages: string[];
  }[] }[] } = JSON.parse(readFileSync(results[0]!, "utf8"));
  copyFileSync(profiles[0]!, join(output, `${label}.json`));
  const cases = tests.testResults.flatMap(file => file.assertionResults)
    .filter(test => test.status !== "pending");
  if (cases.length !== 1 || !cases[0]!.title.startsWith(scenario))
    throw new Error(`The ${label} run did not execute the selected scenario`);
  const test = cases[0]!;
  const expected = {
    sessions: label === "before" ? 8 : 1,
    organizations: 0,
    memberships: label === "before" ? 7 : 1,
    removals: 0,
  };
  if (profile.reads !== 8 || profile.samples !== 30 ||
      JSON.stringify(profile.firstChecks) !== JSON.stringify(expected) ||
      JSON.stringify(profile.lastChecks) !== JSON.stringify(expected))
    throw new Error(`Unexpected ${label} authentication counts`);
  if (label === "before") {
    if (result.status === 0 || test.status !== "failed" ||
        !test.failureMessages.some(message => message.includes("Dashboard batch authentication budget")))
      throw new Error("The baseline must fail the authentication budget assertion");
  } else if (result.status !== 0 || test.status !== "passed") {
    throw new Error("The candidate must pass the complete scenario and its cleanup");
  }
  writeFileSync(join(output, `${label}-result.json`), JSON.stringify({
    scenario: test.title,
    status: test.status,
    expectedBudgetFailure: label === "before",
  }, null, 2));
  return profile;
};

if (process.env.CI !== "true") throw new Error("Run this profile in CI with an isolated prepared upstream checkout");
mkdirSync(output, { recursive: true });
let before: Profile;
apply(true);
try { before = measure("before"); }
finally { apply(false); }
const after = measure("after");
const summary = {
  database: "PGlite",
  samplesPerCandidate: 30,
  readsPerBatch: 8,
  before,
  after,
};
writeFileSync(join(output, "comparison.json"), JSON.stringify(summary, null, 2));
const markdown = `## Dashboard batch profile

Same runner, same eight reads, separate fresh self-host servers. PGlite wall times do not predict production Postgres latency.

| Measurement | Before | After |
| --- | ---: | ---: |
| Warm p50 | ${before.p50Ms} ms | ${after.p50Ms} ms |
| Warm p90 | ${before.p90Ms} ms | ${after.p90Ms} ms |
| Session checks per batch | ${before.firstChecks.sessions} | ${after.firstChecks.sessions} |
| Membership checks per batch | ${before.firstChecks.memberships} | ${after.firstChecks.memberships} |

The baseline failed the authentication budget assertion. The candidate passed the full scenario, including organization aliases, a denied organization, another caller, a removed member and a revoked session. Self-host does not emit organization-resolution SQL spans or read removal tombstones; the scenario counts those on Cloud.
`;
writeFileSync(join(output, "comparison.md"), markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
