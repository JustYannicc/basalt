import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RELEASE_MERGE_POLICY, validateCheckRunReceipt, type CheckRunReceipt } from "./policy.ts";

export function createCheckRunReceipt(input: {
  repository: string;
  pullRequest: number;
  runId: number;
  runAttempt: number;
  head: string;
  base: string;
  checkedOutCommit: string;
  checkedOutParents: string[];
}): CheckRunReceipt {
  const parents = input.checkedOutParents;
  if (parents.length !== 2) throw new Error("checked out PR merge result must have exactly two parents");
  const receipt = {
    version: 1 as const,
    repository: input.repository,
    pullRequest: input.pullRequest,
    runId: input.runId,
    runAttempt: input.runAttempt,
    head: input.head,
    base: input.base,
    mergeCommit: input.checkedOutCommit,
    parents: [parents[0] ?? "", parents[1] ?? ""] as const,
  } satisfies CheckRunReceipt;
  const problems = validateCheckRunReceipt(receipt, {
    repository: input.repository,
    pullRequest: input.pullRequest,
    runId: input.runId,
    runAttempt: input.runAttempt,
    head: input.head,
    base: input.base,
  });
  if (problems.length) throw new Error(problems.join("; "));
  if (input.checkedOutCommit === input.head || input.checkedOutCommit === input.base)
    throw new Error("checked out PR merge result must be a distinct commit");
  return receipt;
}

export function writePullRequestCheckReceipt(env = process.env): void {
  if (env.GITHUB_EVENT_NAME !== "pull_request") throw new Error("Check receipt requires a pull_request event");
  const repository = requiredText(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const eventPath = requiredText(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
  const outputDirectory = requiredText(env.RUNNER_TEMP, "RUNNER_TEMP");
  const checkedOutSha = requiredSha(env.GITHUB_SHA, "GITHUB_SHA");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
  if (!isRecord(event) || !isRecord(event.repository) || !isRecord(event.pull_request))
    throw new Error("Check receipt pull_request event payload is invalid");
  const pullRequest = event.pull_request;
  const head = isRecord(pullRequest.head) ? pullRequest.head : undefined;
  const base = isRecord(pullRequest.base) ? pullRequest.base : undefined;
  const headRepo = head && isRecord(head.repo) ? head.repo : undefined;
  const baseRepo = base && isRecord(base.repo) ? base.repo : undefined;
  if (event.repository.full_name !== repository || headRepo?.full_name !== repository || baseRepo?.full_name !== repository)
    throw new Error("Check receipt is only available for same-repository pull requests");
  if (base?.ref !== RELEASE_MERGE_POLICY.baseBranch || typeof head?.ref !== "string" ||
    !head.ref.startsWith(RELEASE_MERGE_POLICY.updaterBranchPrefix))
    throw new Error("Check receipt is only available for allowlisted release branches targeting main");
  const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels : [];
  if (!labels.some((label) => isRecord(label) && label.name === RELEASE_MERGE_POLICY.releaseLabel))
    throw new Error("Check receipt requires the release-update label");

  const headSha = requiredSha(head.sha, "pull_request.head.sha");
  const baseSha = requiredSha(base.sha, "pull_request.base.sha");
  const number = positiveInteger(pullRequest.number, "pull_request.number");
  const runId = positiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const runAttempt = positiveInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  const commitLine = execFileSync("git", ["rev-list", "--parents", "--no-abbrev", "-n", "1", "HEAD"], { encoding: "utf8" }).trim();
  const [commit, ...parents] = commitLine.split(/\s+/);
  if (!commit || commit !== checkedOutSha) throw new Error("checked out commit does not match GITHUB_SHA");
  const receipt = createCheckRunReceipt({
    repository,
    pullRequest: number,
    runId,
    runAttempt,
    head: headSha,
    base: baseSha,
    checkedOutCommit: commit,
    checkedOutParents: parents,
  });
  writeFileSync(join(outputDirectory, RELEASE_MERGE_POLICY.checkReceiptFile), `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
}

function requiredText(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function requiredSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) throw new Error(`${label} must be a full commit SHA`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive safe integer`);
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    writePullRequestCheckReceipt();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
