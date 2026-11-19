import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const directory = new URL("../.github/workflows/", import.meta.url);

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; environment?: unknown; secrets?: unknown; steps?: Step[] };
type Workflow = { on?: unknown; env?: unknown; jobs: Record<string, Job> };
type File = { name: string; workflow: Workflow };

const read = (name: string): Workflow => parse(readFileSync(new URL(name, directory), "utf8"));
const workflows: File[] = readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, workflow: read(name) }));

// A guard against regressions, not a boundary: a pull_request run takes its workflow from the pull
// request, so only secrets kept in a main-only environment are out of an unmerged branch's reach.

// Every secret a pull-request job may hold, named so the list can only shrink: release-update
// previews deploy the pull request's head with these until stages get credentials of their own.
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
    "PREVIEW_CLAUDE_AUTH_JSON",
    "PREVIEW_CODEX_CLI_AUTH_JSON",
    "PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON",
    "PREVIEW_SMOKE_EMAIL",
    "PREVIEW_SMOKE_PASSWORD",
    "PREVIEW_STATE_KEY",
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

/** The terms that must all hold for a condition to pass, split at top-level `&&`. */
function conjuncts(condition: string | undefined) {
  const expression = (condition ?? "").trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const terms: string[] = [];
  let depth = 0,
    quoted = false,
    start = 0;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (character === "'") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    const pair = expression.slice(index, index + 2);
    // A top-level disjunction can make any term optional, so it constrains nothing.
    if (depth === 0 && pair === "||") return [];
    if (depth === 0 && pair === "&&") {
      terms.push(expression.slice(start, index));
      start = index + 2;
    }
  }
  terms.push(expression.slice(start));
  return terms
    .map((term) => term.trim())
    .map((term) => (/^\((?:[^()]|\([^()]*\))*\)$/.test(term) ? term.slice(1, -1).trim() : term))
    .filter(Boolean);
}

/** A job can run on a pull request unless its condition requires another event. */
function reachableOnPullRequest(condition: string | undefined) {
  return !conjuncts(condition).some((term) => {
    const event = /^github\.event_name\s*==\s*'([a-z_]+)'$/.exec(term)?.[1];
    return event !== undefined && !event.startsWith("pull_request");
  });
}

const requiresMain = (condition: string | undefined) =>
  conjuncts(condition).includes("github.ref == 'refs/heads/main'");

// A workflow_run job confined to the repository's own pushes to main runs main's code even when it
// checks out the triggering run's head.
const confinedToMainPush = (condition: string | undefined) =>
  [
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ].every((term) => conjuncts(condition).includes(term));

// Every secret a job can read: named in it or its workflow's env, any form or case; all of them on
// indirect access; an environment's, which are invisible here, once it names one.
function secretsOf(workflow: Workflow, job: Job) {
  const text = JSON.stringify([workflow.env ?? null, job]);
  const named = [
    ...text.matchAll(/\bsecrets\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*'([^']+)'\s*\])/gi),
  ].map((match) => (match[1] ?? match[2]!).toUpperCase());
  const indirect =
    /toJSON\(\s*secrets\s*\)|\bsecrets\s*\[\s*[^'\s]/i.test(text) || job.secrets === "inherit";
  return [
    ...new Set([
      ...named,
      ...(indirect ? ["<every secret>"] : []),
      ...(job.environment === undefined ? [] : ["<environment secrets>"]),
    ]),
  ].sort();
}

const checksOutMain = (job: Job) =>
  (job.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/checkout"))
    .every((step) => ["main", "refs/heads/main"].includes(String(step.with?.ref)));

const readsPullRequestHead = (job: Job) =>
  /github\.(?:event\.pull_request\.head|head_ref|event\.workflow_run\.head)|refs\/pull\//.test(
    JSON.stringify(job.steps ?? []),
  );

const pushBranches = (on: unknown) => {
  const push = on && typeof on === "object" && "push" in on ? on.push : undefined;
  const branches = push && typeof push === "object" && "branches" in push ? push.branches : [];
  return Array.isArray(branches) ? branches.map(String) : [];
};

/** Violations in a set of workflows; the same rules run on the real files and on fixtures below. */
function violations(files: File[]) {
  const found: string[] = [];
  for (const { name, workflow } of files) {
    const on = events(workflow.on);
    const branches = pushBranches(workflow.on);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const key = `${name}/${id}`;
      const held = secretsOf(workflow, job);
      if (on.includes("pull_request") && reachableOnPullRequest(job.if)) {
        const allowed = knownExposure[key] ?? [];
        const extra = held.filter((secret) => !allowed.includes(secret));
        if (extra.length) found.push(`${key}: a pull request's code holds ${extra.join(", ")}`);
      }
      if (!held.length) continue;
      // These run the base branch's workflow with secrets, so they must run main's code.
      if (
        (on.includes("pull_request_target") || on.includes("workflow_run")) &&
        !confinedToMainPush(job.if) &&
        (!checksOutMain(job) || readsPullRequestHead(job))
      )
        found.push(`${key}: runs code other than main's with secrets`);
      const otherRefs =
        on.includes("workflow_dispatch") ||
        (on.includes("push") && !(branches.length === 1 && branches[0] === "main"));
      if (otherRefs && !requiresMain(job.if) && !checksOutMain(job))
        found.push(`${key}: holds secrets on a ref other than main`);
    }
  }
  return found;
}

test("no job runs code other than main's with a secret, beyond the named exposure", () => {
  assert.deepEqual(violations(workflows), []);
  const check = workflows.find(({ name }) => name === "ci.yml");
  assert.ok(check);
  for (const job of Object.values(check.workflow.jobs))
    assert.deepEqual(secretsOf(check.workflow, job), []);
  for (const [key, secrets] of Object.entries(knownExposure)) {
    const [name, id = ""] = key.split("/");
    const file = workflows.find((candidate) => candidate.name === name);
    const job = file?.workflow.jobs[id];
    assert.ok(file && job, `stale exposure ${key}`);
    assert.deepEqual(secretsOf(file.workflow, job), secrets, key);
  }
});

test("every way a pull-request job can reach a secret is caught", () => {
  const job = (extra: Partial<Job>): Job => ({ steps: [{ run: "true" }], ...extra });
  const pr = (jobs: Record<string, Job>, env?: unknown): File => ({
    name: "fixture.yml",
    workflow: { on: { pull_request: {} }, env, jobs },
  });
  const run = (text: string) => pr({ a: job({ steps: [{ run: text }] }) });
  const cases: [string, File][] = [
    ["operator key", run("${{ secrets.POOL_MANAGEMENT_KEY }}")],
    ["any other secret", run("${{ secrets.RELEASE_UPDATE_TOKEN }}")],
    ["lower case", run("${{ SECRETS.pool_deployment_key }}")],
    ["workflow env", pr({ a: job({}) }, { TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" })],
    ["toJSON", run("${{ toJSON(secrets) }}")],
    ["indexed by name", run("${{ secrets['POOL_DEPLOYMENT_KEY'] }}")],
    ["indexed by expression", run("${{ secrets[format('POOL_{0}', 'X')] }}")],
    ["inherited secrets", pr({ a: job({ secrets: "inherit" }) })],
    ["environment", pr({ a: job({ environment: "production-release" }) })],
    [
      "negated condition",
      pr({
        a: job({
          if: "!(github.event_name == 'push')",
          steps: [{ run: "${{ secrets.POOL_APP_SIGNING_KEY }}" }],
        }),
      }),
    ],
  ];
  for (const [label, fixture] of cases) assert.notDeepEqual(violations([fixture]), [], label);
  const otherEvent = pr({
    a: job({
      if: "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
      steps: [{ run: "${{ secrets.POOL_MANAGEMENT_KEY }}" }],
    }),
  });
  assert.deepEqual(violations([otherEvent]), []);
});

test("secrets beside a pull request's run or on another ref run only main's code", () => {
  const holding = (step: Step, extra: Partial<Job> = {}): Job => ({
    steps: [step, { run: "${{ secrets.CLOUDFLARE_API_TOKEN }}" }],
    ...extra,
  });
  const file = (on: unknown, job: Job): File => ({
    name: "fixture.yml",
    workflow: { on, jobs: { a: job } },
  });
  const main = { uses: "actions/checkout@v4", with: { ref: "main" } };
  const head = {
    uses: "actions/checkout@v4",
    with: { ref: "${{ github.event.workflow_run.head_sha }}" },
  };
  for (const on of [{ pull_request_target: {} }, { workflow_run: {} }]) {
    assert.deepEqual(violations([file(on, holding(main))]), []);
    for (const step of [
      { uses: "actions/checkout@v4" },
      { uses: "actions/checkout@v4", with: { ref: "${{ github.head_ref }}" } },
      { run: "git fetch origin refs/pull/1/head" },
    ])
      assert.notDeepEqual(violations([file(on, holding(step))]), [], JSON.stringify(step));
  }
  const mainPush = [
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ].join(" && ");
  assert.deepEqual(violations([file({ workflow_run: {} }, holding(head, { if: mainPush }))]), []);
  const branchOnly = holding(head, { if: "github.event.workflow_run.head_branch == 'main'" });
  assert.notDeepEqual(violations([file({ workflow_run: {} }, branchOnly)]), []);
  const dispatch = { workflow_dispatch: {} };
  const branch = { uses: "actions/checkout@v4" };
  assert.notDeepEqual(violations([file(dispatch, holding(branch))]), []);
  const onMain = holding(branch, { if: "github.ref == 'refs/heads/main'" });
  assert.deepEqual(violations([file(dispatch, onMain)]), []);
  const batches = { push: { branches: ["main", "batch/**"] } };
  assert.notDeepEqual(violations([file(batches, holding(branch))]), []);
  assert.deepEqual(violations([file({ push: { branches: ["main"] } }, holding(branch))]), []);
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
  assert.equal(reachableOnPullRequest("!(x && github.event_name == 'push')"), true);
  assert.equal(reachableOnPullRequest("${{ github.event_name == 'push' }}"), false);
  assert.equal(reachableOnPullRequest("github.event_name != 'push' && a"), true);
  assert.equal(
    reachableOnPullRequest("always() && !cancelled() && github.event_name == 'push' && (a || b)"),
    false,
  );
  assert.equal(reachableOnPullRequest("(github.event_name == 'push')"), false);
});
