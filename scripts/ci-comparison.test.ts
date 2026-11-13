import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the pipeline guard excludes a merged release bump from an older PR's merged checkout", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const steps = workflow.jobs["cpa-pipeline"].steps;
  const comparison = steps.find((entry: { id?: string }) => entry.id === "comparison");
  const guard = steps.find((entry: { run?: string }) =>
    entry.run?.includes("cpa-pipeline-guard.py"),
  );
  const root = mkdtempSync(join(tmpdir(), "basalt-guard-merge-base-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const sources = join(root, "containers/pool/sources.json");
  const pin = (commit: string) =>
    writeFileSync(
      sources,
      JSON.stringify({ artifacts: { node: { repository: "fixture/node", commit, patches: [] } } }),
    );
  try {
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    mkdirSync(join(root, "containers/pool/patches"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      new URL("./cpa-pipeline-guard.py", import.meta.url),
      join(root, "scripts/cpa-pipeline-guard.py"),
    );
    pin("old-release");
    writeFileSync(join(root, "client"), "original client");
    git("add", ".");
    git("commit", "-qm", "old release");
    const stale = git("rev-parse", "HEAD");
    git("branch", "pr");
    pin("merged-release");
    writeFileSync(
      join(root, "containers/pool/patches/home-compatibility.patch"),
      "merged Home carry",
    );
    git("add", ".");
    git("commit", "-qm", "release bump and Home compatibility");
    const current = git("rev-parse", "HEAD");
    git("remote", "add", "origin", root);
    git("update-ref", "refs/remotes/origin/main", stale);
    git("switch", "-q", "pr");
    writeFileSync(join(root, "client"), "new client");
    git("commit", "-qam", "client change");
    const head = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "-m", "PR merge ref", "main");
    assert.equal(git("merge-base", "HEAD", "main"), current);
    const output = join(root, "comparison");
    writeFileSync(output, "");
    const environment = {
      ...process.env,
      PULL_REQUEST: "true",
      BASE_REF: "main",
      BATCH_PUSH: "false",
      BASE_SHA: stale,
      HEAD_SHA: head,
      BATCH_MODE: "false",
      GITHUB_OUTPUT: output,
    };
    if (comparison)
      execFileSync("bash", ["-e", "-c", comparison.run], { cwd: root, env: environment });
    const resolved = readFileSync(output, "utf8").trim().split("=")[1];
    const base =
      guard.env.BASE_SHA === "${{ steps.comparison.outputs.base_sha }}" ? resolved : stale;
    const command = guard.run
      .split("\n")
      .filter((line: string) => !line.trimStart().startsWith("python3 -m unittest "))
      .join("\n");
    const check = (candidate = head) =>
      spawnSync("bash", ["-e", "-c", command], {
        cwd: root,
        env: { ...environment, BASE_SHA: base, HEAD_SHA: candidate },
        encoding: "utf8",
      });
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(base, stale);
    assert.equal(result.stdout.trim(), "CPA source pin unchanged");

    git("switch", "-q", "--detach", head);
    pin("new-bump-in-this-PR");
    writeFileSync(join(root, "containers/pool/runtime.py"), "unrelated runtime change");
    git("add", ".");
    git("commit", "-qm", "negative bump on source head");
    const combined = check(git("rev-parse", "HEAD"));
    assert.notEqual(combined.status, 0);
    assert.match(combined.stderr, /CPA bump changes runtime code: containers\/pool\/runtime.py/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
