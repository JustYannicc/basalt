import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyUpdatePlan, planUpdate } from "./update.ts";
import { createBasaltFixture, createHomeAssets, createHomeSource, createToolsSource, fixtureApi } from "./simulation-fixtures.ts";

export async function simulateRelease(): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "basalt-release-proof-"));
  try {
    const source = createToolsSource(join(root, "executor"));
    const home = createHomeSource(join(root, "home"));
    const assets = createHomeAssets(join(root, "assets"));
    const api = fixtureApi(source.candidate, home.candidate, assets, home.oauthSource);
    const patch = source.patch;

    const toolsRepo = createBasaltFixture(join(root, "tools-basalt"), source.base, home.base, patch);
    const toolsPlan = await planUpdate(toolsRepo, "tools", api);
    assert.equal(toolsPlan.candidatePins.tools.commit, source.candidate);
    const toolsBranch = await commitCandidate(toolsRepo, toolsPlan);
    assert.match(toolsBranch.name, /^release-updates\/tools-executor-2\.0\.0-beta\.27-[a-f0-9]{12}$/);
    const firstToolsHead = toolsBranch.head;
    git(toolsRepo, ["switch", "main"]);
    writeFileSync(join(toolsRepo, "README.md"), "main advanced while the release PR was open\n");
    git(toolsRepo, ["add", "README.md"]);
    git(toolsRepo, ["commit", "-m", "advance base independently"]);
    const staleBaseHead = git(toolsRepo, ["rev-parse", "HEAD"]).trim();
    const refreshedToolsPlan = await planUpdate(toolsRepo, "tools", api);
    const refreshedToolsBranch = reconcileExistingBranch(toolsRepo, refreshedToolsPlan, toolsBranch.name);
    assert.notEqual(refreshedToolsBranch.head, firstToolsHead);
    assert.equal(git(toolsRepo, ["merge-base", "main", toolsBranch.name]).trim(), staleBaseHead);
    git(toolsRepo, ["switch", "main"]);
    const repeatedToolsPlan = await planUpdate(toolsRepo, "tools", api);
    const repeatedToolsBranch = reconcileExistingBranch(toolsRepo, repeatedToolsPlan, toolsBranch.name);
    assert.equal(repeatedToolsBranch.head, refreshedToolsBranch.head);
    assert.equal(git(toolsRepo, ["rev-parse", "refs/simulated-pulls/1/head"]).trim(), refreshedToolsBranch.head);

    const patchCheck = verifyPatch(source.repository, source.candidate, patch);
    assert.equal(patchCheck.status, 0, patchCheck.stderr);
    assert.match(patchCheck.source, /mode = "basalt"/);
    assert.match(patchCheck.source, /release = "new"/);

    const homeRepo = createBasaltFixture(join(root, "home-basalt"), source.base, home.base, patch);
    const homePlan = await planUpdate(homeRepo, "home", api);
    assert.equal(homePlan.candidatePins.home.tag, "v1.1.7");
    assert.equal(homePlan.candidatePins.home.assets.amd64.sha256, assets.amd64.sha256);
    assert.equal(homePlan.candidatePins.node.tag, "v8.0.40");
    const homeBranch = await commitCandidate(homeRepo, homePlan);
    assert.equal(homeBranch.name, "release-updates/home-v1.1.7");
    assert.equal(git(homeRepo, ["rev-parse", "refs/simulated-pulls/1/head"]).trim(), homeBranch.head);

    const brokenRepo = createBasaltFixture(join(root, "broken-basalt"), source.base, home.base, patch.replace("mode = \"upstream\"", "mode = \"missing\""));
    const brokenPlan = await planUpdate(brokenRepo, "tools", api);
    const brokenBranch = await commitCandidate(brokenRepo, brokenPlan);
    const brokenPatchCheck = verifyPatch(source.repository, source.candidate, patch.replace("mode = \"upstream\"", "mode = \"missing\""));
    assert.notEqual(brokenPatchCheck.status, 0);
    assert.equal(git(brokenRepo, ["rev-parse", "refs/simulated-pulls/1/head"]).trim(), brokenBranch.head);
    assert.equal(JSON.parse(readFileSync(join(brokenRepo, "upstream.json"), "utf8")).commit, source.candidate);

    git(toolsRepo, ["merge", "--squash", toolsBranch.name]);
    git(toolsRepo, ["commit", "-m", "merge release candidate"]);
    const deployedCandidate = git(toolsRepo, ["rev-parse", "HEAD"]).trim();
    git(toolsRepo, ["revert", "--no-edit", deployedCandidate]);
    assert.equal(git(toolsRepo, ["rev-parse", "HEAD^{tree}"]).trim(), git(toolsRepo, ["rev-parse", "main^{tree}"]).trim());
    assert.equal(JSON.parse(readFileSync(join(toolsRepo, "upstream.json"), "utf8")).commit, source.base);
    const rolledBack = verifyPatch(source.repository, source.base, patch);
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.match(rolledBack.source, /mode = "basalt"/);
    assert.match(rolledBack.source, /release = "old"/);

    return {
      schemaVersion: 1,
      simulatedPullRequests: { tools: 1, home: 1, brokenCandidate: 1 },
      tools: { source: "v2 release tag", tag: source.releaseTag, base: source.base, candidate: source.candidate, branch: toolsBranch.name, idempotentRetry: true, staleBaseReconciled: true },
      home: { tag: "v1.1.7", base: home.base, commit: home.candidate, branch: homeBranch.name, amd64Sha256: assets.amd64.sha256 },
      patches: { validApplyAndDiffCheck: "passed", stalePatchCheck: "failed", staleCandidateStillHasPullRequestRef: true },
      rollback: { previousCommitRestored: source.base, sourceTreeEqualsMain: true, carriedPatchApplies: true },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function commitCandidate(root: string, plan: Awaited<ReturnType<typeof planUpdate>>): Promise<{ name: string; head: string }> {
  const branch = `release-updates/${plan.releaseKey}`;
  git(root, ["switch", "-c", branch]);
  applyUpdatePlan(root, plan);
  if (plan.changedPaths.length) {
    git(root, ["add", "--", ...plan.changedPaths]);
    git(root, ["commit", "-m", `Update ${plan.releaseKey}`]);
  }
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const pullRefs = git(root, ["for-each-ref", "--format=%(refname)", "refs/simulated-pulls/"]).trim().split("\n").filter(Boolean);
  const number = pullRefs.length + 1;
  git(root, ["update-ref", `refs/simulated-pulls/${number}/head`, head]);
  return { name: branch, head };
}

function reconcileExistingBranch(root: string, plan: Awaited<ReturnType<typeof planUpdate>>, branch: string): { head: string } {
  const common = git(root, ["merge-base", "main", branch]).trim();
  const previousSubject = git(root, ["show", "-s", "--format=%s", branch]).trim();
  const previousAuthor = git(root, ["show", "-s", "--format=%an", branch]).trim();
  assert.equal(previousSubject, `Update ${plan.releaseKey}`);
  assert.equal(previousAuthor, "Release proof");
  const receiptText = git(root, ["show", `${branch}:scripts/releases/receipts/tools.json`]);
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.source, plan.source);
  assert.equal(receipt.releaseKey, plan.releaseKey);
  assert.equal(receipt.candidatePins.tools.commit, plan.candidatePins.tools.commit);

  const changes = git(root, ["diff", "--name-status", `${common}...${branch}`]);
  const rows = changes.trim().split("\n").filter(Boolean).map((row) => row.split("\t"));
  const changedPaths = rows.map((row) => row.at(-1)!).sort();
  assert.deepEqual(changedPaths, plan.changedPaths.slice().sort());
  for (const row of rows) {
    if (row[1]?.startsWith("patches/") || row.at(-1)?.startsWith("patches/")) assert.equal(row[0], "D");
  }
  for (const file of plan.files) {
    if (file.content === null) {
      assert.throws(() => git(root, ["show", `${branch}:${file.path}`]));
    } else {
      assert.equal(git(root, ["show", `${branch}:${file.path}`]), file.content);
    }
  }

  if (git(root, ["rev-parse", "main"]).trim() !== common) {
    git(root, ["rebase", "main", branch]);
  }
  const head = git(root, ["rev-parse", branch]).trim();
  const pullRef = git(root, ["for-each-ref", "--format=%(refname)", "refs/simulated-pulls/"]).trim().split("\n").find(Boolean);
  if (pullRef) git(root, ["update-ref", pullRef, head]);
  return { head };
}

function verifyPatch(sourceRepo: string, commit: string, patch: string): { status: number; stderr: string; source: string } {
  const worktree = join(sourceRepo, `../source-check-${commit.slice(0, 8)}`);
  git(sourceRepo, ["worktree", "add", "--detach", worktree, commit]);
  try {
    const patchPath = join(sourceRepo, "../candidate.patch");
    writeFileSync(patchPath, patch);
    const checked = spawnSync("git", ["apply", "--check", patchPath], { cwd: worktree, encoding: "utf8" });
    if (checked.status !== 0) return { status: checked.status ?? 1, stderr: checked.stderr, source: "" };
    git(worktree, ["apply", patchPath]);
    git(worktree, ["diff", "--check"]);
    return { status: 0, stderr: "", source: readFileSync(join(worktree, "apps/hosted/cloud/src/mode.ts"), "utf8") + readFileSync(join(worktree, "apps/hosted/cloud/src/version.ts"), "utf8") };
  } finally {
    rmSync(join(sourceRepo, "../candidate.patch"), { force: true });
    git(sourceRepo, ["worktree", "remove", "--force", worktree]);
  }
}

function git(path: string, args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await simulateRelease();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
