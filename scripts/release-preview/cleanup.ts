import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint } from "./checkpoint.ts";
import { privateOperation } from "./process.ts";
import { GitHubApi } from "../release-merge/github.ts";
import { validatePreviewReceipt } from "../release-merge/policy.ts";

type CleanupTarget = { pullRequest: number; branch: string; runId?: number; head?: string };

export function cleanupTarget(event: any, repository: string): CleanupTarget {
  if (event.repository?.full_name !== repository) throw new Error("Invalid cleanup repository");
  if (event.pull_request) {
    const pr = event.pull_request;
    if (event.action !== "closed" || pr.head?.repo?.full_name !== repository
      || !pr.head.ref?.startsWith("release-updates/")
      || !pr.labels?.some((label: any) => label.name === "release-update")
      || !Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error("Invalid closed release PR");
    return { pullRequest: pr.number, branch: pr.head.ref, ...(typeof pr.head.sha === "string" ? { head: pr.head.sha } : {}) };
  }
  const run = event.workflow_run;
  if (run?.name !== "Release preview" || run.event !== "pull_request" || run.status !== "completed"
    || run.head_repository?.full_name !== repository || !run.head_branch?.startsWith("release-updates/")
    || !Number.isSafeInteger(run.id) || run.id < 1 || run.pull_requests?.length !== 1
    || !Number.isSafeInteger(run.pull_requests[0].number) || run.pull_requests[0].number < 1) {
    throw new Error("Invalid preview cleanup event");
  }
  return { pullRequest: run.pull_requests[0].number, branch: run.head_branch, runId: run.id };
}

function gh(path: string): Buffer {
  return execFileSync("gh", ["api", path], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });
}

async function restoreCheckpoint(root: string, repository: string, target: CleanupTarget, privateRoot: string): Promise<"proven" | "restored" | "missing"> {
  const runIds = target.runId ? [target.runId] : [];
  if (!target.runId) {
    for (let page = 1; page <= 10; page++) {
      const { workflow_runs: runs } = JSON.parse(gh(
        `repos/${repository}/actions/workflows/release-preview.yml/runs?event=pull_request&branch=${encodeURIComponent(target.branch)}&per_page=100&page=${page}`,
      ).toString());
      if (!Array.isArray(runs)) throw new Error("Invalid preview run list");
      for (const run of runs) {
        if (run.pull_requests?.some((pr: any) => pr.number === target.pullRequest)) runIds.push(run.id);
      }
      if (runs.length < 100) break;
      if (page === 10) throw new Error("Preview run list may be truncated");
    }
  }
  // Only the latest associated run can establish prior teardown. A later cancelled attempt needs recovery.
  if (runIds.length && !target.runId) {
    const latest = JSON.parse(gh(`repos/${repository}/actions/runs/${runIds[0]}`).toString());
    const association = latest.pull_requests?.find((pr: any) => pr.number === target.pullRequest);
    if (latest.status === "completed" && latest.conclusion === "success" && latest.event === "pull_request"
      && latest.head_branch === target.branch && latest.head_repository?.full_name === repository
      && latest.head_sha === target.head && association?.head?.sha === target.head
      && typeof association.base?.sha === "string") {
      const receipt = await new GitHubApi(process.env.GH_TOKEN).getPreviewReceipt(repository, latest.id,
        `release-preview-${target.pullRequest}-${latest.head_sha}`);
      if (receipt !== undefined && validatePreviewReceipt(receipt, { pullRequest: target.pullRequest,
        head: latest.head_sha, base: association.base.sha }).length === 0) return "proven";
    }
  }
  for (const runId of runIds) {
    const { artifacts } = JSON.parse(gh(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`).toString());
    if (!Array.isArray(artifacts) || artifacts.length >= 100) throw new Error("Invalid preview cleanup artifacts");
    const name = `release-preview-cleanup-${target.pullRequest}-${runId}`;
    const matches = artifacts.filter((item: any) => item.name === name && !item.expired);
    if (matches.length === 0) continue;
    if (matches.length !== 1) throw new Error("Ambiguous preview cleanup artifact");
    const zip = gh(`repos/${repository}/actions/artifacts/${matches[0].id}/zip`);
    const zipPath = join(privateRoot, "checkpoint.zip");
    await writeFile(zipPath, zip, { mode: 0o600 });
    const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/);
    if (entries.length !== 1 || entries[0] !== "preview-plan.json.enc") throw new Error("Invalid preview checkpoint archive");
    const encrypted = execFileSync("unzip", ["-p", zipPath, "preview-plan.json.enc"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });
    const encryptedPath = join(privateRoot, "checkpoint.json.enc");
    await writeFile(encryptedPath, encrypted, { mode: 0o600 });
    await checkpoint("restore", root, encryptedPath, process.env.PREVIEW_STATE_KEY ?? "", target.pullRequest);
    return "restored";
  }
  return "missing";
}

async function main(): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_REPOSITORY) {
    throw new Error("Preview cleanup runs only from a trusted Actions event");
  }
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const target = cleanupTarget(event, process.env.GITHUB_REPOSITORY);
  const root = process.cwd();
  const privateRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "basalt-preview-cleanup-"));
  let sequence = 0;
  const operation = (mode: string) => privateOperation({ label: mode, command: process.execPath,
    args: ["scripts/preview/lifecycle.ts", mode, String(target.pullRequest)], directory: root,
    environment: { ...process.env, GITHUB_OUTPUT: undefined, GITHUB_ENV: undefined },
    logPath: join(privateRoot, `${++sequence}-${mode}.log`), timeoutMs: 15 * 60_000 });
  try {
    await mkdir(join(root, ".local"), { recursive: true, mode: 0o700 });
    const recovery = await restoreCheckpoint(root, process.env.GITHUB_REPOSITORY, target, privateRoot);
    if (recovery === "proven") {
      console.log("The latest preview has an authenticated successful teardown receipt");
      return;
    }
    if (recovery === "missing") await operation("plan");
    let failure: unknown;
    try { await operation("destroy"); } catch (error) { failure = error; }
    await operation("verify");
    if (failure) throw failure;
    console.log("Temporary release preview resources are absent");
  } finally { await rm(privateRoot, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith("/cleanup.ts")) {
  try { await main(); }
  catch { console.error("Preview cleanup failed; provider resource absence is not established"); process.exitCode = 1; }
}
