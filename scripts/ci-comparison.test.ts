import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedInputs } from "./ci/affected.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

test("PR comparison excludes merged compatibility changes despite stale event and tracking refs", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.select.steps.find(
    (entry: { id?: string }) => entry.id === "comparison",
  );
  const root = mkdtempSync(join(tmpdir(), "basalt-pr-comparison-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-q", "--initial-branch=candidate");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    writeFileSync(join(root, "carry.patch"), "original");
    writeFileSync(join(root, "input"), "old release");
    git("add", ".");
    git("commit", "-qm", "old base");
    const stale = git("rev-parse", "HEAD");
    writeFileSync(join(root, "carry.patch"), "merged compatibility correction");
    git("commit", "-qam", "current base");
    const current = git("rev-parse", "HEAD");
    git("branch", "stable", current);
    git("remote", "add", "origin", root);
    git("update-ref", "refs/remotes/origin/stable", stale);
    writeFileSync(join(root, "input"), "new release");
    git("commit", "-qam", "bump");
    const head = git("rev-parse", "HEAD");
    const output = join(root, "output");
    const environment = {
      ...process.env,
      PULL_REQUEST: "true",
      BASE_REF: "stable",
      BATCH_PUSH: "false",
      BASE_SHA: stale,
      HEAD_SHA: head,
      GITHUB_OUTPUT: output,
    };
    writeFileSync(output, "");
    execFileSync("bash", ["-e", "-c", step.run], { cwd: root, env: environment });
    assert.equal(readFileSync(output, "utf8"), `base_sha=${current}\n`);
    assert.equal(git("rev-parse", "refs/remotes/origin/stable"), current);
    assert.deepEqual(changedInputs(root, current, head).changed, ["input"]);
    assert.equal(step.env.BASE_REF, "${{ github.base_ref || 'main' }}");
    assert.equal(step.env.PULL_REQUEST, "${{ github.event_name == 'pull_request' }}");

    git("switch", "-q", "stable");
    writeFileSync(join(root, "later-base-input"), "unmerged base change");
    git("add", "later-base-input");
    git("commit", "-qm", "base advances independently");
    const advanced = git("rev-parse", "HEAD");
    git("switch", "-q", "candidate");
    writeFileSync(output, "");
    execFileSync("bash", ["-e", "-c", step.run], { cwd: root, env: environment });
    assert.equal(readFileSync(output, "utf8"), `base_sha=${current}\n`);
    assert.equal(git("rev-parse", "refs/remotes/origin/stable"), advanced);

    writeFileSync(output, "");
    execFileSync("bash", ["-e", "-c", step.run], {
      cwd: root,
      env: { ...environment, PULL_REQUEST: "false" },
    });
    assert.equal(readFileSync(output, "utf8"), `base_sha=${stale}\n`);

    writeFileSync(output, "");
    assert.throws(() =>
      execFileSync("bash", ["-e", "-c", step.run], {
        cwd: root,
        env: { ...environment, BASE_REF: "missing" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(readFileSync(output, "utf8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
