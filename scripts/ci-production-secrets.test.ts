import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const directory = new URL("../.github/workflows/", import.meta.url);

type Step = {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  environment?: unknown;
  secrets?: unknown;
  steps?: Step[];
};
type Workflow = { on?: unknown; env?: unknown; defaults?: unknown; jobs: Record<string, Job> };
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

// The only jobs that hold secrets beside a pull request's run or after another run. Each runs main's
// code; any new one needs review before it joins this list.
const baseRunJobs = [
  "release-cleanup.yml/cleanup",
  "release-merge.yml/merge",
  // Its checkout is the candidate job's main commit, never a pull request's.
  "release.yml/release",
];

type Provider = { output: string; sha256: string };
// Jobs whose output a secret-holding job may check out as main's commit. The guard proves the job is
// confined to main on every path into it; that the commit it writes is main's lives in shell it can't
// read. So the whole job is pinned (its outputs, every step, defaults, runner): any change to it fails
// here until someone re-reviews it and re-pins.
const mainCommitProviders: Record<string, Provider> = {
  // A main push's head, or the newest passing main commit containing it; a dispatch from main, or a
  // named full commit that is an ancestor of main.
  "release.yml/candidate": {
    output: "sha",
    sha256: "3c7006be591b510dff6b5147d868897e5d79a0b78680c718ff74e02f0f23dc5b",
  },
};
// Events whose secret-holding jobs these rules understand; anything else holding secrets fails.
const knownEvents = [
  "push",
  "schedule",
  "workflow_dispatch",
  "workflow_run",
  "pull_request",
  "pull_request_target",
];

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

/** The alternatives of a condition, split at top-level `||`, each without its outer parentheses. */
function disjuncts(condition: string | undefined) {
  const expression = (condition ?? "").trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const parts: string[] = [];
  let depth = 0,
    quoted = false,
    start = 0;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (character === "'") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0 && expression.slice(index, index + 2) === "||") {
      parts.push(expression.slice(start, index));
      start = index + 2;
    }
  }
  parts.push(expression.slice(start));
  return parts
    .map((part) => part.trim())
    .map((part) => (/^\((?:[^()]|\([^()]*\))*\)$/.test(part) ? part.slice(1, -1).trim() : part));
}

// A workflow_run job confined to the repository's own pushes to main runs main's code even when it
// checks out the triggering run's head.
const confinedToMainPush = (condition: string | undefined) =>
  [
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ].every((term) => conjuncts(condition).includes(term));

// Every secret a job can read: named in an expression in it or its workflow's env, in any case or
// indexing; all of them on any other use of the secrets context; an environment's, which are
// invisible here, once it names one.
function secretsOf(workflow: Workflow, job: Job) {
  const text = JSON.stringify([workflow.env ?? null, job]);
  const expressions = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]!);
  const access = /\bsecrets\b\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*'([^']+)'\s*\])?/gi;
  const named: string[] = [];
  let indirect = job.secrets !== undefined;
  for (const expression of expressions)
    for (const match of expression.matchAll(access)) {
      const name = match[1] ?? match[2];
      if (name) named.push(name.toUpperCase());
      else indirect = true;
    }
  return [
    ...new Set([
      ...named,
      ...(indirect ? ["<every secret>"] : []),
      ...(job.environment === undefined ? [] : ["<environment secrets>"]),
    ]),
  ].sort();
}

// Every alternative must be main's: a dispatch, push or schedule that also requires main's ref, or
// another run that is this repository's push to main. Under workflow_run, github.ref is always the
// default branch, so the ref alone proves nothing there.
const confinedToMain = (condition: string | undefined) =>
  condition !== undefined &&
  disjuncts(condition).every((part) => {
    const terms = conjuncts(part);
    const onMain =
      terms.includes("github.ref == 'refs/heads/main'") &&
      ["workflow_dispatch", "push", "schedule"].some((event) =>
        terms.includes(`github.event_name == '${event}'`),
      );
    return onMain || confinedToMainPush(part);
  });

// The workflow's own defaults and env reach every step of the job, so they are part of its pin.
const jobHash = (workflow: Workflow, job: Job) =>
  createHash("sha256")
    .update(JSON.stringify([workflow.defaults ?? null, workflow.env ?? null, job]))
    .digest("hex");

/** Whether a checkout ref is a pinned provider's main commit, read straight from the job's needs. */
function providedMainCommit(
  name: string,
  workflow: Workflow,
  job: Job,
  index: number,
  providers: Record<string, Provider>,
) {
  // First, so no earlier step can rewrite its env (GITHUB_ENV) or the tools it runs (GITHUB_PATH).
  if (index !== 0) return false;
  const step = job.steps![index]!;
  let ref = String(step.with?.ref);
  const viaEnv = /^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(ref)?.[1];
  if (viaEnv) ref = String(step.env?.[viaEnv] ?? job.env?.[viaEnv]);
  const output = /^\$\{\{\s*needs\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/.exec(ref);
  if (!output) return false;
  const [, id = "", key = ""] = output;
  const needs = [job.needs ?? []].flat();
  const provider = providers[`${name}/${id}`];
  const source = workflow.jobs[id];
  return (
    needs.includes(id) &&
    provider?.output === key &&
    source?.outputs?.[key] !== undefined &&
    confinedToMain(source.if) &&
    jobHash(workflow, source) === provider.sha256
  );
}

const checksOutMain = (
  name: string,
  workflow: Workflow,
  job: Job,
  providers: Record<string, Provider> = mainCommitProviders,
) =>
  (job.steps ?? []).every(
    (step, index) =>
      // GitHub resolves action names in any case.
      !step.uses?.toLowerCase().startsWith("actions/checkout") ||
      // Another repository's main is not this one's.
      ([undefined, "${{ github.repository }}"].includes(step.with?.repository as string) &&
        (["main", "refs/heads/main"].includes(String(step.with?.ref)) ||
          providedMainCommit(name, workflow, job, index, providers))),
  );

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
function violations(files: File[], providers: Record<string, Provider> = mainCommitProviders) {
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
      const unknown = on.filter((event) => !knownEvents.includes(event));
      if (unknown.length) found.push(`${key}: holds secrets under ${unknown.join(", ")}`);
      // These run the base branch's workflow with secrets, so they must run main's code.
      if (on.includes("pull_request_target") || on.includes("workflow_run")) {
        if (!baseRunJobs.includes(key))
          found.push(`${key}: holds secrets beside another run without review`);
        else if (
          !confinedToMainPush(job.if) &&
          (!checksOutMain(name, workflow, job, providers) || readsPullRequestHead(job))
        )
          found.push(`${key}: runs code other than main's with secrets`);
      }
      const otherRefs =
        on.includes("workflow_dispatch") ||
        (on.includes("push") && !(branches.length === 1 && branches[0] === "main"));
      if (otherRefs && !requiresMain(job.if))
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
  for (const key of baseRunJobs) {
    const [name, id = ""] = key.split("/");
    assert.ok(workflows.find((file) => file.name === name)?.workflow.jobs[id], `stale ${key}`);
  }
  for (const [key, provider] of Object.entries(mainCommitProviders)) {
    const [name, id = ""] = key.split("/");
    const file = workflows.find((candidate) => candidate.name === name);
    const job = file?.workflow.jobs[id];
    assert.ok(file && job?.outputs?.[provider.output], `stale provider ${key}`);
    assert.equal(
      jobHash(file.workflow, job),
      provider.sha256,
      `${key}: re-review the job, then re-pin it`,
    );
  }
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
    ["toJSON with parentheses", run("${{ toJSON((secrets)) }}")],
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
  const event = (on: unknown): File => ({
    name: "fixture.yml",
    workflow: { on, jobs: { a: job({ steps: [{ run: "${{ secrets.POOL_DEPLOYMENT_KEY }}" }] }) } },
  });
  for (const on of [{ pull_request_review: {} }, { merge_group: {} }, { issue_comment: {} }])
    assert.notDeepEqual(violations([event(on)]), [], JSON.stringify(on));
});

test("secrets beside a pull request's run or on another ref run only main's code", () => {
  const holding = (step: Step, extra: Partial<Job> = {}): Job => ({
    steps: [step, { run: "${{ secrets.CLOUDFLARE_API_TOKEN }}" }],
    ...extra,
  });
  // Named as an allowed base-run job, so these fixtures test what such a job may do.
  const file = (on: unknown, job: Job): File => ({
    name: "release-cleanup.yml",
    workflow: { on, jobs: { cleanup: job } },
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
      { uses: "actions/checkout@v4", with: { ref: "${{ github.event.pull_request.head.sha }}" } },
      { uses: "actions/checkout@v4", with: { ref: "${{ github.event.workflow_run.head_sha }}" } },
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
  for (const dropped of mainPush.split(" && ")) {
    const partial = mainPush
      .split(" && ")
      .filter((term) => term !== dropped)
      .join(" && ");
    assert.notDeepEqual(
      violations([file({ workflow_run: {} }, holding(head, { if: partial }))]),
      [],
      dropped,
    );
  }
  const unreviewed: File = {
    name: "fixture.yml",
    workflow: { on: { workflow_run: {} }, jobs: { a: holding(main) } },
  };
  assert.notDeepEqual(violations([unreviewed]), []);
  const branchOnly = holding(head, { if: "github.event.workflow_run.head_branch == 'main'" });
  assert.notDeepEqual(violations([file({ workflow_run: {} }, branchOnly)]), []);
  const dispatch = { workflow_dispatch: {} };
  const branch = { uses: "actions/checkout@v4" };
  assert.notDeepEqual(violations([file(dispatch, holding(branch))]), []);
  // Checking out main is not enough: a later step can still run the dispatching ref's code.
  assert.notDeepEqual(violations([file(dispatch, holding(main))]), []);
  assert.notDeepEqual(violations([file(dispatch, { steps: [{ run: "${{ secrets.X }}" }] })]), []);
  const onMain = holding(branch, { if: "github.ref == 'refs/heads/main'" });
  assert.deepEqual(violations([file(dispatch, onMain)]), []);
  const batches = { push: { branches: ["main", "batch/**"] } };
  assert.notDeepEqual(violations([file(batches, holding(branch))]), []);
  assert.deepEqual(violations([file({ push: { branches: ["main"] } }, holding(branch))]), []);
});

test("a secret-holding job may check out a pinned provider's main commit, and nothing else", () => {
  const pick: Step = {
    id: "pick",
    run: 'git merge-base --is-ancestor "$INPUT" "$HEAD" && echo "sha=$INPUT" >> "$GITHUB_OUTPUT"',
  };
  const dispatchFromMain =
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";
  const mainPush = [
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ].join(" && ");
  const candidate: Job = {
    if: `(${dispatchFromMain}) || (${mainPush})`,
    outputs: { sha: "${{ steps.pick.outputs.sha }}" },
    steps: [pick],
  };
  const pinned = {
    "release.yml/candidate": { output: "sha", sha256: jobHash({ jobs: {} }, candidate) },
  };
  const checkout = (ref: string, extra: Record<string, unknown> = {}): Step => ({
    uses: "actions/checkout@v4",
    with: { ref, ...extra },
  });
  const secret: Step = { run: "${{ secrets.CLOUDFLARE_API_TOKEN }}" };
  const fixture = (
    release: Partial<Job>,
    provider: Partial<Job> = {},
    ref = "${{ env.CANDIDATE }}",
  ): File => ({
    name: "release.yml",
    workflow: {
      on: { workflow_run: {}, workflow_dispatch: {} },
      jobs: {
        candidate: { ...candidate, ...provider },
        release: {
          needs: "candidate",
          if: "github.ref == 'refs/heads/main' && needs.candidate.outputs.release == 'true'",
          env: { CANDIDATE: "${{ needs.candidate.outputs.sha }}" },
          environment: { name: "production-release", deployment: false },
          steps: [checkout(ref), secret],
          ...release,
        },
      },
    },
  });
  const workflowWide = (extra: Partial<Workflow>): File => {
    const file = fixture({});
    return { ...file, workflow: { ...file.workflow, ...extra } };
  };
  // Pinned to whatever the fixture's provider job is, so only the rule under test can refuse it.
  const pinnedTo = (file: File) => ({
    "release.yml/candidate": {
      output: "sha",
      sha256: jobHash(file.workflow, file.workflow.jobs.candidate!),
    },
  });
  // The release path as it is: the candidate job's main commit, through the job's env or directly.
  assert.deepEqual(violations([fixture({})], pinned), []);
  assert.deepEqual(violations([fixture({}, {}, "${{ needs.candidate.outputs.sha }}")], pinned), []);
  const head = "${{ github.event.pull_request.head.sha }}";
  const refused: [string, File, "pinned" | "matching" | "none"][] = [
    ["a pull request's head", fixture({}, {}, head), "pinned"],
    ["a pull request's merge ref", fixture({}, {}, "refs/pull/1/merge"), "pinned"],
    [
      "the triggering run's head",
      fixture({}, {}, "${{ github.event.workflow_run.head_sha }}"),
      "pinned",
    ],
    ["the head ref", fixture({}, {}, "${{ github.head_ref }}"), "pinned"],
    // A job that writes a sha but proves nothing about main.
    ["an unpinned job's output", fixture({}), "none"],
    // The pin covers the whole job: what it exports, every step and the shell they run in.
    [
      "a changed provider step",
      fixture({}, { steps: [{ ...pick, run: 'echo "sha=$INPUT"' }] }),
      "pinned",
    ],
    [
      "an output that skips the proof",
      fixture({}, { outputs: { sha: "${{ inputs.candidate || steps.pick.outputs.sha }}" } }),
      "pinned",
    ],
    [
      "a step before the proof",
      fixture({}, { steps: [{ run: 'echo "$RUNNER_TEMP/fake" >> "$GITHUB_PATH"' }, pick] }),
      "pinned",
    ],
    [
      "another shell",
      fixture({}, { defaults: { run: { shell: "python {0}" } } } as Partial<Job>),
      "pinned",
    ],
    [
      "an output the job doesn't export",
      fixture({}, { outputs: {} }),
      "matching",
    ],
    [
      "another output",
      fixture(
        { env: { CANDIDATE: "${{ needs.candidate.outputs.ref }}" } },
        { outputs: { sha: "${{ steps.pick.outputs.sha }}", ref: "${{ steps.pick.outputs.sha }}" } },
      ),
      "matching",
    ],
    ["a job it doesn't need", fixture({ needs: [] }), "pinned"],
    // Each confinement case is pinned to its own provider job, so only the condition refuses it.
    [
      "a provider on any branch",
      fixture({}, { if: "github.event_name == 'workflow_dispatch'" }),
      "matching",
    ],
    [
      "a provider after any run",
      fixture({}, { if: `${dispatchFromMain} || github.ref == 'refs/heads/main'` }),
      "matching",
    ],
    ["a provider with no condition", fixture({}, { if: undefined }), "matching"],
    [
      "a provider after a branch's run",
      fixture(
        {},
        { if: `(${dispatchFromMain}) || (github.event.workflow_run.head_branch == 'main')` },
      ),
      "matching",
    ],
    [
      "an env rewritten before the checkout",
      fixture({
        steps: [
          { run: 'echo "CANDIDATE=$PR" >> "$GITHUB_ENV"' },
          checkout("${{ env.CANDIDATE }}"),
          secret,
        ],
      }),
      "pinned",
    ],
    [
      "any step before the checkout",
      fixture({ steps: [{ run: "true" }, checkout("${{ needs.candidate.outputs.sha }}"), secret] }),
      "pinned",
    ],
    [
      "a step env over the job's",
      fixture({
        steps: [
          { ...checkout("${{ env.CANDIDATE }}"), env: { CANDIDATE: "${{ inputs.candidate }}" } },
          secret,
        ],
      }),
      "pinned",
    ],
    [
      "another repository",
      fixture({
        steps: [checkout("${{ env.CANDIDATE }}", { repository: "someone/fork" }), secret],
      }),
      "pinned",
    ],
    ["a workflow-level shell", workflowWide({ defaults: { run: { shell: "python {0}" } } }), "pinned"],
    ["a workflow-level env", workflowWide({ env: { BASH_ENV: "./fake-env.sh" } }), "pinned"],
    [
      "a second checkout in another case",
      fixture({
        steps: [
          checkout("${{ env.CANDIDATE }}"),
          { uses: "Actions/Checkout@v4", with: { ref: "${{ inputs.candidate }}" } },
          secret,
        ],
      }),
      "pinned",
    ],
    [
      "a release without main's ref on dispatch",
      fixture({ if: "needs.candidate.outputs.release == 'true'" }),
      "pinned",
    ],
  ];
  for (const [label, file, pin] of refused) {
    const providers = pin === "pinned" ? pinned : pin === "matching" ? pinnedTo(file) : {};
    assert.notDeepEqual(violations([file], providers), [], label);
  }
  // Another repository is refused for a literal main checkout too.
  const literal: File = {
    name: "release-cleanup.yml",
    workflow: {
      on: { workflow_run: {} },
      jobs: { cleanup: { steps: [checkout("main", { repository: "someone/fork" }), secret] } },
    },
  };
  assert.notDeepEqual(violations([literal]), []);
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
  assert.equal(reachableOnPullRequest("github.event_name == 'push' && a || b"), true);
  // An operator inside a quoted string is text, not logic.
  assert.equal(reachableOnPullRequest("github.event_name == 'push' && a == '||'"), false);
});
