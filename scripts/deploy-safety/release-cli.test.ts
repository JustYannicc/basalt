import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRestoredBackup, candidateCheckout, resolveManualRollbackSourceRoot } from "./release.ts";
import { gitRepositoryRoot } from "./release-plan.ts";

test("rollback workflow selects a release and defers deployment status eligibility to the guarded CLI", () => {
  const workflow = readFileSync(join(gitRepositoryRoot(), ".github/workflows/release-rollback.yml"), "utf8");
  assert.match(workflow, /inputs:\n\s+release_sha:/);
  assert.doesNotMatch(workflow, /failed_release_sha|FAILED_RELEASE_SHA/);
  assert.match(workflow, /release\.ts rollback-report/);
  assert.match(workflow, /release\.ts rollback-target/);
  assert.match(workflow, /--deployment-id "\$DEPLOYMENT_ID"/);
  assert.doesNotMatch(workflow, /DEPLOYMENT_STATUS"\s*!=\s*"(?:failure|error)"/);
  assert.match(workflow, /environment: production-release/);
});

test("rollback runs only for the backup the dispatcher says they restored", () => {
  const workflow = readFileSync(join(gitRepositoryRoot(), ".github/workflows/release-rollback.yml"), "utf8");
  assert.match(workflow, /\n\s+restored_backup:\n\s+description: [^\n]+\n\s+required: true/);
  for (const command of ["rollback-target", "manual-rollback"])
    assert.match(workflow, new RegExp(`release\\.ts ${command} \\\\\\n(?:\\s+--[^\\n]+\\n)*?\\s+--restored-backup "\\$RESTORED_BACKUP"`), command);
  assert.equal(workflow.match(/RESTORED_BACKUP: \$\{\{ inputs\.restored_backup \}\}/g)?.length, 2);
  assertRestoredBackup(" basalt-release-v2-recorded\n", "basalt-release-v2-recorded");
  assert.throws(() => assertRestoredBackup("basalt-release-v2-other", "basalt-release-v2-recorded"), /recorded backup, basalt-release-v2-recorded; restore that exact backup first/);
});

test("Workflow-identity releases fail closed in the drain step", () => {
  for (const name of ["release-main.yml", "release-manual.yml"]) {
    const workflow = readFileSync(join(gitRepositoryRoot(), ".github/workflows", name), "utf8");
    assert.match(workflow, /- name: Journal changes require all existing workflow runs drained before deployment\n\s+run: node scripts\/deploy-safety\/release\.ts inspect-workflows /, name);
    assert.ok(workflow.indexOf("inspect-workflows") < workflow.indexOf("release.ts deploy "), name);
  }
});

test("bootstrap report accepts trusted main on workflow_dispatch without candidate-root", () => {
  const root = realpathSync(gitRepositoryRoot());
  const candidate = commitAt(root);
  const restore = setEnvironment({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidate,
    RUNNER_TEMP: mkdtempSync(join(tmpdir(), "basalt-runner-temp-")),
    BASALT_RELEASE_CANDIDATE_SHA: undefined,
  });
  const previousDirectory = process.cwd();
  try {
    process.chdir(root);
    assert.deepEqual(candidateCheckout({ "--candidate": candidate }, true), { root, commit: candidate });
    const trustedCandidate = commitAt(gitRepositoryRoot());
    assert.throws(() => candidateCheckout({ "--candidate": trustedCandidate }), /separate worktree under RUNNER_TEMP/);
  } finally {
    process.chdir(previousDirectory);
    restore();
  }
});

test("manual commands require the exact candidate worktree under RUNNER_TEMP", () => {
  const temporary = mkdtempSync(join(tmpdir(), "basalt-manual-candidate-"));
  const runnerTemp = join(temporary, "runner-temp");
  const candidateRoot = join(runnerTemp, "candidate");
  mkdirSync(candidateRoot, { recursive: true });
  const candidate = createCommit(candidateRoot);
  const restore = setEnvironment({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "f".repeat(40),
    RUNNER_TEMP: runnerTemp,
    BASALT_RELEASE_CANDIDATE_SHA: undefined,
  });
  try {
    assert.deepEqual(candidateCheckout({ "--candidate": candidate, "--candidate-root": candidateRoot }), {
      root: realpathSync(candidateRoot),
      commit: candidate,
    });
    assert.throws(
      () => candidateCheckout({ "--candidate": "f".repeat(40), "--candidate-root": candidateRoot }),
      /does not match the checked-out HEAD/,
    );
    const trustedCandidate = commitAt(gitRepositoryRoot());
    assert.throws(() => candidateCheckout({ "--candidate": trustedCandidate }), /separate worktree under RUNNER_TEMP/);
    assert.throws(() => candidateCheckout({ "--candidate-root": candidateRoot }), /Missing required option --candidate/);
  } finally {
    restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("automatic report uses the checked-out candidate without candidate-root", () => {
  const root = realpathSync(gitRepositoryRoot());
  const candidate = commitAt(root);
  const restore = setEnvironment({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidate,
    BASALT_RELEASE_CANDIDATE_SHA: undefined,
  });
  try {
    assert.deepEqual(candidateCheckout({ "--candidate": candidate }, true), { root, commit: candidate });
  } finally {
    restore();
  }
});

test("manual rollback source must be a separate exact-baseline worktree under RUNNER_TEMP", () => {
  const temporary = mkdtempSync(join(tmpdir(), "basalt-rollback-roots-"));
  const failedRoot = join(temporary, "failed-candidate");
  const rollbackRoot = join(temporary, "rollback-source");
  mkdirSync(failedRoot);
  mkdirSync(rollbackRoot);
  const failedSha = createCommit(failedRoot);
  const rollbackSha = createCommit(rollbackRoot);
  try {
    assert.equal(resolveManualRollbackSourceRoot(rollbackSha, rollbackRoot, failedRoot, temporary), realpathSync(rollbackRoot));
    assert.throws(
      () => resolveManualRollbackSourceRoot(failedSha, rollbackRoot, failedRoot, temporary),
      /does not match the recorded production baseline/,
    );
    assert.throws(
      () => resolveManualRollbackSourceRoot(rollbackSha, failedRoot, failedRoot, temporary),
      /separate from the failed candidate/,
    );
    const outsideRoot = mkdtempSync(join(tmpdir(), "basalt-outside-rollback-"));
    try {
      const outsideSha = createCommit(outsideRoot);
      assert.throws(
        () => resolveManualRollbackSourceRoot(outsideSha, outsideRoot, failedRoot, temporary),
        /must be under RUNNER_TEMP/,
      );
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function commitAt(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function createCommit(root: string): string {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  writeFileSync(join(root, "candidate.txt"), `${root}\n`);
  execFileSync("git", ["add", "candidate.txt"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "candidate"], { cwd: root });
  return commitAt(root);
}

function setEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const runnerTemp = values.RUNNER_TEMP;
    if (runnerTemp?.includes("basalt-runner-temp-")) rmSync(runnerTemp, { recursive: true, force: true });
  };
}
