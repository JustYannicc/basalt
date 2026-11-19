import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const directory = new URL("../.github/workflows/", import.meta.url);

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; steps?: Step[] };
type Workflow = { on?: unknown; jobs: Record<string, Job> };

const workflows = readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => {
    const text = readFileSync(new URL(name, directory), "utf8");
    return { name, workflow: parse(text) as Workflow, text };
  });

// The same envelope key that signs read-only operator calls also authorizes every writing operator
// command, so a job that holds one of these can crash or fence production's runtime.
const operatorKeys = [
  "POOL_APP_SIGNING_KEY",
  "POOL_APP_SIGNING_KEY_PREVIOUS",
  "POOL_MANAGEMENT_KEY",
  "POOL_DEPLOYMENT_KEY",
  "POOL_ACCEPTANCE_KEY",
];
// Every other credential that addresses production or decrypts its data.
const productionSecrets = [
  ...operatorKeys,
  "APP_DOMAIN_CONTROLLER_TOKEN",
  "APP_DOMAIN_CONTROL_SECRET",
  "AUTH_GITHUB_CLIENT_ID",
  "AUTH_GITHUB_CLIENT_SECRET",
  "BASALT_RESTORE_PREPARATION_PROBE_INPUT",
  "BETTER_AUTH_SECRET",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "EXECUTOR_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_MAPS_ROUTES_API_KEY",
  "MCP_SESSION_KEY_CURRENT",
  "MCP_SESSION_KEY_PREVIOUS",
  "PLANETSCALE_API_TOKEN",
  "PLANETSCALE_API_TOKEN_ID",
  "PLANETSCALE_ORGANIZATION",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_KEY",
  "SENTRY_DSN",
  "SENTRY_OTLP_ENDPOINT",
];
const isProduction = (name: string) =>
  productionSecrets.includes(name) || name.startsWith("EXECUTOR_OAUTH_");

// Known exposure, named so it can only shrink: release-update previews deploy the pull request's
// head with the account tokens until stages get credentials of their own.
const knownExposure: Record<string, string[]> = {
  "release-preview.yml/preview": [
    "AUTH_GITHUB_CLIENT_ID",
    "AUTH_GITHUB_CLIENT_SECRET",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "PLANETSCALE_API_TOKEN",
    "PLANETSCALE_API_TOKEN_ID",
    "PLANETSCALE_ORGANIZATION",
  ],
};

const events = (on: unknown) =>
  typeof on === "string"
    ? [on]
    : Array.isArray(on)
      ? on.map(String)
      : on && typeof on === "object"
        ? Object.keys(on)
        : [];

/** A job can run on a pull request unless every reading of its condition requires another event. */
export function reachableOnPullRequest(condition: string | undefined) {
  if (!condition) return true;
  const expression = condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  if (expression.includes("||")) return true;
  return !expression
    .split("&&")
    .map((term) => term.trim().replace(/^\(+|\)+$/g, ""))
    .some((term) => {
      const event = /^github\.event_name\s*==\s*'([a-z_]+)'$/.exec(term)?.[1];
      return event !== undefined && !event.startsWith("pull_request");
    });
}

const secretsOf = (job: Job) => [
  ...new Set([...JSON.stringify(job).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]!)),
];

const pullRequestJobs = () =>
  workflows.flatMap(({ name, workflow }) =>
    events(workflow.on).some((event) => event.startsWith("pull_request"))
      ? Object.entries(workflow.jobs)
          .filter(([, job]) => reachableOnPullRequest(job.if))
          .map(([id, job]) => ({ key: `${name}/${id}`, name, job, on: events(workflow.on) }))
      : [],
  );

test("Check, which runs every pull request's code, references no secret at all", () => {
  const check = workflows.find(({ name }) => name === "ci.yml");
  assert.ok(check);
  assert.doesNotMatch(check.text, /secrets\./);
});

test("no job a pull request can start holds a production operator key", () => {
  const jobs = pullRequestJobs();
  assert.ok(jobs.some(({ key }) => key === "ci.yml/fast"));
  for (const { key, job } of jobs)
    for (const secret of secretsOf(job))
      assert.ok(!operatorKeys.includes(secret), `${key} references ${secret}`);
});

// pull_request_target runs the base branch's workflow; the next test keeps its code main's.
test("no job that runs a pull request's code holds another production secret beyond the named exposure", () => {
  for (const { key, job, on } of pullRequestJobs()) {
    if (!on.includes("pull_request")) continue;
    const held = secretsOf(job).filter(isProduction).sort();
    assert.deepEqual(held, knownExposure[key] ?? [], key);
  }
  const seen = new Set(pullRequestJobs().map(({ key }) => key));
  for (const key of Object.keys(knownExposure)) assert.ok(seen.has(key), `stale exposure ${key}`);
});

test("a pull_request_target job holding secrets runs only main's code", () => {
  for (const { key, job, on } of pullRequestJobs()) {
    if (!on.includes("pull_request_target") || !secretsOf(job).length) continue;
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout")) assert.equal(step.with?.ref, "main", key);
      assert.doesNotMatch(JSON.stringify(step), /github\.event\.pull_request\.head/, key);
    }
  }
});

test("only a condition that requires another event keeps a job off pull requests", () => {
  assert.equal(reachableOnPullRequest(undefined), true);
  assert.equal(reachableOnPullRequest("always()"), true);
  assert.equal(reachableOnPullRequest("github.event_name == 'pull_request'"), true);
  assert.equal(
    reachableOnPullRequest(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    ),
    false,
  );
  assert.equal(
    reachableOnPullRequest("github.event_name == 'push' || github.event_name == 'pull_request'"),
    true,
  );
  assert.equal(reachableOnPullRequest("${{ github.event_name == 'push' }}"), false);
});
