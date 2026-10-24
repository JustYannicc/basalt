import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateCheckout, resolveManualRollbackSourceRoot } from "./release.ts";
import { gitRepositoryRoot } from "./release-plan.ts";

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
