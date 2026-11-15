import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredSecrets } from "../environment.ts";
import { passedMainPushCheck, validateMainCandidate } from "../release-merge/main-candidate.ts";
import { test } from "node:test";
import { BarrierRefusal } from "./refusal.ts";
import {
  candidateEligibilityRefusal,
  checkedActivationClient,
  exactMigrationRelease,
  migrationActivationGate,
  migrationActivationInput,
  trustedActivationTooling,
} from "./migration-activation-gate.ts";

const environment = {
  BASALT_RELEASE_CANDIDATE: "a".repeat(40),
  MIGRATION_ACTIVATION_MODE: "plan",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "synthetic/basalt",
  GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/release-main.yml@refs/heads/main",
};

test("the trusted activation gate imports before package dependencies are installed", () => {
  const gate = new URL("./migration-activation-gate.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { isBuiltin, registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isBuiltin(specifier) && !/^(?:\\.|\\/|file:)/u.test(specifier))
      throw new Error("Activation gate requires an uninstalled package: " + specifier);
    return nextResolve(specifier, context);
  }
});
await import(${JSON.stringify(gate)});`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("a successful containing release cannot substitute for the exact recorded candidate", () => {
  const candidate = environment.BASALT_RELEASE_CANDIDATE;
  assert.equal(
    exactMigrationRelease(candidate, { state: "ready", gitCommit: candidate, deploymentId: 42 }),
    42,
  );
  for (const ledger of [
    { state: "uninitialized" as const },
    { state: "unresolved" as const, gitCommit: candidate, deploymentId: 42 },
    { state: "ready" as const, gitCommit: "b".repeat(40), deploymentId: 43 },
    { state: "ready" as const, gitCommit: candidate, deploymentId: 0 },
  ])
    assert.throws(() => exactMigrationRelease(candidate, ledger), /wrong-production-candidate/);
});

test("only exact candidate plan, digest and inspect inputs enter the trusted activation job", () => {
  for (const mode of ["plan", "inspect", "b".repeat(64)])
    assert.deepEqual(
      migrationActivationInput({ ...environment, MIGRATION_ACTIVATION_MODE: mode }),
      {
        candidate: environment.BASALT_RELEASE_CANDIDATE,
        mode,
      },
    );
  for (const mode of ["", "apply", "Plan", "b".repeat(63), " b".repeat(32)])
    assert.throws(
      () => migrationActivationInput({ ...environment, MIGRATION_ACTIVATION_MODE: mode }),
      /mode-invalid/,
    );
  for (const candidate of ["", "main", "a".repeat(39), "a".repeat(40) + "\n"])
    assert.throws(
      () => migrationActivationInput({ ...environment, BASALT_RELEASE_CANDIDATE: candidate }),
      /candidate-required/,
    );
});

test("activation refuses PR, non-main and different workflow contexts before connecting", () => {
  // Read-only modes get no exemption: a plan from a topic branch would run unreviewed code.
  for (const mode of ["plan", "inspect", "b".repeat(64)])
    for (const changed of [
      { GITHUB_ACTIONS: "false" },
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REF: "refs/heads/topic" },
      { GITHUB_REF: "refs/tags/main" },
      { GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/other.yml@refs/heads/main" },
      {
        GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/release-main.yml@refs/heads/topic",
      },
    ])
      assert.throws(
        () =>
          migrationActivationInput({
            ...environment,
            MIGRATION_ACTIVATION_MODE: mode,
            ...changed,
          }),
        /trusted-workflow/,
      );
  assert.throws(
    () =>
      migrationActivationInput({ ...environment, BASALT_HOME_SCHEMA_RETRY_INTENT: "other-intent" }),
    /conflicting-input/,
  );
});

test("the client that touches production is the dispatched main commit", () => {
  const dispatched = "c".repeat(40);
  assert.equal(trustedActivationTooling({ GITHUB_SHA: dispatched }, dispatched), dispatched);
  for (const [source, head] of [
    [{ GITHUB_SHA: dispatched }, environment.BASALT_RELEASE_CANDIDATE],
    [{ GITHUB_SHA: dispatched }, ""],
    [{}, dispatched],
    [{ GITHUB_SHA: "main" }, "main"],
  ] as const)
    assert.throws(
      () => trustedActivationTooling(source, head),
      (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.equal(error.reason, "migration-activation-trusted-tooling-required");
        assert.deepEqual(error.delta?.changed, [
          { path: "HEAD", old: source.GITHUB_SHA ?? "unavailable", new: head },
        ]);
        return true;
      },
    );
});

test("only a client whose main push Check passed may send an activation", async () => {
  const client = "c".repeat(40);
  const digest = "b".repeat(64);
  const run = (run: Record<string, unknown>) => ({
    head_sha: client,
    event: "push",
    path: ".github/workflows/ci.yml",
    ...run,
  });
  // GitHub's answer for this commit's completed push Checks on main, as the real reader asks.
  const checks = (runs: readonly unknown[]) => {
    const urls: string[] = [];
    return {
      urls,
      passed: (commit: string) =>
        passedMainPushCheck("synthetic/basalt", "fixture", commit, async (url) => {
          urls.push(url);
          return Response.json({ workflow_runs: runs });
        }),
    };
  };
  for (const [state, runs] of [
    ["still running, so nothing completed", []],
    ["failed", [run({ conclusion: "failure" })]],
    ["cancelled", [run({ conclusion: "cancelled" })]],
    ["passed on another commit", [run({ conclusion: "success", head_sha: "d".repeat(40) })]],
    ["passed as a pull request Check", [run({ conclusion: "success", event: "pull_request" })]],
    [
      "passed in another workflow",
      [run({ conclusion: "success", path: ".github/workflows/x.yml" })],
    ],
  ] as const) {
    const github = checks(runs);
    await assert.rejects(
      checkedActivationClient(digest, client, github.passed),
      (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal, state);
        assert.equal(error.reason, "migration-activation-client-check-required");
        assert.deepEqual(error.delta?.changed, [
          { path: "pushCheck", old: "success", new: "not successful" },
        ]);
        assert.ok(error.delta?.why?.includes(`client=${client}`));
        return true;
      },
      state,
    );
    const query = new URL(github.urls[0]!).searchParams;
    assert.deepEqual(
      [query.get("head_sha"), query.get("event"), query.get("branch"), query.get("status")],
      [client, "push", "main", "completed"],
    );
    // Reading never needs a green client, and never asks.
    const reading = checks(runs);
    for (const mode of ["plan", "inspect"])
      await checkedActivationClient(mode, client, reading.passed);
    assert.deepEqual(reading.urls, []);
  }
  const green = checks([run({ conclusion: "failure" }), run({ conclusion: "success" })]);
  await checkedActivationClient(digest, client, green.passed);
  assert.equal(green.urls.length, 1);
  await assert.rejects(
    checkedActivationClient(digest, client, async () => {
      throw new Error("GitHub unavailable");
    }),
    /GitHub unavailable/,
  );
});

test("the gate asks for the client's Check only before a digest, and before the ledger", async (context) => {
  const candidate = environment.BASALT_RELEASE_CANDIDATE;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const client = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  const gate = async (mode: string, clientCheck: string) => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search);
      if (url.pathname.endsWith("/commits/main")) return Response.json({ sha: candidate });
      if (url.pathname.endsWith("/actions/workflows/ci.yml/runs")) {
        const commit = url.searchParams.get("head_sha");
        return Response.json({
          workflow_runs: [
            {
              head_sha: commit,
              event: "push",
              path: ".github/workflows/ci.yml",
              conclusion: commit === candidate ? "success" : clientCheck,
            },
          ],
        });
      }
      // No pull requests for the candidate, and an empty production deployment ledger.
      return Response.json([]);
    };
    const outcome = await migrationActivationGate({
      ...environment,
      MIGRATION_ACTIVATION_MODE: mode,
      GITHUB_SHA: client,
      GITHUB_TOKEN: "fixture",
    }).catch((error: unknown) => error);
    assert.ok(outcome instanceof BarrierRefusal, String(outcome));
    return {
      reason: outcome.reason,
      askedClient: urls.some((url) => url.includes(`head_sha=${client}`)),
      readLedger: urls.some((url) => url.includes("/deployments")),
    };
  };
  const pastTheCheck = "migration-activation-wrong-production-candidate";
  assert.deepEqual(await gate("b".repeat(64), "failure"), {
    reason: "migration-activation-client-check-required",
    askedClient: true,
    readLedger: false,
  });
  assert.deepEqual(await gate("b".repeat(64), "success"), {
    reason: pastTheCheck,
    askedClient: true,
    readLedger: true,
  });
  for (const mode of ["plan", "inspect"])
    assert.deepEqual(await gate(mode, "failure"), {
      reason: pastTheCheck,
      askedClient: false,
      readLedger: true,
    });
});

test("an ineligible candidate is refused by name; other gate errors keep their text private", async () => {
  // The real validator's sentence, so rewording it there cannot silently drop the reason here.
  const candidate = environment.BASALT_RELEASE_CANDIDATE;
  const unchecked = await validateMainCandidate(
    "synthetic/basalt",
    "fixture",
    candidate,
    candidate,
    async (url) =>
      Response.json(url.endsWith("/commits/main") ? { sha: candidate } : { workflow_runs: [] }),
  ).catch((error: unknown) => candidateEligibilityRefusal(error));
  assert.ok(unchecked instanceof BarrierRefusal);
  assert.deepEqual(unchecked.delta?.changed, [
    {
      path: "eligibility",
      old: "eligible",
      new: "the main release candidate has no successful push Check",
    },
  ]);
  for (const [message, change] of [
    [
      "the main release candidate has no successful push Check",
      {
        path: "eligibility",
        old: "eligible",
        new: "the main release candidate has no successful push Check",
      },
    ],
    [
      "main does not contain the release candidate",
      { path: "eligibility", old: "eligible", new: "main does not contain the release candidate" },
    ],
    [
      "GitHub request for the main release candidate failed with HTTP 403",
      { path: "github.status", old: 200, new: 403 },
    ],
  ] as const) {
    const refusal = candidateEligibilityRefusal(new Error(message));
    assert.equal(refusal?.reason, "migration-activation-candidate-ineligible");
    assert.deepEqual(refusal?.delta?.changed, [change]);
  }
  for (const error of [
    new Error(
      "GitHub request for the main release candidate failed with HTTP 403 for a private path",
    ),
    new Error("fetch failed: private transport text"),
    "the main release candidate has no successful push Check",
    undefined,
  ])
    assert.equal(candidateEligibilityRefusal(error), undefined);
});

test("the gate step names both commits when its checkout is not the dispatched one", (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "basalt-activation-gate-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const summary = join(scratch, "summary.md");
  const dispatched = "c".repeat(40);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./migration-activation-gate.ts", import.meta.url))],
    {
      // Another directory: the client's commit is its own checkout's, not the working directory's.
      cwd: scratch,
      env: {
        ...environment,
        PATH: process.env.PATH,
        GITHUB_SHA: dispatched,
        GITHUB_TOKEN: "fixture",
        GITHUB_STEP_SUMMARY: summary,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  const change = `| tooling | HEAD | "${dispatched}" → "${head}" |`;
  assert.ok(readFileSync(summary, "utf8").includes(change));
  assert.ok(result.stderr.includes(change), result.stderr);
  assert.match(
    result.stderr,
    /^::error title=Release barrier refused::Release barrier refused: migration-activation-trusted-tooling-required%0A/m,
  );
});

for (const status of [403, 503]) {
  test(`the actual activation gate reports a client Check HTTP ${status} in its refusal summary`, (context) => {
    const scratch = mkdtempSync(join(tmpdir(), "basalt-client-check-refusal-"));
    context.after(() => rmSync(scratch, { recursive: true, force: true }));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const client = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const candidate = environment.BASALT_RELEASE_CANDIDATE;
    const summary = join(scratch, "summary.md");
    const stub = join(scratch, "github.mjs");
    writeFileSync(
      stub,
      `
const client = ${JSON.stringify(client)}, candidate = ${JSON.stringify(candidate)};
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/commits/main")) return Response.json({ sha: candidate });
  if (url.pathname.endsWith("/actions/workflows/ci.yml/runs")) {
    const commit = url.searchParams.get("head_sha");
    if (commit === client)
      return new Response("synthetic-private-github-detail", { status: ${status} });
    return Response.json({ workflow_runs: [{
      head_sha: commit, event: "push", path: ".github/workflows/ci.yml", conclusion: "success"
    }] });
  }
  if (url.pathname.endsWith("/pulls")) return Response.json([]);
  throw new Error("The failed client lookup must precede any deployment ledger read");
};
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", stub, fileURLToPath(new URL("./migration-activation-gate.ts", import.meta.url))],
      {
        cwd: scratch,
        env: {
          ...environment,
          PATH: process.env.PATH,
          MIGRATION_ACTIVATION_MODE: "b".repeat(64),
          GITHUB_SHA: client,
          GITHUB_TOKEN: "fixture",
          GITHUB_STEP_SUMMARY: summary,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /migration-activation-client-check-unavailable/);
    const detail = readFileSync(summary, "utf8");
    const change = `| tooling | github.status | 200 → ${status} |`;
    for (const output of [result.stderr, detail]) {
      assert.ok(output.includes(change), output);
      assert.ok(output.includes(client), "the refusal names the dispatched client commit");
      assert.doesNotMatch(
        output,
        /migration-activation-gate-failed|synthetic-private-github-detail/,
      );
    }
  });
}

test("a production release hold refuses every activation input before connecting", () => {
  for (const mode of ["plan", "inspect", "b".repeat(64)]) {
    assert.throws(
      () =>
        migrationActivationInput({
          ...environment,
          MIGRATION_ACTIVATION_MODE: mode,
          PRODUCTION_RELEASE_HOLD: "restore in progress",
        }),
      /migration-activation-release-held.*PRODUCTION_RELEASE_HOLD/,
    );
    assert.doesNotThrow(() =>
      migrationActivationInput({
        ...environment,
        MIGRATION_ACTIVATION_MODE: mode,
        PRODUCTION_RELEASE_HOLD: "  ",
      }),
    );
  }
});

test("the activation workflow keeps the release lock and excludes all ordinary deployment work", () => {
  const require = createRequire(new URL("../architecture/package.json", import.meta.url));
  const { parse } = require("yaml");
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release-main.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.concurrency, {
    group: "deploy-production",
    "cancel-in-progress": false,
  });
  assert.match(workflow.jobs.backup.if, /inputs\.migration_activation == ''/);
  assert.match(workflow.jobs.deploy.if, /inputs\.migration_activation == ''/);
  const job = workflow.jobs["migration-activation"];
  assert.equal(job.environment, "production-release");
  assert.match(job.if, /inputs\.migration_activation != ''/);
  assert.equal(job.needs, undefined);
  const steps = job.steps;
  assert.equal(steps[0].with.ref, "${{ github.sha }}");
  const validate = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("migration-activation-gate.ts"),
  );
  const select = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("git worktree add"),
  );
  const run = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("migration-activation-entry.ts"),
  );
  assert.ok(validate > 0 && select > validate && run > select);
  // Main's client runs in main's checkout; the candidate is prepared beside it as data.
  assert.equal(steps[run]["working-directory"], undefined);
  assert.equal(steps[run].env.BASALT_ACTIVATION_SOURCE_ROOT, "${{ runner.temp }}/candidate");
  assert.equal(steps[run].env.BASALT_RELEASE_CANDIDATE, undefined);
  const prepared = steps
    .filter((step: { run?: string }) => step.run === "npm run prepare:upstream")
    .map((step: { "working-directory"?: string }) => step["working-directory"]);
  assert.deepEqual(prepared, ["${{ runner.temp }}/candidate", undefined]);
  assert.ok(
    steps.every(
      (step: { run?: string; "working-directory"?: string }) =>
        step["working-directory"] === undefined || step.run === "npm run prepare:upstream",
    ),
  );
  const commands = steps.map((step: { run?: string }) => step.run ?? "").join("\n");
  assert.doesNotMatch(
    commands,
    /already-live|main-candidate\.ts newest|release\.ts deploy|backup-only|--apply|--activate-change-journal/,
  );
  assert.doesNotMatch(commands, /\$\{\{ inputs\./);
  assert.equal(steps[run].env.MIGRATION_ACTIVATION_MODE, "${{ inputs.migration_activation }}");
  const artifact = steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(artifact.if, "always()");
  assert.equal(artifact.with.path, ".local/release-barrier/migration-activation.json");
});

test("the activation workflow starts main's client with the candidate's release identity", (context) => {
  const require = createRequire(new URL("../architecture/package.json", import.meta.url));
  const { parse } = require("yaml");
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release-main.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs["migration-activation"].steps.find((step: { run?: string }) =>
    step.run?.includes("migration-activation-entry.ts"),
  );
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "basalt-activation-config-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const candidateRoot = join(scratch, "candidate");
  mkdirSync(candidateRoot);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: candidateRoot, encoding: "utf8" }).trim();
  git("init", "--quiet");
  writeFileSync(join(candidateRoot, "release"), "candidate\n");
  git("add", "release");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    "candidate",
  );
  const candidate = git("rev-parse", "HEAD");
  const tooling = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.notEqual(candidate, tooling);
  const output = join(scratch, "config.json");
  const keys = [
    "BETTER_AUTH_URL",
    "ALCHEMY_STAGE",
    "PLANETSCALE_DATABASE_NAME",
    "PLANETSCALE_REGION",
    "PLANETSCALE_CLUSTER_SIZE",
    "CLOUD_SOURCE_NAMESPACE",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "TELEMETRY_RELAY_KEY",
    "BASALT_RELEASE_CANDIDATE",
    "BASALT_ACTIVATION_SOURCE_ROOT",
    "EXECUTOR_COMPILER_CACHE_RELEASE",
    "BASALT_RELEASE_ATTEMPT",
    "MIGRATION_ACTIVATION_MODE",
    "BASALT_HOME_SCHEMA_RETRY_INTENT",
  ];
  const client = join(bin, "bun");
  writeFileSync(
    client,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.CONFIG_OUTPUT, JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]])),
}));
process.exit(Number(process.env.CONFIG_CLIENT_EXIT || 0));
`,
  );
  chmodSync(client, 0o700);
  const source = {
    ...Object.fromEntries(requiredSecrets.map((key) => [key, "fixture"])),
    AUTH_GITHUB_CLIENT_ID: "fixture-github-client-id",
    AUTH_GITHUB_CLIENT_SECRET: "fixture-github-client-secret",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_DEPLOYMENT_KEY: "cd".repeat(32),
    ALCHEMY_STAGE: "production",
    BASALT_RELEASE_ATTEMPT: "stale-fixture-attempt",
    BASALT_HOME_SCHEMA_RETRY_INTENT: "",
    BASALT_ACTIVATION_SOURCE_ROOT: candidateRoot,
    CONFIG_OUTPUT: output,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  };
  const attempts = new Set<string>();
  for (const mode of ["plan", "inspect", "f".repeat(64)]) {
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      cwd: root,
      env: { ...source, MIGRATION_ACTIVATION_MODE: mode },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(captured.args, ["scripts/release-barrier/migration-activation-entry.ts"]);
    assert.equal(captured.env.BETTER_AUTH_URL, "https://app.signalbox.run");
    assert.equal(captured.env.ALCHEMY_STAGE, "production");
    assert.equal(captured.env.PLANETSCALE_DATABASE_NAME, "basalt");
    assert.equal(captured.env.PLANETSCALE_REGION, "eu-central");
    assert.equal(captured.env.PLANETSCALE_CLUSTER_SIZE, "PS_5");
    assert.equal(captured.env.CLOUD_SOURCE_NAMESPACE, "basalt-production-apps");
    assert.equal(captured.env.GITHUB_CLIENT_ID, source.AUTH_GITHUB_CLIENT_ID);
    assert.equal(captured.env.GITHUB_CLIENT_SECRET, source.AUTH_GITHUB_CLIENT_SECRET);
    assert.match(captured.env.TELEMETRY_RELAY_KEY, /^[a-f0-9]{64}$/);
    // The release identity is the candidate checkout's commit, never the client's own.
    assert.equal(captured.env.BASALT_RELEASE_CANDIDATE, candidate);
    assert.equal(captured.env.EXECUTOR_COMPILER_CACHE_RELEASE, candidate);
    assert.equal(captured.env.BASALT_ACTIVATION_SOURCE_ROOT, candidateRoot);
    assert.match(
      captured.env.BASALT_RELEASE_ATTEMPT,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    attempts.add(captured.env.BASALT_RELEASE_ATTEMPT);
    assert.equal(captured.env.MIGRATION_ACTIVATION_MODE, mode);
    assert.equal(captured.env.BASALT_HOME_SCHEMA_RETRY_INTENT, "");
  }
  assert.equal(attempts.size, 3);
  const failed = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
    cwd: root,
    env: { ...source, MIGRATION_ACTIVATION_MODE: "plan", CONFIG_CLIENT_EXIT: "17" },
    encoding: "utf8",
  });
  assert.notEqual(failed.status, 0);
});
